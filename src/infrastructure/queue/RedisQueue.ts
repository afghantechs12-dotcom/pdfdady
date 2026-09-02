import Redis from "ioredis";
import type { IQueue, EnqueueInput } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { Job } from "@/src/domain/entities/Job";
import type { ILogger } from "@/src/application/ports/Logger";

const READY = "pdfdadi:queue:ready";
const PROCESSING = "pdfdadi:queue:processing";

/**
 * Redis IQueue adapter — a reliable queue using BRPOPLPUSH: a popped id is
 * atomically moved to a processing list, so a crashed worker's job is
 * recoverable from `processing` (a visibility-timeout reaper is a follow-up).
 * Only constructed when REDIS_URL is set (see container.ts); the in-memory
 * adapter is the dev/test path.
 */
export class RedisQueue implements IQueue {
  protected readonly redis: Redis;

  constructor(
    redisUrl: string,
    protected readonly jobRepo: IJobRepository,
    protected readonly logger: ILogger,
  ) {
    this.redis = new Redis(redisUrl);
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    const job = await this.jobRepo.create({
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
      // Ownership is part of creating the record, not a later patch: a row that
      // exists unowned for even a moment is a row an ownership check must deny.
      ownerType: input.ownerType ?? null,
      ownerId: input.ownerId ?? null,
      workspaceId: input.workspaceId ?? null,
      toolSlug: input.toolSlug ?? null,
    });
    await this.redis.lpush(READY, job.id);
    return job;
  }

  async pull(timeoutMs = 1_000): Promise<Job | null> {
    const id = await this.redis.brpoplpush(
      READY,
      PROCESSING,
      Math.max(1, Math.ceil(timeoutMs / 1000)),
    );
    if (!id) return null;
    return (await this.jobRepo.get(id)) ?? null;
  }

  async requeue(jobId: string): Promise<void> {
    await this.redis.lpush(READY, jobId);
  }
}
