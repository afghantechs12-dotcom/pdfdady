import type { JobStatus } from "@/src/domain/entities/Job";

/**
 * The authoritative job lifecycle, as a pure state machine.
 *
 * The brief's vocabulary is CREATED → QUEUED → PROCESSING → COMPLETED, with
 * FAILED / CANCELLED / EXPIRED as the other terminal outcomes. The persisted
 * column values predate that vocabulary and use `running` for PROCESSING, so
 * that word is kept on the wire — renaming it would require rewriting existing
 * rows for no behavioural gain, and this module documents the mapping instead.
 * `LIFECYCLE_NAME` exists so reports and logs can speak the brief's language
 * without a second, drifting status union.
 *
 * Why a separate module rather than `if` checks at the call sites: the invalid
 * transitions below are not stylistic preferences, they are correctness
 * guarantees. "A cancelled job never publishes a result" is only true if
 * `cancelled → completed` is unrepresentable, and that can only be enforced in
 * one place. Every status write in the system funnels through
 * `IJobRepository.transition`, which asks this function.
 */
export const LIFECYCLE_NAME: Record<JobStatus, string> = {
  created: "CREATED",
  queued: "QUEUED",
  running: "PROCESSING",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  expired: "EXPIRED",
};

/** Every status a job can hold, in lifecycle order. */
export const ALL_JOB_STATUSES: readonly JobStatus[] = [
  "created",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
];

/**
 * Ordinary (non-retry) transitions. Read as "from → the set it may enter".
 *
 * - `created` can be abandoned (`cancelled`) or rejected before it is ever
 *   queued (`failed` — e.g. validation ran after the record was written).
 * - `queued` can expire: its staged input has a TTL, and a job that outlives
 *   its input is not runnable.
 * - `running` reaches exactly one of the three real outcomes.
 * - `completed` can only decay to `expired` (its output was purged). It can
 *   NEVER go back to `running`: the result has already been handed out.
 * - `failed`, `cancelled` and `expired` are terminal here; the only way out of
 *   the first two is the deliberate retry command below.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  created: new Set<JobStatus>(["queued", "cancelled", "failed"]),
  queued: new Set<JobStatus>(["running", "cancelled", "failed", "expired"]),
  running: new Set<JobStatus>(["completed", "failed", "cancelled"]),
  completed: new Set<JobStatus>(["expired"]),
  failed: new Set<JobStatus>([]),
  cancelled: new Set<JobStatus>([]),
  expired: new Set<JobStatus>([]),
};

/**
 * Statuses a deliberate retry command may move back to `queued`.
 *
 * `expired` is deliberately excluded even though retry is otherwise a licence
 * to re-enter the lifecycle: an expired job's staged input has been deleted, so
 * "retry" would queue work that is guaranteed to fail on a missing input. The
 * honest answer to "retry this expired job" is "re-upload", and
 * `ProcessingJobService.retryJob` says so rather than queueing a doomed attempt.
 */
export const RETRYABLE_FROM: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "failed",
  "cancelled",
]);

/**
 * Statuses a stale-job recovery may move back to `queued`.
 *
 * Exactly one, and deliberately not folded into `RETRYABLE_FROM`. `retry` is a
 * *user* command, and `ProcessingJobService.retryJob` tells the user "Only a
 * failed or cancelled job can be retried" — which has to stay true, because a
 * user who could requeue a `running` job could start a second Ghostscript run on
 * a job that is already being processed. Recovery is the opposite situation: the
 * worker holding the job is gone, proven by a stale lease, and `running` is the
 * only status that can be abandoned that way.
 *
 * A separate flag also means the recovery path cannot be reached by accident.
 * Nothing in the ordinary table permits `running → queued`, so every requeue of
 * a live-looking job has to name itself.
 */
export const RECOVERABLE_FROM: ReadonlySet<JobStatus> = new Set<JobStatus>(["running"]);

/**
 * Statuses a job can actually be moved to `expired` from, derived from the table
 * above rather than restated.
 *
 * The retention sweep needs this: selecting every past-due row regardless of
 * status would keep handing it `failed` and `cancelled` rows, whose expiry the
 * lifecycle refuses. Ordered oldest-first and taken in fixed-size batches, those
 * permanently-refused rows would fill the window and starve the `completed` rows
 * that genuinely still hold bytes.
 */
export const EXPIRABLE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>(
  (Object.keys(ALLOWED_TRANSITIONS) as JobStatus[]).filter((from) =>
    ALLOWED_TRANSITIONS[from].has("expired"),
  ),
);

/** Statuses from which no further work will happen without an explicit retry. */
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

/** True when the job has stopped moving on its own. */
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** True when a result may legitimately be served for this status. */
export function canPublishResult(status: JobStatus): boolean {
  return status === "completed";
}

/** Whether `from → to` is a legal ordinary transition. Self-transitions are not. */
export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.has(to) ?? false;
}

/** Whether an explicit retry command may move this status back to `queued`. */
export function canRetryTransition(from: JobStatus): boolean {
  return RETRYABLE_FROM.has(from);
}

/** Whether a stale-job recovery may move this status back to `queued`. */
export function canRecoverTransition(from: JobStatus): boolean {
  return RECOVERABLE_FROM.has(from);
}

/**
 * Whether a write is permitted, given which privileged command the caller is
 * invoking. Each flag still has to be what it claims: both only unlock
 * `→ queued`, and only from their own set of statuses.
 *
 * A terminal job is unreachable by recovery for the same structural reason a
 * cancelled job cannot complete — `completed`, `failed`, `cancelled` and
 * `expired` are simply absent from `RECOVERABLE_FROM`, so "a finished job is
 * never resurrected by the reaper" is a property of this table rather than of a
 * check someone has to remember to write at the call site.
 */
export function isTransitionAllowed(
  from: JobStatus,
  to: JobStatus,
  opts: { retry?: boolean; recover?: boolean } = {},
): boolean {
  if (canTransition(from, to)) return true;
  if (Boolean(opts.retry) && to === "queued" && canRetryTransition(from)) return true;
  return Boolean(opts.recover) && to === "queued" && canRecoverTransition(from);
}

/** Thrown when application code attempts a transition the lifecycle forbids. */
export class InvalidJobTransitionError extends Error {
  readonly from: JobStatus;
  readonly to: JobStatus;

  constructor(from: JobStatus, to: JobStatus) {
    super(
      `Invalid job transition ${LIFECYCLE_NAME[from] ?? from} -> ${LIFECYCLE_NAME[to] ?? to}`,
    );
    this.name = "InvalidJobTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** `isTransitionAllowed`, but throwing — for call sites where refusal is a bug. */
export function assertTransition(
  from: JobStatus,
  to: JobStatus,
  opts: { retry?: boolean; recover?: boolean } = {},
): void {
  if (!isTransitionAllowed(from, to, opts)) {
    throw new InvalidJobTransitionError(from, to);
  }
}
