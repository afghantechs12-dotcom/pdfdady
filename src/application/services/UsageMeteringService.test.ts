import { beforeEach, describe, expect, it } from "vitest";

import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import { StaticEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import type { CounterIncrement, CounterReading } from "@/src/application/ports/metering/UsageRepository";
import type { LimitMode } from "@/src/domain/metering/decision";
import { PLAN_ENTITLEMENTS } from "@/src/domain/metering/plans";
import { periodBoundsFor } from "@/src/domain/metering/periods";
import {
  UsageLimitError,
  UsageMeteringService,
  resolveLimitMode,
} from "./UsageMeteringService";

/**
 * Focused tests for the metering seam.
 *
 * These are behavioural: every one drives the real service against the real
 * in-memory repository and asserts on counters and ledger rows, because the
 * defects this phase can actually ship are all in the seam rather than in the
 * pure policy the domain tests already cover. A test that only proved
 * `evaluateLimits` works would pass just as happily against a service that never
 * calls it.
 */

const AT = new Date("2026-08-24T12:00:00.000Z");
const ACTOR = { ownerType: "user" as const, ownerId: "user-1" };
const REMOTE_TOOL = "compress-pdf";
const LOCAL_TOOL = "merge-pdf";
const FREE_OPS_LIMIT = PLAN_ENTITLEMENTS.free.meters.server_operations!;

function build(mode: LimitMode = "observe") {
  const usage = new InMemoryUsageRepository();
  const service = new UsageMeteringService({
    usage,
    entitlements: new StaticEntitlementProvider("free"),
    logger: new ConsoleLogger("error"),
    mode,
    now: () => AT,
  });
  return { usage, service };
}

/** Current `server_operations` for the actor, read straight from the store. */
function operations(usage: InMemoryUsageRepository, at = AT): number {
  return usage.counterAmount({
    ...ACTOR,
    meter: "server_operations",
    periodStart: periodBoundsFor("day", at).start,
  });
}

function authorizeInput(overrides: Partial<Parameters<UsageMeteringService["authorize"]>[0]> = {}) {
  return {
    actor: ACTOR,
    toolSlug: REMOTE_TOOL,
    executionMode: "remote_job" as const,
    inputBytes: 1_000_000,
    ...overrides,
  };
}

function settleInput(
  overrides: Partial<Parameters<UsageMeteringService["settleProcessingOutcome"]>[0]> = {},
) {
  return {
    jobId: "job-1",
    actor: ACTOR,
    toolSlug: REMOTE_TOOL,
    executionMode: "remote_job" as const,
    result: "success" as const,
    attempt: 1,
    willRetry: false,
    inputBytes: 1_000_000,
    outputBytes: 500_000,
    pageCount: 3,
    durationMs: 1234,
    errorCategory: null,
    reservation: { reservedAt: AT },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("admission below the limit", () => {
  it("allows the operation and reserves exactly one of it", async () => {
    const { usage, service } = build("enforce");

    const outcome = await service.authorize(authorizeInput());

    expect(outcome.allowed).toBe(true);
    expect(outcome.blocked).toBe(false);
    expect(outcome.plan).toBe("free");
    expect(outcome.reservation).not.toBeNull();
    expect(outcome.degraded).toBe(false);
    // Reserved, not merely approved: the allowance is held before the work runs.
    expect(operations(usage)).toBe(1);
  });

  it("counts bytes as well as operations", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput({ inputBytes: 2_500_000 }));

    expect(
      usage.counterAmount({
        ...ACTOR,
        meter: "server_input_bytes",
        periodStart: periodBoundsFor("day", AT).start,
      }),
    ).toBe(2_500_000);
  });
});

describe("observe mode", () => {
  it("reports a denial without blocking, and still counts the usage", async () => {
    const { usage, service } = build("observe");
    // Exactly at the ceiling, so one more operation would exceed it.
    await service.authorize(authorizeInput());
    await seedOperations(usage, FREE_OPS_LIMIT - 1);

    const outcome = await service.authorize(authorizeInput());

    // The truthful verdict is "no"; the applied verdict is "carry on".
    expect(outcome.allowed).toBe(false);
    expect(outcome.blocked).toBe(false);
    expect(outcome.decision.reason).toBe("meter_exhausted");
    expect(outcome.decision.enforced).toBe(false);
    // The reservation is KEPT. The work is proceeding, so the over-limit traffic
    // has to appear in the counters — it is the entire dataset this phase exists
    // to collect.
    expect(outcome.reservation).not.toBeNull();
    expect(operations(usage)).toBe(FREE_OPS_LIMIT + 1);

    const denials = usage.recordedEvents().filter((e) => e.eventName === "limit_reached");
    expect(denials).toHaveLength(1);
    expect(denials[0]?.properties?.enforced).toBe(false);
    expect(denials[0]?.properties?.reason).toBe("meter_exhausted");
  });

  it("never produces a UsageLimitError-worthy decision", async () => {
    const { usage, service } = build("observe");
    await seedOperations(usage, FREE_OPS_LIMIT + 50);

    const outcome = await service.authorize(authorizeInput());

    expect(outcome.blocked).toBe(false);
    // The route only constructs the error from `blocked`, so an observe-mode
    // denial cannot reach a 429.
    expect(new UsageLimitError(outcome.decision).retryAfterSeconds).toBeGreaterThan(0);
  });

  it("is the default, and an unrecognized mode does not start enforcing", () => {
    expect(resolveLimitMode(undefined)).toBe("observe");
    expect(resolveLimitMode("")).toBe("observe");
    expect(resolveLimitMode("ENFORCE_LATER")).toBe("observe");
    expect(resolveLimitMode("enforce")).toBe("enforce");
    expect(resolveLimitMode("off")).toBe("off");
  });
});

describe("enforcement", () => {
  it("blocks past the ceiling and leaves no reservation behind", async () => {
    const { usage, service } = build("enforce");
    await seedOperations(usage, FREE_OPS_LIMIT);

    const outcome = await service.authorize(authorizeInput());

    expect(outcome.blocked).toBe(true);
    expect(outcome.reservation).toBeNull();
    // A refused submission is not charged for the refusal.
    expect(operations(usage)).toBe(FREE_OPS_LIMIT);
  });

  it("refuses an oversized file without touching a counter", async () => {
    const { usage, service } = build("enforce");

    const outcome = await service.authorize(
      authorizeInput({ inputBytes: PLAN_ENTITLEMENTS.free.maxFileBytes + 1 }),
    );

    expect(outcome.blocked).toBe(true);
    expect(outcome.decision.reason).toBe("file_too_large");
    // No Retry-After: waiting does not shrink the file.
    expect(outcome.decision.retryAfterSeconds).toBeNull();
    expect(operations(usage)).toBe(0);
  });

  it("refuses when too many of the actor's jobs are already running", async () => {
    const { usage, service } = build("enforce");
    usage.setActiveOperations("user", "user-1", PLAN_ENTITLEMENTS.free.maxConcurrentJobs);

    const outcome = await service.authorize(authorizeInput());

    expect(outcome.blocked).toBe(true);
    expect(outcome.decision.reason).toBe("too_many_concurrent");
    expect(operations(usage)).toBe(0);
  });
});

describe("reservation atomicity", () => {
  /**
   * Two submissions racing for the last remaining slot.
   *
   * The barrier is what makes this a real test rather than a formality: both
   * callers are held until they have BOTH read the pre-state, which is exactly
   * the interleaving a read-then-compare admission check gets wrong and an
   * increment-then-check one gets right. On an in-memory store the race
   * otherwise almost never happens, so a test without the barrier would pass
   * against a broken implementation.
   */
  class RacingRepository extends InMemoryUsageRepository {
    private arrived = 0;
    private release!: () => void;
    private readonly gate = new Promise<void>((r) => {
      this.release = r;
    });
    constructor(private readonly readers: number) {
      super();
    }
    async readCounters(scopes: Parameters<InMemoryUsageRepository["readCounters"]>[0]) {
      const readings = await super.readCounters(scopes);
      this.arrived += 1;
      if (this.arrived >= this.readers) this.release();
      else await this.gate;
      return readings;
    }
  }

  it("admits exactly one of two concurrent requests for the final slot", async () => {
    const usage = new RacingRepository(2);
    const service = new UsageMeteringService({
      usage,
      entitlements: new StaticEntitlementProvider("free"),
      logger: new ConsoleLogger("error"),
      mode: "enforce",
      now: () => AT,
    });
    // One slot left: both callers will read this same number.
    await seedOperations(usage, FREE_OPS_LIMIT - 1);

    const [a, b] = await Promise.all([
      service.authorize(authorizeInput()),
      service.authorize(authorizeInput()),
    ]);

    const admitted = [a, b].filter((o) => !o.blocked);
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.reservation).not.toBeNull();
    // The loser's reservation was refunded, so the counter lands exactly on the
    // limit rather than one past it.
    expect(operations(usage)).toBe(FREE_OPS_LIMIT);
  });

  it("records the losing request as a denial", async () => {
    const usage = new RacingRepository(2);
    const service = new UsageMeteringService({
      usage,
      entitlements: new StaticEntitlementProvider("free"),
      logger: new ConsoleLogger("error"),
      mode: "enforce",
      now: () => AT,
    });
    await seedOperations(usage, FREE_OPS_LIMIT - 1);

    await Promise.all([
      service.authorize(authorizeInput()),
      service.authorize(authorizeInput()),
    ]);

    const denials = usage.recordedEvents().filter((e) => e.eventName === "limit_reached");
    expect(denials).toHaveLength(1);
    expect(denials[0]?.properties?.enforced).toBe(true);
  });
});

describe("settlement", () => {
  it("consumes a successful job exactly once", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput());
    expect(operations(usage)).toBe(1);

    const settlement = await service.settleProcessingOutcome(settleInput());

    expect(settlement.settled).toBe(true);
    expect(settlement.disposition).toBe("kept");
    // Still one. Success is precisely the case where the admission charge stands
    // and nothing further happens — charging again here is the classic
    // double-count.
    expect(operations(usage)).toBe(1);
  });

  it("does not double-count a duplicate completion", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput({ inputBytes: 1_000_000 }));

    const first = await service.settleProcessingOutcome(
      settleInput({ result: "failure", errorCategory: "invalid_input" }),
    );
    const second = await service.settleProcessingOutcome(
      settleInput({ result: "failure", errorCategory: "invalid_input" }),
    );

    expect(first.disposition).toBe("refunded");
    expect(second.disposition).toBe("duplicate");
    // Refunded once, not twice. A second refund would mint an operation of
    // allowance out of nothing.
    expect(operations(usage)).toBe(0);
  });

  it("refunds a permanent failure, and follows the retry policy for a pending one", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput());

    const pending = await service.settleProcessingOutcome(
      settleInput({
        result: "failure",
        errorCategory: "processor_timeout",
        willRetry: true,
      }),
    );

    expect(pending.settled).toBe(false);
    expect(pending.disposition).toBe("pending_retry");
    // The operation stays charged while another attempt is coming: it is still
    // one operation the user asked for.
    expect(operations(usage)).toBe(1);

    const terminal = await service.settleProcessingOutcome(
      settleInput({
        result: "failure",
        errorCategory: "processor_timeout",
        attempt: 3,
        willRetry: false,
      }),
    );

    expect(terminal.disposition).toBe("refunded");
    expect(operations(usage)).toBe(0);
  });

  it("refunds a cancellation", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput());

    const settlement = await service.settleProcessingOutcome(
      settleInput({ result: "cancelled", errorCategory: "cancelled" }),
    );

    expect(settlement.disposition).toBe("refunded");
    expect(operations(usage)).toBe(0);
  });

  it("does not refund a job that never held a reservation", async () => {
    const { usage, service } = build("enforce");
    // Somebody else's usage, and no admission for this job.
    await seedOperations(usage, 5);

    const settlement = await service.settleProcessingOutcome(
      settleInput({ result: "failure", errorCategory: "invalid_input", reservation: null }),
    );

    expect(settlement.disposition).toBe("unreserved");
    // Crediting back a debit that never happened would hand out free allowance.
    expect(operations(usage)).toBe(5);
  });

  it("refunds into the window the reservation was taken in, not the current one", async () => {
    const usage = new InMemoryUsageRepository();
    const reservedAt = new Date("2026-08-24T23:59:30.000Z");
    const settledAt = new Date("2026-08-25T00:00:30.000Z");
    const service = new UsageMeteringService({
      usage,
      entitlements: new StaticEntitlementProvider("free"),
      logger: new ConsoleLogger("error"),
      mode: "enforce",
      now: () => reservedAt,
    });

    await service.authorize(authorizeInput({ at: reservedAt }));
    expect(operations(usage, reservedAt)).toBe(1);

    await service.settleProcessingOutcome(
      settleInput({
        result: "failure",
        errorCategory: "invalid_input",
        reservation: { reservedAt },
        at: settledAt,
      }),
    );

    // Yesterday goes back to zero; today was never touched. Crediting today
    // instead would leave yesterday permanently over-counted AND inflate today's
    // remaining allowance.
    expect(operations(usage, reservedAt)).toBe(0);
    expect(operations(usage, settledAt)).toBe(0);
  });
});

describe("worker attempts", () => {
  it("records one ledger row per attempt, each with its attempt number", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput());

    await service.settleProcessingOutcome(
      settleInput({ attempt: 1, result: "failure", errorCategory: "processor_timeout", willRetry: true }),
    );
    await service.settleProcessingOutcome(
      settleInput({ attempt: 2, result: "failure", errorCategory: "processor_timeout", willRetry: true }),
    );
    await service.settleProcessingOutcome(settleInput({ attempt: 3, result: "success" }));

    const attempts = usage
      .recordedEvents()
      .filter((e) => e.eventName === "tool_processing_completed")
      .map((e) => e.attempt);
    // Three runs really happened; a job that succeeded on attempt 3 must not
    // hide the two that failed.
    expect(attempts).toEqual([1, 2, 3]);
    // But only ONE customer operation was ever charged.
    expect(operations(usage)).toBe(1);
  });

  it("charges compute per attempt, because three runs cost three runs", async () => {
    const { usage, service } = build("enforce");
    await service.authorize(authorizeInput());
    const monthStart = periodBoundsFor("month", AT).start;
    const compute = () =>
      usage.counterAmount({ ...ACTOR, meter: "compute_units", periodStart: monthStart });

    await service.settleProcessingOutcome(
      settleInput({ attempt: 1, result: "failure", errorCategory: "processor_timeout", willRetry: true }),
    );
    const afterOne = compute();
    await service.settleProcessingOutcome(settleInput({ attempt: 2, result: "success" }));

    expect(afterOne).toBeGreaterThan(0);
    expect(compute()).toBeGreaterThan(afterOne);
    // Compute is not enforceable, so it can never deny anything — it is a cost
    // ledger, not a quota.
    expect((await service.snapshot(ACTOR, AT)).meters.map((m) => m.meter)).not.toContain(
      "compute_units",
    );
  });

  it("does not re-charge compute when the same attempt is reported twice", async () => {
    const { usage, service } = build("enforce");
    const monthStart = periodBoundsFor("month", AT).start;
    const compute = () =>
      usage.counterAmount({ ...ACTOR, meter: "compute_units", periodStart: monthStart });

    await service.settleProcessingOutcome(settleInput({ attempt: 1, result: "success" }));
    const once = compute();
    await service.settleProcessingOutcome(settleInput({ attempt: 1, result: "success" }));

    expect(once).toBeGreaterThan(0);
    expect(compute()).toBe(once);
    expect(
      usage.recordedEvents().filter((e) => e.eventName === "tool_processing_completed"),
    ).toHaveLength(1);
  });
});

describe("release", () => {
  it("returns a held allowance, and only once", async () => {
    const { usage, service } = build("enforce");
    const outcome = await service.authorize(authorizeInput());
    expect(operations(usage)).toBe(1);

    await service.release(outcome.reservation);
    await service.release(outcome.reservation);

    // A double release refunds once. The second call finds the amounts already
    // zeroed rather than crediting a second operation.
    expect(operations(usage)).toBe(0);
  });

  it("tolerates a null reservation", async () => {
    const { service } = build("enforce");
    await expect(service.release(null)).resolves.toBeUndefined();
  });
});

describe("local tools", () => {
  it("consume no remote-job quota and write no counter row", async () => {
    const { usage, service } = build("enforce");
    await seedOperations(usage, FREE_OPS_LIMIT);

    const outcome = await service.authorize(
      authorizeInput({ toolSlug: LOCAL_TOOL, executionMode: "local" }),
    );

    // Allowed even though the *remote* allowance is fully spent: a tool that runs
    // in the browser costs us nothing to run.
    expect(outcome.blocked).toBe(false);
    expect(outcome.allowed).toBe(true);
    expect(outcome.reservation).toBeNull();
    expect(operations(usage)).toBe(FREE_OPS_LIMIT);
  });

  it("settle to nothing rather than to zero", async () => {
    const { usage, service } = build("enforce");

    const settlement = await service.settleProcessingOutcome(
      settleInput({ toolSlug: LOCAL_TOOL, executionMode: "local" }),
    );

    expect(settlement.disposition).toBe("not_metered");
    expect(settlement.costUnits).toBe(0);
    expect(operations(usage)).toBe(0);
  });

  it("treat an unknown slug as unmetered rather than as a refusal", async () => {
    const { usage, service } = build("enforce");

    const outcome = await service.authorize(
      authorizeInput({ toolSlug: "not-a-tool", executionMode: null }),
    );

    // Refusing an unknown tool is `createJob`'s job via `assertRemoteJobTool`;
    // duplicating that guard here would put it in two places.
    expect(outcome.blocked).toBe(false);
    expect(outcome.reservation).toBeNull();
    expect(operations(usage)).toBe(0);
  });
});

describe("privacy of usage records", () => {
  it("carries no document content, no filename, no storage key, and no owner id", async () => {
    const { usage, service } = build("observe");
    await seedOperations(usage, FREE_OPS_LIMIT + 1);
    await service.authorize(authorizeInput());
    await service.settleProcessingOutcome(settleInput());

    const events = usage.recordedEvents();
    expect(events.length).toBeGreaterThan(0);
    const json = JSON.stringify(events).toLowerCase();

    for (const secret of [
      "user-1",
      "ownerid",
      "document.pdf",
      "%pdf",
      "processing-inputs/",
      "jobs/job-1/output",
      "job-1",
      "/tmp",
    ]) {
      expect(json).not.toContain(secret.toLowerCase());
    }
    // The dimensions that ARE there describe the population, not the person.
    expect(events.every((e) => e.ownerType === "user")).toBe(true);
    expect(events.some((e) => e.planId === "free")).toBe(true);
    expect(events.some((e) => e.inputSizeBucket !== null)).toBe(true);
  });

  it("has no field an owner id could be passed through", async () => {
    const { usage, service } = build("enforce");
    await service.settleProcessingOutcome(settleInput());

    // Not a matter of this method being careful: `UsageEventRecord` declares no
    // owner id, so the ledger is anonymous by construction.
    for (const event of usage.recordedEvents()) {
      expect(Object.keys(event)).not.toContain("ownerId");
    }
  });
});

describe("identity", () => {
  it("charges the actor it was given, and has no channel for a claimed one", async () => {
    const { usage, service } = build("enforce");

    // A body-supplied owner would arrive as... nothing. `authorize` accepts an
    // actor object only, and the submit path builds it from the session-resolved
    // JobActor. The closest a caller can come to spoofing is charging its OWN
    // allowance under a different label, which is what this asserts is happening.
    await service.authorize(authorizeInput({ actor: { ownerType: "anon", ownerId: "anon-9" } }));

    expect(operations(usage)).toBe(0);
    expect(
      usage.counterAmount({
        ownerType: "anon",
        ownerId: "anon-9",
        meter: "server_operations",
        periodStart: periodBoundsFor("day", AT).start,
      }),
    ).toBe(1);
  });

  it("puts an anonymous visitor on the guest plan, not on a signed-in one", async () => {
    const { service } = build("enforce");

    const outcome = await service.authorize(
      authorizeInput({ actor: { ownerType: "anon", ownerId: "anon-9" } }),
    );

    expect(outcome.plan).toBe("guest");
  });
});

describe("fail-open", () => {
  /** A repository whose reads and writes both fail. */
  class BrokenRepository extends InMemoryUsageRepository {
    async readCounters(): Promise<CounterReading[]> {
      throw new Error("database is on fire");
    }
    async incrementCounters(_: readonly CounterIncrement[]): Promise<CounterReading[]> {
      throw new Error("database is on fire");
    }
  }

  it("allows the work when metering cannot be consulted", async () => {
    const service = new UsageMeteringService({
      usage: new BrokenRepository(),
      entitlements: new StaticEntitlementProvider("free"),
      logger: new ConsoleLogger("error"),
      mode: "enforce",
      now: () => AT,
    });

    const outcome = await service.authorize(authorizeInput());

    // A metering outage must never stop someone compressing a PDF.
    expect(outcome.blocked).toBe(false);
    expect(outcome.degraded).toBe(true);
    // And no reservation is claimed, so nothing later refunds a debit that never
    // happened.
    expect(outcome.reservation).toBeNull();
  });

  it("treats an unresolvable plan as free rather than as the most generous one", async () => {
    const service = new UsageMeteringService({
      usage: new InMemoryUsageRepository(),
      entitlements: {
        planFor: async () => {
          throw new Error("no org service");
        },
      },
      logger: new ConsoleLogger("error"),
      mode: "enforce",
      now: () => AT,
    });

    expect((await service.authorize(authorizeInput())).plan).toBe("free");
  });
});

describe("snapshot", () => {
  it("reports used, remaining, and the reset instant for each enforceable meter", async () => {
    const { usage, service } = build("observe");
    await service.authorize(authorizeInput({ inputBytes: 3_000_000 }));

    const snap = await service.snapshot(ACTOR, AT);

    expect(snap.plan).toBe("free");
    expect(snap.mode).toBe("observe");
    const ops = snap.meters.find((m) => m.meter === "server_operations")!;
    expect(ops.used).toBe(1);
    expect(ops.limit).toBe(FREE_OPS_LIMIT);
    expect(ops.remaining).toBe(FREE_OPS_LIMIT - 1);
    expect(ops.resetAt.getTime()).toBe(periodBoundsFor("day", AT).end.getTime());
    // Only enforceable meters are an "allowance"; the cost ledger is not one.
    expect(snap.meters.map((m) => m.meter).sort()).toEqual([
      "server_input_bytes",
      "server_operations",
    ]);
    void usage;
  });
});

/** Puts `count` operations on the actor's day counter, bypassing the service. */
async function seedOperations(usage: InMemoryUsageRepository, count: number): Promise<void> {
  const bounds = periodBoundsFor("day", AT);
  await usage.incrementCounters([
    {
      ...ACTOR,
      meter: "server_operations",
      periodStart: bounds.start,
      periodEnd: bounds.end,
      delta: count,
    },
  ]);
}
