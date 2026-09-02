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

/** Identity of a counter row, as a map key. */
function counterKey(scope: {
  ownerType: string;
  ownerId: string;
  meter: string;
  periodStart: Date;
}): string {
  return [scope.ownerType, scope.ownerId, scope.meter, scope.periodStart.getTime()].join("|");
}

interface CounterCell {
  periodStart: Date;
  periodEnd: Date;
  amount: number;
}

/**
 * In-memory usage repository, for tests and for a deployment with no database.
 *
 * It mirrors the Prisma adapter's *observable* behaviour, including the parts
 * that exist for correctness rather than convenience: a missing counter reads as
 * zero, a negative net amount is clamped, and increments are applied to the
 * stored cell rather than to a snapshot the caller passed in. A test that passes
 * here and fails against Prisma would mean this class is lying, so the two are
 * deliberately kept behaviourally identical.
 *
 * Concurrency: JavaScript's single-threaded model makes an in-memory
 * read-modify-write atomic with respect to other awaits, so the increment here
 * cannot lose a count. That is a property of the runtime, not evidence that the
 * SQL path is safe — which is why the Prisma adapter has its own concurrency
 * test against a real database.
 */
export class InMemoryUsageRepository implements IUsageRepository {
  private readonly counters = new Map<string, CounterCell>();
  private readonly events: UsageEventRecord[] = [];
  /** Durable settlement markers, keyed like the `usage_settlements` primary key. */
  private readonly settlements = new Map<string, Date>();
  /** Per-owner in-flight operation count, set by tests via `setActiveOperations`. */
  private readonly active = new Map<string, number>();

  async incrementCounters(
    increments: readonly CounterIncrement[],
  ): Promise<CounterReading[]> {
    return increments.map((inc) => {
      const key = counterKey(inc);
      const cell = this.counters.get(key) ?? {
        periodStart: inc.periodStart,
        periodEnd: inc.periodEnd,
        amount: 0,
      };
      // Clamped at zero for the same reason as the SQL path: a release that
      // arrives without its reservation must not mint a negative allowance that
      // silently grants free work.
      cell.amount = Math.max(0, cell.amount + Math.trunc(inc.delta));
      this.counters.set(key, cell);
      return {
        meter: inc.meter,
        periodStart: cell.periodStart,
        periodEnd: cell.periodEnd,
        amount: cell.amount,
      };
    });
  }

  async readCounters(scopes: readonly CounterScope[]): Promise<CounterReading[]> {
    return scopes.map((s) => {
      const cell = this.counters.get(counterKey(s));
      return {
        meter: s.meter,
        periodStart: s.periodStart,
        periodEnd: s.periodEnd,
        amount: cell?.amount ?? 0,
      };
    });
  }

  async countActiveOperations(
    ownerType: UsageOwnerType,
    ownerId: string,
  ): Promise<number> {
    return this.active.get(`${ownerType}|${ownerId}`) ?? 0;
  }

  async recordEvent(event: UsageEventRecord): Promise<void> {
    // Copied on write. A caller that mutates its record afterwards must not
    // retroactively edit the ledger — the real one is durable and this one
    // stands in for it.
    this.events.push({ ...event, properties: event.properties ? { ...event.properties } : null });
  }

  async recordEvents(events: readonly UsageEventRecord[]): Promise<void> {
    for (const event of events) await this.recordEvent(event);
  }

  async toolUsageSummary(window: UsageWindow): Promise<ToolUsageRow[]> {
    // `durationSamples` is omitted from the accumulator because `durationCount`
    // already is it; it is named on the way out so the row shape stays the port's.
    interface Acc extends Omit<ToolUsageRow, "durationSamples"> {
      durationSum: number;
      durationCount: number;
    }
    const byTool = new Map<string, Acc>();
    for (const event of this.inWindow(window)) {
      if (!event.toolSlug || !event.result) continue;
      let acc = byTool.get(event.toolSlug);
      if (!acc) {
        acc = {
          toolSlug: event.toolSlug,
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
        byTool.set(event.toolSlug, acc);
      }
      acc.total += 1;
      if (event.result === "success") acc.succeeded += 1;
      else if (event.result === "cancelled") acc.cancelled += 1;
      else if (event.result === "failure") acc.failed += 1;
      acc.costUnits += event.costUnits ?? 0;
      acc.inputBytes += event.inputBytes ?? 0;
      if (event.durationMs !== null && event.durationMs !== undefined) {
        acc.durationSum += event.durationMs;
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
    if (toolSlugs.length === 0) return 0;
    const allowed = new Set(toolSlugs);
    const days = new Set<string>();
    for (const event of this.inWindow(window)) {
      if (!event.toolSlug || !event.result) continue;
      if (!allowed.has(event.toolSlug)) continue;
      days.add(event.occurredAt.toISOString().slice(0, 10));
    }
    return days.size;
  }

  async eventCounts(
    window: UsageWindow,
    eventNames?: readonly string[],
    toolSlug?: string | null,
  ): Promise<EventCountRow[]> {
    if (eventNames && eventNames.length === 0) return [];
    const wanted = eventNames ? new Set(eventNames) : null;
    const counts = new Map<string, number>();
    for (const event of this.inWindow(window)) {
      if (wanted && !wanted.has(event.eventName)) continue;
      if (toolSlug && event.toolSlug !== toolSlug) continue;
      counts.set(event.eventName, (counts.get(event.eventName) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([eventName, count]) => ({ eventName, count }))
      .sort((a, b) => b.count - a.count || a.eventName.localeCompare(b.eventName));
  }

  async eventCountsByTool(
    window: UsageWindow,
    eventNames?: readonly string[],
  ): Promise<ToolEventCountRow[]> {
    if (eventNames && eventNames.length === 0) return [];
    const wanted = eventNames ? new Set(eventNames) : null;
    // The row is kept alongside the count so the composite key never has to be
    // parsed back apart — a split on a separator is one escaping bug away from
    // merging two tools whose slugs contain it.
    const counts = new Map<string, ToolEventCountRow>();
    for (const event of this.inWindow(window)) {
      if (wanted && !wanted.has(event.eventName)) continue;
      const slug = event.toolSlug ?? null;
      const key = `${slug ?? "\u0000"}\u0000${event.eventName}`;
      const row = counts.get(key);
      if (row) row.count += 1;
      else counts.set(key, { toolSlug: slug, eventName: event.eventName, count: 1 });
    }
    return [...counts.values()].sort(
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
    if (eventNames && eventNames.length === 0) return [];
    const wanted = eventNames ? new Set(eventNames) : null;
    // Keyed by string because a Map cannot distinguish the null bucket from the
    // literal "null" one; the sentinel is mapped back to null on the way out.
    const NULL_BUCKET = "\u0000null";
    const counts = new Map<string, number>();
    for (const event of this.inWindow(window)) {
      if (wanted && !wanted.has(event.eventName)) continue;
      const raw = event[dimension];
      const key = typeof raw === "string" && raw.length > 0 ? raw : NULL_BUCKET;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ value: key === NULL_BUCKET ? null : key, count }))
      .sort((a, b) => b.count - a.count || (a.value ?? "").localeCompare(b.value ?? ""));
  }

  /**
   * The same compare-and-set, in one process.
   *
   * `Set.add` after a `has` is atomic here for the reason the Prisma version
   * needs a constraint for: there is no await between them, so no other task can
   * interleave. This instance IS the shared substrate — two services constructed
   * over the same repository behave like two workers over the same database,
   * which is what makes the concurrency tests meaningful rather than staged.
   */
  async claimSettlement(key: string, at: Date): Promise<boolean> {
    if (this.settlements.has(key)) return false;
    this.settlements.set(key, at);
    return true;
  }

  async pruneEventsBefore(before: Date): Promise<number> {
    const kept = this.events.filter((e) => e.occurredAt.getTime() >= before.getTime());
    const removed = this.events.length - kept.length;
    this.events.length = 0;
    this.events.push(...kept);
    return removed;
  }

  async pruneCountersBefore(before: Date): Promise<number> {
    let removed = 0;
    for (const [key, cell] of [...this.counters.entries()]) {
      if (cell.periodEnd.getTime() < before.getTime()) {
        this.counters.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // ---- test affordances ----------------------------------------------------

  /** Sets the in-flight operation count an owner appears to have. */
  setActiveOperations(ownerType: UsageOwnerType, ownerId: string, count: number): void {
    this.active.set(`${ownerType}|${ownerId}`, count);
  }

  /** The ledger as written, for assertions. Copied so a test cannot mutate state. */
  recordedEvents(): UsageEventRecord[] {
    return this.events.map((e) => ({ ...e }));
  }

  /** Current amount for one counter scope, without going through readCounters. */
  counterAmount(scope: {
    ownerType: string;
    ownerId: string;
    meter: string;
    periodStart: Date;
  }): number {
    return this.counters.get(counterKey(scope))?.amount ?? 0;
  }

  reset(): void {
    this.counters.clear();
    this.events.length = 0;
    this.active.clear();
    this.settlements.clear();
  }

  private inWindow(window: UsageWindow): UsageEventRecord[] {
    return this.events.filter(
      (e) =>
        e.occurredAt.getTime() >= window.from.getTime() &&
        e.occurredAt.getTime() < window.to.getTime(),
    );
  }
}
