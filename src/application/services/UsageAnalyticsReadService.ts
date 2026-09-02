import type { ILogger } from "@/src/application/ports/Logger";
import type {
  DimensionCountRow,
  EventCountRow,
  IUsageRepository,
  ToolEventCountRow,
  ToolUsageRow,
  UsageWindow,
} from "@/src/application/ports/metering/UsageRepository";
import {
  ANALYTICS_EVENTS,
  type AnalyticsEventName,
} from "@/src/domain/metering/events";
import {
  FUNNEL_STEPS,
  LOCAL_FUNNEL_STEPS,
  rollupFunnel,
  worstFunnelStep,
  type FunnelStepRollup,
} from "@/src/domain/metering/funnel";
import { executionModeForSlug, REMOTE_JOB_TOOL_SLUGS } from "@/lib/tools/executionPolicy";
import {
  assessEnforcementReadiness,
  recommendLimits,
  type CalibrationObservation,
  type EnforcementReadiness,
  type LimitRecommendation,
  type ObservationBucket,
} from "@/src/domain/metering/readiness";
import type { LimitMode } from "@/src/domain/metering/decision";

/**
 * The READ half of usage. Everything the admin analytics surface is allowed to
 * know, and nothing else.
 *
 * ── Why a separate service from UsageMeteringService ────────────────────────
 *
 * Same reason `ProductAnalyticsService` is separate: the token you can resolve
 * bounds what the caller can do. This class holds one dependency it only ever
 * *queries*, and has no code path to `incrementCounters` or `recordEvent`. So an
 * admin dashboard — a page anyone with a session cookie can refresh in a loop —
 * cannot move a quota counter or write a row into the ledger it is reading. A
 * "read model" that shares a class with the writer is a read model in name only.
 *
 * ── Why the browser never receives a UsageEvent ─────────────────────────────
 *
 * Every method here returns aggregates: counts, sums, means, and ratios. There is
 * deliberately no method that returns rows, because a row is where the data that
 * must not travel lives — `subjectHash` is designed to be unlinkable, and the
 * moment a page holds a list of them it holds a visitor list, whatever the column
 * is called. A group-by cannot leak an individual; a `findMany` can, and the port
 * offers this service no way to ask for one.
 *
 * ── Why the window is bounded before it is used ─────────────────────────────
 *
 * `from`/`to` arrive from a query string, so they are attacker-supplied even
 * behind an admin cookie. An unbounded range makes an admin page a table scan of
 * the entire ledger — the cheapest denial of service in the product, and one that
 * gets slower every day it collects data. `boundReportWindow` clamps first and
 * reports that it did, so a truncated range shows as truncated instead of reading
 * as "that is all the data there is".
 *
 * ── Why nothing here throws ────────────────────────────────────────────────
 *
 * The same rule the rest of the metering stack follows. This service is only
 * *read* by an admin page today, so a throw could not reach a PDF tool — but the
 * rule is enforced here rather than assumed, because the next caller of a read
 * service is usually a page that also renders something a user needs. A failed
 * query returns zeroes and `degraded: true`; a dashboard that cannot tell "no
 * activity" from "the query failed" will confidently report an outage as calm.
 */

/** Longest window the report will read. See the note above on unbounded ranges. */
export const MAX_REPORT_DAYS = 92;

/** Window used when the caller names neither bound. */
export const DEFAULT_REPORT_DAYS = 7;

/**
 * Window the CALIBRATION read defaults to, which is not the dashboard's.
 *
 * The dashboard default answers "what is happening lately", and a week is the
 * right answer to that. Readiness asks a different question, and against a
 * fortnight threshold a seven-day default could never answer it yes: however long
 * the deployment had been observing, at most seven distinct days fit inside the
 * window, so the days gap was permanent and structural rather than a fact about
 * traffic.
 *
 * Thirty rather than exactly `MIN_OBSERVATION_DAYS`, because a fourteen-day window
 * would demand traffic on all fourteen consecutive days — one quiet Sunday and the
 * count can never reach the threshold. The threshold itself is untouched: fourteen
 * distinct days must still each carry real server traffic.
 */
export const CALIBRATION_DEFAULT_DAYS = 30;

/** Most tools listed in the top-tools table. The rest are counted, not dropped silently. */
export const TOP_TOOLS_LIMIT = 8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The events that describe a *completed* piece of work, local or remote.
 *
 * `tool_view` is excluded even though it carries an `executionMode`: it would
 * make "local activity" mostly a page-view count, and the number would then rise
 * when a tool is *less* used but more browsed.
 */
const OUTCOME_EVENTS: readonly AnalyticsEventName[] = [
  ANALYTICS_EVENTS.job_succeeded,
  ANALYTICS_EVENTS.job_failed,
  ANALYTICS_EVENTS.tool_processing_completed,
];

/**
 * The tool whose funnel is shown first when the caller names none.
 *
 * A default, no longer a limit: every local tool reports its funnel now, so the
 * dashboard compares them. This stays because a dashboard that opens on nothing
 * makes the reader choose before they have seen anything to choose between, and
 * Merge is the highest-volume local tool.
 */
export const FUNNEL_TOOL_SLUG = "merge-pdf";

/** How many tool funnels are compared at once. The rest are counted, not hidden. */
export const FUNNEL_TOOLS_LIMIT = 6;

export interface ReportWindowRequest {
  /** ISO date or datetime. Ignored when unparseable. */
  from?: string | null;
  to?: string | null;
  /**
   * Which tool's funnel to feature. An unknown slug falls back to the default
   * rather than erroring, for the same reason an unparseable date does: a
   * bookmarked dashboard should survive a tool being renamed.
   */
  funnelToolSlug?: string | null;
}

export interface BoundedReportWindow extends UsageWindow {
  /** Whole days spanned, rounded up. Always at least 1. */
  days: number;
  /** True when a requested bound was moved. Surfaced so the UI can say so. */
  clamped: boolean;
}

/**
 * Clamps a requested range to something safe to query. Pure, so the policy is
 * testable without a database.
 *
 * The rules, and the failure each one prevents:
 *
 *  - An unparseable bound is *ignored* rather than rejected. A 400 on a bad date
 *    turns a bookmarked dashboard into an error page after a format change; the
 *    default window is a useful answer to a malformed question.
 *  - `to` is never in the future. A future bound reads as "no data recently",
 *    which is indistinguishable from an ingest outage.
 *  - `from` must precede `to`. Reversed bounds otherwise produce an empty report
 *    that looks like a dead product.
 *  - The span is capped at `MAX_REPORT_DAYS`, moving `from` forward, not `to`
 *    back: the recent end is the end anyone is looking at.
 *
 * `defaultDays` is the span used when the caller names no `from`. It is a
 * parameter because the calibration read needs a wider default than the
 * dashboard — see `CALIBRATION_DEFAULT_DAYS`.
 */
export function boundReportWindow(
  request: ReportWindowRequest,
  now: Date,
  defaultDays: number = DEFAULT_REPORT_DAYS,
): BoundedReportWindow {
  const requestedFrom = parseInstant(request.from);
  const requestedTo = parseInstant(request.to);
  let clamped = false;

  // A named bound that could not be parsed is a clamp: the caller asked for
  // something and got the default, and silently substituting is how a dashboard
  // shows the wrong week without saying so.
  if (request.from && !requestedFrom) clamped = true;
  if (request.to && !requestedTo) clamped = true;

  let to = requestedTo ?? now;
  if (to.getTime() > now.getTime()) {
    to = now;
    clamped = true;
  }

  let from = requestedFrom ?? new Date(to.getTime() - defaultDays * MS_PER_DAY);
  if (from.getTime() >= to.getTime()) {
    from = new Date(to.getTime() - MS_PER_DAY);
    clamped = true;
  }
  if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * MS_PER_DAY) {
    from = new Date(to.getTime() - MAX_REPORT_DAYS * MS_PER_DAY);
    clamped = true;
  }

  return {
    from,
    to,
    days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY)),
    clamped,
  };
}

function parseInstant(raw: string | null | undefined): Date | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Server-side processing totals over the window. One row per *attempt*, not per job. */
export interface ProcessingTotals {
  /** Attempts that reported an outcome. A retried job contributes more than one. */
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** succeeded / runs, 0–1. Null when nothing ran — never 0, which would read as total failure. */
  successRate: number | null;
  inputBytes: number;
  computeUnits: number;
  /** Mean over attempts that reported a duration; null when none did. */
  averageDurationMs: number | null;
  /** How many attempts that mean is built from, so a thin sample is visible. */
  durationSamples: number;
}

export interface LabelledCount {
  label: string;
  count: number;
}

export interface FunnelReport {
  toolSlug: string;
  /**
   * Which spine this funnel was measured against.
   *
   * Reported rather than implied: a local tool has no `job_submitted` step and a
   * server tool does, so two funnels in the same table are only comparable if the
   * reader can see that they are counting different sequences. `null` is a tool
   * the execution policy no longer recognises — a slug that was renamed or
   * retired while its events were still in the window.
   */
  executionMode: "local" | "remote_job" | null;
  /**
   * What a step's `count` counts. Stated in the payload rather than in a doc
   * comment nobody reading the dashboard will see.
   */
  countUnit: "events";
  steps: FunnelStepRollup[];
  /** `job_failed` beside the funnel, not inside it. See LOCAL_FUNNEL_STEPS. */
  failed: number;
  /** Largest absolute drop, or null when nobody was lost. */
  worstStep: AnalyticsEventName | null;
}

export interface AnalyticsReport {
  window: { from: string; to: string; days: number; clamped: boolean };
  processing: ProcessingTotals;
  /** Completed operations split by execution mode: `local`, `remote_job`, `unattributed`. */
  execution: LabelledCount[];
  /** Busiest tools first, capped at TOP_TOOLS_LIMIT. */
  topTools: ToolUsageRow[];
  /** Distinct tools with activity, so a capped table cannot read as the whole list. */
  toolCount: number;
  /**
   * Normalized failure classes, from server attempts AND in-browser runs.
   *
   * One list rather than two because there is one label space:
   * `LocalToolErrorCategory` is declared `satisfies readonly JobErrorCategory[]`,
   * so `corrupt_document` means the same thing wherever it was recorded. Only
   * categories the ledger actually holds appear — nothing is inferred for a row
   * that has none.
   */
  errorCategories: LabelledCount[];
  /**
   * In-browser failures the ledger has no category for.
   *
   * This used to be *every* local failure, because local tools reported a
   * user-facing sentence and no class. They now carry one (see the local failure
   * taxonomy), so what remains here is the honest residue: rows recorded before
   * the taxonomy existed, and any future emit that loses its category. Counting
   * them separately keeps the gap visible instead of folding it into
   * `internal_error`, which would put a fabricated number beside measured ones.
   */
  uncategorizedLocalFailures: number;
  /** The single funnel the caller asked for (or the default tool's). */
  funnel: FunnelReport;
  /**
   * One funnel per tool with activity, busiest first, capped at
   * `FUNNEL_TOOLS_LIMIT`. This is what makes the section a comparison rather than
   * a single tool's report — the question "which tool loses people" cannot be
   * answered by a dashboard that only ever shows one.
   */
  funnels: FunnelReport[];
  /** Distinct tools with funnel activity, so the cap above cannot read as the whole list. */
  funnelToolCount: number;
  /** True when any query failed. The numbers above are then floors, not totals. */
  degraded: boolean;
}

export interface UsageAnalyticsReadServiceDeps {
  usage: IUsageRepository;
  logger: ILogger;
  now?: () => Date;
  /**
   * The enforcement mode the deployment is actually running in.
   *
   * Passed in rather than read from `process.env` here, and rather than resolved
   * a second time: `UsageMeteringService` already resolves it once at
   * construction, and a report that resolved its own copy could disagree with the
   * service that actually makes the decisions — which is the worst possible thing
   * for a readiness verdict to be wrong about. Defaults to `observe`, matching
   * `resolveLimitMode`, so a caller that forgets cannot accidentally produce a
   * report claiming enforcement is live.
   */
  limitMode?: LimitMode;
}

/**
 * The calibration payload: what has been observed, and whether it is enough.
 *
 * `observation` and `readiness` are separate fields on purpose. The observation
 * is measurement and the readiness is a judgement over it with declared
 * thresholds, and keeping them apart is what lets a reader disagree with the
 * judgement while still trusting the numbers.
 */
export interface CalibrationReport {
  window: { from: string; to: string; days: number; clamped: boolean };
  observation: CalibrationObservation;
  readiness: EnforcementReadiness;
  recommendations: LimitRecommendation[];
}

export class UsageAnalyticsReadService {
  private readonly usage: IUsageRepository;
  private readonly logger: ILogger;
  private readonly now: () => Date;
  private readonly limitMode: LimitMode;

  constructor(deps: UsageAnalyticsReadServiceDeps) {
    this.usage = deps.usage;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.limitMode = deps.limitMode ?? "observe";
  }

  /**
   * The whole dashboard in one call.
   *
   * Four queries, issued together, each aggregated by the store. They are
   * independent, so one failing degrades its own section instead of emptying the
   * report — a funnel is still worth reading on a day the tool table times out.
   */
  async report(request: ReportWindowRequest = {}): Promise<AnalyticsReport> {
    const window = boundReportWindow(request, this.now());
    const failures: string[] = [];

    const [tools, execution, categories, localCategories, funnelCounts] = await Promise.all([
      this.read("tool usage", failures, () => this.usage.toolUsageSummary(window), []),
      this.read(
        "execution mode split",
        failures,
        () => this.usage.dimensionCounts(window, "executionMode", OUTCOME_EVENTS),
        [] as DimensionCountRow[],
      ),
      this.read(
        "error categories",
        failures,
        () =>
          this.usage.dimensionCounts(window, "errorCategory", [
            ANALYTICS_EVENTS.tool_processing_completed,
          ]),
        [] as DimensionCountRow[],
      ),
      // A separate read rather than one over both events, because the two need
      // different treatment of the SAME null bucket: on a server attempt null
      // means the attempt succeeded, on `job_failed` it means a failure nobody
      // classified. Merging first would make those indistinguishable.
      this.read(
        "local error categories",
        failures,
        () => this.usage.dimensionCounts(window, "errorCategory", [ANALYTICS_EVENTS.job_failed]),
        [] as DimensionCountRow[],
      ),
      this.read(
        "funnel",
        failures,
        () => this.usage.eventCountsByTool(window, FUNNEL_EVENTS),
        [] as ToolEventCountRow[],
      ),
    ]);

    const funnels = funnelsFrom(funnelCounts);
    const featured =
      funnels.find((f) => f.toolSlug === request.funnelToolSlug) ??
      funnels.find((f) => f.toolSlug === FUNNEL_TOOL_SLUG) ??
      funnels[0] ??
      emptyFunnel(request.funnelToolSlug ?? FUNNEL_TOOL_SLUG);

    return {
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        days: window.days,
        clamped: window.clamped,
      },
      processing: totalsFrom(tools),
      execution: execution.map((row) => ({
        // A row with no `executionMode` is a real state, not a bug: the auth
        // routes record `signup`/`login` without one. Naming it beats folding it
        // into `local`, which would overstate the mode we are least able to see.
        label: row.value ?? "unattributed",
        count: row.count,
      })),
      topTools: tools.slice(0, TOP_TOOLS_LIMIT),
      toolCount: tools.length,
      // The null bucket is dropped rather than labelled: on this event a null
      // category means the attempt SUCCEEDED, so surfacing it would put the
      // success count in a list of failures.
      errorCategories: mergeCategories(categories, localCategories),
      // The null bucket of the local read, and only that: a `job_failed` with a
      // category is measured, not a gap.
      uncategorizedLocalFailures: localCategories
        .filter((row) => row.value === null)
        .reduce((sum, row) => sum + row.count, 0),
      funnel: featured,
      funnels: funnels.slice(0, FUNNEL_TOOLS_LIMIT),
      funnelToolCount: funnels.length,
      degraded: failures.length > 0,
    };
  }

  /**
   * What the observation window actually contains, and whether it is enough to
   * enforce a limit from.
   *
   * Four queries again, and the same fail-soft `read` — but with one difference
   * that matters more here than on the dashboard: a degraded read makes the
   * verdict `false` outright (see `assessEnforcementReadiness`). On the dashboard
   * a missing section is a gap in a page; here it would be a limit calibrated
   * from a floor.
   */
  async calibration(request: ReportWindowRequest = {}): Promise<CalibrationReport> {
    const window = boundReportWindow(request, this.now(), CALIBRATION_DEFAULT_DAYS);
    const failures: string[] = [];

    const [tools, observedDays, sizes, population, limits] = await Promise.all([
      this.read("tool usage", failures, () => this.usage.toolUsageSummary(window), []),
      // Measured coverage, and only over the server tools whose traffic may
      // authorize a server limit — the same allowlist `serverOperationsOf`
      // applies, so the days and the operations describe the same rows.
      this.read(
        "observed days",
        failures,
        () => this.usage.observedOperationDays(window, [...REMOTE_JOB_TOOL_SLUGS]),
        0,
      ),
      this.read(
        "input size buckets",
        failures,
        () =>
          this.usage.dimensionCounts(window, "inputSizeBucket", [
            ANALYTICS_EVENTS.tool_processing_completed,
          ]),
        [] as DimensionCountRow[],
      ),
      this.read(
        "population",
        failures,
        () => this.usage.dimensionCounts(window, "ownerType", OUTCOME_EVENTS),
        [] as DimensionCountRow[],
      ),
      this.read(
        "limit events",
        failures,
        () => this.usage.eventCounts(window, [ANALYTICS_EVENTS.limit_reached]),
        [] as EventCountRow[],
      ),
    ]);

    const observation: CalibrationObservation = {
      // Days with traffic, NOT `window.days`. The span the caller asked for is
      // still reported, as `window.days` on the payload — but a readiness gate
      // fed by it measures a date picker instead of a deployment.
      days: observedDays,
      limitMode: this.limitMode,
      operations: tools.reduce((sum, t) => sum + t.total, 0),
      tools: tools.map((t) => ({
        toolSlug: t.toolSlug,
        executionMode: executionModeForSlug(t.toolSlug),
        operations: t.total,
        failures: t.failed,
        // Null when nothing ran, never 0: a tool with no attempts has no failure
        // rate, and rendering 0% would report an unused tool as a flawless one.
        failureRate: t.total > 0 ? t.failed / t.total : null,
        computeUnits: t.costUnits,
        inputBytes: t.inputBytes,
        averageDurationMs: t.averageDurationMs,
        durationSamples: t.durationSamples,
      })),
      inputSizeBuckets: bucketsFrom(sizes),
      population: bucketsFrom(population),
      limitEvents: limits.reduce((sum, row) => sum + row.count, 0),
      degraded: failures.length > 0,
    };

    const readiness = assessEnforcementReadiness(observation);
    return {
      window: {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        days: window.days,
        clamped: window.clamped,
      },
      observation,
      readiness,
      recommendations: recommendLimits(observation, readiness),
    };
  }

  /**
   * Runs one query, or degrades to a fallback.
   *
   * `Promise.all` over these would otherwise make any single rejection reject the
   * whole report, which is the thing the fail-soft rule exists to prevent.
   */
  private async read<T>(
    what: string,
    failures: string[],
    query: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await query();
    } catch (err) {
      failures.push(what);
      this.logger.warn("Analytics read degraded", {
        section: what,
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  }
}

/**
 * Grouped counts as labelled buckets.
 *
 * The null bucket is labelled `unknown` rather than dropped. On a size grouping
 * an absent bucket means the attempt reported no input size, which is a real
 * measurement gap — dropping it would make the buckets sum to less than the
 * operation count with nothing on the page to explain the difference.
 */
function bucketsFrom(rows: readonly DimensionCountRow[]): ObservationBucket[] {
  return rows.map((row) => ({ label: row.value ?? "unknown", count: row.count }));
}

/** Sums per-tool rows into one set of totals. */
function totalsFrom(tools: readonly ToolUsageRow[]): ProcessingTotals {
  let runs = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let inputBytes = 0;
  let computeUnits = 0;
  let durationSum = 0;
  let durationSamples = 0;

  for (const tool of tools) {
    runs += tool.total;
    succeeded += tool.succeeded;
    failed += tool.failed;
    cancelled += tool.cancelled;
    inputBytes += tool.inputBytes;
    computeUnits += tool.costUnits;
    if (tool.averageDurationMs !== null && tool.durationSamples > 0) {
      // Weighted by the number of measurements behind each mean, not by the
      // tool's total attempts: an unweighted average of averages lets one tool
      // with three runs count as much as one with three thousand.
      durationSum += tool.averageDurationMs * tool.durationSamples;
      durationSamples += tool.durationSamples;
    }
  }

  return {
    runs,
    succeeded,
    failed,
    cancelled,
    successRate: runs > 0 ? succeeded / runs : null,
    inputBytes,
    computeUnits,
    averageDurationMs: durationSamples > 0 ? Math.round(durationSum / durationSamples) : null,
    durationSamples,
  };
}

/**
 * Every event either funnel spine needs, plus the failure counted beside them.
 *
 * The union of both spines rather than one, because a single grouped query serves
 * local and server tools alike and the spine is chosen per tool afterwards.
 */
const FUNNEL_EVENTS: readonly AnalyticsEventName[] = [
  ...new Set<AnalyticsEventName>([
    ...LOCAL_FUNNEL_STEPS,
    ...FUNNEL_STEPS,
    ANALYTICS_EVENTS.job_failed,
  ]),
];

/**
 * One funnel per tool that produced events, busiest first.
 *
 * "Busiest" is the FIRST step of the tool's own spine, not the row count: ranking
 * by total events would put a tool with many failed runs above a tool with more
 * visitors, and the point of the ordering is to show where the most people are.
 * Rows with no tool (`signup`, `login`) are dropped — they have no funnel.
 */
function funnelsFrom(rows: readonly ToolEventCountRow[]): FunnelReport[] {
  const byTool = new Map<string, EventCountRow[]>();
  for (const row of rows) {
    if (!row.toolSlug) continue;
    const list = byTool.get(row.toolSlug);
    if (list) list.push(row);
    else byTool.set(row.toolSlug, [row]);
  }

  return [...byTool.entries()]
    .map(([toolSlug, counts]) => funnelFor(toolSlug, counts))
    .sort(
      (a, b) =>
        (b.steps[0]?.count ?? 0) - (a.steps[0]?.count ?? 0) ||
        a.toolSlug.localeCompare(b.toolSlug),
    );
}

/**
 * Sums two category reads into one list, busiest first.
 *
 * Null buckets are dropped here rather than at the call site so neither read can
 * contribute one: on a server attempt a null category means the attempt
 * SUCCEEDED, and on a local failure it means nobody classified it — neither is a
 * failure class, and both would be misread as one in a list of them.
 */
function mergeCategories(...reads: readonly DimensionCountRow[][]): LabelledCount[] {
  const totals = new Map<string, number>();
  for (const rows of reads) {
    for (const row of rows) {
      if (row.value === null) continue;
      totals.set(row.value, (totals.get(row.value) ?? 0) + row.count);
    }
  }
  return [...totals]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Rolls one tool's event counts against the spine its execution mode can produce. */
function funnelFor(toolSlug: string, counts: readonly EventCountRow[]): FunnelReport {
  const executionMode = executionModeForSlug(toolSlug);
  // An unrecognised slug is reported against the local spine, which is the
  // shorter one: measuring it against a `job_submitted` it may never have emitted
  // would clamp every later step to zero and show a retired tool as broken rather
  // than as retired.
  const spine = executionMode === "remote_job" ? FUNNEL_STEPS : LOCAL_FUNNEL_STEPS;
  const steps = rollupFunnel(
    spine.map((step) => ({ step, count: countOf(counts, step) })),
    spine,
  );
  return {
    toolSlug,
    executionMode,
    countUnit: "events",
    steps,
    failed: countOf(counts, ANALYTICS_EVENTS.job_failed),
    worstStep: worstFunnelStep(steps)?.step ?? null,
  };
}

/**
 * The featured funnel when the named tool produced nothing in the window.
 *
 * Zeroes against a real spine, not an empty `steps` array: a table that renders
 * no rows reads as "this section is broken", while a spine of zeroes reads as
 * "nobody used this tool this week", which is the truth.
 */
function emptyFunnel(toolSlug: string): FunnelReport {
  return funnelFor(toolSlug, []);
}

/** One event's count, with a missing row read as zero rather than as absent. */
function countOf(counts: readonly EventCountRow[], name: string): number {
  return counts.find((row) => row.eventName === name)?.count ?? 0;
}
