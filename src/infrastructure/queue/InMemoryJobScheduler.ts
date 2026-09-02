import type { IJobScheduler } from "@/src/application/ports/queue/JobScheduler";
import type { IQueue, EnqueueInput } from "@/src/application/ports/queue/Queue";
import type { IJobRepository } from "@/src/application/ports/repositories/JobRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { Job } from "@/src/domain/entities/Job";

/**
 * In-process IJobScheduler — creates the job record, then a setTimeout fires at
 * `runAt` to place the job id on the queue. Single-instance (dev); the Redis
 * adapter (sorted-set + poller) is the multi-instance production path. Cancel
 * clears the timer + marks the job cancelled.
 */
export class InMemoryJobScheduler implements IJobScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly queue: IQueue,
    private readonly jobRepo: IJobRepository,
    private readonly logger: ILogger,
  ) {}

  async schedule(input: EnqueueInput, runAt: Date): Promise<Job> {
    const job = await this.jobRepo.create({
      type: input.type,
      payload: input.payload,
      maxAttempts: input.maxAttempts,
    });
    const delay = Math.max(0, runAt.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      void this.queue
        .requeue(job.id)
        .catch((e) =>
          this.logger.error("Scheduler enqueue failed", {
            jobId: job.id,
            error: String(e),
          }),
        );
    }, delay);
    this.timers.set(job.id, timer);
    return job;
  }

  async cancel(jobId: string): Promise<void> {
    const t = this.timers.get(jobId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(jobId);
    }
    // Guarded: a job that already finished stays finished. `transition` returns
    // null rather than throwing for both "missing" and "not allowed from here",
    // which is exactly the best-effort semantics this call wants.
    await this.jobRepo
      .transition(jobId, "cancelled", { finishedAt: new Date() })
      .catch(() => null);
  }
}
