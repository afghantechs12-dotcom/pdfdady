import type { Job } from "@/src/domain/entities/Job";
import type { EnqueueInput } from "./Queue";

/**
 * JobScheduler port — schedule a job to become eligible at a future time
 * (delayed jobs), with cancellation. Adapters: in-memory (setTimeout) and Redis
 * (a sorted set keyed by runAt, polled onto the queue when due). Recurring jobs
 * are a future extension (re-schedule on completion).
 */
export interface IJobScheduler {
  /** Creates the job record (status queued) and makes it eligible at `runAt`. */
  schedule(input: EnqueueInput, runAt: Date): Promise<Job>;
  /** Cancels a scheduled job before it runs (status → cancelled). */
  cancel(jobId: string): Promise<void>;
}
