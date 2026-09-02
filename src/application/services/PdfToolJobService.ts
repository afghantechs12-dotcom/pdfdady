import type { Job, JobStatus } from "@/src/domain/entities/Job";
import { TERMINAL_JOB_STATUSES } from "@/src/domain/entities/Job";
import type { StoredFileOwnerType } from "@/src/domain/entities/StoredFile";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import type { ToolJobErrorType } from "@/lib/tools/jobError";
import type { JobActor } from "@/src/application/services/jobOwnership";
import type { ProcessingUsageReservationRef } from "@/src/application/services/ProcessingJobService";

/**
 * Application service that drives server-side PDF tools through the M2 queue.
 *
 * The route stores the input via IUploadService, then calls `enqueue` to place a
 * `pdf-tool` job on the queue. The worker handler (infrastructure) is the SINGLE
 * place a processor is invoked — both the legacy synchronous route (which awaits
 * the job) and the async route (which returns the jobId immediately) go through
 * this service, so there is no duplicated processor logic.
 *
 * Progress is streamed out-of-band via IJobEvents (the SSE route subscribes);
 * cancellation is delegated to IWorker.cancel, which the handler observes via
 * JobContext.isCancelled + the processor's AbortSignal.
 */

/** The job type identifier registered on the worker. */
export const PDF_TOOL_JOB_TYPE = "pdf-tool";

/** Batch job type: runs one tool across many inputs, zips the outputs. */
export const PDF_TOOL_BATCH_JOB_TYPE = "pdf-tool-batch";

/** The file-retention sweep job type (purges expired tool outputs). */
export const FILE_RETENTION_JOB_TYPE = "file-retention";

/**
 * Error category the handler records on a failed job (in `job.result`) so the
 * route can map it back to the right HTTP status without re-running the work.
 * Validation errors are handled in the route BEFORE enqueue, so they never
 * reach the handler. The type + its user-facing message live in
 * `@/lib/tools/jobError` (shared with the client); re-exported here so existing
 * imports from this service keep working.
 */
export type { ToolJobErrorType } from "@/lib/tools/jobError";

/** Payload enqueued for a `pdf-tool` job. The input is already in storage. */
export interface PdfToolJobPayload {
  slug: string;
  /** StoredFile id of the staged input (handler resolves it → storage key). */
  inputFileId: string;
  originalName: string;
  /** Input extension incl. dot (e.g. ".pdf") — for the temp input filename. */
  ext: string;
  /** Sanitized base name (no extension) used to name the output download. */
  baseName: string;
  inputSize: number;
  options: Record<string, string>;
  ownerType: StoredFileOwnerType;
  ownerId: string;
  /**
   * The allowance this job is holding, carried to the worker so the settlement
   * refunds into the window it was debited from. Same shape and same reasoning as
   * the pilot pipeline's — reused rather than re-declared so a legacy job and a
   * pipeline job cannot drift into two different representations of one fact.
   *
   * Absent when nothing was reserved: a metering read that failed open. The
   * worker then settles the attempt and charges the compute, but refunds nothing.
   */
  usage?: ProcessingUsageReservationRef | null;
}

/** Result recorded on a completed `pdf-tool` job. */
export interface PdfToolJobResult {
  outputFileId: string;
  outputKey: string;
  downloadName: string;
  mimeType: string;
  originalSize: number;
  resultSize: number;
}

/** Recorded in `job.result` on a failed job so the route can map the status. */
export interface PdfToolJobError {
  errorType: ToolJobErrorType;
}

export interface EnqueueToolJobInput {
  slug: string;
  inputFileId: string;
  originalName: string;
  ext: string;
  baseName: string;
  inputSize: number;
  options: Record<string, string>;
  /**
   * Owns the staged *file* (StoredFile) — a different, narrower union than the
   * job owner. Kept for the handler/storage layer; unrelated to who may address
   * the job over HTTP.
   */
  ownerType: StoredFileOwnerType;
  ownerId: string;
  /**
   * Owns the *job row* — the identity an ownership check on `/api/jobs/[id]`
   * compares against. Resolved server-side from the session/anon cookie.
   */
  actor: JobActor;
  /** The held allowance, or null when admission reserved nothing. */
  usage?: ProcessingUsageReservationRef | null;
}

/** One staged input within a batch job. */
export interface PdfToolBatchInput {
  /** StoredFile id of the staged input (handler resolves it → storage key). */
  fileId: string;
  originalName: string;
  ext: string;
  /** Sanitized base name (no extension) used to name this input's output. */
  baseName: string;
  size: number;
}

/** Payload enqueued for a `pdf-tool-batch` job. Inputs are already in storage. */
export interface PdfToolBatchJobPayload {
  slug: string;
  inputs: PdfToolBatchInput[];
  options: Record<string, string>;
  ownerType: StoredFileOwnerType;
  ownerId: string;
  /** See `PdfToolJobPayload.usage`. One reservation covers the whole batch. */
  usage?: ProcessingUsageReservationRef | null;
}

export interface EnqueueToolBatchJobInput {
  slug: string;
  inputs: PdfToolBatchInput[];
  options: Record<string, string>;
  ownerType: StoredFileOwnerType;
  ownerId: string;
  /** Owns the job row — see `EnqueueToolJobInput.actor`. */
  actor: JobActor;
  /** The held allowance, or null when admission reserved nothing. */
  usage?: ProcessingUsageReservationRef | null;
}

/** A flattened, serializable view of a job for API responses / polling. */
export interface ToolJobStatus {
  id: string;
  status: JobStatus;
  /** Latest progress (null when the job hasn't reported any). */
  progress: { pct: number; detail?: string } | null;
  /** Present only when status === "completed". */
  result: PdfToolJobResult | null;
  /** Human-readable error message (present when status === "failed"). */
  error: string | null;
  /** Error category (present when status === "failed"). */
  errorType: ToolJobErrorType | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toStatus(
  job: Job,
  progress: { pct: number; detail?: string } | null,
): ToolJobStatus {
  let result: PdfToolJobResult | null = null;
  let errorType: ToolJobErrorType | null = null;
  if (job.status === "completed" && job.result) {
    result = job.result as PdfToolJobResult;
  } else if (job.status === "failed" && job.result) {
    const err = job.result as Partial<PdfToolJobError> | null;
    errorType = err?.errorType ?? "unexpected";
  }
  return {
    id: job.id,
    status: job.status,
    progress,
    result,
    error: job.error,
    errorType,
  };
}

export class PdfToolJobService {
  /** Tracks the most recent progress event per job (best-effort, in-process). */
  private readonly latestProgress = new Map<
    string,
    { pct: number; detail?: string }
  >;

  constructor(
    private readonly queue: IQueue,
    private readonly jobRepo: IJobRepository,
    private readonly worker: IWorker,
  ) {}

  /** Records a progress event for a job (called from the SSE route's subscription). */
  recordProgress(jobId: string, pct: number, detail?: string): void {
    this.latestProgress.set(jobId, { pct, detail });
  }

  async enqueue(input: EnqueueToolJobInput): Promise<Job> {
    const payload: PdfToolJobPayload = {
      slug: input.slug,
      inputFileId: input.inputFileId,
      originalName: input.originalName,
      ext: input.ext,
      baseName: input.baseName,
      inputSize: input.inputSize,
      options: input.options,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      usage: input.usage ?? null,
    };
    // maxAttempts = 1: tool failures (corrupt file, missing binary) are not
    // transient — retrying would just re-run an expensive conversion for the
    // same result. A failed job goes straight to the dead-letter (failed status).
    return this.queue.enqueue({
      type: PDF_TOOL_JOB_TYPE,
      payload,
      maxAttempts: 1,
      // The actor owns the ROW, which is what `/api/jobs/[id]` checks. Distinct
      // from the payload's StoredFile owner above: that scopes the file for the
      // handler, and an ownership check has never been able to read it.
      ownerType: input.actor.ownerType,
      ownerId: input.actor.ownerId,
      workspaceId: input.actor.workspaceId ?? null,
      toolSlug: input.slug,
    });
  }

  /**
   * Enqueues a batch job: one tool run per staged input, outputs zipped into a
   * single archive. Same maxAttempts=1 rationale as `enqueue`. The result is a
   * `PdfToolJobResult` whose output is the zip (so status/download/streaming
   * reuse the single-job machinery — only the job type differs).
   */
  async enqueueBatch(input: EnqueueToolBatchJobInput): Promise<Job> {
    const payload: PdfToolBatchJobPayload = {
      slug: input.slug,
      inputs: input.inputs,
      options: input.options,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      usage: input.usage ?? null,
    };
    return this.queue.enqueue({
      type: PDF_TOOL_BATCH_JOB_TYPE,
      payload,
      maxAttempts: 1,
      // Same reasoning as `enqueue` — a batch is addressed by id exactly like a
      // single job, so it needs the same row-level owner.
      ownerType: input.actor.ownerType,
      ownerId: input.actor.ownerId,
      workspaceId: input.actor.workspaceId ?? null,
      toolSlug: input.slug,
    });
  }

  async getStatus(jobId: string): Promise<ToolJobStatus | null> {
    const job = await this.jobRepo.get(jobId);
    if (!job) return null;
    const progress = this.latestProgress.get(jobId) ?? null;
    if (TERMINAL_JOB_STATUSES.has(job.status)) this.latestProgress.delete(jobId);
    return toStatus(job, progress);
  }

  /**
   * Polls the job repository until the job reaches a terminal state or the
   * timeout elapses. The robust, provider-agnostic way to wait (works whether
   * the worker is in-process or a separate process against a shared DB). Returns
   * the terminal status, or the last-seen non-terminal status on timeout.
   */
  async awaitCompletion(
    jobId: string,
    timeoutMs = 390_000,
    pollMs = 250,
  ): Promise<ToolJobStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: ToolJobStatus | null = null;
    while (Date.now() < deadline) {
      const status = await this.getStatus(jobId);
      if (!status) throw new Error(`Job ${jobId} not found`);
      last = status;
      if (TERMINAL_JOB_STATUSES.has(status.status)) return status;
      await sleep(pollMs);
    }
    // Timed out without reaching a terminal state — return the last snapshot.
    return last ?? (await this.getStatus(jobId))!;
  }

  /** Best-effort cancellation of a running job (the handler checks isCancelled). */
  async cancel(jobId: string): Promise<void> {
    await this.worker.cancel(jobId);
  }
}
