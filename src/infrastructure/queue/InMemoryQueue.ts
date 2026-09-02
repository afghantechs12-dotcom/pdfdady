import type { Job } from "@/src/domain/entities/Job";
import type { IQueue, EnqueueInput } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * In-process IQueue adapter — the M2.1 default (no Redis). Jobs are durably
 * recorded via the JobRepository and queued by id in an in-memory list; `pull`
 * resolves immediately if a job is ready, otherwise waits up to `timeoutMs` for
 * an enqueue to notify it, then retries once. M2.3 adds a Redis adapter
 * (BRPOPLPUSH) implementing the same interface.
 */
export class InMemoryQueue implements IQueue {
  private readonly ids: string[] = [];
  private readonly waiters: Waiter[] = [];

  constructor(
    private readonly jobRepo: IJobRepository,
    private readonly logger: ILogger,
  ) {}

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
    this.ids.push(job.id);
    this.logger.debug("Job enqueued", { jobId: job.id, type: job.type });
    this.notify();
    return job;
  }

  async pull(timeoutMs = 1_000): Promise<Job | null> {
    const id = this.ids.shift();
    if (id) return (await this.jobRepo.get(id)) ?? null;
    if (timeoutMs <= 0) return null;

    // Wait for a notify, then retry once.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        resolve();
      }, timeoutMs);
      const waiter: Waiter = { resolve, timer };
      this.waiters.push(waiter);
    });

    const nextId = this.ids.shift();
    if (nextId) return (await this.jobRepo.get(nextId)) ?? null;
    return null;
  }

  async requeue(jobId: string): Promise<void> {
    this.ids.push(jobId);
    this.logger.debug("Job requeued", { jobId });
    this.notify();
  }

  private notify(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) this.waiters.splice(idx, 1);
  }
}
