import type { Job } from "@/src/domain/entities/Job";
import type {
  IWorker,
  JobHandler,
  JobContext,
} from "@/src/application/ports/queue/Worker";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IJobEvents } from "@/src/application/ports/queue/JobEvents";

/** Fixed, gentle backoff for in-place retries (M2.3 Redis uses delayed queues). */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface InMemoryWorkerOptions {
  /** Override the retry backoff (useful in tests to avoid real sleeps). */
  backoffMs?: (attempt: number) => number;
  /** Progress/cancellation event sink; when omitted, progress is a no-op. */
  events?: IJobEvents;
  /**
   * Max jobs processed concurrently. Default 1 (sequential — preserves the
   * M2.3 behavior in tests). The production bootstrap sets this to
   * TOOLS_MAX_CONCURRENCY so jobs drained from the queue run in parallel
   * (without it, the synchronous tool route awaiting a job through the queue
   * would serialize every conversion).
   */
  concurrency?: number;
}

/**
 * In-process IWorker adapter — drains the IQueue and dispatches to registered
 * handlers with in-place retry up to maxAttempts, plus cancellation (via
 * ctx.isCancelled), progress reporting (via ctx.progress → IJobEvents), and
 * dead-letter requeue. Business logic lives in the handlers; this adapter only
 * orchestrates pull → run → record. The M2.3 Redis worker implements the same
 * interface against a shared queue.
 */
export class InMemoryWorker implements IWorker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly cancelled = new Set<string>();
  private _running = false;
  private loopPromise: Promise<void> | null = null;
  private active = 0;
  private readonly drainWaiters: Array<() => void> = [];

  constructor(
    private readonly queue: IQueue,
    private readonly jobRepo: IJobRepository,
    private readonly logger: ILogger,
    private readonly options: InMemoryWorkerOptions = {},
  ) {}

  get running(): boolean {
    return this._running;
  }

  get activeCount(): number {
    return this.active;
  }

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this.loopPromise = this.loop().catch((err) => {
      this.logger.error("Worker loop crashed", { error: String(err) });
      this._running = false;
    });
  }

  stop(): void {
    this._running = false;
    // Release any loop iteration blocked on the concurrency semaphore so the
    // loop can observe _running=false and exit promptly.
    while (this.drainWaiters.length) this.drainWaiters.shift()!();
  }

  async cancel(jobId: string): Promise<void> {
    this.cancelled.add(jobId);
  }

  async clearCancellation(jobId: string): Promise<void> {
    this.cancelled.delete(jobId);
  }

  async requeue(jobId: string): Promise<void> {
    // Reset attempts so the revived job gets a fresh set of retries, and clear
    // any stale cancellation flag so the revived run isn't pre-cancelled.
    //
    // `retry: true` is required: returning a terminal job to `queued` is exactly
    // the move the lifecycle otherwise forbids, and this is the sanctioned
    // command that performs it.
    this.cancelled.delete(jobId);
    const revived = await this.jobRepo.transition(
      jobId,
      "queued",
      { error: null, attempts: 0, finishedAt: null },
      { retry: true },
    );
    if (!revived) {
      // Already queued or running — the requeue is a no-op rather than an error,
      // because "make this job runnable again" is satisfied either way.
      this.logger.debug("Requeue skipped; job is not in a revivable state", { jobId });
      return;
    }
    await this.queue.requeue(jobId);
  }

  /** Drains the queue once (for tests); halts when no ready jobs. */
  async drainOnce(): Promise<void> {
    while (true) {
      const job = await this.queue.pull(0);
      if (!job) break;
      await this.process(job);
    }
  }

  private async loop(): Promise<void> {
    const limit = Math.max(1, this.options.concurrency ?? 1);
    while (this._running) {
      if (this.active >= limit) {
        // Semaphore full — wait for an in-flight job to finish before pulling.
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
        continue;
      }
      const job = await this.queue.pull(1_000);
      if (!job) continue;
      this.active++;
      void this.process(job).finally(() => {
        this.active = Math.max(0, this.active - 1);
        const next = this.drainWaiters.shift();
        if (next) next();
      });
    }
  }

  private async process(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);

    // THE CLAIM. A guarded compare-and-swap, not a blind write: it succeeds for
    // exactly one caller and only from a status the lifecycle allows. That is
    // what makes it safe to run more than one worker against a shared queue —
    // two processes can pull the same id, but only one can claim it — and it is
    // also what stops a job the user cancelled while it sat in the queue from
    // being started anyway.
    const claimed = await this.jobRepo.transition(job.id, "running", {
      startedAt: new Date(),
    });
    if (!claimed) {
      this.logger.info("Job claim refused; skipping", {
        jobId: job.id,
        type: job.type,
        status: job.status,
      });
      return;
    }

    try {
      if (!handler) {
        await this.jobRepo.transition(job.id, "failed", {
          error: `No handler registered for job type "${job.type}"`,
          finishedAt: new Date(),
        });
        this.logger.warn("Job had no handler", { jobId: job.id, type: job.type });
        return;
      }

      const ctx: JobContext = {
        progress: (pct, detail) =>
          this.options.events
            ? this.options.events.emitProgress(job.id, pct, detail)
            : Promise.resolve(),
        isCancelled: () => this.cancelled.has(job.id),
      };

      let lastError: string | null = null;
      for (let attempt = job.attempts + 1; attempt <= job.maxAttempts; attempt++) {
        if (ctx.isCancelled()) {
          await this.jobRepo.transition(job.id, "cancelled", {
            finishedAt: new Date(),
          });
          this.logger.info("Job cancelled", { jobId: job.id, type: job.type });
          return;
        }
        try {
          const { result, terminal } = await handler(job, ctx);
          // A handler that recorded its own outcome (with a failure category and
          // a user-safe message) has the authoritative answer; overwriting it
          // here would discard that detail.
          if (terminal) return;
          const done = await this.jobRepo.transition(job.id, "completed", {
            result,
            attempts: attempt,
            finishedAt: new Date(),
          });
          if (!done) {
            // Refused: the job reached a terminal state while the handler ran —
            // in practice, the user cancelled. The result is deliberately
            // dropped rather than published.
            this.logger.info("Completion refused; job already terminal", {
              jobId: job.id,
              type: job.type,
            });
          }
          return;
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          this.logger.warn("Job attempt failed", {
            jobId: job.id,
            type: job.type,
            attempt,
            error: lastError,
          });
          await this.jobRepo.update(job.id, { attempts: attempt, error: lastError });
          if (ctx.isCancelled()) {
            await this.jobRepo.transition(job.id, "cancelled", {
              finishedAt: new Date(),
            });
            return;
          }
          if (attempt < job.maxAttempts) {
            const backoff = this.options.backoffMs ?? backoffMs;
            await sleep(backoff(attempt));
          }
        }
      }
      // Dead-letter: all attempts exhausted → failed (requeue() can revive it).
      await this.jobRepo.transition(job.id, "failed", {
        error: lastError,
        finishedAt: new Date(),
      });
    } finally {
      // Clear the cancellation flag on every terminal exit so the set can't
      // grow unbounded. (A pre-pull cancel survives into the handler because we
      // no longer clear it at the top of process(); requeue() clears it for a
      // fresh revived run.)
      this.cancelled.delete(job.id);
    }
  }
}
