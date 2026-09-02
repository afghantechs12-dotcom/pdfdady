import { createWriteStream, createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  JobHandler,
  JobContext,
  JobHandlerResult,
} from "@/src/application/ports/queue/Worker";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IJobScheduler } from "@/src/application/ports/queue/JobScheduler";
import type { ILogger } from "@/src/application/ports/Logger";
import type { Job } from "@/src/domain/entities/Job";
import type { StoredFileOwnerType } from "@/src/domain/entities/StoredFile";

import {
  FILE_RETENTION_JOB_TYPE,
  type PdfToolJobPayload,
  type PdfToolBatchJobPayload,
  type PdfToolJobResult,
  type PdfToolJobError,
  type ToolJobErrorType,
} from "@/src/application/services/PdfToolJobService";

import type {
  ProcessingOutcomeResult,
  UsageMeteringService,
} from "@/src/application/services/UsageMeteringService";
import type { JobErrorCategory } from "@/src/domain/jobs/jobErrors";
import { classifyFailure } from "@/src/infrastructure/processing/classifyFailure";
import { executionModeForSlug } from "@/lib/tools/executionPolicy";

import {
  getProcessor,
  ProcessingError,
  type ProcessContext,
  type ServerOutput,
} from "@/lib/server/toolProcessing";
import { CommandAbortedError, CommandError } from "@/lib/server/runCommand";
import { MissingDependencyError } from "@/lib/server/dependencyCheck";
import { createJobDir, safeJoin } from "@/lib/server/tempFiles";
import { cleanupJob } from "@/lib/server/cleanup";
import { streamZipFiles } from "@/lib/server/zip";
import {
  webStreamToNodeReadable,
  nodeReadableToWebStream,
} from "@/src/infrastructure/storage/streamBridge";

/** Resolves a slug to a processor; swappable in tests, defaults to getProcessor. */
type ProcessorResolver = (slug: string) =>
  | ((ctx: ProcessContext) => Promise<ServerOutput>)
  | undefined;

/**
 * Tool output retention: a completed job's output lives this long in storage so
 * the client can download it (sync path streams it immediately; the async path
 * fetches it later). The retention sweep purges expired outputs + inputs.
 */
export const TOOL_OUTPUT_TTL_MS = 60 * 60 * 1000; // 1 hour

/** How often the retention sweep runs (re-scheduled on each completion). */
export const RETENTION_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/** Key prefixes for ephemeral tool files (never content-addressed/shared). */
const TOOL_KEY_PREFIXES = ["tool-inputs/", "jobs/"];

/** Cancellation marker — the worker sees ctx.isCancelled() and marks the job. */
class JobCancelledError extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "JobCancelledError";
  }
}

/** Pipes a Web ReadableStream into a file path without buffering it whole. */
async function streamToFile(
  stream: ReadableStream<Uint8Array>,
  filePath: string,
): Promise<void> {
  await pipeline(webStreamToNodeReadable(stream), createWriteStream(filePath));
}

/** Returns a Web ReadableStream over a file's bytes (for uploadStream). */
function fileToWebStream(filePath: string): ReadableStream<Uint8Array> {
  return nodeReadableToWebStream(createReadStream(filePath));
}

function isToolKey(key: string): boolean {
  return TOOL_KEY_PREFIXES.some((p) => key.startsWith(p));
}

function mapErrorType(err: unknown): ToolJobErrorType {
  if (err instanceof MissingDependencyError) return "missing-dependency";
  if (err instanceof ProcessingError) return "processing";
  if (err instanceof CommandError) return "command";
  return "unexpected";
}

export interface PdfToolHandlerDeps {
  storage: IObjectStorage;
  fileMeta: IFileMetadataRepository;
  upload: IUploadService;
  jobRepo: IJobRepository;
  logger: ILogger;
  /** Override the processor resolver (tests inject a fake; default = getProcessor). */
  resolveProcessor?: ProcessorResolver;
  /** Override the cancellation poll interval (tests use a small value). */
  cancelPollMs?: number;
  /**
   * Authoritative usage metering. Optional for the same reason the pilot
   * handler's is: a worker constructed without it still processes files. A
   * metering seam that could refuse to run the work would make measurement a
   * dependency of the product, which is backwards.
   */
  metering?: UsageMeteringService;
}

/** Minimal staged-input shape needed to run a processor once. */
interface StagedInput {
  fileId: string;
  ext: string;
  baseName: string;
}

interface ProcessOnceArgs {
  slug: string;
  input: StagedInput;
  options: Record<string, string>;
  /** Parent job temp dir; the input gets its own `item-<index>` subdir so batch
   * outputs (which processors write to `ctx.jobDir` with fixed names like
   * "compressed.pdf") never collide. */
  parentJobDir: string;
  index: number;
  signal: AbortSignal;
  /** Called after the input is staged, right before the processor runs. */
  onProcessStart?: () => void | Promise<void>;
}

/**
 * Materializes one staged input from storage to a per-input temp subdir and runs
 * the processor against it — the shared "run one tool on one file" step used by
 * both the single-job and batch-job handlers (no duplicated processor logic).
 * Returns the processor's output descriptor (the output file lives in the
 * per-input subdir).
 */
async function processOnce(
  deps: PdfToolHandlerDeps,
  args: ProcessOnceArgs,
): Promise<ServerOutput> {
  const itemDir = path.join(args.parentJobDir, `item-${args.index}`);
  await mkdir(itemDir, { recursive: true });

  const inputMeta = await deps.fileMeta.get(args.input.fileId);
  if (!inputMeta) {
    throw new ProcessingError("The uploaded file is no longer available.");
  }
  const inputPath = safeJoin(itemDir, `input${args.input.ext || ""}`);
  // Stream the input from storage straight to the temp file (no buffering).
  await streamToFile(await deps.storage.getStream(inputMeta.key), inputPath);

  await args.onProcessStart?.();

  const resolveProcessor = deps.resolveProcessor ?? getProcessor;
  const processor = resolveProcessor(args.slug);
  if (!processor) {
    throw new ProcessingError("This tool does not support server processing.");
  }
  return processor({
    inputPath,
    jobDir: itemDir,
    baseName: args.input.baseName,
    options: args.options,
    signal: args.signal,
  });
}

/**
 * Streams an output file into storage (uploadStream — never buffered whole) and
 * returns the StoredFile + its key. Shared by the single handler (one output)
 * and the batch handler (the zip).
 */
async function storeOutput(
  deps: PdfToolHandlerDeps,
  jobId: string,
  ownerType: StoredFileOwnerType,
  ownerId: string,
  outputPath: string,
  downloadName: string,
  mimeType: string,
): Promise<{ fileId: string; outputKey: string; size: number }> {
  const outputKey = `jobs/${jobId}/output/${path.basename(downloadName)}`;
  const expiresAt = new Date(Date.now() + TOOL_OUTPUT_TTL_MS);
  const { file } = await deps.upload.uploadStream({
    ownerType,
    ownerId,
    originalName: downloadName,
    mimeType,
    data: fileToWebStream(outputPath),
    key: outputKey,
    expiresAt,
  });
  return { fileId: file.id, outputKey: file.key, size: file.size };
}

/**
 * Categorized-failure handling shared by both handlers (via `runToolJob`):
 * records the errorType in `job.result` (so the route can map the HTTP status
 * without re-running) and logs it. Cancellation (CommandAbortedError /
 * JobCancelledError) is left unrecorded so the worker marks the job cancelled
 * rather than failed. The caller (`runToolJob`) always rethrows `err`.
 */
async function recordFailure(
  deps: PdfToolHandlerDeps,
  jobId: string,
  slug: string,
  err: unknown,
): Promise<void> {
  if (err instanceof CommandAbortedError || err instanceof JobCancelledError) {
    return;
  }
  const errorType = mapErrorType(err);
  try {
    await deps.jobRepo.update(jobId, { result: { errorType } as PdfToolJobError });
  } catch (updateErr) {
    deps.logger.warn("Failed to record job error type", {
      jobId,
      error: String(updateErr),
    });
  }
  deps.logger.warn("Tool job failed", {
    jobId,
    slug,
    errorType,
    error: err instanceof Error ? err.message : String(err),
  });
}

interface JobEnv {
  jobDir: string;
  controller: AbortController;
}

/**
 * Input bytes for either payload shape.
 *
 * `inputSize` for a single job, the sum of the staged inputs for a batch. Read
 * off the payload rather than the result, because a failed attempt has no result
 * and its input size is exactly what a size-bucketed failure rate needs.
 */
function payloadInputBytes(payload: unknown): number | null {
  const p = payload as Partial<PdfToolJobPayload & PdfToolBatchJobPayload> | null;
  if (typeof p?.inputSize === "number") return p.inputSize;
  if (Array.isArray(p?.inputs)) {
    return p.inputs.reduce((sum, i) => sum + (typeof i?.size === "number" ? i.size : 0), 0);
  }
  return null;
}

/**
 * Settles one attempt of a legacy tool job against the authoritative meters.
 *
 * Called from `runToolJob`, which both handlers route through, so all fourteen
 * server tools are metered by one call rather than fourteen. The
 * numbers come from what actually happened — the payload's staged byte counts,
 * the result's output size, a measured duration, and `classifyFailure` for the
 * category — so nothing here is an estimate dressed as a measurement.
 *
 * Never throws. A metering failure at the end of a job whose output is already in
 * storage must not turn that job into a failed one.
 */
async function settleToolJobUsage(
  deps: PdfToolHandlerDeps,
  job: Job,
  args: {
    result: ProcessingOutcomeResult;
    outputBytes: number | null;
    durationMs: number;
    errorCategory: JobErrorCategory | null;
  },
): Promise<void> {
  if (!deps.metering) return;
  const payload = job.payload as Partial<PdfToolJobPayload> | null;
  const slug = payload?.slug ?? "unknown";
  const reservedAt = payload?.usage ? new Date(payload.usage.reservedAt) : null;
  try {
    await deps.metering.settleProcessingOutcome({
      jobId: job.id,
      // Resolved from the job ROW, which the submission stamped from the session
      // cookie. Not from the payload's StoredFile owner, which is the shared
      // "anon" bucket for every legacy job and would file all usage under one id.
      actor: {
        ownerType: job.ownerType ?? "system",
        ownerId: job.ownerId ?? "system",
      },
      toolSlug: slug,
      executionMode: executionModeForSlug(slug),
      result: args.result,
      // Stale by design on an in-place retry, and harmless: these job types are
      // enqueued with maxAttempts 1, so there is only ever one attempt to number.
      attempt: job.attempts + 1,
      // ponytail: always false, because `enqueue`/`enqueueBatch` set
      // maxAttempts: 1 — a legacy tool failure is deterministic and is never
      // retried. Derive it from `job.maxAttempts` the day that changes; a guard
      // test pins the constant so the change cannot be silent.
      willRetry: false,
      inputBytes: payloadInputBytes(job.payload),
      outputBytes: args.outputBytes,
      // Legacy processors return bytes and a name, never a page count. Reporting
      // a guess would put a fabricated number in the column the cost model is
      // meant to be calibrated against.
      pageCount: null,
      durationMs: args.durationMs,
      errorCategory: args.errorCategory,
      reservation:
        reservedAt && !Number.isNaN(reservedAt.getTime()) ? { reservedAt } : null,
    });
  } catch (err) {
    deps.logger.warn("Usage settlement failed", {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Shared job scaffolding for both the single + batch handlers: creates the temp
 * dir, wires the cancellation poller (isCancelled → abort the AbortSignal so the
 * running binary is SIGKILLed), runs the body, and on any error records the
 * categorized errorType + rethrows (so the worker marks the job failed/
 * cancelled). The temp dir is always cleaned up. Centralizing this guarantees
 * every tool-job handler wires cancellation + cleanup identically.
 */
async function runToolJob(
  deps: PdfToolHandlerDeps,
  job: Job,
  ctx: JobContext,
  body: (env: JobEnv) => Promise<JobHandlerResult>,
): Promise<JobHandlerResult> {
  const cancelPollMs = deps.cancelPollMs ?? 200;
  const jobDir = await createJobDir();
  const controller = new AbortController();
  const cancelPoller = setInterval(() => {
    if (ctx.isCancelled()) controller.abort();
  }, cancelPollMs);
  const startedAt = Date.now();
  try {
    const outcome = await body({ jobDir, controller });
    const output = outcome.result as PdfToolJobResult | undefined;
    await settleToolJobUsage(deps, job, {
      result: "success",
      outputBytes: typeof output?.resultSize === "number" ? output.resultSize : null,
      durationMs: Date.now() - startedAt,
      errorCategory: null,
    });
    return outcome;
  } catch (err) {
    const slug = (job.payload as { slug?: string })?.slug ?? "unknown";
    await recordFailure(deps, job.id, slug, err);
    // Cancellation is a distinct outcome, not a failure: the user got nothing, so
    // the allowance comes back either way, but a cancelled run must not show up in
    // the failure rate for the tool. `JobCancelledError` is this file's own marker
    // and `classifyFailure` cannot know it, so the flag is passed explicitly.
    const cancelled = ctx.isCancelled() || err instanceof JobCancelledError;
    const { category } = classifyFailure(err, { cancelled });
    await settleToolJobUsage(deps, job, {
      result: cancelled || category === "cancelled" ? "cancelled" : "failure",
      outputBytes: null,
      durationMs: Date.now() - startedAt,
      errorCategory: category,
    });
    throw err;
  } finally {
    clearInterval(cancelPoller);
    await cleanupJob(jobDir);
  }
}

/**
 * Creates the `pdf-tool` job handler — runs one processor on one staged input,
 * streams the output to storage, and records the result. Both the legacy
 * synchronous route and the async route enqueue jobs that this handler drains.
 * Progress is reported via ctx.progress; cancellation via ctx.isCancelled + the
 * AbortSignal (the running binary is SIGKILLed).
 */
export function createPdfToolHandler(deps: PdfToolHandlerDeps): JobHandler {
  return (job, ctx) =>
    runToolJob(deps, job, ctx, async ({ jobDir, controller }) => {
      const payload = job.payload as PdfToolJobPayload;

      if (ctx.isCancelled()) throw new JobCancelledError();

      await ctx.progress(5, "Preparing input");
      const output = await processOnce(deps, {
        slug: payload.slug,
        input: { fileId: payload.inputFileId, ext: payload.ext, baseName: payload.baseName },
        options: payload.options,
        parentJobDir: jobDir,
        index: 0,
        signal: controller.signal,
        onProcessStart: () => ctx.progress(15, "Processing"),
      });

      if (ctx.isCancelled()) throw new JobCancelledError();
      await ctx.progress(90, "Saving result");
      const stored = await storeOutput(
        deps,
        job.id,
        payload.ownerType,
        payload.ownerId,
        output.outputPath,
        output.downloadName,
        output.mimeType,
      );

      await ctx.progress(100, "Done");
      const result: PdfToolJobResult = {
        outputFileId: stored.fileId,
        outputKey: stored.outputKey,
        downloadName: output.downloadName,
        mimeType: output.mimeType,
        originalSize: payload.inputSize,
        resultSize: stored.size,
      };
      return { result };
    });
}

/**
 * Creates the `pdf-tool-batch` job handler — runs the same processor on each
 * staged input (in isolated per-input subdirs), then streams a zip of the
 * outputs into storage. Progress is reported per file; cancellation is checked
 * between files + via the AbortSignal during each run. The first input that
 * fails fails the whole batch (clear, actionable error); a batch never produces
 * a partial zip. The result is a `PdfToolJobResult` whose output is the zip, so
 * status/download/streaming reuse the single-job machinery.
 */
export function createPdfToolBatchHandler(deps: PdfToolHandlerDeps): JobHandler {
  return (job, ctx) =>
    runToolJob(deps, job, ctx, async ({ jobDir, controller }) => {
      const payload = job.payload as PdfToolBatchJobPayload;
      const total = payload.inputs.length;

      const outputs: ServerOutput[] = [];
      for (let i = 0; i < total; i++) {
        if (ctx.isCancelled()) throw new JobCancelledError();
        const inp = payload.inputs[i];
        const pct = Math.round((i / total) * 90); // 0..90 across files; 90+ for packaging
        await ctx.progress(
          pct,
          `Processing ${i + 1}/${total}: ${inp.originalName}`,
        );
        const output = await processOnce(deps, {
          slug: payload.slug,
          input: { fileId: inp.fileId, ext: inp.ext, baseName: inp.baseName },
          options: payload.options,
          parentJobDir: jobDir,
          index: i,
          signal: controller.signal,
        });
        outputs.push(output);
      }

      if (ctx.isCancelled()) throw new JobCancelledError();
      await ctx.progress(92, "Packaging results");
      // Stream-zip the per-input outputs (named by each processor's downloadName)
      // — never held whole in memory (see lib/server/zip.ts).
      const zipName = "processed-files.zip";
      const zipPath = await streamZipFiles(
        jobDir,
        outputs.map((o) => ({ filePath: o.outputPath, name: o.downloadName })),
        zipName,
      );

      await ctx.progress(97, "Saving result");
      const stored = await storeOutput(
        deps,
        job.id,
        payload.ownerType,
        payload.ownerId,
        zipPath,
        zipName,
        "application/zip",
      );

      await ctx.progress(100, "Done");
      const originalSize = payload.inputs.reduce((sum, x) => sum + x.size, 0);
      const result: PdfToolJobResult = {
        outputFileId: stored.fileId,
        outputKey: stored.outputKey,
        downloadName: zipName,
        mimeType: "application/zip",
        originalSize,
        resultSize: stored.size,
      };
      return { result };
    });
}

export interface FileRetentionHandlerDeps {
  storage: IObjectStorage;
  fileMeta: IFileMetadataRepository;
  scheduler: IJobScheduler;
  logger: ILogger;
}

/**
 * Creates the `file-retention` job handler: purges expired tool files (inputs +
 * outputs) from storage and metadata, then re-schedules itself. Only objects
 * under the ephemeral tool key prefixes are deleted from storage (content-
 * addressed `ca/` objects are shared and left to their own lifecycle); the
 * metadata row is always removed when expired.
 */
export function createFileRetentionHandler(
  deps: FileRetentionHandlerDeps,
): JobHandler {
  return async () => {
    let purged = 0;
    try {
      const expired = await deps.fileMeta.listExpired(new Date(), 500);
      for (const f of expired) {
        try {
          if (isToolKey(f.key)) {
            await deps.storage.delete(f.key);
          }
          await deps.fileMeta.delete(f.id);
          purged += 1;
        } catch (err) {
          deps.logger.warn("Retention: failed to purge file", {
            fileId: f.id,
            key: f.key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      // Re-schedule the next sweep so the job recurs (the scheduler is
      // one-shot; recurring jobs re-schedule on completion).
      try {
        await deps.scheduler.schedule(
          { type: FILE_RETENTION_JOB_TYPE, payload: {}, maxAttempts: 1 },
          new Date(Date.now() + RETENTION_INTERVAL_MS),
        );
      } catch (err) {
        deps.logger.warn("Retention: failed to re-schedule", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    deps.logger.debug("Retention sweep complete", { purged });
    return { result: { purged } };
  };
}
