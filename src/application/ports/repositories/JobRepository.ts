import type { Job, JobOwnerType, JobStatus } from "@/src/domain/entities/Job";

/**
 * JobRepository port — persistence abstraction for background jobs.
 *
 * The queue/worker adapters use this to durably record job state (so a crash
 * mid-job doesn't lose history). The application layer depends only on this
 * interface, not on Prisma.
 */
export interface JobCreateInput {
  type: string;
  payload: unknown;
  maxAttempts?: number;
  /**
   * Initial status. Defaults to `queued` so every existing caller — the queue
   * adapters and the scheduler, which create a record and immediately make it
   * runnable — is unchanged. The processing pipeline passes `created`, because
   * it writes the record first and queues it as a separate, auditable step.
   */
  status?: JobStatus;
  ownerType?: JobOwnerType | null;
  ownerId?: string | null;
  workspaceId?: string | null;
  toolSlug?: string | null;
  idempotencyKey?: string | null;
  progressStage?: string | null;
  expiresAt?: Date | null;
  inputBytes?: number | null;
}

export interface JobUpdatePatch {
  status?: JobStatus;
  result?: unknown;
  error?: string | null;
  attempts?: number;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  progressStage?: string | null;
  errorCategory?: string | null;
  safeErrorMessage?: string | null;
  queuedAt?: Date | null;
  cancelRequestedAt?: Date | null;
  expiresAt?: Date | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
}

/** Everything a status change may write, minus the status itself. */
export type JobTransitionPatch = Omit<JobUpdatePatch, "status">;

/**
 * Guards shared by every write a worker makes about its own attempt.
 */
export interface JobWriteOptions {
  /**
   * The `attempts` value the row must still hold for this write to land — the
   * fencing token that stops a worker which has lost its job from writing to it.
   *
   * `attempts` counts *finished* attempts, so while attempt N is in flight the
   * row reads `N - 1`; every recovery of an abandoned attempt charges it and
   * bumps the count. That makes the counter monotonic per job and unique per
   * live attempt, which is the whole fence: a worker presenting the count it
   * started from is still the job's authority, and one presenting an older count
   * has been superseded and must not write.
   *
   * No new column, because the lifecycle already has a monotonic per-attempt
   * number and a second one could disagree with the row it describes. Also not a
   * random lease id: `attempts` is the value recovery *has* to write anyway, so
   * the fence cannot drift out of sync with the act of recovering.
   *
   * Absent means unfenced — for writes that are not about one attempt (a user's
   * cancellation request, a status change the lifecycle alone governs).
   */
  expectAttempts?: number;
}

export interface JobTransitionOptions extends JobWriteOptions {
  /**
   * Marks this write as a deliberate retry, which is the only way a `failed` or
   * `cancelled` job may return to `queued`. It unlocks nothing else.
   */
  retry?: boolean;
  /**
   * Marks this write as stale-job recovery, the only way a `running` job may
   * return to `queued`. It unlocks nothing else — in particular it cannot revive
   * a terminal job, because `RECOVERABLE_FROM` contains only `running`.
   *
   * Separate from `retry` on purpose: a user-facing retry must never be able to
   * requeue a job a live worker is holding. See the state machine.
   */
  recover?: boolean;
}

export interface IJobRepository {
  create(input: JobCreateInput): Promise<Job>;
  get(id: string): Promise<Job | null>;

  /**
   * Field write that is not a status change (attempt counters, progress stage,
   * diagnostics). Passing `status` here bypasses the lifecycle and is reserved
   * for adapters that have already checked it; prefer `transition`.
   *
   * Unconditional unless `opts.expectAttempts` is given, in which case it is a
   * compare-and-swap on that value and returns `null` when the row has moved on
   * — the same refusal shape as `transition`, because a fenced-out progress
   * write and a fenced-out status write are the same event: this worker no
   * longer owns the attempt.
   */
  update(
    id: string,
    patch: JobUpdatePatch,
    opts?: JobWriteOptions,
  ): Promise<Job | null>;

  /**
   * Guarded, compare-and-swap status change: applies `to` only if the job's
   * *current persisted* status permits it under
   * `src/domain/jobs/jobStateMachine.ts`, and only if that status has not
   * changed since it was read.
   *
   * Returns the updated job, or `null` when the move was refused — because the
   * lifecycle forbids it (`cancelled → completed`), because another process
   * moved the job first, or because `opts.expectAttempts` no longer matches the
   * row. Refusal is a normal, expected outcome that callers must handle: it is exactly what stops a worker from publishing
   * a result for a job the user has already cancelled, and what stops two
   * workers from both claiming the same queued job.
   */
  transition(
    id: string,
    to: JobStatus,
    patch?: JobTransitionPatch,
    opts?: JobTransitionOptions,
  ): Promise<Job | null>;

  listByStatus(status: JobStatus, limit?: number): Promise<Job[]>;

  /**
   * `running` jobs whose lease has expired — i.e. `updatedAt <= before` — oldest
   * first, for the stuck-job reaper.
   *
   * `updatedAt` *is* the lease. Every write to the row refreshes it: the claim
   * into `running`, each progress-stage write, a cancellation request. Nothing
   * new is stored to express "a worker is alive on this job", because the column
   * that already changes whenever a worker touches the job answers the same
   * question — and a second, parallel heartbeat column could disagree with the
   * row it describes.
   *
   * Filtered in the query rather than in the caller so the sweep is genuinely
   * bounded: `listByStatus("running", n)` would spend the whole window on live
   * jobs on a busy node and recover nothing.
   */
  listStaleRunning(before: Date, limit?: number): Promise<Job[]>;

  /**
   * Finds a job by its caller-supplied de-duplication key, scoped to an owner.
   *
   * Scoped by owner deliberately: an unscoped key would let one visitor collide
   * with (and therefore read) another visitor's job by guessing a key.
   */
  findByIdempotencyKey(
    ownerType: JobOwnerType,
    ownerId: string,
    idempotencyKey: string,
  ): Promise<Job | null>;

  /**
   * Jobs at or past `expiresAt` that the lifecycle can still move to `expired`,
   * oldest first, for the retention sweep.
   *
   * Scoped to expirable statuses on purpose — see `EXPIRABLE_STATUSES`. Returning
   * every past-due row would keep offering the sweep `failed` and `cancelled`
   * rows it can never expire, which in fixed-size oldest-first batches starves
   * the rows that still hold bytes.
   */
  listExpirable(now: Date, limit?: number): Promise<Job[]>;
}
