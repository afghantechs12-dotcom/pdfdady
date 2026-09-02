import type { Job, JobStatus } from "@/src/domain/entities/Job";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IWorker } from "@/src/application/ports/queue/Worker";
import type { ILogger } from "@/src/application/ports/Logger";
import {
  isTerminal,
  canPublishResult,
  InvalidJobTransitionError,
} from "@/src/domain/jobs/jobStateMachine";
import {
  isRetryableCategory,
  safeMessageFor,
  toJobErrorCategory,
  type JobErrorCategory,
} from "@/src/domain/jobs/jobErrors";
import type { JobProgressStage } from "@/src/domain/jobs/progressStage";
import { assertRemoteJobTool } from "@/lib/tools/executionPolicy";
import {
  assertActorOwnsJob,
  JobAuthorizationError,
  type JobActor,
} from "./jobOwnership";
import { deliverQueuedJob, type QueueHandoffDeps } from "./queueHandoff";

/**
 * The queue type for every tool processing job created by this service.
 *
 * Distinct from the legacy `pdf-tool` type so both can coexist during the
 * pilot rollout: the feature flag decides which type a submission creates, and
 * a rollback does not have to reinterpret rows written by the new path.
 */
export const PROCESSING_JOB_TYPE = "processing";

/** How long a completed output (and its staged input) stays retrievable. */
export const PROCESSING_OUTPUT_TTL_MS = 60 * 60 * 1000;

/**
 * Total attempts a processing job may consume, including the first.
 *
 * Bounded, and bounded low. An unbounded (or generous) retry budget on work that
 * costs a Ghostscript process is a self-inflicted denial of service, and most
 * failures here are deterministic — see `isRetryableCategory`, which stops
 * "corrupt PDF" from being retried at all.
 */
export const MAX_PROCESSING_ATTEMPTS = 3;

/** Internal diagnostic written to a row whose queue handoff failed. Never shown. */
const HANDOFF_DIAGNOSTIC =
  "The queue would not accept this job, so it was not started.";

/** A staged input, by reference. Bytes live in object storage, never in the row. */
export interface ProcessingInputRef {
  /** Object storage key. */
  key: string;
  /**
   * Sanitized name used only to name the output file. Never used as a path
   * component and never trusted — see `sanitizeBaseName` at the staging site.
   */
  displayName: string;
  bytes: number;
}

/**
 * The usage reservation a submission is holding, carried to the worker.
 *
 * Present only when an allowance was actually taken — a local tool, or a
 * metering read that failed open, leaves it absent, and the worker must then
 * settle nothing. Refunding a debit that never happened would mint allowance.
 *
 * `reservedAt` is an ISO string because this payload round-trips through JSON,
 * and it is the *reservation's* instant rather than the settlement's: a job
 * submitted at 23:59 UTC and refunded at 00:01 has to credit back the window it
 * debited, or yesterday stays over-counted forever and today is silently
 * inflated.
 */
export interface ProcessingUsageReservationRef {
  reservedAt: string;
}

export interface ProcessingJobPayload {
  toolSlug: string;
  inputs: ProcessingInputRef[];
  /** Declared tool options only; collected against the tool's option schema. */
  options: Record<string, string>;
  usage?: ProcessingUsageReservationRef | null;
}

export interface ProcessingOutputRef {
  /** Storage key. Internal — never sent to a client. */
  key: string;
  /**
   * StoredFile id, so the download route can go through IDownloadService and get
   * a second, independent check plus retention awareness — rather than signing a
   * raw key the job payload happens to name.
   */
  fileId: string;
  downloadName: string;
  mimeType: string;
  bytes: number;
}

export interface ProcessingJobResult {
  output: ProcessingOutputRef;
  /** Present only when the processor could actually determine it. */
  pageCount?: number;
}

/**
 * The safe, user-facing projection of a job.
 *
 * Nothing in here is internal: no storage keys, no `error` diagnostics, no
 * payload. Routes serialize this and nothing else, so a field cannot leak by
 * someone returning the raw record "just for debugging".
 */
export interface JobView {
  jobId: string;
  toolSlug: string | null;
  status: JobStatus;
  stage: JobProgressStage | null;
  attempt: number;
  maxAttempts: number;
  /** True only when a result exists and may be downloaded right now. */
  resultAvailable: boolean;
  errorCategory: JobErrorCategory | null;
  /** The only failure text a client may display. */
  errorMessage: string | null;
  retryable: boolean;
  cancellable: boolean;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
  inputBytes: number | null;
  outputBytes: number | null;
  /**
   * The produced file's name and type — the two things a client needs to talk
   * about the result rather than merely download it.
   *
   * Safe to send, and nothing else from `output` is: `key` and `fileId` are the
   * storage locations and stay behind this boundary. The name is the one the
   * naming policy already put in `Content-Disposition`, so a client that displays
   * it agrees with the file the user receives instead of guessing; the MIME lets
   * a result surface refuse an action the output cannot support (an archive
   * cannot be opened in the editor) without hardcoding which tool produced it.
   *
   * Null until a result exists.
   */
  outputFileName: string | null;
  outputMimeType: string | null;
}

/** Thrown when the addressed job does not exist. */
export class JobNotFoundError extends Error {
  constructor() {
    super("Job not found.");
    this.name = "JobNotFoundError";
  }
}

/**
 * Thrown when a request is well-formed and authorized but the job's current
 * state does not permit it — cancelling a finished job, retrying a permanent
 * failure, downloading before completion.
 */
export class JobConflictError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "JobConflictError";
    this.reason = reason;
  }
}

export interface CreateProcessingJobInput {
  actor: JobActor;
  toolSlug: string;
  inputs: ProcessingInputRef[];
  options: Record<string, string>;
  /** Client-supplied de-duplication key; scoped to the actor when matched. */
  idempotencyKey?: string | null;
  maxAttempts?: number;
  /** The allowance this submission reserved, if any. See the type's note. */
  usage?: ProcessingUsageReservationRef | null;
}

export interface CreateProcessingJobOutcome {
  job: Job;
  /** True when an existing job was returned instead of a new one being created. */
  deduplicated: boolean;
}

export interface ProcessingJobServiceDeps {
  jobRepo: IJobRepository;
  queue: IQueue;
  worker: IWorker;
  logger: ILogger;
  now?: () => Date;
}

/**
 * The single owner of processing-job state.
 *
 * Every rule that must hold for every caller lives here: ownership, the tool
 * allowlist, lifecycle validity, retry budget, whether a result may be handed
 * out. API routes call these methods; they never touch `IJobRepository`
 * directly. That is not a stylistic preference — the moment a route writes a
 * status itself, "a cancelled job never publishes a result" stops being a
 * property of the system and becomes a property of that one route.
 *
 * Transitions go through `jobRepo.transition`, which validates against the pure
 * state machine and compare-and-swaps. A `null` return from it means the move
 * was refused, and every caller here treats that as meaningful rather than
 * retrying blindly.
 *
 * Every write a worker makes about its own attempt is additionally *fenced* on
 * that attempt (`expectAttempts`), and the fence is derived here rather than
 * asked of the caller — a worker already passes the attempt it is reporting on,
 * and a fence a call site can forget is not a fence. This is what the state
 * machine cannot do: `running → failed` is a perfectly legal move, so nothing in
 * the lifecycle distinguishes the worker that owns the attempt from a stalled
 * one whose job was recovered and handed to somebody else.
 */
export class ProcessingJobService {
  private readonly jobRepo: IJobRepository;
  private readonly queue: IQueue;
  private readonly worker: IWorker;
  private readonly logger: ILogger;
  private readonly now: () => Date;

  constructor(deps: ProcessingJobServiceDeps) {
    this.jobRepo = deps.jobRepo;
    this.queue = deps.queue;
    this.worker = deps.worker;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
  }

  /** The three collaborators the shared queue handoff needs. */
  private get handoff(): QueueHandoffDeps {
    return { jobRepo: this.jobRepo, queue: this.queue, logger: this.logger };
  }

  // ---- creation ----------------------------------------------------------

  /**
   * Writes a durable job record in `created` — not yet queued.
   *
   * Two steps rather than one because the failure between them matters: a record
   * that exists but was never queued is a recoverable, visible state, whereas an
   * enqueue that happens before the row exists is a job the user can never be
   * told about.
   *
   * The tool allowlist is checked here, before anything else, so a bad slug
   * cannot reach a processor lookup.
   */
  async createJob(input: CreateProcessingJobInput): Promise<CreateProcessingJobOutcome> {
    assertRemoteJobTool(input.toolSlug);

    if (input.inputs.length === 0) {
      throw new JobConflictError("no_input", "No file was provided.");
    }

    if (input.idempotencyKey) {
      const existing = await this.jobRepo.findByIdempotencyKey(
        input.actor.ownerType,
        input.actor.ownerId,
        input.idempotencyKey,
      );
      // Scoped by actor, so a guessed key returns *their* job or nothing — it can
      // never hand one visitor another visitor's job.
      if (existing) return { job: existing, deduplicated: true };
    }

    const payload: ProcessingJobPayload = {
      toolSlug: input.toolSlug,
      inputs: input.inputs,
      options: input.options,
      usage: input.usage ?? null,
    };

    const inputBytes = input.inputs.reduce((sum, i) => sum + (i.bytes || 0), 0);

    const job = await this.jobRepo.create({
      type: PROCESSING_JOB_TYPE,
      payload,
      status: "created",
      maxAttempts: input.maxAttempts ?? MAX_PROCESSING_ATTEMPTS,
      ownerType: input.actor.ownerType,
      ownerId: input.actor.ownerId,
      workspaceId: input.actor.workspaceId ?? null,
      toolSlug: input.toolSlug,
      idempotencyKey: input.idempotencyKey ?? null,
      progressStage: "preparing",
      expiresAt: new Date(this.now().getTime() + PROCESSING_OUTPUT_TTL_MS),
      inputBytes,
    });

    return { job, deduplicated: false };
  }

  /** Moves a `created` job onto the queue. Idempotent for an already-queued job. */
  async queueJob(jobId: string): Promise<Job> {
    const job = await this.requireJob(jobId);
    if (job.status === "queued") return job;

    const queued = await this.jobRepo.transition(jobId, "queued", {
      queuedAt: this.now(),
      progressStage: "queued",
    });
    if (!queued) throw new InvalidJobTransitionError(job.status, "queued");

    // Only the id crosses the queue boundary. Nothing about the document travels
    // in the message, so a queue backend never holds user content.
    //
    // A push that fails must not leave the row saying `queued`: on the adapters
    // that keep their own ready list there would then be nothing to serve it, and
    // nothing in the system revisits such a row (see `deliverQueuedJob`). It is
    // rolled back to `failed` rather than to `created`, which was its status a
    // moment ago, because `created` is not a state anything can act on — no sweep
    // looks at it and `retryJob` refuses it, so a client replaying its
    // `Idempotency-Key` after the error it just received would be handed the same
    // dead row again. `failed`/`internal_error` is both honest (the submission
    // *did* fail) and actionable by the retry path that already exists, with the
    // attempt budget untouched because nothing ran.
    await deliverQueuedJob(this.handoff, jobId, {
      status: "failed",
      patch: {
        error: HANDOFF_DIAGNOSTIC,
        errorCategory: "internal_error",
        safeErrorMessage: safeMessageFor("internal_error"),
        finishedAt: this.now(),
        // The two fields the transition above wrote, put back as they were.
        queuedAt: job.queuedAt,
        progressStage: job.progressStage,
      },
    });
    return queued;
  }

  /** createJob + queueJob, the normal submission path. */
  async submitJob(input: CreateProcessingJobInput): Promise<CreateProcessingJobOutcome> {
    const outcome = await this.createJob(input);
    if (outcome.deduplicated) return outcome;
    const queued = await this.queueJob(outcome.job.id);
    return { job: queued, deduplicated: false };
  }

  // ---- reads ------------------------------------------------------------

  /** Ownership-checked read, returning only the safe projection. */
  async getJob(jobId: string, actor: JobActor): Promise<JobView> {
    const job = await this.requireOwnedJob(jobId, actor);
    return this.toView(job);
  }

  /**
   * Ownership-checked result read.
   *
   * Refuses unless the job is `completed`. A job that is `running`, `cancelled`,
   * `failed` or `expired` has no result a client may have, and returning a
   * partially-written output would be worse than returning nothing.
   */
  async getResult(jobId: string, actor: JobActor): Promise<ProcessingJobResult> {
    const job = await this.requireOwnedJob(jobId, actor);

    if (job.status === "expired") {
      throw new JobConflictError("expired", "This result is no longer available.");
    }
    if (!canPublishResult(job.status)) {
      throw new JobConflictError("not_ready", "This job has not finished yet.");
    }
    const result = job.result as ProcessingJobResult | null;
    if (!result?.output?.key) {
      throw new JobConflictError("no_result", "This job produced no downloadable result.");
    }
    if (job.expiresAt && job.expiresAt.getTime() <= this.now().getTime()) {
      throw new JobConflictError("expired", "This result is no longer available.");
    }
    return result;
  }

  // ---- worker-side lifecycle -------------------------------------------

  /**
   * Claims a queued job for processing.
   *
   * Returns null when the claim is refused: either the job is not `queued` any
   * more (cancelled while waiting) or another worker won the race. The
   * compare-and-swap in the repository is what makes running two workers safe —
   * without it, both would pull the same id and run Ghostscript twice on it.
   */
  async startJob(jobId: string): Promise<Job | null> {
    return this.jobRepo.transition(jobId, "running", {
      startedAt: this.now(),
      progressStage: "processing",
    });
  }

  /**
   * Records the named stage the worker has reached. Never a fabricated number.
   *
   * Fenced on `attempt` like every other worker write: a superseded worker's
   * progress write would stamp a stage on an attempt it does not own and, worse,
   * refresh `updatedAt` — the lease — hiding the live worker's staleness from the
   * reaper. Refusal is silent because progress is advisory; the terminal writes
   * are where a lost attempt has to be acted on.
   */
  async recordStage(
    jobId: string,
    stage: JobProgressStage,
    attempt: number,
  ): Promise<void> {
    await this.jobRepo.update(
      jobId,
      { progressStage: stage },
      { expectAttempts: attempt - 1 },
    );
  }

  /**
   * Whether `attempt` is still the job's authority — its outcome either pending
   * or already recorded on the row.
   *
   * The read-only form of the fence, for a worker deciding what a refused write
   * still obliges it to do. Refusal has two causes that look identical at the
   * call site and demand opposite behaviour: the job went terminal under *this*
   * attempt, so this worker is still its authority and still owes the settlement
   * that returns the user's allowance; or the attempt was recovered and another
   * worker owns the job now, so this worker owes nothing and must record nothing
   * — anything it writes double-counts an attempt the sweep already recorded and
   * refunds a job that is at that moment still running.
   *
   * `attempts` counts finished attempts, which makes the two cases distinguishable
   * from the row alone:
   *
   *  - `attempt - 1` — the row still shows this attempt in flight. Ours.
   *  - `attempt` and terminal — this attempt's own outcome is what ended the job.
   *    Ours: nobody else will settle it.
   *  - `attempt` and NOT terminal — recovery charged this attempt and requeued the
   *    job, so the count is ours but the live attempt is not. Superseded.
   *  - anything higher — later attempts have come and gone. Superseded.
   */
  async ownsAttempt(jobId: string, attempt: number): Promise<boolean> {
    const job = await this.jobRepo.get(jobId);
    if (!job) return false;
    if (job.attempts === attempt - 1) return true;
    return job.attempts === attempt && isTerminal(job.status);
  }

  /**
   * Publishes a successful result.
   *
   * Returns false when the transition is refused — overwhelmingly because the
   * user cancelled while the processor was finishing. The caller must then treat
   * the produced output as garbage and delete it; the honest outcome of "you
   * cancelled" is no result, even though the CPU work was already spent.
   */
  async completeJob(
    jobId: string,
    result: ProcessingJobResult,
    attempt: number,
  ): Promise<boolean> {
    const done = await this.jobRepo.transition(
      jobId,
      "completed",
      {
        result,
        attempts: attempt,
        progressStage: "done",
        finishedAt: this.now(),
        outputBytes: result.output?.bytes ?? null,
        error: null,
        errorCategory: null,
        safeErrorMessage: null,
      },
      { expectAttempts: attempt - 1 },
    );
    return done !== null;
  }

  /**
   * Records a failure with its classification.
   *
   * `diagnostic` is the internal message and is stored in `error`, which is
   * never serialized to a client. The user-facing text comes from the category
   * alone, so a stack trace or a command line in `diagnostic` cannot reach a
   * browser even by accident.
   */
  async failJob(
    jobId: string,
    category: JobErrorCategory,
    diagnostic: string,
    attempt: number,
  ): Promise<boolean> {
    const failed = await this.jobRepo.transition(
      jobId,
      "failed",
      {
        error: diagnostic.slice(0, 2000),
        errorCategory: category,
        safeErrorMessage: safeMessageFor(category),
        attempts: attempt,
        finishedAt: this.now(),
      },
      { expectAttempts: attempt - 1 },
    );
    return failed !== null;
  }

  /** Marks a job cancelled from the worker side, once it has actually stopped. */
  async markCancelled(jobId: string, attempt: number): Promise<boolean> {
    const cancelled = await this.jobRepo.transition(
      jobId,
      "cancelled",
      {
        attempts: attempt,
        errorCategory: "cancelled",
        safeErrorMessage: safeMessageFor("cancelled"),
        finishedAt: this.now(),
      },
      { expectAttempts: attempt - 1 },
    );
    return cancelled !== null;
  }

  // ---- user-initiated control ------------------------------------------

  /**
   * Requests cancellation.
   *
   * Deliberately honest about what this can and cannot do. For a job still
   * `created` or `queued`, nothing has started, so it is cancelled outright and
   * the answer is final. For a `running` job the request is *recorded*
   * (`cancelRequestedAt`) and broadcast to the worker, which aborts its
   * subprocess at the next check; the status becomes `cancelled` when the worker
   * confirms it has stopped, not when the button is clicked.
   *
   * `stopped` in the return value is what the UI must key off. Reporting
   * instantaneous cancellation for a running job would be a lie, and the one
   * guarantee that *is* absolute — no result is published after a successful
   * cancellation — comes from the state machine, not from timing.
   */
  async cancelJob(
    jobId: string,
    actor: JobActor,
  ): Promise<{ view: JobView; stopped: boolean }> {
    const job = await this.requireOwnedJob(jobId, actor);

    if (isTerminal(job.status)) {
      throw new JobConflictError(
        "already_finished",
        "This job has already finished, so it cannot be cancelled.",
      );
    }

    if (job.status === "created" || job.status === "queued") {
      const cancelled = await this.jobRepo.transition(jobId, "cancelled", {
        cancelRequestedAt: this.now(),
        finishedAt: this.now(),
        errorCategory: "cancelled",
        safeErrorMessage: safeMessageFor("cancelled"),
      });
      // Tell the worker anyway: it may have pulled the id between our read and
      // our write, in which case the transition above lost and the flag is what
      // stops it.
      await this.worker.cancel(jobId).catch(() => {});
      if (cancelled) return { view: this.toView(cancelled), stopped: true };
      const latest = await this.requireJob(jobId);
      return { view: this.toView(latest), stopped: isTerminal(latest.status) };
    }

    await this.jobRepo.update(jobId, { cancelRequestedAt: this.now() });
    await this.worker.cancel(jobId);
    const latest = await this.requireJob(jobId);
    return { view: this.toView(latest), stopped: false };
  }

  /**
   * Starts a fresh attempt on a failed or cancelled job.
   *
   * Refused for three distinct reasons, each reported separately so the UI can
   * say something true: the failure is permanent (a corrupt file will not become
   * valid), the attempt budget is spent, or the staged input has expired and
   * there is nothing left to process.
   */
  async retryJob(jobId: string, actor: JobActor): Promise<JobView> {
    const job = await this.requireOwnedJob(jobId, actor);

    if (job.status === "expired") {
      throw new JobConflictError(
        "expired",
        "The uploaded file for this job is no longer available. Please upload it again.",
      );
    }
    if (job.status !== "failed" && job.status !== "cancelled") {
      throw new JobConflictError(
        "not_retryable_status",
        "Only a failed or cancelled job can be retried.",
      );
    }
    if (job.status === "failed") {
      const category = toJobErrorCategory(job.errorCategory);
      if (!isRetryableCategory(category)) {
        throw new JobConflictError(
          "permanent_failure",
          "This failure will not be fixed by trying again.",
        );
      }
    }
    if (job.attempts >= job.maxAttempts) {
      throw new JobConflictError(
        "attempts_exhausted",
        "This job has already used all of its attempts.",
      );
    }
    if (job.expiresAt && job.expiresAt.getTime() <= this.now().getTime()) {
      throw new JobConflictError(
        "expired",
        "The uploaded file for this job is no longer available. Please upload it again.",
      );
    }

    const requeued = await this.jobRepo.transition(
      jobId,
      "queued",
      {
        error: null,
        errorCategory: null,
        safeErrorMessage: null,
        finishedAt: null,
        startedAt: null,
        cancelRequestedAt: null,
        queuedAt: this.now(),
        progressStage: "queued",
      },
      // The single sanctioned route out of a terminal state. Attempts are NOT
      // reset: the budget is per job, so retry cannot be used to loop forever.
      { retry: true },
    );
    if (!requeued) throw new InvalidJobTransitionError(job.status, "queued");

    // Clear the stale cancellation flag before the job becomes runnable.
    //
    // A job cancelled while it waited in the queue was never processed, so
    // nothing cleared the worker's flag for it. Without this the revived attempt
    // is pre-cancelled: the handler's first `isCancelled()` returns true and the
    // job dies again immediately.
    await this.worker.clearCancellation(jobId).catch(() => {});

    // Enqueue directly rather than via `worker.requeue`. That method performs its
    // own `→ queued` transition first and bails out when it is refused — which is
    // exactly what happens here, because the transition above already succeeded.
    // Delegating to it would therefore skip the enqueue entirely and leave the
    // job sitting in `queued` forever, never picked up. (It also resets
    // `attempts` to zero, which would make the retry budget unenforceable.)
    //
    // This is the handoff where a lost push hurts most, because it destroys the
    // very affordance the user just used: the row lands `queued`, and `queued` is
    // not retryable — the check above refuses anything that is not
    // `failed`/`cancelled` — so a retry whose delivery failed would make every
    // further retry impossible. Rolling back to the *original* terminal status is
    // what keeps the next attempt available, and it has to be the original one:
    // restoring `failed` over a `cancelled` job leaves `errorCategory:
    // "cancelled"`, which `isRetryableCategory` rejects as permanent.
    await deliverQueuedJob(this.handoff, jobId, {
      status: job.status,
      patch: {
        error: job.error,
        errorCategory: job.errorCategory,
        safeErrorMessage: job.safeErrorMessage,
        finishedAt: job.finishedAt,
        startedAt: job.startedAt,
        cancelRequestedAt: job.cancelRequestedAt,
        queuedAt: job.queuedAt,
        progressStage: job.progressStage,
      },
    });

    return this.toView(requeued);
  }

  /**
   * Marks a job's output as gone. Called by the retention sweep, not by users.
   *
   * `completed → expired` and `queued → expired` are both legal: the first is a
   * purged output, the second a staged input that outlived its TTL before the
   * work ever ran.
   */
  async expireJob(jobId: string): Promise<boolean> {
    const job = await this.jobRepo.get(jobId);
    if (!job) return false;
    const expired = await this.jobRepo.transition(jobId, "expired", {
      finishedAt: job.finishedAt ?? this.now(),
    });
    return expired !== null;
  }

  // ---- helpers ----------------------------------------------------------

  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.jobRepo.get(jobId);
    if (!job) throw new JobNotFoundError();
    return job;
  }

  /**
   * Loads a job and proves the caller owns it.
   *
   * A non-existent job and someone else's job both raise
   * `JobAuthorizationError`, which routes render as 404. Distinguishing them
   * would turn the endpoint into an oracle for which job ids exist.
   */
  private async requireOwnedJob(jobId: string, actor: JobActor): Promise<Job> {
    const job = await this.jobRepo.get(jobId);
    if (!job) throw new JobAuthorizationError();
    if (job.type !== PROCESSING_JOB_TYPE) throw new JobAuthorizationError();
    assertActorOwnsJob(actor, job);
    return job;
  }

  /** Projects a record to the safe view. The only serialization path for a job. */
  toView(job: Job): JobView {
    const category = job.errorCategory ? toJobErrorCategory(job.errorCategory) : null;
    const notExpired = !job.expiresAt || job.expiresAt.getTime() > this.now().getTime();
    const output = (job.result as ProcessingJobResult | null)?.output ?? null;
    return {
      jobId: job.id,
      toolSlug: job.toolSlug,
      status: job.status,
      stage: (job.progressStage as JobProgressStage | null) ?? null,
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
      resultAvailable:
        canPublishResult(job.status) && Boolean(job.result) && notExpired,
      errorCategory: category,
      errorMessage: job.safeErrorMessage,
      retryable:
        (job.status === "cancelled" ||
          (job.status === "failed" && category !== null && isRetryableCategory(category))) &&
        job.attempts < job.maxAttempts &&
        notExpired,
      cancellable: !isTerminal(job.status),
      createdAt: job.createdAt.toISOString(),
      queuedAt: job.queuedAt?.toISOString() ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      inputBytes: job.inputBytes,
      outputBytes: job.outputBytes,
      // From the result record, not from the tool slug: the name and type belong
      // to the bytes that were actually written.
      outputFileName: output?.downloadName ?? null,
      outputMimeType: output?.mimeType ?? null,
    };
  }
}
