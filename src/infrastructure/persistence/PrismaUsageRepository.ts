import { Prisma } from "@prisma/client";
import type { PrismaClient, UsageCounter as CounterRow } from "@prisma/client";
import type {
  CounterIncrement,
  CounterReading,
  CounterScope,
  DimensionCountRow,
  EventCountRow,
  ToolEventCountRow,
  IUsageRepository,
  ToolUsageRow,
  UsageDimension,
  UsageEventRecord,
  UsageOwnerType,
  UsageWindow,
} from "@/src/application/ports/metering/UsageRepository";
import { isMeterKey, type MeterKey } from "@/src/domain/metering/meters";

/** Job statuses that count as "in flight" for the concurrency limit. */
const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;

/**
 * The meter a counter row records, tolerantly read.
 *
 * A row written by a build that knew a meter this build does not must not crash
 * the read — the caller is deciding whether to allow work, and an unparseable
 * historical row is not a reason to deny it. It is dropped from the projection
 * instead.
 */
function meterOf(row: CounterRow): MeterKey | null {
  return isMeterKey(row.meter) ? row.meter : null;
}

function toReading(row: CounterRow, meter: MeterKey): CounterReading {
  return {
    meter,
    periodStart: new Date(row.periodStart),
    periodEnd: new Date(row.periodEnd),
    amount: Number.isFinite(row.amount) ? Math.trunc(row.amount) : 0,
  };
}

/** Integer or null. Guards against a float reaching an Int column. */
function intOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * SQLite/Postgres-backed usage repository.
 *
 * Two things about this class are load-bearing rather than incidental:
 *
 *  - **`incrementCounters` never reads before it writes.** Each increment is a
 *    single `upsert` with `{ increment: delta }`, which the unique constraint on
 *    `(ownerType, ownerId, meter, periodStart)` makes safe under concurrency.
 *    A read-then-write would let two simultaneous submissions both see "9 of 10
 *    used" and both proceed, so the quota would hold only under traffic light
 *    enough not to need it.
 *
 *  - **`recordEvent` cannot write an owner id.** Not because this mapper is
 *    careful, but because `UsageEventRecord` has no such field and the table has
 *    no such column. The analytics ledger stays anonymous by construction; the
 *    counters table is where identity lives, and it holds nothing but a number.
 */
export class PrismaUsageRepository implements IUsageRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async incrementCounters(
    increments: readonly CounterIncrement[],
  ): Promise<CounterReading[]> {
    const readings: CounterReading[] = [];
    for (const inc of increments) {
      const delta = Math.trunc(inc.delta);
      const row = await this.prisma.usageCounter.upsert({
        where: {
          usage_counter_owner_meter_period: {
            ownerType: inc.ownerType,
            ownerId: inc.ownerId,
            meter: inc.meter,
            periodStart: inc.periodStart,
          },
        },
        create: {
          ownerType: inc.ownerType,
          ownerId: inc.ownerId,
          meter: inc.meter,
          periodStart: inc.periodStart,
          periodEnd: inc.periodEnd,
          // A first-ever increment starts from zero, so the created amount is
          // the delta itself. Clamped at zero: a release arriving before its
          // reservation (a retried rollback, say) must not create a negative
          // allowance that silently grants free work.
          amount: delta > 0 ? delta : 0,
        },
        update: { amount: { increment: delta } },
      });
      readings.push(toReading(row, inc.meter));
    }
    return readings;
  }

  async readCounters(scopes: readonly CounterScope[]): Promise<CounterReading[]> {
    if (scopes.length === 0) return [];
    const rows = await this.prisma.usageCounter.findMany({
      where: {
        OR: scopes.map((s) => ({
          ownerType: s.ownerType,
          ownerId: s.ownerId,
          meter: s.meter,
          periodStart: s.periodStart,
        })),
      },
    });
    const byKey = new Map<string, CounterRow>();
    for (const row of rows) {
      byKey.set(`${row.meter} ${new Date(row.periodStart).getTime()}`, row);
    }
    // One reading per requested scope, in order. A missing row reads as 0 rather
    // than as absent: the caller is computing "how much remains", and a hole in
    // that projection is indistinguishable from an unlimited allowance.
    return scopes.map((s) => {
      const row = byKey.get(`${s.meter} ${s.periodStart.getTime()}`);
      const meter = row ? meterOf(row) : null;
      if (!row || !meter) {
        return {
          meter: s.meter,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          amount: 0,
        };
      }
      return toReading(row, meter);
    });
  }

  async countActiveOperations(
    ownerType: UsageOwnerType,
    ownerId: string,
  ): Promise<number> {
    return this.prisma.job.count({
      where: { ownerType, ownerId, status: { in: [...ACTIVE_JOB_STATUSES] } },
    });
  }

  async recordEvent(event: UsageEventRecord): Promise<void> {
    await this.prisma.usageEvent.create({ data: this.toRow(event) });
  }

  async recordEvents(events: readonly UsageEventRecord[]): Promise<void> {
    if (events.length === 0) return;
    // createMany is not supported on every provider this schema targets, and a
    // partial batch is acceptable here — the ledger is append-only and each row
    // stands alone, so a failure mid-batch loses the tail rather than corrupting
    // anything.
    for (const event of events) await this.recordEvent(event);
  }

  async toolUsageSummary(window: UsageWindow): Promise<ToolUsageRow[]> {
    const rows = await this.prisma.usageEvent.findMany({
      where: {
        occurredAt: { gte: window.from, lt: window.to },
        toolSlug: { not: null },
        result: { not: null },
      },
      select: {
        toolSlug: true,
        result: true,
        costUnits: true,
        inputBytes: true,
        durationMs: true,
      },
    });

    // `durationSamples` is omitted from the accumulator because `durationCount`
    // already is it; it is named on the way out so the row shape stays the port's.
    interface Acc extends Omit<ToolUsageRow, "durationSamples"> {
      durationSum: number;
      durationCount: number;
    }
    const byTool = new Map<string, Acc>();
    for (const row of rows) {
      const slug = row.toolSlug;
      if (!slug) continue;
      let acc = byTool.get(slug);
      if (!acc) {
        acc = {
          toolSlug: slug,
          total: 0,
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          costUnits: 0,
          inputBytes: 0,
          averageDurationMs: null,
          durationSum: 0,
          durationCount: 0,
        };
        byTool.set(slug, acc);
      }
      acc.total += 1;
      if (row.result === "success") acc.succeeded += 1;
      else if (row.result === "cancelled") acc.cancelled += 1;
      else if (row.result === "failure") acc.failed += 1;
      acc.costUnits += row.costUnits ?? 0;
      acc.inputBytes += row.inputBytes ?? 0;
      if (row.durationMs !== null && row.durationMs !== undefined) {
        acc.durationSum += row.durationMs;
        acc.durationCount += 1;
      }
    }

    return [...byTool.values()]
      .map(({ durationSum, durationCount, ...row }) => ({
        ...row,
        averageDurationMs:
          durationCount > 0 ? Math.round(durationSum / durationCount) : null,
        durationSamples: durationCount,
      }))
      .sort((a, b) => b.total - a.total || a.toolSlug.localeCompare(b.toolSlug));
  }

  async observedOperationDays(
    window: UsageWindow,
    toolSlugs: readonly string[],
  ): Promise<number> {
    // Same rule as `eventCounts`: an empty allowlist counts nothing.
    if (toolSlugs.length === 0) return 0;
    const rows = await this.prisma.usageEvent.findMany({
      where: {
        occurredAt: { gte: window.from, lt: window.to },
        toolSlug: { in: [...toolSlugs] },
        result: { not: null },
      },
      select: { occurredAt: true },
    });
    // Counted in JS rather than by a SQL date function on purpose: `date()` and
    // `date_trunc` are not the same function on SQLite and PostgreSQL, and a
    // grouping that silently used the server's local zone on one of them would
    // put one busy evening on two calendar days. `toISOString` is UTC by
    // definition, which is the zone every other window bound here is in.
    const days = new Set<string>();
    for (const row of rows) days.add(row.occurredAt.toISOString().slice(0, 10));
    return days.size;
  }

  async eventCounts(
    window: UsageWindow,
    eventNames?: readonly string[],
    toolSlug?: string | null,
  ): Promise<EventCountRow[]> {
    // An empty (rather than omitted) filter means "count nothing", not "count
    // everything" — otherwise a caller that filtered its list down to zero names
    // would silently get the whole ledger back.
    if (eventNames && eventNames.length === 0) return [];
    const grouped = await this.prisma.usageEvent.groupBy({
      by: ["eventName"],
      where: {
        occurredAt: { gte: window.from, lt: window.to },
        ...(eventNames ? { eventName: { in: [...eventNames] } } : {}),
        ...(toolSlug ? { toolSlug } : {}),
      },
      _count: { _all: true },
    });
    return grouped
      .map((g) => ({ eventName: g.eventName, count: g._count._all }))
      .sort((a, b) => b.count - a.count || a.eventName.localeCompare(b.eventName));
  }

  async eventCountsByTool(
    window: UsageWindow,
    eventNames?: readonly string[],
  ): Promise<ToolEventCountRow[]> {
    // Same "empty means nothing" rule as eventCounts.
    if (eventNames && eventNames.length === 0) return [];
    const grouped = await this.prisma.usageEvent.groupBy({
      by: ["toolSlug", "eventName"],
      where: {
        occurredAt: { gte: window.from, lt: window.to },
        ...(eventNames ? { eventName: { in: [...eventNames] } } : {}),
      },
      _count: { _all: true },
    });
    return grouped
      .map((g) => ({
        toolSlug: g.toolSlug,
        eventName: g.eventName,
        count: g._count._all,
      }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.toolSlug ?? "").localeCompare(b.toolSlug ?? "") ||
          a.eventName.localeCompare(b.eventName),
      );
  }

  async dimensionCounts(
    window: UsageWindow,
    dimension: UsageDimension,
    eventNames?: readonly string[],
  ): Promise<DimensionCountRow[]> {
    // See the port: an empty list means "count nothing".
    if (eventNames && eventNames.length === 0) return [];
    // `dimension` is a closed union of column names (UsageDimension), so this
    // cast narrows a runtime-chosen field to something Prisma's generated
    // grouping type accepts. It is not a widening: a value outside the union
    // cannot reach here, which is why the union exists rather than a `string`.
    const grouped = await this.prisma.usageEvent.groupBy({
      by: [dimension as "executionMode"],
      where: {
        occurredAt: { gte: window.from, lt: window.to },
        ...(eventNames ? { eventName: { in: [...eventNames] } } : {}),
      },
      _count: { _all: true },
    });
    return grouped
      .map((row) => ({
        value: (row as Record<string, unknown>)[dimension] as string | null,
        count: row._count._all,
      }))
      .sort((a, b) => b.count - a.count || (a.value ?? "").localeCompare(b.value ?? ""));
  }

  /**
   * The insert IS the compare-and-set.
   *
   * `create` against a primary key, not `upsert` and not a `findUnique` first:
   * both of those would tell every racing worker that it won. The unique
   * violation is the signal, so the database arbitrates rather than the process.
   */
  async claimSettlement(key: string, at: Date): Promise<boolean> {
    try {
      await this.prisma.usageSettlement.create({ data: { key, claimedAt: at } });
      return true;
    } catch (err) {
      // P2002 = unique constraint violation: someone else got there first, which
      // is a successful outcome for this method. Anything else is a real fault
      // and must propagate — swallowing it would answer "not claimed" to an
      // outage and let a refund happen twice.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return false;
      }
      throw err;
    }
  }

  async pruneEventsBefore(before: Date): Promise<number> {
    const result = await this.prisma.usageEvent.deleteMany({
      where: { occurredAt: { lt: before } },
    });
    return result.count;
  }

  async pruneCountersBefore(before: Date): Promise<number> {
    const result = await this.prisma.usageCounter.deleteMany({
      where: { periodEnd: { lt: before } },
    });
    return result.count;
  }

  /**
   * Maps a ledger record onto its row.
   *
   * `properties` is serialized, not filtered: sanitization is the taxonomy's job
   * and has already happened by the time a record reaches a repository. Doing it
   * again here would put the privacy rule in two places and let them disagree.
   */
  private toRow(event: UsageEventRecord) {
    return {
      eventName: event.eventName,
      occurredAt: event.occurredAt,
      ownerType: event.ownerType ?? null,
      planId: event.planId ?? null,
      subjectHash: event.subjectHash ?? null,
      toolSlug: event.toolSlug ?? null,
      executionMode: event.executionMode ?? null,
      result: event.result ?? null,
      errorCategory: event.errorCategory ?? null,
      attempt: intOrNull(event.attempt),
      inputBytes: intOrNull(event.inputBytes),
      outputBytes: intOrNull(event.outputBytes),
      inputSizeBucket: event.inputSizeBucket ?? null,
      pageCount: intOrNull(event.pageCount),
      durationMs: intOrNull(event.durationMs),
      costUnits: intOrNull(event.costUnits),
      properties:
        event.properties && Object.keys(event.properties).length > 0
          ? JSON.stringify(event.properties)
          : null,
    };
  }
}
