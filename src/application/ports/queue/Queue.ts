import type { Job, JobOwnerType } from "@/src/domain/entities/Job";

/**
 * Queue port — enqueue + pull background jobs.
 *
 * A pull-based contract so it maps cleanly onto both an in-memory array and a
 * Redis list (BRPOPLPUSH) in M2.3. `enqueue` records the job durably (via the
 * JobRepository) and makes it available to `pull`; `pull` resolves with the
 * next queued job or null after `timeoutMs`.
 */
export interface EnqueueInput {
  type: string;
  payload: unknown;
  maxAttempts?: number;
  /**
   * Ownership, recorded on the job row at creation.
   *
   * Optional because most job types have no user-facing owner (the retention
   * sweep, ingestion, the scheduler) and are never addressed by id over HTTP.
   * For the job types that ARE addressable — the legacy `pdf-tool` and
   * `pdf-tool-batch` types — these are what make an ownership check possible at
   * all: an unowned row is owned by nobody, so a check against it can only ever
   * deny. Resolved server-side from the session/anon cookie; never from a
   * request body.
   */
  ownerType?: JobOwnerType | null;
  ownerId?: string | null;
  workspaceId?: string | null;
  /** The tool this job runs, e.g. `compress-pdf`. Null for infrastructure jobs. */
  toolSlug?: string | null;
}

export interface IQueue {
  enqueue(input: EnqueueInput): Promise<Job>;
  pull(timeoutMs?: number): Promise<Job | null>;
  /** Puts an existing job id back on the ready queue (used by requeue/scheduler). */
  requeue(jobId: string): Promise<void>;
}
