import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryUsageRepository } from "@/src/infrastructure/persistence/InMemoryUsageRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type {
  IUsageRepository,
  UsageEventRecord,
  UsageWindow,
} from "@/src/application/ports/metering/UsageRepository";
import { ANALYTICS_EVENTS } from "@/src/domain/metering/events";
import { FUNNEL_STEPS, LOCAL_FUNNEL_STEPS } from "@/src/domain/metering/funnel";
import {
  boundReportWindow,
  DEFAULT_REPORT_DAYS,
  FUNNEL_TOOL_SLUG,
  FUNNEL_TOOLS_LIMIT,
  MAX_REPORT_DAYS,
  TOP_TOOLS_LIMIT,
  UsageAnalyticsReadService,
} from "./UsageAnalyticsReadService";

/**
 * The read surface's contract, against the real in-memory repository rather than
 * a mock of it — so the aggregation being asserted is aggregation that a
 * repository actually performs, not a stub's echo of the expected answer.
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

function makeService(usage: IUsageRepository): UsageAnalyticsReadService {
  return new UsageAnalyticsReadService({ usage, logger, now: () => NOW });
}

function event(overrides: Partial<UsageEventRecord> & { eventName: string }): UsageEventRecord {
  return {
    occurredAt: new Date(NOW.getTime() - MS_PER_DAY),
    ...overrides,
  };
}

let repo: InMemoryUsageRepository;

beforeEach(() => {
  repo = new InMemoryUsageRepository();
  logger.warn.mockClear();
});

describe("window bounding", () => {
  it("defaults to the recent window when no bounds are given", () => {
    const w = boundReportWindow({}, NOW);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.days).toBe(DEFAULT_REPORT_DAYS);
    expect(w.clamped).toBe(false);
  });

  it("caps an over-long range and says that it did", () => {
    const w = boundReportWindow(
      { from: new Date(NOW.getTime() - 900 * MS_PER_DAY).toISOString() },
      NOW,
    );
    expect(w.days).toBe(MAX_REPORT_DAYS);
    expect(w.clamped).toBe(true);
    // The recent end is preserved: an operator asking for "everything" still
    // sees today, which is the part they were looking at.
    expect(w.to.toISOString()).toBe(NOW.toISOString());
  });

  it("never reports into the future", () => {
    const w = boundReportWindow({ to: new Date(NOW.getTime() + 30 * MS_PER_DAY).toISOString() }, NOW);
    expect(w.to.toISOString()).toBe(NOW.toISOString());
    expect(w.clamped).toBe(true);
  });

  it("repairs reversed bounds instead of returning an empty report", () => {
    const w = boundReportWindow(
      { from: "2026-03-14T00:00:00.000Z", to: "2026-03-01T00:00:00.000Z" },
      NOW,
    );
    expect(w.from.getTime()).toBeLessThan(w.to.getTime());
    expect(w.clamped).toBe(true);
  });

  it("ignores an unparseable bound rather than failing the page", () => {
    const w = boundReportWindow({ from: "last tuesday", to: "" }, NOW);
    expect(w.days).toBe(DEFAULT_REPORT_DAYS);
    // Still flagged: the caller asked for something and got the default.
    expect(w.clamped).toBe(true);
  });

  it("bounds the window the report actually queries", async () => {
    const seen: Array<{ from: Date; to: Date }> = [];
    const spy: IUsageRepository = {
      ...repo,
      toolUsageSummary: async (w: UsageWindow) => {
        seen.push(w);
        return [];
      },
      eventCounts: async (w: UsageWindow) => {
        seen.push(w);
        return [];
      },
      dimensionCounts: async (w: UsageWindow) => {
        seen.push(w);
        return [];
      },
    } as unknown as IUsageRepository;

    await makeService(spy).report({ from: "1970-01-01T00:00:00.000Z" });

    expect(seen.length).toBeGreaterThan(0);
    for (const w of seen) {
      // Every query, not merely the reported window, is inside the cap. A bound
      // computed for the header and a different one passed to the store is the
      // shape this asserts against.
      expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(MAX_REPORT_DAYS * MS_PER_DAY);
      expect(w.to.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it("excludes events outside the requested window", async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_processing_completed, toolSlug: "merge-pdf", result: "success" }),
    );
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.tool_processing_completed,
        toolSlug: "merge-pdf",
        result: "success",
        occurredAt: new Date(NOW.getTime() - 40 * MS_PER_DAY),
      }),
    );

    const report = await makeService(repo).report({
      from: new Date(NOW.getTime() - 2 * MS_PER_DAY).toISOString(),
    });
    expect(report.processing.runs).toBe(1);
  });
});

describe("processing totals", () => {
  beforeEach(async () => {
    for (const [slug, result] of [
      ["merge-pdf", "success"],
      ["merge-pdf", "success"],
      ["merge-pdf", "failure"],
      ["compress-pdf", "success"],
      ["compress-pdf", "cancelled"],
    ] as const) {
      await repo.recordEvent(
        event({
          eventName: ANALYTICS_EVENTS.tool_processing_completed,
          toolSlug: slug,
          result,
          inputBytes: 1000,
          costUnits: 2,
          durationMs: 500,
        }),
      );
    }
  });

  it("aggregates successes and failures across tools", async () => {
    const { processing } = await makeService(repo).report();
    expect(processing.runs).toBe(5);
    expect(processing.succeeded).toBe(3);
    expect(processing.failed).toBe(1);
    expect(processing.cancelled).toBe(1);
    expect(processing.successRate).toBeCloseTo(3 / 5);
    expect(processing.inputBytes).toBe(5000);
    expect(processing.computeUnits).toBe(10);
  });

  it("ranks tools by volume and reports how many exist", async () => {
    const { topTools, toolCount } = await makeService(repo).report();
    expect(topTools.map((t) => t.toolSlug)).toEqual(["merge-pdf", "compress-pdf"]);
    expect(topTools[0]?.total).toBe(3);
    expect(topTools[0]?.succeeded).toBe(2);
    expect(topTools[0]?.failed).toBe(1);
    expect(toolCount).toBe(2);
  });

  it("caps the tool table but still counts what it dropped", async () => {
    for (let i = 0; i < TOP_TOOLS_LIMIT + 4; i += 1) {
      await repo.recordEvent(
        event({
          eventName: ANALYTICS_EVENTS.tool_processing_completed,
          toolSlug: `filler-${i}`,
          result: "success",
        }),
      );
    }
    const { topTools, toolCount } = await makeService(repo).report();
    expect(topTools).toHaveLength(TOP_TOOLS_LIMIT);
    // A truncated table that reported its own length as the total would read as
    // "these are all the tools", which is how a silent cap becomes a wrong answer.
    expect(toolCount).toBeGreaterThan(TOP_TOOLS_LIMIT);
  });

  it("weights the overall duration by measurements, not by attempts", async () => {
    repo.reset();
    // One tool with a single slow timed run, another with many untimed runs.
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_processing_completed, toolSlug: "slow", result: "success", durationMs: 10_000 }),
    );
    for (let i = 0; i < 20; i += 1) {
      await repo.recordEvent(
        event({ eventName: ANALYTICS_EVENTS.tool_processing_completed, toolSlug: "untimed", result: "success" }),
      );
    }
    const { processing } = await makeService(repo).report();
    // 10s, from the one measurement that exists. Weighting by `total` would
    // divide the single sample across 21 attempts and report ~476ms.
    expect(processing.averageDurationMs).toBe(10_000);
    expect(processing.durationSamples).toBe(1);
  });
});

describe("execution mode split", () => {
  it("separates in-browser from server work", async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.job_succeeded, toolSlug: FUNNEL_TOOL_SLUG, executionMode: "local" }),
    );
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.job_succeeded, toolSlug: FUNNEL_TOOL_SLUG, executionMode: "local" }),
    );
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_processing_completed, toolSlug: "ocr", executionMode: "remote_job", result: "success" }),
    );

    const { execution } = await makeService(repo).report();
    expect(execution).toEqual([
      { label: "local", count: 2 },
      { label: "remote_job", count: 1 },
    ]);
  });

  it("names an unrecorded mode rather than folding it into local", async () => {
    await repo.recordEvent(event({ eventName: ANALYTICS_EVENTS.job_succeeded }));
    const { execution } = await makeService(repo).report();
    expect(execution).toEqual([{ label: "unattributed", count: 1 }]);
  });

  it("ignores page views, which would make local activity a browse count", async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_view, toolSlug: FUNNEL_TOOL_SLUG, executionMode: "local" }),
    );
    const { execution } = await makeService(repo).report();
    expect(execution).toEqual([]);
  });
});

describe("failure categories", () => {
  it("reports the categories the ledger recorded", async () => {
    for (const category of ["encrypted_input", "encrypted_input", "corrupt_input"]) {
      await repo.recordEvent(
        event({
          eventName: ANALYTICS_EVENTS.tool_processing_completed,
          toolSlug: "compress-pdf",
          result: "failure",
          errorCategory: category,
        }),
      );
    }
    const { errorCategories } = await makeService(repo).report();
    expect(errorCategories).toEqual([
      { label: "encrypted_input", count: 2 },
      { label: "corrupt_input", count: 1 },
    ]);
  });

  it("does not list successes as an unnamed failure category", async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_processing_completed, toolSlug: "merge-pdf", result: "success" }),
    );
    const { errorCategories } = await makeService(repo).report();
    // A success has no errorCategory, so it lands in the null bucket. Surfacing
    // that bucket would put the success count in a list of failures.
    expect(errorCategories).toEqual([]);
  });

  it("invents no category for a local failure that has none", async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.job_failed, toolSlug: FUNNEL_TOOL_SLUG, executionMode: "local" }),
    );
    const report = await makeService(repo).report();
    expect(report.errorCategories).toEqual([]);
    // Counted, and counted as what it is: uncategorized.
    expect(report.uncategorizedLocalFailures).toBe(1);
  });

  it("counts a classified local failure as a failure class, not as a gap", async () => {
    // Local tools carry a category now. Filing them under "uncategorized"
    // anyway would report a measurement gap that has been closed, and would
    // leave every in-browser failure out of the one card that names causes.
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.job_failed,
        toolSlug: FUNNEL_TOOL_SLUG,
        executionMode: "local",
        errorCategory: "corrupt_document",
      }),
    );
    const report = await makeService(repo).report();
    expect(report.errorCategories).toEqual([{ label: "corrupt_document", count: 1 }]);
    expect(report.uncategorizedLocalFailures).toBe(0);
  });

  it("sums a local and a server failure of the same class into one row", async () => {
    // `LocalToolErrorCategory` is `satisfies readonly JobErrorCategory[]`, so the
    // label means the same thing in both places. Two rows with the same name
    // would read as two different causes.
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.job_failed,
        toolSlug: FUNNEL_TOOL_SLUG,
        executionMode: "local",
        errorCategory: "password_required",
      }),
    );
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.tool_processing_completed,
        toolSlug: "compress-pdf",
        executionMode: "remote_job",
        result: "failure",
        errorCategory: "password_required",
      }),
    );
    const report = await makeService(repo).report();
    expect(report.errorCategories).toEqual([{ label: "password_required", count: 2 }]);
  });

  it("orders categories by count, so the biggest cause is first", async () => {
    for (let i = 0; i < 3; i += 1) {
      await repo.recordEvent(
        event({
          eventName: ANALYTICS_EVENTS.job_failed,
          toolSlug: FUNNEL_TOOL_SLUG,
          executionMode: "local",
          errorCategory: "internal_error",
        }),
      );
    }
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.job_failed,
        toolSlug: FUNNEL_TOOL_SLUG,
        executionMode: "local",
        errorCategory: "invalid_input",
      }),
    );
    const { errorCategories } = await makeService(repo).report();
    expect(errorCategories.map((c) => c.label)).toEqual(["internal_error", "invalid_input"]);
  });

  it("still keeps a successful server attempt out of the failure list", async () => {
    // Both reads have a null bucket and they mean opposite things. A merge that
    // kept nulls would put the success count in a list of failures.
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.tool_processing_completed,
        toolSlug: "compress-pdf",
        executionMode: "remote_job",
        result: "success",
      }),
    );
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.job_failed, toolSlug: FUNNEL_TOOL_SLUG, executionMode: "local" }),
    );
    const report = await makeService(repo).report();
    expect(report.errorCategories).toEqual([]);
    expect(report.uncategorizedLocalFailures).toBe(1);
  });
});

describe("funnel", () => {
  async function trackFunnel(counts: Partial<Record<string, number>>, toolSlug = FUNNEL_TOOL_SLUG) {
    for (const [name, count] of Object.entries(counts)) {
      for (let i = 0; i < (count ?? 0); i += 1) {
        await repo.recordEvent(event({ eventName: name, toolSlug, executionMode: "local" }));
      }
    }
  }

  it("reports the local spine in order", async () => {
    await trackFunnel({
      tool_view: 100,
      file_selected: 60,
      tool_start: 50,
      job_succeeded: 45,
      download: 30,
    });
    const { funnel } = await makeService(repo).report();
    expect(funnel.steps.map((s) => s.step)).toEqual([...LOCAL_FUNNEL_STEPS]);
    expect(funnel.steps.map((s) => s.count)).toEqual([100, 60, 50, 45, 30]);
    expect(funnel.steps[4]?.conversionFromStart).toBeCloseTo(0.3);
    expect(funnel.countUnit).toBe("events");
  });

  it("names the step that loses the most", async () => {
    await trackFunnel({
      tool_view: 100,
      file_selected: 90,
      tool_start: 85,
      job_succeeded: 80,
      download: 20,
    });
    const { funnel } = await makeService(repo).report();
    expect(funnel.worstStep).toBe(ANALYTICS_EVENTS.download);
  });

  it("survives a missing optional step without crashing or inventing one", async () => {
    // No file_selected at all — an older client, or a beacon lost on unload.
    await trackFunnel({ tool_view: 10, tool_start: 8, job_succeeded: 8, download: 5 });
    const { funnel } = await makeService(repo).report();
    expect(funnel.steps).toHaveLength(LOCAL_FUNNEL_STEPS.length);
    // The missing step reads as zero and clamps everything after it: the
    // defensible floor. Skipping the step would report 80% conversion through a
    // stage no data supports.
    expect(funnel.steps[1]?.count).toBe(0);
    expect(funnel.steps.every((s) => s.conversionFromPrevious <= 1)).toBe(true);
  });

  it("keeps every ratio in 0–1 when a later step outnumbers an earlier one", async () => {
    await trackFunnel({ tool_view: 5, file_selected: 40, tool_start: 40, job_succeeded: 40, download: 40 });
    const { funnel } = await makeService(repo).report();
    expect(funnel.steps.every((s) => s.conversionFromStart <= 1)).toBe(true);
    expect(funnel.steps.every((s) => s.count <= 5)).toBe(true);
  });

  it("counts only the funnel tool's events", async () => {
    const full = { tool_view: 10, file_selected: 10, tool_start: 10, job_succeeded: 10, download: 10 };
    await trackFunnel(full);
    // A second, busier tool. Unfiltered, its 500s would swamp the 10s above and
    // the conversion between two steps would be a number about no tool at all.
    await trackFunnel({ ...full, tool_view: 500, download: 500 }, "split-pdf");
    const { funnel } = await makeService(repo).report();
    expect(funnel.steps[0]?.count).toBe(10);
    expect(funnel.steps[4]?.count).toBe(10);
  });

  it("keeps failures out of the spine", async () => {
    await trackFunnel({ tool_view: 10, file_selected: 10, tool_start: 10, job_failed: 10 });
    const { funnel } = await makeService(repo).report();
    expect(funnel.steps.map((s) => s.step)).not.toContain(ANALYTICS_EVENTS.job_failed);
    expect(funnel.failed).toBe(10);
  });
});

describe("zero data", () => {
  it("reports a usable empty shape rather than nulls or a throw", async () => {
    const report = await makeService(repo).report();
    expect(report.processing.runs).toBe(0);
    // Null, not 0: a 0% success rate on a quiet day reads as total failure.
    expect(report.processing.successRate).toBeNull();
    expect(report.processing.averageDurationMs).toBeNull();
    expect(report.topTools).toEqual([]);
    expect(report.toolCount).toBe(0);
    expect(report.execution).toEqual([]);
    expect(report.errorCategories).toEqual([]);
    expect(report.funnel.steps).toHaveLength(LOCAL_FUNNEL_STEPS.length);
    expect(report.funnel.steps.every((s) => s.count === 0)).toBe(true);
    expect(report.funnel.worstStep).toBeNull();
    expect(report.degraded).toBe(false);
  });
});

describe("comparing funnels across tools", () => {
  async function track(toolSlug: string, counts: Partial<Record<string, number>>) {
    const mode = toolSlug === "compress-pdf" ? "remote_job" : "local";
    for (const [name, count] of Object.entries(counts)) {
      for (let i = 0; i < (count ?? 0); i += 1) {
        await repo.recordEvent(event({ eventName: name, toolSlug, executionMode: mode }));
      }
    }
  }

  it("reports a funnel for every tool with activity, not just merge", async () => {
    // The gap this closes: eleven local tools were uninstrumented, so the
    // dashboard showed one funnel and looked complete.
    await track("merge-pdf", { tool_view: 10, file_selected: 8, tool_start: 7, job_succeeded: 6, download: 5 });
    await track("crop-pdf", { tool_view: 4, file_selected: 3, tool_start: 3, job_succeeded: 2, download: 1 });
    await track("sign-pdf", { tool_view: 2, file_selected: 1 });

    const { funnels, funnelToolCount } = await makeService(repo).report();
    expect(funnels.map((f) => f.toolSlug)).toEqual(["merge-pdf", "crop-pdf", "sign-pdf"]);
    expect(funnelToolCount).toBe(3);
    expect(funnels[1]?.steps.map((s) => s.count)).toEqual([4, 3, 3, 2, 1]);
  });

  it("orders by the tools with the most people in them, not the most rows", async () => {
    // `noisy` has more events but fewer visitors. Ranking on row count would put
    // a tool with a lot of retries above the one most people actually reach.
    await track("crop-pdf", { tool_view: 50 });
    await track("sign-pdf", { tool_view: 10, file_selected: 10, tool_start: 10, job_failed: 40 });

    const { funnels } = await makeService(repo).report();
    expect(funnels[0]?.toolSlug).toBe("crop-pdf");
  });

  it("measures a server tool against the spine that has job_submitted", async () => {
    // Local and remote funnels are different sequences. Reporting compress-pdf
    // against the local spine would ignore the step where a submission is lost;
    // reporting merge against the remote one would read a structural zero at
    // `job_submitted` and clamp its download count to nothing.
    await track("compress-pdf", {
      tool_view: 20,
      tool_start: 15,
      file_selected: 15,
      job_submitted: 12,
      job_succeeded: 10,
      download: 8,
    });
    await track("merge-pdf", { tool_view: 20, file_selected: 18, tool_start: 16, job_succeeded: 15, download: 14 });

    const { funnels } = await makeService(repo).report();
    const compress = funnels.find((f) => f.toolSlug === "compress-pdf");
    const merge = funnels.find((f) => f.toolSlug === "merge-pdf");
    expect(compress?.executionMode).toBe("remote_job");
    expect(compress?.steps.map((s) => s.step)).toEqual([...FUNNEL_STEPS]);
    expect(compress?.steps.at(-1)?.count).toBe(8);
    expect(merge?.executionMode).toBe("local");
    expect(merge?.steps.map((s) => s.step)).toEqual([...LOCAL_FUNNEL_STEPS]);
    expect(merge?.steps.at(-1)?.count).toBe(14);
  });

  it("features the tool the caller names", async () => {
    await track("merge-pdf", { tool_view: 100 });
    await track("crop-pdf", { tool_view: 5 });
    const { funnel } = await makeService(repo).report({ funnelToolSlug: "crop-pdf" });
    expect(funnel.toolSlug).toBe("crop-pdf");
    expect(funnel.steps[0]?.count).toBe(5);
  });

  it("falls back to the default tool rather than erroring on an unknown slug", async () => {
    // A bookmarked dashboard must survive a tool being renamed.
    await track("merge-pdf", { tool_view: 7 });
    const { funnel } = await makeService(repo).report({ funnelToolSlug: "tool-that-was-renamed" });
    expect(funnel.toolSlug).toBe(FUNNEL_TOOL_SLUG);
    expect(funnel.steps[0]?.count).toBe(7);
  });

  it("features a real spine of zeroes when the named tool did nothing", async () => {
    // Not an empty array: no rows reads as a broken section, while zeroes read as
    // "nobody used this tool this week".
    const { funnel, funnels } = await makeService(repo).report({ funnelToolSlug: "crop-pdf" });
    expect(funnels).toEqual([]);
    expect(funnel.toolSlug).toBe("crop-pdf");
    expect(funnel.executionMode).toBe("local");
    expect(funnel.steps).toHaveLength(LOCAL_FUNNEL_STEPS.length);
    expect(funnel.steps.every((s) => s.count === 0)).toBe(true);
  });

  it("caps the comparison and says how many tools it left out", async () => {
    for (let i = 0; i < FUNNEL_TOOLS_LIMIT + 3; i += 1) {
      await track(`tool-${i}`, { tool_view: 100 - i });
    }
    const { funnels, funnelToolCount } = await makeService(repo).report();
    expect(funnels).toHaveLength(FUNNEL_TOOLS_LIMIT);
    expect(funnelToolCount).toBe(FUNNEL_TOOLS_LIMIT + 3);
  });

  it("gives no funnel to events that have no tool", async () => {
    // `signup`/`login` are recorded without a slug. A "null" funnel row would be
    // a section of the dashboard about nothing.
    await repo.recordEvent(event({ eventName: ANALYTICS_EVENTS.tool_view }));
    const { funnels } = await makeService(repo).report();
    expect(funnels).toEqual([]);
  });

  it("counts local failures across every tool, not only the featured one", async () => {
    await track("merge-pdf", { job_failed: 2 });
    await track("crop-pdf", { job_failed: 3 });
    const report = await makeService(repo).report();
    expect(report.uncategorizedLocalFailures).toBe(5);
    // And each tool still sees its own, beside its funnel rather than inside it.
    expect(report.funnels.find((f) => f.toolSlug === "crop-pdf")?.failed).toBe(3);
  });
});

describe("failure isolation", () => {
  it("degrades instead of throwing when a query fails", async () => {
    const broken: IUsageRepository = {
      ...repo,
      toolUsageSummary: async () => {
        throw new Error("db down");
      },
      eventCounts: async () => {
        throw new Error("db down");
      },
      eventCountsByTool: async () => {
        throw new Error("db down");
      },
      dimensionCounts: async () => {
        throw new Error("db down");
      },
    } as unknown as IUsageRepository;

    const report = await makeService(broken).report();
    expect(report.degraded).toBe(true);
    expect(report.processing.runs).toBe(0);
    expect(report.funnel.steps).toHaveLength(LOCAL_FUNNEL_STEPS.length);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("keeps the sections that worked when only one query fails", async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_processing_completed, toolSlug: "merge-pdf", result: "success" }),
    );
    const partial: IUsageRepository = {
      toolUsageSummary: repo.toolUsageSummary.bind(repo),
      eventCounts: repo.eventCounts.bind(repo),
      eventCountsByTool: repo.eventCountsByTool.bind(repo),
      dimensionCounts: async () => {
        throw new Error("group-by unsupported");
      },
    } as unknown as IUsageRepository;

    const report = await makeService(partial).report();
    expect(report.degraded).toBe(true);
    // The tool table still answers. One failing section must not empty the page.
    expect(report.processing.runs).toBe(1);
  });

  it("never writes while reading, so a dashboard refresh cannot move a quota", async () => {
    const writes: string[] = [];
    const watched: IUsageRepository = {
      ...repo,
      toolUsageSummary: repo.toolUsageSummary.bind(repo),
      eventCounts: repo.eventCounts.bind(repo),
      eventCountsByTool: repo.eventCountsByTool.bind(repo),
      dimensionCounts: repo.dimensionCounts.bind(repo),
      incrementCounters: async (...args: unknown[]) => {
        writes.push("incrementCounters");
        return repo.incrementCounters(args[0] as never);
      },
      recordEvent: async (...args: unknown[]) => {
        writes.push("recordEvent");
        return repo.recordEvent(args[0] as never);
      },
      recordEvents: async () => {
        writes.push("recordEvents");
      },
      pruneEventsBefore: async () => {
        writes.push("pruneEventsBefore");
        return 0;
      },
      pruneCountersBefore: async () => {
        writes.push("pruneCountersBefore");
        return 0;
      },
    } as unknown as IUsageRepository;

    await makeService(watched).report();
    expect(writes).toEqual([]);
    // And local analytics events did not become quota consumption.
    expect(
      repo.counterAmount({
        ownerType: "user",
        ownerId: "u1",
        meter: "server_operations",
        periodStart: new Date("2026-03-15T00:00:00.000Z"),
      }),
    ).toBe(0);
  });
});

/**
 * The two port methods this slice added, asserted against the implementation the
 * service actually calls. The rules below have no other caller today, and an
 * untested rule with no caller is a rule that silently stops being true.
 */
describe("aggregation contract", () => {
  beforeEach(async () => {
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.job_succeeded, toolSlug: "merge-pdf", executionMode: "local" }),
    );
  });

  it("treats an empty name filter as 'count nothing', not 'count everything'", async () => {
    const window = { from: new Date(NOW.getTime() - 7 * MS_PER_DAY), to: NOW };
    // A caller that filtered its list down to zero names must not receive the
    // entire ledger back.
    await expect(repo.eventCounts(window, [])).resolves.toEqual([]);
    await expect(repo.dimensionCounts(window, "executionMode", [])).resolves.toEqual([]);
  });

  it("bounds every grouped count by the window", async () => {
    const stale = { from: new Date(NOW.getTime() - 90 * MS_PER_DAY), to: new Date(NOW.getTime() - 30 * MS_PER_DAY) };
    await expect(repo.dimensionCounts(stale, "executionMode")).resolves.toEqual([]);
    await expect(repo.eventCounts(stale)).resolves.toEqual([]);
  });

  it("cannot be asked to group by the subject pseudonym", () => {
    // A compile-time guarantee, restated here so the reason survives: UsageDimension
    // has no member for `subjectHash`, so a group-by that would enumerate visitors
    // cannot be requested. The line below fails typecheck if that changes.
    // @ts-expect-error subjectHash is deliberately not a UsageDimension
    void (() => repo.dimensionCounts({ from: NOW, to: NOW }, "subjectHash"));
  });
});

describe("what may leave the server", () => {
  it("carries no identity, no raw row, and no properties", async () => {
    await repo.recordEvent(
      event({
        eventName: ANALYTICS_EVENTS.tool_processing_completed,
        toolSlug: "merge-pdf",
        result: "failure",
        errorCategory: "corrupt_input",
        executionMode: "remote_job",
        subjectHash: "SUBJECT-HASH-SENTINEL",
        planId: "free",
        ownerType: "user",
        inputBytes: 4096,
        durationMs: 120,
        properties: { fileName: "PRIVATE-PROPERTY-SENTINEL" },
      }),
    );
    await repo.recordEvent(
      event({ eventName: ANALYTICS_EVENTS.tool_view, toolSlug: FUNNEL_TOOL_SLUG, subjectHash: "SUBJECT-HASH-SENTINEL" }),
    );

    const serialized = JSON.stringify(await makeService(repo).report());

    expect(serialized).not.toContain("SUBJECT-HASH-SENTINEL");
    expect(serialized).not.toContain("PRIVATE-PROPERTY-SENTINEL");
    expect(serialized).not.toContain("subjectHash");
    expect(serialized).not.toContain("properties");
    expect(serialized).not.toContain("ownerId");
    // The aggregate the sentinels were attached to did survive, so the absence
    // above is redaction rather than an empty report passing the check.
    expect(serialized).toContain("corrupt_input");
  });

  it("has no method that returns ledger rows", () => {
    const surface = [
      ...Object.getOwnPropertyNames(UsageAnalyticsReadService.prototype),
      ...Object.keys(makeService(repo)),
    ];
    // The class exposes one query. A future `events()` or `recentRows()` helper
    // is the shape this test exists to fail on.
    expect(surface.filter((k) => k !== "constructor" && !k.startsWith("_"))).toEqual(
      expect.arrayContaining(["report"]),
    );
    expect(surface).not.toContain("events");
    expect(surface).not.toContain("rows");
    expect(surface).not.toContain("subjects");
  });
});
