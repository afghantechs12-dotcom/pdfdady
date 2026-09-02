import { ENFORCEABLE_METERS, type MeterKey } from "./meters";
import type { LimitMode } from "./decision";
import { meterLimitFor, ALL_PLAN_IDS, type PlanId } from "./plans";

/**
 * WHETHER we have seen enough real traffic to turn a limit on. Pure.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * `plans.ts` already carries numbers, and its own doc comment admits what they
 * are: headroom picked so that nothing regresses, not ceilings derived from
 * usage. The tempting next step is to look at a dashboard, decide the numbers
 * "look about right", and flip `USAGE_LIMIT_MODE` to `enforce`. That is the
 * expensive mistake — a ceiling calibrated from a week of pre-launch traffic is
 * calibrated against almost nobody, and the first thing it does at scale is
 * refuse work from the users who matter most.
 *
 * So this module's job is mostly to say **no**, and to say it for a reason a
 * reader can check. `ready_for_enforcement` is false until the observation
 * itself clears explicit thresholds, and when it is false the `reason` and
 * `gaps` name exactly what is missing rather than leaving "not yet" to
 * interpretation.
 *
 * ── Why it recommends nothing when the data is thin ─────────────────────────
 *
 * A recommendation derived from insufficient data is worse than no
 * recommendation, because it *looks* like evidence. `LimitRecommendation` is a
 * discriminated union with an `insufficient_data` arm carrying no number at all,
 * so there is no field a caller could read and mistake for a calibrated figure.
 * The alternative — a number plus a `confidence: "low"` flag — is the shape that
 * gets shipped anyway once someone is in a hurry.
 *
 * ── What this deliberately does NOT claim ───────────────────────────────────
 *
 * `operationsPerDay` is a MEAN over the window, and it is named and typed as
 * one. The ledger is aggregated by tool and by dimension, not by day, so no
 * percentile of daily volume is available from it — and a p95 fabricated from a
 * mean is the exact kind of invented number the paragraph above is about. When a
 * per-day distribution is needed, it needs a per-day grouping first.
 */

/**
 * How long the ledger must have been observing before a limit may be enforced.
 *
 * Two weeks, because the unit of variation in document work is the week: month
 * ends, Mondays, and the reporting cycles that produce the days a limit would
 * actually bite on. One week of data cannot distinguish "this is our volume"
 * from "this is what one busy week looks like".
 */
export const MIN_OBSERVATION_DAYS = 14;

/**
 * How many metered operations must be in the window.
 *
 * Deliberately modest: this is a floor below which the arithmetic is meaningless,
 * not a target. Fifty operations across two weeks describes a handful of sessions
 * and cannot support any ceiling at all.
 */
export const MIN_OBSERVED_OPERATIONS = 500;

/**
 * How many distinct tools must have activity.
 *
 * A ceiling calibrated on one tool's traffic is a ceiling for that tool. There
 * are fourteen server tools with very different cost profiles, and a limit tuned
 * on compression alone would be wrong for OCR in one direction and wrong for
 * unlock in the other.
 */
export const MIN_OBSERVED_TOOLS = 3;

/** One labelled bucket of a grouped count. Mirrors the reporting shape. */
export interface ObservationBucket {
  label: string;
  count: number;
}

/** What one tool did over the observation window. */
export interface ToolObservation {
  toolSlug: string;
  /** From the execution policy; null for a slug that is no longer registered. */
  executionMode: "local" | "remote_job" | null;
  /** Attempts with a recorded outcome. A retried job contributes more than one. */
  operations: number;
  failures: number;
  /** failures / operations, 0–1. Null when nothing ran — never 0. */
  failureRate: number | null;
  computeUnits: number;
  inputBytes: number;
  /** Mean over attempts that reported a duration; null when none did. */
  averageDurationMs: number | null;
  /** How many attempts the mean is built from, so a thin sample is visible. */
  durationSamples: number;
}

/** Everything the readiness question is answered from. Assembled by the caller. */
export interface CalibrationObservation {
  /**
   * Distinct calendar days inside the window that carry observed server traffic.
   *
   * MEASURED coverage, not the span the caller asked for. That distinction is the
   * whole value of the field: while this was the window span, `MIN_OBSERVATION_DAYS`
   * was satisfiable by widening a date picker over one busy day and unsatisfiable
   * by the default seven-day window no matter how long the deployment had been
   * observing. Neither reading had anything to do with how much traffic had
   * actually been seen.
   */
  days: number;
  /** The mode the deployment is actually running in right now. */
  limitMode: LimitMode;
  /**
   * Attempts with a recorded outcome over the window, ALL tools — including local
   * ones and slugs the registry no longer knows.
   *
   * Reported whole because it is the measurement. The readiness gate deliberately
   * does not use it: see `serverOperationsOf`.
   */
  operations: number;
  tools: readonly ToolObservation[];
  /** Input sizes by coarse bucket, from `sizeBucket`. */
  inputSizeBuckets: readonly ObservationBucket[];
  /** Population split by owner type: `anon` (guest), `user`, `system`. */
  population: readonly ObservationBucket[];
  /**
   * `limit_reached` rows in the window.
   *
   * In observe mode every one of these is a would-have-blocked event: the
   * decision was truthful and the caller did not act on it. That equivalence is
   * only valid while the mode IS observe, which is why `limitMode` travels with
   * the count instead of the caller being trusted to remember.
   */
  limitEvents: number;
  /** True when any query behind these numbers failed. They are then floors. */
  degraded: boolean;
}

/** Why enforcement is or is not ready. Closed, so a UI can branch exhaustively. */
export type ReadinessReason =
  | "insufficient_observation_data"
  | "observation_degraded"
  | "not_observing"
  | "already_enforcing"
  | "observation_sufficient";

export interface EnforcementReadiness {
  /**
   * Snake_case because it is a wire field the brief names verbatim, and because
   * the one thing that must never happen to it is a silent rename that leaves a
   * consumer reading `undefined` — which is falsy, and so would look like a
   * cautious "no" while actually meaning "the check is gone".
   */
  ready_for_enforcement: boolean;
  reason: ReadinessReason;
  /** What is missing, in the order a reader would fix it. Empty when ready. */
  gaps: readonly string[];
  thresholds: {
    minObservationDays: number;
    minOperations: number;
    minTools: number;
  };
  observed: {
    /** Distinct days with observed server traffic. Measured, not requested. */
    days: number;
    /**
     * Server operations only — the figure the threshold is applied to.
     *
     * Not `observation.operations`. See `serverOperationsOf` for why a local run
     * must never help authorize a server ceiling.
     */
    operations: number;
    /**
     * Attempts excluded from `operations` because their tool does not run on the
     * server. Surfaced so the exclusion is visible rather than a silent gap
     * between two operation counts on one page.
     */
    excludedOperations: number;
    /** Mean per day over the days observed. Not a percentile — see the module note. */
    operationsPerDay: number;
    toolsObserved: number;
    guestShare: number | null;
    /** Would-have-blocked count while in observe mode; null in any other mode. */
    wouldHaveBlocked: number | null;
  };
}

/**
 * Guest traffic as a share of the population, or null when nothing was recorded.
 *
 * Null rather than 0: "no events" and "no guests" are different facts, and a
 * dashboard that renders 0% for the first one reports an empty ledger as a
 * product with no anonymous visitors.
 */
export function guestShareOf(population: readonly ObservationBucket[]): number | null {
  const total = population.reduce((sum, b) => sum + b.count, 0);
  if (total <= 0) return null;
  const guests = population
    .filter((b) => b.label === "anon")
    .reduce((sum, b) => sum + b.count, 0);
  return guests / total;
}

/**
 * The tools whose traffic may authorize a server limit.
 *
 * The meters being calibrated (`server_operations`, `server_input_bytes`) count
 * work the server did. A tool that runs entirely in the browser consumes none of
 * it — and yet its attempts reach the same ledger, because the settlement path
 * records an attempt row before it discovers the tool is unmetered. Left in, a
 * fortnight of in-browser merges would clear a threshold guarding a ceiling on
 * server jobs, and the first thing that ceiling would do is refuse work it was
 * never calibrated against.
 *
 * `executionMode` comes from the execution policy, not from the row's own claim,
 * so a caller cannot promote a local tool by labelling it. A null mode — a slug
 * the registry no longer knows — is excluded for the same reason: unattributable
 * traffic cannot vouch for anything.
 */
export function serverOperationsOf(tools: readonly ToolObservation[]): number {
  return tools
    .filter((t) => t.executionMode === "remote_job")
    .reduce((sum, t) => sum + t.operations, 0);
}

export function assessEnforcementReadiness(
  observation: CalibrationObservation,
): EnforcementReadiness {
  const serverTools = observation.tools.filter((t) => t.executionMode === "remote_job");
  const toolsObserved = serverTools.filter((t) => t.operations > 0).length;
  const operations = serverOperationsOf(observation.tools);
  const days = Math.max(1, Math.trunc(observation.days));
  const observed = {
    days: observation.days,
    operations,
    // Never negative in practice, but clamped anyway: `operations` and `tools`
    // are assembled by the caller, and a total that lagged its own breakdown
    // would otherwise render as "-3 operations excluded".
    excludedOperations: Math.max(0, observation.operations - operations),
    operationsPerDay: operations / days,
    toolsObserved,
    guestShare: guestShareOf(observation.population),
    // Only meaningful in observe mode: in `enforce` these rows are real refusals
    // and in `off` the decision never ran, so reporting either as
    // "would have blocked" would be a category error.
    wouldHaveBlocked: observation.limitMode === "observe" ? observation.limitEvents : null,
  };

  const gaps: string[] = [];
  if (observation.days < MIN_OBSERVATION_DAYS) {
    gaps.push(
      `observed ${observation.days} of ${MIN_OBSERVATION_DAYS} required days`,
    );
  }
  if (operations < MIN_OBSERVED_OPERATIONS) {
    gaps.push(
      `observed ${operations} of ${MIN_OBSERVED_OPERATIONS} required server operations`,
    );
  }
  if (toolsObserved < MIN_OBSERVED_TOOLS) {
    gaps.push(`observed ${toolsObserved} of ${MIN_OBSERVED_TOOLS} required tools`);
  }

  const thresholds = {
    minObservationDays: MIN_OBSERVATION_DAYS,
    minOperations: MIN_OBSERVED_OPERATIONS,
    minTools: MIN_OBSERVED_TOOLS,
  };

  // Degradation first, and unconditionally: a partial query makes every number
  // above a floor rather than a total, and a floor can clear a threshold that the
  // real value would also have cleared — or that it would not. Either way the
  // observation is not the thing that was measured, so it cannot authorize
  // anything. This is checked before the counts so that a degraded read can never
  // be the report that says "ready".
  if (observation.degraded) {
    return {
      ready_for_enforcement: false,
      reason: "observation_degraded",
      gaps: ["at least one usage query failed; the counts are floors, not totals"],
      thresholds,
      observed,
    };
  }

  if (gaps.length > 0) {
    return {
      ready_for_enforcement: false,
      reason: "insufficient_observation_data",
      gaps,
      thresholds,
      observed,
    };
  }

  // Enough data — but "enough data" is not the same as "ready", and the mode
  // decides which. `off` means the decision never even ran, so there are no
  // would-have-blocked rows behind these totals and nothing has been calibrated
  // against; `enforce` means the question is already answered.
  if (observation.limitMode === "off") {
    return {
      ready_for_enforcement: false,
      reason: "not_observing",
      gaps: ["USAGE_LIMIT_MODE is off, so no limit decisions are being recorded"],
      thresholds,
      observed,
    };
  }
  if (observation.limitMode === "enforce") {
    return {
      ready_for_enforcement: false,
      reason: "already_enforcing",
      gaps: [],
      thresholds,
      observed,
    };
  }

  return {
    ready_for_enforcement: true,
    reason: "observation_sufficient",
    gaps: [],
    thresholds,
    observed,
  };
}

/**
 * A calibrated ceiling for one meter on one plan, or an honest refusal.
 *
 * The `available` arm carries the arithmetic that produced it — `basisPerDay` and
 * `headroomFactor` — because a recommendation nobody can reconstruct is a
 * recommendation nobody can argue with, and a limit is exactly the kind of number
 * that should be argued with before it refuses someone's work.
 */
export type LimitRecommendation =
  | {
      status: "insufficient_data";
      meter: MeterKey;
      plan: PlanId;
      /** Today's configured allowance, for comparison. Null when unlimited. */
      currentLimit: number | null;
    }
  | {
      status: "available";
      meter: MeterKey;
      plan: PlanId;
      currentLimit: number | null;
      /** Observed mean per day for the whole population. */
      basisPerDay: number;
      /** Multiple of the mean the suggestion leaves as headroom. */
      headroomFactor: number;
      suggestedPerDay: number;
    };

/**
 * Headroom over the observed mean.
 *
 * A limit set at the mean refuses roughly half of all days. Ten times the mean is
 * an abuse ceiling rather than a product gate, which is what these meters are
 * for — and it is a round number, so nobody will mistake it for the output of a
 * model. It is deliberately crude: the honest precision available from a mean
 * with no daily distribution behind it is about one significant figure.
 */
export const RECOMMENDATION_HEADROOM_FACTOR = 10;

/**
 * Per-plan, per-meter recommendations — every one `insufficient_data` until the
 * readiness verdict says otherwise.
 *
 * The gate is `assessEnforcementReadiness`, not a second set of thresholds here.
 * Two places that decide "is the data good enough" is one place that will
 * disagree with the other, and the disagreeing one will be the one that ships a
 * number.
 */
export function recommendLimits(
  observation: CalibrationObservation,
  readiness: EnforcementReadiness = assessEnforcementReadiness(observation),
): LimitRecommendation[] {
  const out: LimitRecommendation[] = [];

  for (const plan of ALL_PLAN_IDS) {
    for (const meter of ENFORCEABLE_METERS) {
      const currentLimit = meterLimitFor(plan, meter);
      if (!readiness.ready_for_enforcement) {
        out.push({ status: "insufficient_data", meter, plan, currentLimit });
        continue;
      }
      // Only `server_operations` has an observed per-day basis in the ledger
      // aggregate. A byte meter would need input bytes per owner per day, which
      // the current grouping does not produce — so it stays honest instead of
      // borrowing the operations figure and calling it bytes.
      if (meter !== "server_operations") {
        out.push({ status: "insufficient_data", meter, plan, currentLimit });
        continue;
      }
      // The readiness figure, not a second derivation of it. `observation.operations`
      // includes local attempts, and a ceiling for a server meter derived from
      // browser work would be a number about the wrong machine.
      const basisPerDay = readiness.observed.operationsPerDay;
      out.push({
        status: "available",
        meter,
        plan,
        currentLimit,
        basisPerDay,
        headroomFactor: RECOMMENDATION_HEADROOM_FACTOR,
        suggestedPerDay: Math.ceil(basisPerDay * RECOMMENDATION_HEADROOM_FACTOR),
      });
    }
  }

  return out;
}
