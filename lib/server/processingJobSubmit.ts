import { randomUUID } from "node:crypto";

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type { ServerToolConfig } from "@/data/serverToolConfig";
import type { JobActor } from "@/src/application/services/jobOwnership";
import {
  ProcessingJobService,
  PROCESSING_OUTPUT_TTL_MS,
  type ProcessingInputRef,
} from "@/src/application/services/ProcessingJobService";
import type { JobView } from "@/src/application/services/ProcessingJobService";
import {
  UsageLimitError,
  UsageMeteringService,
  type UsageReservation,
} from "@/src/application/services/UsageMeteringService";
import { executionModeForSlug } from "@/lib/tools/executionPolicy";
import { ensureWorkerReady } from "@/src/infrastructure/jobs/workerBootstrap";

import { validateUpload, UploadValidationError } from "./validateUpload";
import { bufferToWebStream, collectOptions, sanitizeBaseName } from "./toolJobSubmit";

export interface SubmitProcessingJobInput {
  slug: string;
  config: ServerToolConfig;
  request: Request;
  /** Resolved server-side. Never read from the request body. */
  actor: JobActor;
}

export interface SubmittedProcessingJob {
  view: JobView;
  /** True when an existing job was returned for a repeated idempotency key. */
  deduplicated: boolean;
}

/** Max idempotency key length accepted from a client. */
const MAX_IDEMPOTENCY_KEY = 128;

/**
 * Reads the client's idempotency key, or null.
 *
 * Length- and charset-bounded because this value becomes part of a unique index
 * lookup. It is not a secret and does not need to be: keys are scoped to the
 * resolved owner, so the worst a guessed key can do is return the guesser their
 * own job.
 */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get("idempotency-key");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_IDEMPOTENCY_KEY) return null;
  return /^[\w.:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Stages a pilot tool's inputs and creates a `processing` job.
 *
 * Ordering matters and is the reason this reads the way it does:
 *
 *  1. **Validate before staging.** A file that fails validation never reaches
 *     storage, so a rejected upload leaves nothing to clean up.
 *  2. **Stage before queueing.** The job is created `created`, not `queued`, and
 *     only becomes runnable once every input is durably stored. A worker can
 *     therefore never pull a job whose inputs are half-written — the classic race
 *     in this design.
 *  3. **Return immediately after queueing.** The response carries a job id; the
 *     request does no processing. This is the whole point of the phase.
 *
 * Ownership comes from `actor`, which the caller resolved from the session cookie
 * on the server. Nothing in the request body can influence who owns the job.
 */
export async function submitProcessingJob(
  input: SubmitProcessingJobInput,
): Promise<SubmittedProcessingJob> {
  const { slug, config, request, actor } = input;

  // Idempotent; ensures a worker exists to drain the job even when no separate
  // worker process is running.
  ensureWorkerReady();

  const jobs = appContainer.resolve<ProcessingJobService>(Tokens.ProcessingJobService);
  const uploadService = appContainer.resolve<IUploadService>(Tokens.UploadService);
  const metering = appContainer.resolve<UsageMeteringService>(Tokens.UsageMeteringService);
  const idempotencyKey = readIdempotencyKey(request);

  const formData = await request.formData();
  const files = formData.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    throw new UploadValidationError("No file was provided.");
  }
  if (files.length > 1) {
    // The pilot is single-input. Say so rather than silently processing the first
    // file and returning a result the user will not recognise.
    throw new UploadValidationError("Please submit one file at a time.");
  }
  const options = collectOptions(formData, config);

  const validated = await validateUpload(files[0], config);
  // The staged input shares the job's retention window, so a job's inputs and its
  // output age out together rather than leaving orphaned inputs behind.
  // `ProcessingJobService` is the authority on the window itself; this only
  // reuses the same constant.
  const expiresAt = new Date(Date.now() + PROCESSING_OUTPUT_TTL_MS);

  // A random path segment, not the filename and not a counter: an input key is a
  // capability in a shared bucket, so it must not be guessable from anything the
  // user can see. The sanitized base name is appended only for operator
  // legibility.
  const inputKey = `processing-inputs/${randomUUID()}/${sanitizeBaseName(
    validated.originalName,
  )}${validated.ext}`;

  // Admission goes here and nowhere else: after validation, so the byte count is
  // real rather than a header's claim, and before the upload, so a refused
  // submission never costs us a write to storage. The actor was resolved from the
  // session cookie by the caller — a body that claims a different owner is
  // charging its own allowance, not someone else's.
  const authorization = await metering.authorize({
    actor: { ownerType: actor.ownerType, ownerId: actor.ownerId },
    toolSlug: slug,
    executionMode: executionModeForSlug(slug),
    inputBytes: validated.size,
    largestInputBytes: validated.size,
  });
  if (authorization.blocked) {
    throw new UsageLimitError(authorization.decision);
  }

  // From here on the reservation is held, so every path out has to either settle
  // it or hand it to the worker. `releaseOnFailure` covers the paths that end
  // here; the worker covers the one that does not.
  const reservation = authorization.reservation;
  const releaseOnFailure = async (err: unknown): Promise<never> => {
    await metering.release(reservation);
    throw err;
  };

  const { file: staged } = await uploadService.uploadStream({
    ownerType: actor.ownerType === "user" ? "user" : "anon",
    ownerId: actor.ownerId,
    originalName: validated.originalName,
    mimeType: validated.mimeType,
    data: bufferToWebStream(validated.buffer),
    key: inputKey,
    expiresAt,
  }).catch(releaseOnFailure);

  const inputs: ProcessingInputRef[] = [
    {
      key: staged.key,
      displayName: validated.originalName,
      bytes: validated.size,
    },
  ];

  const { job, deduplicated } = await jobs
    .createJob({
      actor,
      toolSlug: slug,
      inputs,
      options,
      idempotencyKey,
      usage: reservationRef(reservation),
    })
    .catch(releaseOnFailure);

  if (deduplicated) {
    // A replayed key returns the original job untouched — re-queueing it would
    // run the tool twice, which is exactly what the key exists to prevent. The
    // original submission already paid for that run, so this attempt's
    // reservation is released: charging a retrying client twice for one
    // operation is the bug idempotency exists to prevent, and it applies to the
    // allowance as much as to the work.
    await metering.release(reservation);
    return { view: jobs.toView(job), deduplicated };
  }

  // Deliberately NOT `.catch(releaseOnFailure)`. A queue handoff that fails rolls
  // the row back to `failed`/`internal_error` — a *retryable* state, reachable by
  // the client replaying this key and pressing Retry — so the job may still run,
  // and the debit has to stay with it. Releasing here would leave the payload
  // claiming a reservation that had already been refunded, and the eventual
  // terminal settlement would refund it a second time: `release` and
  // `settleProcessingOutcome` apply their deltas independently, and only the
  // latter is guarded by the once-per-job settlement claim. That mints allowance,
  // which is the one direction this must never fail in.
  const finalJob = await jobs.queueJob(job.id);
  return { view: jobs.toView(finalJob), deduplicated };
}

/** The reservation as the job payload carries it. Null when nothing was held. */
function reservationRef(reservation: UsageReservation | null) {
  return reservation ? { reservedAt: reservation.reservedAt.toISOString() } : null;
}

export { UploadValidationError, UsageLimitError };
