import type { Job } from "@/src/domain/entities/Job";

/**
 * Worker port — registers handlers per job type and drains the queue.
 *
 * The adapter (in-memory now, Redis-backed in M2.3) is responsible for pulling
 * jobs, dispatching to the matching handler, applying retry/backoff up to
 * maxAttempts, and recording terminal status. Business logic lives in the
 * handlers passed to `register`; the worker itself is infrastructure.
 */
export interface JobHandlerResult {
  result?: unknown;
  /**
   * Set when the handler has already recorded the job's terminal status itself.
   *
   * Handlers in the unified processing pipeline classify their own failures and
   * write `completed`/`failed`/`cancelled` with a category and a safe message —
   * detail the generic worker has no access to. Without this flag the worker
   * would follow up with its own `completed` write, and while the state machine
   * would refuse it, relying on a refusal to express "I already handled this" is
   * an invariant held by accident. The flag says it on purpose.
   */
  terminal?: boolean;
}

/**
 * Passed into every handler so it can report progress + check for cancellation.
 * `progress` is emitted via IJobEvents (for SSE/streaming); `isCancelled` lets
 * a long handler abort promptly when cancel(jobId) is called.
 */
export interface JobContext {
  progress(pct: number, detail?: string): Promise<void>;
  isCancelled(): boolean;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<JobHandlerResult>;

export interface IWorker {
  /** Registers a handler for a job type. Multiple types may be registered. */
  register(type: string, handler: JobHandler): void;
  /** Begins draining the queue. Idempotent if already running. */
  start(): void;
  /** Stops draining. In-flight handlers run to completion. */
  stop(): void;
  /** Whether the worker is currently draining. */
  readonly running: boolean;
  /**
   * How many handlers are executing right now.
   *
   * Exists for shutdown: `stop()` only stops *starting* work, so a process that
   * exits immediately afterwards kills whatever was mid-flight. A bounded drain
   * needs to know when the count reaches zero — and needs it from the worker,
   * since nothing else can see inside the loop.
   */
  readonly activeCount: number;
  /** Requests cancellation of a running job (best-effort; the handler checks ctx.isCancelled()). */
  cancel(jobId: string): Promise<void>;
  /**
   * Forgets any recorded cancellation request for a job.
   *
   * Needed because a cancellation flag outlives the run it cancelled: a job
   * cancelled while it sat in the queue is never processed, so nothing clears
   * the flag. Retrying that job would then hand the handler a context whose
   * `isCancelled()` is already true and the fresh attempt would abort
   * instantly — a "Try again" button that silently does nothing.
   *
   * `requeue` clears it as part of reviving a job; this exposes the same clear
   * on its own, for callers that perform the status change themselves (the
   * processing service does, because `requeue` also resets the attempt counter
   * and that would make the retry budget unenforceable).
   */
  clearCancellation(jobId: string): Promise<void>;
  /** Re-queues a failed (dead-letter) job for another run: status→queued + back on the queue. */
  requeue(jobId: string): Promise<void>;
}
