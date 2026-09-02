import { describe, expect, it } from "vitest";

import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import { StaticEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import type { IUsageRepository } from "@/src/application/ports/metering/UsageRepository";
import { periodBoundsFor } from "@/src/domain/metering/periods";
import { UsageMeteringService } from "./UsageMeteringService";

/**
 * Duplicate settlement protection, across processes and across restarts.
 *
 * `UsageMeteringService.test.ts` already covers "a duplicate completion does not
 * double-count" — but only within ONE service instance, which is exactly what an
 * in-process `Set` is good at. That guard was the known limitation this file
 * closes: two workers settling the same job each had their own set, and a process
 * restart forgot every settlement it had ever made.
 *
 * So the shape of every test here is the shape of the bug: two services over ONE
 * repository (two workers over one database), or a fresh service over a
 * repository that already has markers in it (a restart). Nothing is mocked into
 * position — the second service is a genuinely separate object with a genuinely
 * empty memory, and the only thing it shares with the first is the store.
 *
 * The asymmetry between the two meters is deliberate and asserted: the CUSTOMER
 * settlement must happen exactly once, while the infrastructure attempt telemetry
 * may record both attempts. One is a bill and one is a measurement of what the
 * work cost us.
 */

const AT = new Date("2026-08-25T12:00:00.000Z");
const ACTOR = { ownerType: "user" as const, ownerId: "user-1" };

/** One store, N services over it. `workers(2)` is two processes, one database. */
function workers(count: number, usage: IUsageRepository = new InMemoryUsageRepository()) {
  const services = Array.from({ length: count }, () =>
    new UsageMeteringService({
      usage,
      entitlements: new StaticEntitlementProvider("free"),
      logger: new ConsoleLogger("error"),
      mode: "enforce",
      now: () => AT,
    }),
  );
  return { usage, services };
}

function operations(usage: InMemoryUsageRepository): number {
  return usage.counterAmount({
    ...ACTOR,
    meter: "server_operations",
    periodStart: periodBoundsFor("day", AT).start,
  });
}

function settleInput(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    actor: ACTOR,
    toolSlug: "compress-pdf",
    executionMode: "remote_job" as const,
    result: "failure" as const,
    attempt: 1,
    willRetry: false,
    inputBytes: 1_000_000,
    outputBytes: null,
    pageCount: null,
    durationMs: 1234,
    errorCategory: "processor_failed" as const,
    reservation: { reservedAt: AT },
    ...overrides,
  } as Parameters<UsageMeteringService["settleProcessingOutcome"]>[0];
}

/** Takes the allowance the way admission does, so there is something to refund. */
async function reserve(service: UsageMeteringService) {
  const outcome = await service.authorize({
    actor: ACTOR,
    toolSlug: "compress-pdf",
    executionMode: "remote_job",
    inputBytes: 1_000_000,
    largestInputBytes: 1_000_000,
  });
  if (outcome.blocked) throw new Error("unexpectedly blocked");
  return outcome;
}

// ---------------------------------------------------------------------------

describe("two workers settling the same job", () => {
  it("refunds a failure exactly once", async () => {
    const { usage, services } = workers(2);
    const [a, b] = services;
    await reserve(a);
    expect(operations(usage as InMemoryUsageRepository)).toBe(1);

    // Concurrently, not sequentially: the interleaving is the point. A read then
    // a write would let both observe "not settled" and both refund to -1.
    const [first, second] = await Promise.all([
      a.settleProcessingOutcome(settleInput()),
      b.settleProcessingOutcome(settleInput()),
    ]);

    expect(operations(usage as InMemoryUsageRepository)).toBe(0);
    // One of them did it and one found it done. Which one is a race and is not
    // asserted; that exactly one settled is the invariant.
    expect([first.disposition, second.disposition].sort()).toEqual(["duplicate", "refunded"]);
    expect([first.settled, second.settled].sort()).toEqual([false, true]);
  });

  it("keeps a success at one operation", async () => {
    const { usage, services } = workers(2);
    const [a, b] = services;
    await reserve(a);

    await Promise.all([
      a.settleProcessingOutcome(settleInput({ result: "success", errorCategory: null })),
      b.settleProcessingOutcome(settleInput({ result: "success", errorCategory: null })),
    ]);

    // A success settles to "keep the reservation". Two of them keeping it must
    // not add a second charge — nor, worse, refund one and keep the other.
    expect(operations(usage as InMemoryUsageRepository)).toBe(1);
  });

  it("still records both attempts, because that is telemetry and not a bill", async () => {
    const { usage, services } = workers(2);
    const [a, b] = services;
    await reserve(a);

    await Promise.all([
      a.settleProcessingOutcome(settleInput()),
      b.settleProcessingOutcome(settleInput()),
    ]);

    const store = usage as InMemoryUsageRepository;
    const attempts = store
      .recordedEvents()
      .filter((e) => e.eventName === "tool_processing_completed");
    // Two attempt rows, one customer refund. The infrastructure guard is
    // per-process on purpose: a duplicated cost measurement is a rounding error
    // in a calibration dataset, and a duplicated refund is free quota.
    expect(attempts).toHaveLength(2);
    expect(operations(store)).toBe(0);
  });
});

describe("a restarted process", () => {
  it("does not settle a job the previous process already settled", async () => {
    const { usage, services } = workers(1);
    await reserve(services[0]);
    const before = await services[0].settleProcessingOutcome(settleInput());
    expect(before.disposition).toBe("refunded");
    expect(operations(usage as InMemoryUsageRepository)).toBe(0);

    // The deploy. A brand-new service with an empty memory over the same store —
    // which is precisely the case an in-process set could not see, and the reason
    // a redelivered completion callback after a restart used to refund twice.
    const { services: after } = workers(1, usage);
    const again = await after[0].settleProcessingOutcome(settleInput());

    expect(again.settled).toBe(false);
    expect(again.disposition).toBe("duplicate");
    expect(operations(usage as InMemoryUsageRepository)).toBe(0);
  });

  it("does not re-charge a success either", async () => {
    const { usage, services } = workers(1);
    await reserve(services[0]);
    const success = settleInput({ result: "success", errorCategory: null });
    await services[0].settleProcessingOutcome(success);

    const { services: after } = workers(1, usage);
    const again = await after[0].settleProcessingOutcome(success);

    expect(again.disposition).toBe("duplicate");
    expect(operations(usage as InMemoryUsageRepository)).toBe(1);
  });
});

describe("a duplicate completion callback", () => {
  it("is answered from the store, not from memory", async () => {
    // The same service, twice — an SSE reconnect, a redelivered queue message, a
    // handler that records twice. Covered before this change too, and kept: the
    // durable claim must not have made the cheap case worse.
    const { usage, services } = workers(1);
    await reserve(services[0]);
    const first = await services[0].settleProcessingOutcome(settleInput());
    const second = await services[0].settleProcessingOutcome(settleInput());

    expect(first.disposition).toBe("refunded");
    expect(second.disposition).toBe("duplicate");
    expect(operations(usage as InMemoryUsageRepository)).toBe(0);
  });
});

describe("a retry", () => {
  it("leaves the job unclaimed while another attempt is still coming", async () => {
    const { usage, services } = workers(2);
    const [a, b] = services;
    await reserve(a);

    // Attempt 1 failed and WILL be retried. Claiming here would mark the job
    // settled while it is still going to run, so attempt 2's real outcome could
    // never be recorded — a permanently failed job would keep the charge.
    const pending = await a.settleProcessingOutcome(settleInput({ willRetry: true }));
    expect(pending.disposition).toBe("pending_retry");
    expect(operations(usage as InMemoryUsageRepository)).toBe(1);

    // Attempt 2, on a different worker, settles for real.
    const final = await b.settleProcessingOutcome(settleInput({ attempt: 2 }));
    expect(final.disposition).toBe("refunded");
    expect(operations(usage as InMemoryUsageRepository)).toBe(0);
  });

  it("is never a second customer operation, however many attempts it takes", async () => {
    const { usage, services } = workers(1);
    await reserve(services[0]);
    for (const attempt of [1, 2, 3]) {
      await services[0].settleProcessingOutcome(
        settleInput({ attempt, willRetry: attempt < 3, result: "success", errorCategory: null }),
      );
    }
    // Three attempts, three compute charges, ONE customer operation.
    const store = usage as InMemoryUsageRepository;
    expect(operations(store)).toBe(1);
    expect(
      store.counterAmount({
        ...ACTOR,
        meter: "compute_units",
        periodStart: periodBoundsFor("month", AT).start,
      }),
    ).toBeGreaterThan(0);
    expect(
      store.recordedEvents().filter((e) => e.eventName === "tool_processing_completed"),
    ).toHaveLength(3);
  });
});

describe("when the claim store is unreachable", () => {
  /** A repository whose claim call fails, everything else real. */
  function brokenClaims() {
    const usage = new InMemoryUsageRepository();
    const broken = Object.assign(Object.create(Object.getPrototypeOf(usage)), usage, {
      claimSettlement: () => Promise.reject(new Error("claims table offline")),
    }) as IUsageRepository;
    return { usage, broken };
  }

  it("settles anyway, once, and says the settlement was degraded", async () => {
    const { usage, broken } = brokenClaims();
    const { services } = workers(1, broken);
    await reserve(services[0]);

    const first = await services[0].settleProcessingOutcome(settleInput());
    const second = await services[0].settleProcessingOutcome(settleInput());

    // Fail-open, not fail-shut: a metering outage must not stop a refund the user
    // is owed. The in-process guard still prevents the duplicate within this
    // process, and `degraded` is how a caller knows the cross-process guarantee
    // was not available for this settlement.
    expect(first).toMatchObject({ settled: true, disposition: "refunded", degraded: true });
    expect(second).toMatchObject({ settled: false, disposition: "duplicate", degraded: true });
    expect(operations(usage)).toBe(0);
  });

  it("does not report a healthy settlement as degraded", async () => {
    const { usage, services } = workers(1);
    await reserve(services[0]);
    const settlement = await services[0].settleProcessingOutcome(settleInput());
    expect(settlement.degraded).toBe(false);
    expect(operations(usage as InMemoryUsageRepository)).toBe(0);
  });
});
