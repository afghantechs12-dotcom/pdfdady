import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

import type { Job } from "@/src/domain/entities/Job";
import type { JobContext, JobHandler, JobHandlerResult } from "@/src/application/ports/queue/Worker";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IUploadService } from "@/src/application/ports/storage/UploadService";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IToolProcessorRegistry } from "@/src/application/ports/processing/ToolProcessor";
import {
  ProcessingJobService,
  type ProcessingJobPayload,
  type ProcessingJobResult,
} from "@/src/application/services/ProcessingJobService";
import { ProcessingUsageRecorder } from "@/src/application/services/ProcessingUsageRecorder";
import type {
  ProcessingOutcomeResult,
  UsageMeteringService,
} from "@/src/application/services/UsageMeteringService";
import { classifyFailure } from "@/src/infrastructure/processing/classifyFailure";
import { isRetryableCategory, type JobErrorCategory } from "@/src/domain/jobs/jobErrors";
import { PROGRESS_STAGE_COPY, type JobProgressStage } from "@/src/domain/jobs/progressStage";
import {
  createProcessingWorkDir,
  removeProcessingWorkDir,
  safeJoin,
} from "@/lib/server/tempFiles";
import { baseNameOf } from "@/lib/workflow/fileNames";

/** How often the handler checks whether cancellation has been requested. */
const CANCEL_POLL_MS = 200;

export interface ProcessingJobHandlerDeps {
  storage: IObjectStorage;
  upload: IUploadService;
  jobs: ProcessingJobService;
  processors: IToolProcessorRegistry;
  usage: ProcessingUsageRecorder;
  /**
   * Settles the allowance the submission reserved. Optional: a handler built
   * without it still processes jobs correctly and simply records no usage, which
   * is what the fail-open rule requires of every metering seam.
   */
  metering?: UsageMeteringService;
  logger: ILogger;
  /** Overridable for tests so cancellation is observed without real waiting. */
  cancelPollMs?: number;
  now?: () => number;
}

/** Marks an abort caused by the execution ceiling rather than by a user. */
class TimeoutAbortError extends Error {
  constructor(ms: number) {
    super(`Processing exceeded its ${ms}ms ceiling.`);
    this.name = "TimeoutAbortError";
  }
}

/**
 * The unified processing handler.
 *
 * It owns the whole outcome of a job: it classifies its own failure, decides
 * whether another attempt is warranted, and writes the terminal status through
 * `ProcessingJobService`. It returns `{ terminal: true }` so the generic worker
 * does not then overwrite that with a blind `completed`.
 *
 * Four properties are enforced here and are the reason the code is shaped the
 * way it is:
 *
 *  - **Cleanup always happens.** The work directory is removed in `finally`, on
 *    every path: success, failure, cancellation, timeout, and an exception in
 *    the cleanup of a previous step.
 *  - **The ceiling is real.** A processor is given an `AbortSignal` that fires
 *    at its own `timeoutMs`, and `runCommand` turns that into SIGKILL. A hung
 *    Ghostscript cannot hold a worker slot indefinitely.
 *  - **No partial output is ever published.** The output is only uploaded after
 *    the processor resolves; a timeout or cancellation aborts before that, and a
 *    cancellation detected *after* upload deletes the object again.
 *  - **Cancellation wins.** `completeJob` goes through the state machine, so if
 *    the user cancelled while the processor was finishing, publication is
 *    refused and the produced bytes are deleted rather than served.
 */
export function createProcessingJobHandler(deps: ProcessingJobHandlerDeps): JobHandler {
  const cancelPollMs = deps.cancelPollMs ?? CANCEL_POLL_MS;
  const now = deps.now ?? (() => Date.now());

  return async function handleProcessingJob(
    job: Job,
    ctx: JobContext,
  ): Promise<JobHandlerResult> {
    const payload = job.payload as ProcessingJobPayload;
    const attempt = job.attempts + 1;
    const startedAtMs = now();

    // Reported stages, not invented numbers. `pct` exists because the SSE
    // contract has the field; it is derived from the stage, so it can never
    // claim a granularity the worker does not have.
    //
    // Stage writes are deliberately not awaited by the caller: reporting progress
    // must never slow the work down, and a failed status write must never fail
    // the job. They are, however, chained to each other, so they APPLY in the
    // order they were reported and awaiting the last one has awaited them all.
    // A bare `void` per write would let two of them land out of order and leave
    // the job describing an earlier stage than it had reached.
    let stageWrites: Promise<void> = Promise.resolve();
    const reportStage = (stage: JobProgressStage) => {
      const copy = PROGRESS_STAGE_COPY[stage];
      stageWrites = stageWrites
        .then(() => deps.jobs.recordStage(job.id, stage, attempt))
        .catch(() => {});
      void ctx.progress(Math.round(copy.fraction * 100), stage).catch(() => {});
    };

    let workDir: string | null = null;
    let uploadedKey: string | null = null;
    let timedOut = false;
    let ceilingMs = 0;

    const controller = new AbortController();
    const timeoutHandle: { timer?: ReturnType<typeof setTimeout> } = {};
    const cancelPoll = setInterval(() => {
      if (ctx.isCancelled() && !controller.signal.aborted) controller.abort();
    }, cancelPollMs);

    try {
      const processor = deps.processors.require(payload.toolSlug);

      ceilingMs = processor.timeoutMs;
      timeoutHandle.timer = setTimeout(() => {
        timedOut = true;
        if (!controller.signal.aborted) controller.abort();
      }, processor.timeoutMs);

      reportStage("preparing");

      // Refuse before doing any work if cancellation already landed while the
      // job sat in the queue.
      if (ctx.isCancelled()) throw new Error("Cancelled before processing began.");

      const inputPaths: string[] = [];
      if (!workDir) workDir = await createProcessingWorkDir(job.id);
      for (const [index, input] of payload.inputs.entries()) {
        // `displayName` came from a browser. It is used to derive a *name*, and
        // `safeJoin` strips every directory component before it touches the
        // filesystem, so no upload can write outside this job's directory. The
        // index prefix additionally makes collisions between two files called
        // "document.pdf" impossible.
        const target = safeJoin(workDir, `${index}-${input.displayName}`);
        await materializeToDisk(deps.storage, input.key, target);
        inputPaths.push(target);
      }

      const [primary, ...additional] = inputPaths;
      if (!primary) throw new Error("No input was materialized for this job.");

      const outcome = await processor.process({
        inputPath: primary,
        additionalInputPaths: additional,
        workDir,
        baseName: baseNameFor(payload.inputs[0]?.displayName ?? "document"),
        options: payload.options,
        signal: controller.signal,
        reportStage,
      });

      // Between the processor resolving and the upload starting is the last
      // moment cancellation can save the work of storing bytes nobody will get.
      if (ctx.isCancelled()) throw new Error("Cancelled before the result was stored.");

      reportStage("finalizing");

      const outputStat = await stat(outcome.outputPath);
      const key = `jobs/${job.id}/output/${path.basename(outcome.downloadName)}`;
      const stored = await deps.upload.uploadStream({
        ownerType: job.ownerType === "user" ? "user" : "anon",
        ownerId: job.ownerId ?? "anon",
        originalName: outcome.downloadName,
        mimeType: outcome.mimeType,
        data: fileAsWebStream(outcome.outputPath),
        key,
        expiresAt: job.expiresAt,
      });
      uploadedKey = stored.file.key;

      const result: ProcessingJobResult = {
        output: {
          key: stored.file.key,
          fileId: stored.file.id,
          downloadName: outcome.downloadName,
          mimeType: outcome.mimeType,
          bytes: outputStat.size,
        },
        ...(outcome.pageCount !== undefined ? { pageCount: outcome.pageCount } : {}),
      };

      // Drain the stage writes before completing. `completeJob` writes `done`,
      // and an in-flight `finalizing` update that lands afterwards overwrites it
      // — producing a `completed` row whose stage still reads `finalizing`, so
      // the progress stream's final frame describes a finished job as still
      // working. That is not hypothetical: it is what the row from the first
      // browser run of this pipeline recorded.
      //
      // Draining here rather than at every `reportStage` keeps intermediate
      // reporting off the critical path. Completion is the only other writer of
      // the stage, so the terminal boundary is the only place the ordering
      // matters.
      await stageWrites;

      const published = await deps.jobs.completeJob(job.id, result, attempt);
      if (!published) {
        // The write was refused. Delete the object we just wrote either way: an
        // unreferenced output is a privacy problem as well as a storage leak, and
        // publishing it would break the promise that a cancelled job yields no
        // result.
        await deps.storage.delete(uploadedKey).catch(() => {});
        uploadedKey = null;
        deps.logger.info("Processing result discarded; job no longer publishable", {
          jobId: job.id,
          toolSlug: payload.toolSlug,
        });
        // Which refusal it was decides what this attempt still owes. Superseded
        // means the stuck-job sweep recovered this attempt and another worker owns
        // the job now: that worker records its own outcome, and this one recording
        // "cancelled" would double-count the attempt and refund a job that is at
        // that moment still running. Any other refusal is the designed case — the
        // user cancelled while we were finishing — where this attempt is still the
        // job's authority and its allowance has to come back.
        if (!(await deps.jobs.ownsAttempt(job.id, attempt))) {
          logSuperseded(deps, job, attempt, "completion");
          return { terminal: true };
        }
        deps.usage.record({
          toolSlug: payload.toolSlug,
          executionMode: "remote_job",
          jobId: job.id,
          ownerType: job.ownerType,
          result: "cancelled",
          attempt,
          inputBytes: job.inputBytes,
          outputBytes: null,
          durationMs: now() - startedAtMs,
          errorCategory: "cancelled",
          pageCount: null,
        });
        await settleUsage(deps, job, payload, {
          result: "cancelled",
          attempt,
          willRetry: false,
          outputBytes: null,
          pageCount: null,
          durationMs: now() - startedAtMs,
          errorCategory: "cancelled",
        });
        return { terminal: true };
      }

      reportStage("done");
      deps.usage.record({
        toolSlug: payload.toolSlug,
        executionMode: "remote_job",
        jobId: job.id,
        ownerType: job.ownerType,
        result: "success",
        attempt,
        inputBytes: job.inputBytes,
        outputBytes: outputStat.size,
        durationMs: now() - startedAtMs,
        errorCategory: null,
        pageCount: outcome.pageCount ?? null,
      });
      await settleUsage(deps, job, payload, {
        result: "success",
        attempt,
        willRetry: false,
        outputBytes: outputStat.size,
        pageCount: outcome.pageCount ?? null,
        durationMs: now() - startedAtMs,
        errorCategory: null,
      });
      return { result, terminal: true };
    } catch (err) {
      const cancelled = ctx.isCancelled();
      const classified = classifyFailure(
        timedOut ? new TimeoutAbortError(ceilingMs) : err,
        { cancelled, timedOut },
      );

      // A partial or orphaned output must never survive a failed attempt.
      // Nothing after this point reads `uploadedKey` — the `finally` below only
      // touches the work directory — so there is deliberately no reset here,
      // unlike the cancellation branch above where a throw in the usage record
      // would fall through to this handler and need an accurate value.
      if (uploadedKey) await deps.storage.delete(uploadedKey).catch(() => {});

      const { willRetry, superseded } = await recordFailure({
        deps,
        job,
        attempt,
        toolSlug: payload.toolSlug,
        category: classified.category,
        diagnostic: classified.diagnostic,
        durationMs: now() - startedAtMs,
        cancelled,
      });
      // Settled AFTER the retry decision, and from its actual outcome rather
      // than from the intent: a retry that could not be scheduled leaves the job
      // permanently failed, so the allowance has to come back. Deciding this
      // before calling `retryJob` would charge the user for work that never ran
      // again. A superseded attempt settles nothing at all: it is not this job's
      // outcome, and the worker that owns the job now will settle its own.
      if (superseded) return { terminal: true };
      await settleUsage(deps, job, payload, {
        result: cancelled || classified.category === "cancelled" ? "cancelled" : "failure",
        attempt,
        willRetry,
        outputBytes: null,
        pageCount: null,
        durationMs: now() - startedAtMs,
        errorCategory: classified.category,
      });
      return { terminal: true };
    } finally {
      clearInterval(cancelPoll);
      if (timeoutHandle.timer) clearTimeout(timeoutHandle.timer);
      // Unconditional. This is the only place user bytes on local disk are
      // removed, so it must run for every exit path — including one where the
      // failure bookkeeping above itself threw.
      await removeProcessingWorkDir(workDir);
    }
  };
}

interface RecordFailureArgs {
  deps: ProcessingJobHandlerDeps;
  job: Job;
  attempt: number;
  toolSlug: string;
  category: JobErrorCategory;
  diagnostic: string;
  durationMs: number;
  cancelled: boolean;
}

/**
 * Writes the outcome of a failed attempt and decides whether to try again.
 *
 * The retry decision has three independent gates, and all three must pass:
 * the failure class must be one where another attempt could differ, the attempt
 * budget must not be spent, and the user must not have cancelled. Retrying a
 * corrupt document would waste a Ghostscript run and tell the user "processing
 * failed" three times for one deterministic cause.
 *
 * Every attempt is recorded — a usage event per attempt, with its attempt number
 * — so a job that eventually succeeds on attempt 2 does not hide the fact that
 * attempt 1 failed.
 */
async function recordFailure(
  args: RecordFailureArgs,
): Promise<{ willRetry: boolean; superseded: boolean }> {
  const { deps, job, attempt, toolSlug, category, diagnostic, durationMs, cancelled } = args;

  // Nothing at all if this attempt was recovered out from under us. Not just the
  // status write: a superseded attempt that recorded its failure would also
  // double-count the attempt the sweep already recorded, and its `retryJob` would
  // be refused — which this function reads as "permanently failed" and settles by
  // refunding a job another worker is at that moment running to completion.
  //
  // Checked up front rather than inferred from the write's refusal because this
  // path has two writes and a queue push, and the honest answer to "am I still
  // this job's worker" is the same for all three.
  if (!(await deps.jobs.ownsAttempt(job.id, attempt))) {
    logSuperseded(deps, job, attempt, "failure");
    return { willRetry: false, superseded: true };
  }

  deps.usage.record({
    toolSlug,
    executionMode: "remote_job",
    jobId: job.id,
    ownerType: job.ownerType,
    result: cancelled || category === "cancelled" ? "cancelled" : "failure",
    attempt,
    inputBytes: job.inputBytes,
    outputBytes: null,
    durationMs,
    errorCategory: category,
    pageCount: null,
  });

  // Safe diagnostic context, logged separately from anything the user sees. No
  // filename, no storage key, no document content — the tool, the class of
  // failure, and the internal message, which is enough to investigate.
  deps.logger.warn("Processing attempt failed", {
    jobId: job.id,
    toolSlug,
    attempt,
    category,
    diagnostic,
  });

  if (category === "cancelled" || cancelled) {
    await deps.jobs.markCancelled(job.id, attempt);
    return { willRetry: false, superseded: false };
  }

  const canRetry = isRetryableCategory(category) && attempt < job.maxAttempts;
  if (canRetry) {
    // Record the attempt, then hand the job back to the queue as a fresh
    // attempt. Going through `failJob` first (rather than transitioning
    // straight back to `queued`) keeps the failure visible: a user watching the
    // job sees that an attempt failed, not an unexplained pause.
    await deps.jobs.failJob(job.id, category, diagnostic, attempt);
    const scheduled = await deps.jobs
      .retryJob(job.id, {
        ownerType: job.ownerType ?? "system",
        ownerId: job.ownerId ?? "system",
        workspaceId: job.workspaceId,
      })
      .then(() => true)
      .catch((err) => {
        // The job stays `failed` and the user's Retry button still works. An
        // automatic retry failing to schedule must not erase the recorded
        // failure.
        deps.logger.warn("Automatic retry could not be scheduled", {
          jobId: job.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      });
    return { willRetry: scheduled, superseded: false };
  }

  await deps.jobs.failJob(job.id, category, diagnostic, attempt);
  return { willRetry: false, superseded: false };
}

/**
 * The one log line a superseded attempt leaves behind.
 *
 * Sanitized like every other line here — job id, tool, attempt, and which write
 * was dropped. It is the only visible trace of the race, and it says "superseded"
 * rather than "failed" on purpose: the job itself is fine, and whoever reads this
 * must not go looking for a broken one.
 */
function logSuperseded(
  deps: ProcessingJobHandlerDeps,
  job: Job,
  attempt: number,
  write: "completion" | "failure",
): void {
  deps.logger.warn("Superseded attempt wrote nothing", {
    jobId: job.id,
    toolSlug: job.toolSlug,
    attempt,
    write,
  });
}

interface SettleUsageArgs {
  result: ProcessingOutcomeResult;
  attempt: number;
  willRetry: boolean;
  outputBytes: number | null;
  pageCount: number | null;
  durationMs: number;
  errorCategory: JobErrorCategory | null;
}

/**
 * Hands one attempt's outcome to the metering service.
 *
 * Never throws and never awaits anything the user is waiting on: a metering
 * failure at the end of a successful job must not turn that job into a failed
 * one. The reservation comes from the job payload, which the submission wrote —
 * so a job created before this seam existed, or one that failed open at
 * admission, settles with `reservation: null` and is charged nothing back.
 */
async function settleUsage(
  deps: ProcessingJobHandlerDeps,
  job: Job,
  payload: ProcessingJobPayload,
  args: SettleUsageArgs,
): Promise<void> {
  if (!deps.metering) return;
  const reservedAt = payload.usage ? new Date(payload.usage.reservedAt) : null;
  try {
    await deps.metering.settleProcessingOutcome({
      jobId: job.id,
      actor: {
        ownerType: job.ownerType ?? "system",
        ownerId: job.ownerId ?? "system",
      },
      toolSlug: payload.toolSlug,
      executionMode: "remote_job",
      result: args.result,
      attempt: args.attempt,
      willRetry: args.willRetry,
      inputBytes: job.inputBytes,
      outputBytes: args.outputBytes,
      pageCount: args.pageCount,
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
 * Extension-less, sanitized base name for output naming. Never a path.
 *
 * Delegates to the shared filename policy so a server output is named by the same
 * rules as a browser one — including dropping a download-folder `(1)` marker,
 * which the previous `[^\w.-]` substitution turned into `_1_` and carried into
 * every name derived from a re-uploaded download.
 */
function baseNameFor(displayName: string): string {
  return baseNameOf(path.basename(displayName)) || "document";
}

/** Streams an object from storage onto local disk without buffering it. */
async function materializeToDisk(
  storage: IObjectStorage,
  key: string,
  targetPath: string,
): Promise<void> {
  const web = await storage.getStream(key);
  await pipeline(
    Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(targetPath),
  );
}

/**
 * Opens a local file as a Web ReadableStream for the streaming upload path.
 *
 * Streamed rather than read into a Buffer because the output of a compression
 * job can be tens of megabytes, and a worker holding several of those in memory
 * at once is how a worker process dies.
 */
function fileAsWebStream(filePath: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
}
