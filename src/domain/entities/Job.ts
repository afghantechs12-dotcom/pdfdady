/**
 * Persisted job status values.
 *
 * `running` is the brief's PROCESSING state — see
 * `src/domain/jobs/jobStateMachine.ts` for why the older column value is kept.
 * `created` and `expired` are additions: a job now exists as a durable record
 * *before* it is offered to the queue (so a crash between "record written" and
 * "queued" is recoverable rather than invisible), and a completed job whose
 * output has been purged is `expired` rather than pretending its result is
 * still downloadable.
 */
export type JobStatus =
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * Statuses from which no further work happens on its own.
 *
 * Kept for existing callers; `src/domain/jobs/jobStateMachine.ts` is the
 * authority and re-exports the same set including `expired`.
 */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * Who a job belongs to.
 *
 * `anon` is a real owner, not a placeholder: an unauthenticated visitor gets a
 * per-session identifier so their job is still theirs, and someone else's job
 * id is still not enough to read it. `system` covers internally-scheduled work
 * (the retention sweep) that no user may address.
 */
export type JobOwnerType = "user" | "anon" | "system";

/**
 * A unit of background work.
 *
 * The fields fall into four groups: identity (`id`/`type`/`toolSlug`),
 * ownership (`ownerType`/`ownerId`/`workspaceId`), lifecycle
 * (`status`/`attempts`/timestamps/`progressStage`), and outcome
 * (`result`/`error`/`errorCategory`/`safeErrorMessage`).
 *
 * `payload` and `result` hold *references* — storage keys, sizes, option maps —
 * never document bytes. Sizes are recorded in dedicated columns because usage
 * reporting needs them after `result` has been purged.
 *
 * Everything added in this phase is nullable so that rows written before it,
 * and the many existing job types that do not participate in the processing
 * lifecycle, remain valid without a data rewrite.
 */
export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  /** JSON-serializable input reference metadata. Never document bytes. */
  payload: unknown;
  /** JSON-serializable output reference metadata, or null until completion. */
  result: unknown | null;
  /** Internal diagnostic text. NOT user-facing — see `safeErrorMessage`. */
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;

  /** Owner class. Null on legacy rows and non-user-addressable job types. */
  ownerType: JobOwnerType | null;
  /** Stable per-user or per-anonymous-session identifier. */
  ownerId: string | null;
  /** Set when the job was started from inside a workspace. */
  workspaceId: string | null;
  /** The tool this job runs, e.g. `compress-pdf`. Null for infrastructure jobs. */
  toolSlug: string | null;
  /** Caller-supplied de-duplication key, unique per owner. */
  idempotencyKey: string | null;
  /** Named stage the worker last reported. See domain/jobs/progressStage.ts. */
  progressStage: string | null;
  /** Stable machine-readable failure class. See domain/jobs/jobErrors.ts. */
  errorCategory: string | null;
  /** The only failure text that may be shown to a user. */
  safeErrorMessage: string | null;
  /** When the job was handed to the queue (distinct from when it was created). */
  queuedAt: Date | null;
  /** When cancellation was *requested* — the worker may still be winding down. */
  cancelRequestedAt: Date | null;
  /** When the staged input / stored output stops being available. */
  expiresAt: Date | null;
  /** Total input bytes, retained for usage reporting after purge. */
  inputBytes: number | null;
  /** Total output bytes, retained for usage reporting after purge. */
  outputBytes: number | null;
}
