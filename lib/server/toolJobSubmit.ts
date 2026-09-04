import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type {
  PdfToolJobService,
  PdfToolBatchInput,
} from "@/src/application/services/PdfToolJobService";
import type { Job } from "@/src/domain/entities/Job";
import type { JobActor } from "@/src/application/services/jobOwnership";
import {
  UsageLimitError,
  UsageMeteringService,
  type UsageReservation,
} from "@/src/application/services/UsageMeteringService";
import { executionModeForSlug } from "@/lib/tools/executionPolicy";
import { ensureWorkerReady } from "@/src/infrastructure/jobs/workerBootstrap";
import { TOOL_OUTPUT_TTL_MS } from "@/src/infrastructure/jobs/PdfToolWorkerHandler";

import {
  validateUpload,
  UploadValidationError,
} from "./validateUpload";
import {
  isBatchEligible,
  TOOLS_BATCH_MAX_FILES,
  type ServerToolConfig,
  type OptionField,
} from "@/data/serverToolConfig";

/** Wraps a Buffer in a one-shot Web ReadableStream for uploadStream. */
export function bufferToWebStream(data: Buffer): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([data])) as ReadableStream<Uint8Array>;
}

/**
 * Sanitized base name (no extension) for naming outputs; never empty, and never
 * a path segment with a meaning of its own.
 *
 * `.` and `..` survive the character class (a dot is allowed — real filenames
 * carry them), and an upload literally named `..pdf` used to come back out as
 * `..`. Nothing escaped: every consumer joins through `safeJoin`, and the
 * storage guard refuses a traversal. But the contract here is "a name", and a
 * name that means "the parent directory" is not one — it reaches the user as a
 * download called `...pdf` and reaches the log as a path segment. Folded into
 * the same fallback the empty string already takes.
 */
export function sanitizeBaseName(name: string): string {
  const base = path.basename(name, path.extname(name));
  const cleaned = base.replace(/[^\w.-]+/g, "_").slice(0, 80);
  return cleaned.length && !/^\.+$/.test(cleaned) ? cleaned : "document";
}

/** Collects declared option values from the form (never trusts arbitrary keys). */
export function collectOptions(
  formData: FormData,
  config: ServerToolConfig,
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const field of config.options) {
    const value = formData.get(field.name);
    if (typeof value === "string") options[field.name] = value;
  }
  return options;
}

export interface SubmitToolJobInput {
  slug: string;
  config: ServerToolConfig;
  request: Request;
  /**
   * Who the resulting job row belongs to — a validated session, or this
   * visitor's own anon id. Taken as a parameter rather than resolved here (the
   * same shape `submitProcessingJob` uses) so this stays callable from a test
   * with a fake actor, and so the route owns the one cookie-reading call.
   */
  actor: JobActor;
}

export interface SubmittedToolJob {
  job: Job;
}

/**
 * Parses the multipart request, validates the upload, stages the input through
 * the M2 storage layer (uploadStream — job-scoped key + expiry), and enqueues a
 * `pdf-tool` job. Shared by the legacy synchronous route and the async
 * `/api/jobs` route so the staging + enqueue logic lives in ONE place.
 *
 * That sharing is also why authoritative admission lives here rather than in
 * either route. `/api/tools/[slug]` and `/api/jobs` both submit the same work
 * through this function; a metering call in each of them would be two copies of
 * one policy, free to disagree the day one is edited. This is the narrowest seam
 * both paths pass through, so it is the only place a legacy server tool can be
 * admitted — and there is no fifteenth per-tool call site to forget.
 *
 * The caller is responsible for rate limiting, body-size pre-check, and
 * concurrency slot acquisition (the slot must be held BEFORE this call so the
 * formData parse is bounded).
 */
export async function submitToolJob(
  input: SubmitToolJobInput,
): Promise<SubmittedToolJob> {
  const { slug, config, request, actor } = input;

  // Start the background worker (idempotent) so the job is drained.
  ensureWorkerReady();

  const jobService = appContainer.resolve<PdfToolJobService>(
    Tokens.PdfToolJobService,
  );
  const uploadService = appContainer.resolve<IUploadService>(
    Tokens.UploadService,
  );
  const metering = appContainer.resolve<UsageMeteringService>(
    Tokens.UsageMeteringService,
  );

  // A body the parser cannot read is the CLIENT's error, not ours. Without this
  // the TypeError undici throws ("Failed to parse body as FormData.") fell through
  // to the route's generic catch and became a 500 — and any filename containing a
  // raw `"` produces exactly that body. The Workspace upload routes already answer
  // 400 "Malformed multipart body." for the same input; this is the same answer on
  // the tool routes. `UploadValidationError` is what both submit routes already map
  // to 400, so no route needs to change.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    throw new UploadValidationError("Malformed multipart body.");
  }
  // `getAll` so a batch upload (multiple `file` parts) is handled in one parse.
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    throw new UploadValidationError("No file was provided.");
  }
  const options = collectOptions(formData, config);
  const expiresAt = new Date(Date.now() + TOOL_OUTPUT_TTL_MS);

  // Validate every file up front so a bad file fails before any staging.
  const uploads = await Promise.all(
    files.map((f) => validateUpload(f, config)),
  );

  // Batch admissibility is checked BEFORE metering, not after: a tool that
  // cannot batch, or a submission over the file cap, is a validation error and
  // must not take an allowance it is about to throw away. Hoisted above the
  // single-file branch for that reason alone — the checks themselves are
  // unchanged.
  if (uploads.length > 1) {
    if (!isBatchEligible(slug)) {
      throw new UploadValidationError(
        "This tool doesn't support batch processing. Please submit one file at a time.",
      );
    }
    if (uploads.length > TOOLS_BATCH_MAX_FILES) {
      throw new UploadValidationError(
        `You can batch up to ${TOOLS_BATCH_MAX_FILES} files at once.`,
      );
    }
  }

  // Admission: after validation, so the byte counts are the real ones rather
  // than a header's claim, and before any staging, so a refused submission never
  // costs a write to storage. One operation per submission — a batch of eight
  // files is one thing the user asked for, and counting it as eight would make
  // "operations" mean "files", which no plan line says.
  //
  // The actor came from the session cookie in the route. Nothing in the body can
  // name a different owner, so a client cannot charge someone else's allowance.
  const authorization = await metering.authorize({
    actor: { ownerType: actor.ownerType, ownerId: actor.ownerId },
    toolSlug: slug,
    executionMode: executionModeForSlug(slug),
    inputBytes: uploads.reduce((sum, u) => sum + u.size, 0),
    largestInputBytes: uploads.reduce((max, u) => Math.max(max, u.size), 0),
  });
  if (authorization.blocked) {
    throw new UsageLimitError(authorization.decision);
  }

  // From here the reservation is held, so every exit either hands it to the
  // worker (through the payload) or gives it back.
  const reservation = authorization.reservation;
  const releaseOnFailure = async (err: unknown): Promise<never> => {
    await metering.release(reservation);
    throw err;
  };

  // Single-file path: the original `pdf-tool` job (one input → one output).
  if (uploads.length === 1) {
    const u = uploads[0];
    const inputKey = `tool-inputs/${randomUUID()}/${sanitizeBaseName(u.originalName)}${u.ext}`;
    const { file: inputFile } = await uploadService.uploadStream({
      ownerType: "anon",
      ownerId: "anon",
      originalName: u.originalName,
      mimeType: u.mimeType,
      data: bufferToWebStream(u.buffer),
      key: inputKey,
      expiresAt,
    }).catch(releaseOnFailure);
    const job = await jobService.enqueue({
      slug,
      inputFileId: inputFile.id,
      originalName: u.originalName,
      ext: u.ext,
      baseName: sanitizeBaseName(u.originalName),
      inputSize: u.size,
      options,
      // The staged file stays owned by the shared "anon" storage bucket (its
      // reachability is governed by the job gate, not by this field). The job
      // ROW gets the real per-visitor actor — that is what `/api/jobs/[id]`
      // compares against, and a shared id there would let any visitor read any
      // job.
      ownerType: "anon",
      ownerId: "anon",
      actor,
      usage: reservationRef(reservation),
    }).catch(releaseOnFailure);
    return { job };
  }

  // Batch path: stage each input, then enqueue one `pdf-tool-batch` job whose
  // output is a streaming zip of the per-input results.
  const inputs: PdfToolBatchInput[] = [];
  for (const u of uploads) {
    const inputKey = `tool-inputs/${randomUUID()}/${sanitizeBaseName(u.originalName)}${u.ext}`;
    const { file: inputFile } = await uploadService.uploadStream({
      ownerType: "anon",
      ownerId: "anon",
      originalName: u.originalName,
      mimeType: u.mimeType,
      data: bufferToWebStream(u.buffer),
      key: inputKey,
      expiresAt,
    }).catch(releaseOnFailure);
    inputs.push({
      fileId: inputFile.id,
      originalName: u.originalName,
      ext: u.ext,
      baseName: sanitizeBaseName(u.originalName),
      size: u.size,
    });
  }

  const job = await jobService.enqueueBatch({
    slug,
    inputs,
    options,
    // Same split as the single-file path above: shared bucket for the files,
    // per-visitor actor for the row.
    ownerType: "anon",
    ownerId: "anon",
    actor,
    usage: reservationRef(reservation),
  }).catch(releaseOnFailure);
  return { job };
}

/** The reservation as the job payload carries it. Null when nothing was held. */
function reservationRef(reservation: UsageReservation | null) {
  return reservation ? { reservedAt: reservation.reservedAt.toISOString() } : null;
}

export { UploadValidationError, UsageLimitError };
export type { OptionField };
