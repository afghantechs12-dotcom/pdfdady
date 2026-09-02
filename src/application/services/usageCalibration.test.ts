import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type {
  IUsageRepository,
  UsageEventRecord,
} from "@/src/application/ports/metering/UsageRepository";
import type { LimitMode } from "@/src/domain/metering/decision";
import { ANALYTICS_EVENTS } from "@/src/domain/metering/events";
import {
  MIN_OBSERVATION_DAYS,
  MIN_OBSERVED_OPERATIONS,
} from "@/src/domain/metering/readiness";
import {
  CALIBRATION_DEFAULT_DAYS,
  UsageAnalyticsReadService,
} from "./UsageAnalyticsReadService";

/**
 * The calibration read, against the real in-memory repository.
 *
 * `readiness.test.ts` covers the verdict as arithmetic over an observation. This
 * covers the half that arithmetic cannot: whether the observation handed to it is
 * actually assembled from the ledger, over the window the caller asked for, in
 * the mode the deployment is really running in — and whether a failed query
 * degrades rather than silently shrinking the numbers a limit would be picked
 * from.
 */

const NOW = new Date("2026-03-15T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => logger),
} as unknown as ILogger & { warn: ReturnType<typeof vi.fn> };

function makeService(usage: IUsageRepository, limitMode?: LimitMode) {
  return new UsageAnalyticsReadService({ usage, logger, now: () => NOW, limitMode });
}

/** A completed server attempt, the row calibration is built from. */
function attempt(overrides: Partial<UsageEventRecord> = {}): UsageEventRecord {
  return {
    eventName: ANALYTICS_EVENTS.tool_processing_completed,
    occurredAt: new Date(NOW.getTime() - MS_PER_DAY),
    toolSlug: "compress-pdf",
    executionMode: "remote_job",
    ownerType: "user",
    result: "success",
    inputBytes: 500_000,
    inputSizeBucket: "<1MB",
    costUnits: 3,
    durationMs: 800,
    ...overrides,
  };
}

let repo: InMemoryUsageRepository;

beforeEach(() => {
  repo = new InMemoryUsageRepository();
  logger.warn.mockClear();
});

describe("the observation is assembled from the ledger", () => {
  it("counts operations, tools and compute from recorded attempts", async () => {
    await repo.recordEvents([
      attempt(),
      attempt({ result: "failure", errorCategory: "processor_failed" }),
      attempt({ toolSlug: "ocr-pdf", costUnits: 40, durationMs: 9_000 }),
    ]);

    const { observation } = await makeService(repo).calibration();

    expect(observation.operations).toBe(3);
    expect(observation.tools.map((t) => t.toolSlug).sort()).toEqual(["compress-pdf", "ocr-pdf"]);
    const compress = observation.tools.find((t) => t.toolSlug === "compress-pdf");
    expect(compress).toMatchObject({ operations: 2, failures: 1, failureRate: 0.5 });
    expect(observation.tools.reduce((s, t) => s + t.computeUnits, 0)).toBe(46);
  });

  it("labels each tool with its execution mode from the policy, not from the row", async () => {
    // The row's own `executionMode` is what the emitter claimed; the policy is
    // authoritative. A local tool appearing as remote here would put browser-only
    // work into a server-cost calibration.
    await repo.recordEvents([attempt(), attempt({ toolSlug: "merge-pdf" })]);
    const { observation } = await makeService(repo).calibration();
    expect(observation.tools.find((t) => t.toolSlug === "merge-pdf")?.executionMode).toBe("local");
    expect(observation.tools.find((t) => t.toolSlug === "compress-pdf")?.executionMode).toBe(
      "remote_job",
    );
  });

  it("gives a tool with no attempts no failure rate rather than a perfect one", async () => {
    // Nothing ran, so 0% failure would report an unused tool as flawless.
    const { observation } = await makeService(repo).calibration();
    expect(observation.tools).toEqual([]);
    expect(observation.operations).toBe(0);
  });

  it("distributes input sizes by bucket and never by exact bytes", async () => {
    await repo.recordEvents([
      attempt({ inputBytes: 900, inputSizeBucket: "<1MB" }),
      attempt({ inputBytes: 40_000_000, inputSizeBucket: "25-100MB" }),
      attempt({ inputBytes: 40_000_001, inputSizeBucket: "25-100MB" }),
    ]);
    const { observation } = await makeService(repo).calibration();
    expect(observation.inputSizeBuckets).toEqual([
      { label: "25-100MB", count: 2 },
      { label: "<1MB", count: 1 },
    ]);
    // The bucket labels are the whole distribution — no exact size appears, so
    // two events cannot be correlated by their byte counts.
    expect(JSON.stringify(observation.inputSizeBuckets)).not.toContain("40000001");
  });

  it("names the unknown bucket rather than dropping it", async () => {
    // A dropped null makes the buckets sum to less than the operation count with
    // nothing on the page explaining the difference.
    await repo.recordEvents([attempt({ inputSizeBucket: undefined })]);
    const { observation } = await makeService(repo).calibration();
    expect(observation.inputSizeBuckets).toEqual([{ label: "unknown", count: 1 }]);
  });

  it("splits guest from authenticated traffic", async () => {
    await repo.recordEvents([
      attempt({ ownerType: "anon" }),
      attempt({ ownerType: "anon" }),
      attempt({ ownerType: "user" }),
      attempt({ ownerType: "system" }),
    ]);
    const { observation, readiness } = await makeService(repo).calibration();
    expect(observation.population).toEqual([
      { label: "anon", count: 2 },
      { label: "system", count: 1 },
      { label: "user", count: 1 },
    ]);
    expect(readiness.observed.guestShare).toBe(0.5);
  });

  it("counts would-have-blocked events from the limit ledger", async () => {
    await repo.recordEvents([
      { eventName: ANALYTICS_EVENTS.limit_reached, occurredAt: new Date(NOW.getTime() - MS_PER_DAY) },
      { eventName: ANALYTICS_EVENTS.limit_reached, occurredAt: new Date(NOW.getTime() - MS_PER_DAY) },
      attempt(),
    ]);
    const { observation, readiness } = await makeService(repo, "observe").calibration();
    expect(observation.limitEvents).toBe(2);
    expect(readiness.observed.wouldHaveBlocked).toBe(2);
  });

  it("counts only rows inside the requested window", async () => {
    await repo.recordEvents([
      attempt({ occurredAt: new Date(NOW.getTime() - 2 * MS_PER_DAY) }),
      attempt({ occurredAt: new Date(NOW.getTime() - 60 * MS_PER_DAY) }),
    ]);
    const { observation, window } = await makeService(repo).calibration({
      from: new Date(NOW.getTime() - 7 * MS_PER_DAY).toISOString(),
    });
    expect(observation.operations).toBe(1);
    // `observation.days` is MEASURED coverage and `window.days` is the span asked
    // for. One attempt on one day inside a seven-day window is one observed day —
    // if these were the same number, a wider date range would be indistinguishable
    // from more traffic.
    expect(observation.days).toBe(1);
    expect(window.days).toBe(7);
  });

  it("measures observed days as distinct calendar days carrying server traffic", async () => {
    await repo.recordEvents([
      attempt({ occurredAt: new Date(NOW.getTime() - 3 * MS_PER_DAY) }),
      // Same calendar day as the row above, twelve hours apart: volume, not coverage.
      attempt({ occurredAt: new Date(NOW.getTime() - 3 * MS_PER_DAY + 3_600_000) }),
      attempt({ occurredAt: new Date(NOW.getTime() - 5 * MS_PER_DAY) }),
    ]);
    const { observation } = await makeService(repo).calibration();
    expect(observation.operations).toBe(3);
    expect(observation.days).toBe(2);
  });

  it("does not count a day of local-tool traffic as an observed day", async () => {
    // A day on which only in-browser work happened observed nothing about server
    // capacity, so it cannot help clear the observation-days threshold.
    await repo.recordEvents([
      attempt({ toolSlug: "merge-pdf", occurredAt: new Date(NOW.getTime() - 2 * MS_PER_DAY) }),
      attempt({ toolSlug: "compress-pdf", occurredAt: new Date(NOW.getTime() - 4 * MS_PER_DAY) }),
    ]);
    const { observation, readiness } = await makeService(repo).calibration();
    // Both rows are still measured — the observation is honest about what it saw.
    expect(observation.operations).toBe(2);
    // Only the server day counts toward readiness, and only the server operation.
    expect(observation.days).toBe(1);
    expect(readiness.observed.operations).toBe(1);
    expect(readiness.observed.excludedOperations).toBe(1);
  });

  it("cannot have its days threshold widened away by a longer date range", async () => {
    // The bypass this exists to close: two thousand operations on ONE day, asked
    // for over a quarter. A window-span reading of "days" would report 92 observed
    // days and clear the fortnight threshold on a single day of traffic.
    await repo.recordEvents(
      Array.from({ length: 2_000 }, (_, i) =>
        attempt({ toolSlug: ["compress-pdf", "ocr-pdf", "protect-pdf"][i % 3] }),
      ),
    );
    const { observation, window, readiness } = await makeService(repo).calibration({
      from: new Date(NOW.getTime() - 900 * MS_PER_DAY).toISOString(),
    });
    expect(window.days).toBeGreaterThan(MIN_OBSERVATION_DAYS);
    expect(observation.days).toBe(1);
    expect(readiness.ready_for_enforcement).toBe(false);
    expect(readiness.reason).toBe("insufficient_observation_data");
  });

  it("defaults to a window long enough for the days threshold to be reachable", async () => {
    // A seven-day default could never contain fourteen distinct days, so the days
    // gap would be permanent and structural rather than a fact about traffic.
    const { window } = await makeService(repo).calibration();
    expect(window.days).toBe(CALIBRATION_DEFAULT_DAYS);
    expect(CALIBRATION_DEFAULT_DAYS).toBeGreaterThanOrEqual(MIN_OBSERVATION_DAYS);
  });

  it("clamps an over-long range and reports the clamp", async () => {
    const { window } = await makeService(repo).calibration({
      from: new Date(NOW.getTime() - 900 * MS_PER_DAY).toISOString(),
    });
    expect(window.clamped).toBe(true);
  });
});

describe("the verdict reflects the real deployment", () => {
  it("reports the mode it was constructed with", async () => {
    for (const mode of ["off", "observe", "enforce"] as const) {
      const { observation } = await makeService(repo, mode).calibration();
      expect(observation.limitMode).toBe(mode);
    }
  });

  it("defaults to observe, so a forgotten wiring cannot claim enforcement is live", async () => {
    const { observation } = await makeService(repo).calibration();
    expect(observation.limitMode).toBe("observe");
  });

  it("refuses enforcement on a fresh deployment", async () => {
    // The realistic case, and the one the milestone actually ships in: a handful of
    // events and nothing like two weeks of them.
    await repo.recordEvents([attempt(), attempt({ toolSlug: "ocr-pdf" })]);
    const { readiness, recommendations } = await makeService(repo).calibration();
    expect(readiness.ready_for_enforcement).toBe(false);
    expect(readiness.reason).toBe("insufficient_observation_data");
    expect(readiness.gaps.length).toBeGreaterThan(0);
    for (const rec of recommendations) expect(rec.status).toBe("insufficient_data");
  });

  it("cannot be ready on volume alone, however much of it there is", async () => {
    // Two thousand operations across three server tools, all on one day. Every
    // threshold but coverage is cleared, and coverage is the one that says whether
    // this is our volume or one busy afternoon.
    await repo.recordEvents(
      Array.from({ length: 2_000 }, (_, i) =>
        attempt({ toolSlug: ["compress-pdf", "ocr-pdf", "protect-pdf"][i % 3] }),
      ),
    );
    const { readiness } = await makeService(repo).calibration();
    expect(readiness.observed.operations).toBe(2_000);
    expect(readiness.observed.toolsObserved).toBe(3);
    expect(readiness.observed.days).toBeLessThan(MIN_OBSERVATION_DAYS);
    expect(readiness.ready_for_enforcement).toBe(false);
    expect(readiness.gaps.join(" ")).toContain("required days");
  });

  it("becomes ready only once real traffic spans the required days", async () => {
    // The positive control for every refusal above: the same thresholds DO clear
    // when the ledger genuinely holds a fortnight of server traffic across three
    // tools. Without this, every assertion here would also pass against a verdict
    // hardcoded to false.
    await repo.recordEvents(
      Array.from({ length: MIN_OBSERVATION_DAYS * 60 }, (_, i) =>
        attempt({
          toolSlug: ["compress-pdf", "ocr-pdf", "protect-pdf"][i % 3],
          occurredAt: new Date(NOW.getTime() - (1 + (i % MIN_OBSERVATION_DAYS)) * MS_PER_DAY),
        }),
      ),
    );
    const { readiness } = await makeService(repo, "observe").calibration();
    expect(readiness.observed.days).toBe(MIN_OBSERVATION_DAYS);
    expect(readiness.observed.operations).toBeGreaterThanOrEqual(MIN_OBSERVED_OPERATIONS);
    expect(readiness.ready_for_enforcement).toBe(true);
    expect(readiness.reason).toBe("observation_sufficient");
  });
});

describe("a failed query degrades instead of shrinking the basis", () => {
  /** Real repository, one method replaced with a rejection. */
  function withBrokenQuery(method: keyof IUsageRepository): IUsageRepository {
    const usage = new InMemoryUsageRepository();
    return Object.assign(Object.create(Object.getPrototypeOf(usage)), usage, {
      [method]: () => Promise.reject(new Error("query failed")),
    }) as IUsageRepository;
  }

  it("marks the observation degraded and refuses readiness", async () => {
    const { observation, readiness } = await makeService(
      withBrokenQuery("toolUsageSummary"),
    ).calibration();
    expect(observation.degraded).toBe(true);
    expect(readiness.ready_for_enforcement).toBe(false);
    expect(readiness.reason).toBe("observation_degraded");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("degrades on any one of the reads, not just the tool query", async () => {
    for (const method of ["dimensionCounts", "eventCounts", "observedOperationDays"] as const) {
      const { observation } = await makeService(withBrokenQuery(method)).calibration();
      expect(observation.degraded, method).toBe(true);
    }
  });

  it("still answers, so a broken query cannot take the admin page down", async () => {
    const report = await makeService(withBrokenQuery("toolUsageSummary")).calibration();
    expect(report.window.days).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });
});

describe("the calibration payload carries no identity", () => {
  it("exposes no owner, subject, filename or storage key", async () => {
    await repo.recordEvents([
      attempt({ ownerType: "user", subjectHash: "deadbeefdeadbeef" }),
      attempt({ ownerType: "anon", subjectHash: "cafebabecafebabe" }),
    ]);
    const body = JSON.stringify(await makeService(repo).calibration());
    for (const forbidden of ["subjectHash", "deadbeef", "cafebabe", "ownerId", "jobId"]) {
      expect(body, `calibration payload leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("reports populations as counts per type, never as a list of actors", async () => {
    await repo.recordEvents([attempt({ ownerType: "anon" })]);
    const { observation } = await makeService(repo).calibration();
    // Buckets are {label, count}. There is no shape here that could hold an id.
    for (const bucket of observation.population) {
      expect(Object.keys(bucket).sort()).toEqual(["count", "label"]);
    }
  });
});
