import Redis from "ioredis";
import type { IJobScheduler } from "@/src/application/ports/queue/JobScheduler";
import type { IQueue, EnqueueInput } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { Job } from "@/src/domain/entities/Job";

const SCHEDULED = "pdfdadi:queue:scheduled";
const POLL_INTERVAL_MS = 1_000;

/**
 * Redis IJobScheduler — stores due jobs in a sorted set scored by runAt; a
 * poller (started on construction) moves due members onto the queue. Cross-
 * process safe (multiple workers can poll; ZREM is the atomic claim). Only
 * constructed when REDIS_URL is set.
 */
export class RedisJobScheduler implements IJobScheduler {
  private readonly redis: Redis;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    redisUrl: string,
    private readonly queue: IQueue,
    private readonly jobRepo: IJobRepository,
    private readonly logger: ILogger,
  ) {
    this.redis = new Redis(redisUrl);
    this.startPoller();
  }

  async schedule(input: EnqueueInput, runAt: Date): Promise<Job> {
    const job = await this.jobRepo.create({
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
    });
    await this.redis.zadd(SCHEDULED, runAt.getTime(), job.id);
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    await this.redis.zrem(SCHEDULED, jobId);
    // Guarded so a job that already finished stays finished; see the in-memory
    // scheduler for the same call.
    await this.jobRepo
      .transition(jobId, "cancelled", { finishedAt: new Date() })
      .catch(() => null);
  }

  private startPoller(): void {
    this.timer = setInterval(() => {
      void this.dueJobs().catch((e) =>
        this.logger.error("Scheduler poll failed", { error: String(e) }),
      );
    }, POLL_INTERVAL_MS);
  }

  private async dueJobs(): Promise<void> {
    const now = Date.now();
    const due = await this.redis.zrangebyscore(SCHEDULED, 0, now);
    for (const id of due) {
      // Atomic claim: only the worker that removes it owns it.
      const removed = await this.redis.zrem(SCHEDULED, id);
      if (removed) {
        await this.queue.requeue(id);
      }
    }
  }
}
