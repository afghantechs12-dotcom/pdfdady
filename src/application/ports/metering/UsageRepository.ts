import type { MeterKey } from "@/src/domain/metering/meters";
import type { PlanId } from "@/src/domain/metering/plans";

/**
 * The persistence port for usage metering and product analytics.
 *
 * Two responsibilities live behind one port because they share one substrate and
 * one lifecycle, but they are kept strictly apart in the data they carry:
 *
 *  - **Counters** are the enforcement substrate. They are keyed by a real
 *    `ownerId`, because a quota that cannot say whose quota it is cannot be a
 *    quota. They hold nothing but a number.
 *  - **Events** are the analytics ledger. They carry no `ownerId` — the record
 *    type below has no field to put one in — only the population dimensions
 *    (`ownerType`, `planId`) and an unlinkable `subjectHash`.
 *
 * Every method here is expected to be called from a fail-open caller: a metering
 * outage must never stop someone compressing a PDF, so the service above treats
 * a rejection from any of these as "allow, and warn".
 */

/** Who a counter belongs to. Mirrors JobOwnerType; not imported to keep the metering port free of job concepts. */
export type UsageOwnerType = "user" | "anon" | "system";

/** Identifies one counter row: an owner, a meter, and a period. */
export interface CounterScope {
  ownerType: UsageOwnerType;
  ownerId: string;
  meter: MeterKey;
  /** UTC-aligned window start from src/domain/metering/periods.ts. */
  periodStart: Date;
  /** Exclusive window end; the instant this allowance resets. */
  periodEnd: Date;
}

/** One meter's consumption within one period. */
export interface CounterReading {
  meter: MeterKey;
  periodStart: Date;
  periodEnd: Date;
  amount: number;
}

/** A single increment within a batch. All increments in a batch apply atomically per row. */
export interface CounterIncrement extends CounterScope {
  /** Amount to add. May be negative to release a reservation that was not used. */
  delta: number;
}

/**
 * A row for the append-only ledger.
 *
 * Note what is absent: there is no `ownerId`. That omission is the privacy
 * guarantee, expressed in the type rather than in a mapper's discipline — a
 * caller cannot pass an owner id here even by mistake.
 */
export interface UsageEventRecord {
  /** Canonical name from src/domain/metering/events.ts. */
  eventName: string;
  occurredAt: Date;
  ownerType?: UsageOwnerType | null;
  planId?: PlanId | null;
  /** Non-reversible, salt-rotated visitor pseudonym for funnel stitching only. */
  subjectHash?: string | null;
  toolSlug?: string | null;
  executionMode?: string | null;
  result?: string | null;
  errorCategory?: string | null;
  attempt?: number | null;
  inputBytes?: number | null;
  outputBytes?: number | null;
  inputSizeBucket?: string | null;
  pageCount?: number | null;
  durationMs?: number | null;
  costUnits?: number | null;
  /** Already taxonomy-sanitized. The repository serializes, it does not filter. */
  properties?: Record<string, string | number | boolean> | null;
}

/** A window to report over. Both bounds are inclusive of `from`, exclusive of `to`. */
export interface UsageWindow {
  from: Date;
  to: Date;
}

/** Per-tool roll-up for the admin dashboard. */
export interface ToolUsageRow {
  toolSlug: string;
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  costUnits: number;
  inputBytes: number;
  /** Mean duration over attempts that reported one, in ms; null when none did. */
  averageDurationMs: number | null;
  /**
   * How many attempts contributed to `averageDurationMs`.
   *
   * Reported so a caller can combine per-tool means into an overall one that is
   * actually correct. Without it the only available weight is `total`, and a tool
   * whose attempts mostly reported no duration would then pull the overall
   * average toward a figure no measurement supports.
   */
  durationSamples: number;
}

/** Event-name counts, used for the funnel roll-up and for taxonomy coverage. */
export interface EventCountRow {
  eventName: string;
  count: number;
}

/**
 * Event-name counts split by tool, for comparing funnels across tools.
 *
 * A second grouping column rather than one `eventCounts` call per tool: there are
 * eighteen local tools, and eighteen round trips to render one dashboard section
 * is how an admin page becomes the slowest thing in the deployment. `toolSlug` is
 * safe to group by for the same reason `errorCategory` is and `subjectHash` is
 * not — it names a product surface, not a person.
 */
export interface ToolEventCountRow extends EventCountRow {
  /** Null for events recorded without a tool, e.g. `signup`. */
  toolSlug: string | null;
}

/**
 * A ledger *column* the reporting surface may group by.
 *
 * A closed union rather than a string, because this value reaches a query's
 * grouping clause. Widening it to `string` would make the admin surface able to
 * name any column of `usage_events` — including `subjectHash`, whose whole
 * purpose is to be unlinkable and which a group-by would turn into an
 * enumeration of visitors. There is deliberately no member for it here, so the
 * grouping cannot be asked for rather than being refused at the caller.
 */
export type UsageDimension =
  | "executionMode"
  | "errorCategory"
  | "ownerType"
  | "planId"
  | "result"
  // The coarse bucket, never `inputBytes`. Grouping by an exact size would
  // hand the reporting surface a weak per-document fingerprint; the bucket is
  // the column the schema comment already designates for dashboards.
  | "inputSizeBucket";

/** One bucket of a grouped count. `value` is null for rows where the column is unset. */
export interface DimensionCountRow {
  value: string | null;
  count: number;
}

export interface IUsageRepository {
  /**
   * Apply increments atomically, returning the resulting totals.
   *
   * Atomicity is the whole point: a read-modify-write here lets two concurrent
   * submissions both observe "9 used of 10" and both proceed, so the limit is
   * enforced only when traffic is low enough not to need it. Implementations
   * must use a single upsert-with-increment per row, not a read then a write.
   *
   * Returns one reading per increment, in the same order.
   */
  incrementCounters(increments: readonly CounterIncrement[]): Promise<CounterReading[]>;

  /** Current amounts for the given scopes. Missing rows read as 0, never as absent. */
  readCounters(scopes: readonly CounterScope[]): Promise<CounterReading[]>;

  /** How many operations this owner currently has in flight (queued or running). */
  countActiveOperations(ownerType: UsageOwnerType, ownerId: string): Promise<number>;

  /** Append one row to the ledger. */
  recordEvent(event: UsageEventRecord): Promise<void>;

  /** Append many rows. Used by the batched client ingest path. */
  recordEvents(events: readonly UsageEventRecord[]): Promise<void>;

  /** Per-tool volume, failure rate, and cost over a window. */
  toolUsageSummary(window: UsageWindow): Promise<ToolUsageRow[]>;

  /**
   * How many distinct UTC calendar days inside the window carry at least one
   * completed attempt for one of `toolSlugs`.
   *
   * Separate from `toolUsageSummary` because the readiness gate needs a fact that
   * a per-tool roll-up cannot express: whether the traffic is spread over enough
   * days to calibrate from. Without it the only "days" figure available is the
   * span the caller *asked* for, which makes a two-week observation threshold
   * satisfiable by widening a date picker and unsatisfiable by narrowing one.
   *
   * `toolSlugs` is an allowlist, and an EMPTY array means "count nothing" rather
   * than "count everything" — same rule as `eventNames` on `eventCounts`, so a
   * caller whose filter produced no slugs does not silently receive every day the
   * ledger has any row on.
   */
  observedOperationDays(
    window: UsageWindow,
    toolSlugs: readonly string[],
  ): Promise<number>;

  /**
   * Counts per event name over a window, for the funnel and event mix.
   *
   * `toolSlug` narrows to one tool, which is what makes a funnel a funnel: with
   * more than one instrumented tool, an unfiltered count blends a visitor who
   * viewed Merge with one who downloaded from Split, and the conversion between
   * those two steps is then a number about nothing.
   */
  eventCounts(
    window: UsageWindow,
    eventNames?: readonly string[],
    toolSlug?: string | null,
  ): Promise<EventCountRow[]>;

  /**
   * The same counts, grouped by tool as well as by event name.
   *
   * One query for every tool's funnel. The caller decides which tools are worth
   * reporting and against which spine — a local tool and a server tool do not
   * share a funnel shape, and that is a property of the execution policy, not of
   * the ledger.
   */
  eventCountsByTool(
    window: UsageWindow,
    eventNames?: readonly string[],
  ): Promise<ToolEventCountRow[]>;

  /**
   * Counts grouped by one ledger column over a window — local vs remote,
   * failure category, actor class, plan mix.
   *
   * Aggregated by the store, not by the caller: the alternative is selecting the
   * matching rows and counting them in application code, which means the whole
   * window's ledger crosses the process boundary to produce six numbers, and a
   * busy month is then a memory incident rather than a slow query.
   *
   * `eventNames` narrows which events are grouped, and an EMPTY array means
   * "count nothing" rather than "count everything" — same rule as `eventCounts`,
   * so a caller that filtered its list down to nothing does not silently receive
   * the entire ledger.
   */
  dimensionCounts(
    window: UsageWindow,
    dimension: UsageDimension,
    eventNames?: readonly string[],
  ): Promise<DimensionCountRow[]>;

  /**
   * Claim a one-time settlement, durably and atomically.
   *
   * Returns true when THIS call won the claim and must apply the settlement,
   * false when someone already has. Implementations MUST make this a single
   * conditional insert against a unique key — a read then a write lets two
   * workers both observe "not settled" and both refund the same operation, which
   * is the exact race an in-process guard cannot see.
   *
   * Durability is the other half: a marker held in memory is lost on restart, so
   * a completion callback redelivered after a deploy would settle a second time.
   *
   * This is the one method here a caller may NOT treat as fail-open. A rejection
   * means "unknown", not "not claimed"; the service falls back to its bounded
   * in-process guard and reports the settlement as degraded.
   */
  claimSettlement(key: string, at: Date): Promise<boolean>;

  /** Delete ledger rows older than `before`. Returns how many were removed. */
  pruneEventsBefore(before: Date): Promise<number>;

  /** Delete counter rows whose period ended before `before`. Returns how many were removed. */
  pruneCountersBefore(before: Date): Promise<number>;
}
