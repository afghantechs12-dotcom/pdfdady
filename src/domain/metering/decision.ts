import { ENFORCEABLE_METERS, METERS, type MeterKey } from "./meters";
import { retryAfterSecondsFor } from "./periods";
import { planLimitsFor, type PlanId, type PlanLimits } from "./plans";

/**
 * WHETHER an operation is allowed. The one place that decides.
 *
 * Pure: no clock, no database, no container. Everything it needs — the plan, the
 * current counters, the request, the mode — arrives as an argument, so every
 * denial and every near-miss is reproducible in a unit test. This is the
 * `executionPolicy.ts` of limits: before it exists, "are you allowed" gets
 * re-answered at each entry point, and the failure mode is a route that forgot.
 *
 * ── observe vs enforce ──────────────────────────────────────────────────────
 *
 * The decision always reports the TRUTHFUL verdict in `allowed`. `enforced` says
 * whether the caller will act on it. Observe mode therefore produces a complete
 * record of denials that *would* have happened, which is the only honest way to
 * calibrate a limit: you cannot pick a free-tier ceiling from first principles,
 * but you can watch a month of real traffic and see where a candidate ceiling
 * would have bitten and whom it would have hit.
 *
 * A caller must never read `allowed` alone to gate work — `shouldBlock()` is the
 * function that combines the two, so the mode cannot be forgotten at a call site.
 */
export type LimitMode = "off" | "observe" | "enforce";

export function isLimitMode(value: unknown): value is LimitMode {
  return value === "off" || value === "observe" || value === "enforce";
}

/**
 * Why an operation was refused. A closed union so the UI, the HTTP layer and the
 * analytics event all reason over the same set.
 */
export type DenyReason =
  | "meter_exhausted"
  | "file_too_large"
  | "too_many_concurrent";

/**
 * User-facing sentences. Like `safeMessageFor` in src/domain/jobs/jobErrors.ts,
 * these take no interpolated detail — there is no parameter through which a
 * caller could smuggle an internal number, a plan name or another user's usage
 * into a response. The structured fields carry the specifics for our own
 * surfaces; this carries what a stranger may read.
 */
const DENY_MESSAGES: Record<DenyReason, string> = {
  meter_exhausted:
    "You have reached your usage limit for now. It resets shortly — please try again then.",
  file_too_large: "That file is larger than your plan allows.",
  too_many_concurrent:
    "You already have several files processing. Please wait for one to finish and try again.",
};

export function denyMessageFor(reason: DenyReason): string {
  return DENY_MESSAGES[reason] ?? DENY_MESSAGES.meter_exhausted;
}

/** What the caller wants to do, in meter terms. */
export interface LimitRequest {
  /** Amount this operation would add, per meter. Absent meters are unaffected. */
  amounts: Partial<Record<MeterKey, number>>;
  /** Largest single input in this submission, for the file-size ceiling. */
  largestInputBytes: number;
  /** Non-terminal jobs this owner already has in flight. */
  activeOperations: number;
}

export interface LimitUsage {
  /** Current counter value per meter for the relevant window. Absent means zero. */
  counters: Partial<Record<MeterKey, number>>;
}

export interface EvaluateLimitsInput {
  plan: PlanId;
  usage: LimitUsage;
  request: LimitRequest;
  mode: LimitMode;
  /** Current instant — for the reset hint. Passed in; never read from the clock. */
  at: Date;
  /** Overrides the plan table. Tests and future per-owner grants only. */
  limits?: PlanLimits;
}

export interface MeterState {
  meter: MeterKey;
  limit: number | null;
  used: number;
  /** What this request would add. */
  requested: number;
  /** Allowance left BEFORE this request. Null when unlimited. */
  remaining: number | null;
  /** True when applying this request would exceed the allowance. */
  wouldExceed: boolean;
  resetAt: Date;
}

export interface LimitDecision {
  plan: PlanId;
  mode: LimitMode;
  /** The truthful verdict, regardless of mode. */
  allowed: boolean;
  /** Whether the verdict will actually be applied. False in off/observe. */
  enforced: boolean;
  reason: DenyReason | null;
  /** The meter that caused a `meter_exhausted` denial. */
  meter: MeterKey | null;
  limit: number | null;
  used: number;
  remaining: number | null;
  /** Safe to show a user. Null when allowed. */
  message: string | null;
  /** Seconds until the blocking window resets, for a Retry-After header. */
  retryAfterSeconds: number | null;
  /** Every enforceable meter's state, for the allowance snapshot. */
  meters: readonly MeterState[];
}

/**
 * Evaluates every limit and returns the first denial, checked cheapest-first.
 *
 * Order matters for the *message*, not for correctness: a 900MB upload from a
 * guest who is also out of operations should be told the file is too large,
 * because that is the thing they can act on. Telling them to wait for a daily
 * reset would send them back in an hour to hit the same wall.
 */
export function evaluateLimits(input: EvaluateLimitsInput): LimitDecision {
  const limits = input.limits ?? planLimitsFor(input.plan);
  const enforced = input.mode === "enforce";

  const meters: MeterState[] = ENFORCEABLE_METERS.map((meter) => {
    const definition = METERS[meter];
    const limit = limits.meters[meter] ?? null;
    const used = Math.max(0, input.usage.counters[meter] ?? 0);
    const requested = Math.max(0, input.request.amounts[meter] ?? 0);
    return {
      meter,
      limit,
      used,
      requested,
      remaining: limit === null ? null : Math.max(0, limit - used),
      // `>` not `>=`: a limit of 100 must admit the operation that brings the
      // total to exactly 100. Using `>=` would silently make every allowance
      // one smaller than it claims to be.
      wouldExceed: limit !== null && used + requested > limit,
      resetAt: new Date(input.at.getTime() + retryAfterSecondsFor(definition.window, input.at) * 1000),
    };
  });

  const base = {
    plan: input.plan,
    mode: input.mode,
    enforced,
    meters,
  };

  const allow = (): LimitDecision => ({
    ...base,
    allowed: true,
    reason: null,
    meter: null,
    limit: null,
    used: 0,
    remaining: null,
    message: null,
    retryAfterSeconds: null,
  });

  // 1. File size — actionable, and checkable without any counter.
  if (input.request.largestInputBytes > limits.maxFileBytes) {
    return {
      ...base,
      allowed: false,
      reason: "file_too_large",
      meter: null,
      limit: limits.maxFileBytes,
      used: input.request.largestInputBytes,
      remaining: 0,
      message: denyMessageFor("file_too_large"),
      retryAfterSeconds: null,
      // No Retry-After: waiting changes nothing about the file's size, and a
      // header suggesting otherwise would send the client back to fail again.
    };
  }

  // 2. Concurrency — transient, and clears on its own.
  if (input.request.activeOperations >= limits.maxConcurrentJobs) {
    return {
      ...base,
      allowed: false,
      reason: "too_many_concurrent",
      meter: null,
      limit: limits.maxConcurrentJobs,
      used: input.request.activeOperations,
      remaining: 0,
      message: denyMessageFor("too_many_concurrent"),
      retryAfterSeconds: 15,
    };
  }

  // 3. Meters — the allowance proper.
  const exhausted = meters.find((m) => m.wouldExceed);
  if (exhausted) {
    return {
      ...base,
      allowed: false,
      reason: "meter_exhausted",
      meter: exhausted.meter,
      limit: exhausted.limit,
      used: exhausted.used,
      remaining: exhausted.remaining,
      message: denyMessageFor("meter_exhausted"),
      retryAfterSeconds: retryAfterSecondsFor(METERS[exhausted.meter].window, input.at),
    };
  }

  return allow();
}

/**
 * The ONLY function a caller should gate work on.
 *
 * Combining `allowed` and `enforced` here rather than at each call site is what
 * makes observe mode safe: a route cannot accidentally start blocking traffic by
 * reading `allowed` and forgetting the mode, because the mode is not its
 * business.
 */
export function shouldBlock(decision: LimitDecision): boolean {
  return !decision.allowed && decision.enforced;
}

/**
 * Whether this decision is worth recording as a limit event.
 *
 * True for a real denial AND for an observe-mode would-have-denied — the latter
 * is the entire dataset that makes enforcement calibratable rather than a guess.
 */
export function isReportableDenial(decision: LimitDecision): boolean {
  return !decision.allowed && decision.mode !== "off";
}
