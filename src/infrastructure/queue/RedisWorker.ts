import Redis from "ioredis";
import type {
  IWorker,
  JobHandler,
  JobContext,
} from "@/src/application/ports/queue/Worker";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IJobEvents } from "@/src/application/ports/queue/JobEvents";
import type { Job } from "@/src/domain/entities/Job";

const PROCESSING = "pdfdadi:queue:processing";
const DEADLETTER = "pdfdadi:queue:deadletter";
const CANCEL_CHANNEL = "pdfdadi:cancel";
const cancelKey = (id: string) => `pdfdadi:cancel:${id}`;

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RedisWorkerOptions {
  events?: IJobEvents;
  backoffMs?: (attempt: number) => number;
}

/**
 * Redis IWorker adapter — drains a RedisQueue, dispatches to handlers with
 * in-place retry, cancellation (via a pub/sub cancel channel mirrored into a
 * local set), progress (via IJobEvents), and a dead-letter list for
 * exhausted jobs. On completion/failure it LREMs the id from the processing
 * list; final failures are LPUSHed to the dead-letter list. Only constructed
 * when REDIS_URL is set.
 */
export class RedisWorker implements IWorker {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly cancelled = new Set<string>();
  private _running = false;
  private loopPromise: Promise<void> | null = null;
  /** 0 or 1: this loop awaits each job, so it never runs two at once. */
  private active = 0;
  private readonly redis: Redis;
  private readonly sub: Redis;

  constructor(
    redisUrl: string,
    private readonly queue: IQueue,
    private readonly jobRepo: IJobRepository,
    private readonly logger: ILogger,
    private readonly options: RedisWorkerOptions = {},
  ) {
    this.redis = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
    void this.sub.subscribe(CANCEL_CHANNEL);
    this.sub.on("message", (channel, message) => {
      if (channel === CANCEL_CHANNEL) this.cancelled.add(message);
    });
  }

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
      this.logger.error("Redis worker loop crashed", { error: String(err) });
      this._running = false;
    });
  }

  stop(): void {
    this._running = false;
  }

  async cancel(jobId: string): Promise<void> {
    // Broadcast to all workers (subscribed) + set a key for late joiners.
    await this.redis.set(cancelKey(jobId), "1", "EX", 3600);
    await this.redis.publish(CANCEL_CHANNEL, jobId);
  }

  async clearCancellation(jobId: string): Promise<void> {
    this.cancelled.delete(jobId);
    // Also drop the key, so a worker that subscribes later does not read a
    // cancellation that belonged to an earlier attempt.
    await this.redis.del(cancelKey(jobId)).catch(() => 0);
  }

  async requeue(jobId: string): Promise<void> {
    // Reset attempts so the revived job gets a fresh set of retries. `retry:
    // true` is required — see the same call in InMemoryWorker.
    const revived = await this.jobRepo.transition(
      jobId,
      "queued",
      { error: null, attempts: 0, finishedAt: null },
      { retry: true },
    );
    if (!revived) {
      this.logger.debug("Requeue skipped; job is not in a revivable state", { jobId });
      return;
    }
    await this.queue.requeue(jobId);
  }

  private async loop(): Promise<void> {
    while (this._running) {
      const job = await this.queue.pull(1_000);
      if (!job) continue;
      this.active++;
      try {
        await this.process(job);
      } finally {
        this.active = Math.max(0, this.active - 1);
      }
    }
  }

  private async process(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);

    // Guarded claim — the reason two Redis workers can safely drain one queue.
    // BRPOPLPUSH already hands an id to a single consumer, but a recovered
    // `processing` entry can be re-delivered; the compare-and-swap is what makes
    // that re-delivery harmless instead of a second Ghostscript run.
    const claimed = await this.jobRepo.transition(job.id, "running", {
      startedAt: new Date(),
    });
    if (!claimed) {
      this.logger.info("Job claim refused; skipping", {
        jobId: job.id,
        type: job.type,
        status: job.status,
      });
      await this.redis.lrem(PROCESSING, 1, job.id);
      return;
    }
    this.cancelled.delete(job.id);

    if (!handler) {
      await this.deadLetter(job, `No handler for type "${job.type}"`);
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
        await this.jobRepo.transition(job.id, "cancelled", { finishedAt: new Date() });
        await this.redis.lrem(PROCESSING, 1, job.id);
        return;
      }
      try {
        const { result, terminal } = await handler(job, ctx);
        if (terminal) {
          // The handler already recorded the outcome with its classification.
          await this.redis.lrem(PROCESSING, 1, job.id);
          return;
        }
        const done = await this.jobRepo.transition(job.id, "completed", {
          result,
          attempts: attempt,
          finishedAt: new Date(),
        });
        if (!done) {
          this.logger.info("Completion refused; job already terminal", {
            jobId: job.id,
            type: job.type,
          });
        }
        await this.redis.lrem(PROCESSING, 1, job.id);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn("Job attempt failed", { jobId: job.id, type: job.type, attempt, error: lastError });
        await this.jobRepo.update(job.id, { attempts: attempt, error: lastError });
        if (ctx.isCancelled()) {
          await this.jobRepo.transition(job.id, "cancelled", { finishedAt: new Date() });
          await this.redis.lrem(PROCESSING, 1, job.id);
          return;
        }
        if (attempt < job.maxAttempts) {
          const backoff = this.options.backoffMs ?? backoffMs;
          await sleep(backoff(attempt));
        }
      }
    }
    await this.deadLetter(job, lastError);
  }

  private async deadLetter(job: Job, error: string | null): Promise<void> {
    await this.jobRepo.transition(job.id, "failed", { error, finishedAt: new Date() });
    await this.redis.lrem(PROCESSING, 1, job.id);
    await this.redis.lpush(DEADLETTER, job.id);
  }
}
