import { describe, expect, it } from "vitest";
import {
  NOT_MEASURED_LABEL,
  atActiveComparisonLimit,
  canCancel,
  canRecalculate,
  canRetry,
  canShowResult,
  canSubmitComparison,
  comparisonAnnouncement,
  comparisonStatusLabel,
  comparisonTypeOptions,
  describeStatisticsError,
  emptyComparisonDraft,
  formatCount,
  formatFileSize,
  showsProgress,
  sortComparisonsForDisplay,
  statisticsRows,
  statisticsStatusLabel,
  summarizeDifferences,
  validateComparisonDraft,
  type ComparisonView,
  type StatisticsCountsView,
} from "./statisticsLogic";
import { STATISTICS_LIMITS } from "@/src/domain/entities/DocumentStatistics";

function counts(overrides: Partial<StatisticsCountsView> = {}): StatisticsCountsView {
  return {
    pageCount: 12,
    textCharacterCount: 4200,
    wordCount: 700,
    imageCount: 0,
    annotationCount: null,
    bookmarkCount: 3,
    attachmentCount: null,
    fileSize: 81920,
    ...overrides,
  };
}

function view(overrides: Partial<ComparisonView> = {}): ComparisonView {
  return {
    id: "cmp-1",
    type: "textual",
    status: "running",
    progress: 40,
    cancelRequested: false,
    hasResult: false,
    error: null,
    ...overrides,
  };
}

describe("statistics count formatting", () => {
  it("shows an unmeasured count as not measured rather than zero", () => {
    // The distinction the whole M7.11 domain preserves: a document nobody
    // scanned for images must not claim it has none.
    expect(formatCount(null)).toBe(NOT_MEASURED_LABEL);
  });

  it("shows a measured zero as zero", () => {
    expect(formatCount(0)).toBe("0");
  });

  it("formats large counts readably", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("formats file sizes in usable units", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(null)).toBe(NOT_MEASURED_LABEL);
  });

  it("marks unmeasured rows so they can be styled as absent", () => {
    const rows = statisticsRows(counts());
    const annotations = rows.find((r) => r.key === "annotationCount");
    const images = rows.find((r) => r.key === "imageCount");

    expect(annotations?.unmeasured).toBe(true);
    expect(annotations?.value).toBe(NOT_MEASURED_LABEL);
    // Measured zero is not unmeasured.
    expect(images?.unmeasured).toBe(false);
    expect(images?.value).toBe("0");
  });

  it("renders every count as a labelled row", () => {
    const rows = statisticsRows(counts());
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.label.length > 0)).toBe(true);
  });

  it("describes a failed calculation honestly", () => {
    expect(statisticsStatusLabel("failed", null)).toBe("Could not be calculated");
    expect(statisticsStatusLabel("pending", null)).toBe("Calculation pending");
    expect(statisticsStatusLabel("ready", "2026-08-04T12:00:00.000Z")).toContain("Calculated");
  });

  it("offers recalculation only to a writer who is not busy", () => {
    expect(canRecalculate(false, true)).toBe(true);
    expect(canRecalculate(true, true)).toBe(false);
    expect(canRecalculate(false, false)).toBe(false);
  });
});

describe("comparison presentation", () => {
  it("labels each status for a reader", () => {
    expect(comparisonStatusLabel(view({ status: "pending" }))).toBe("Waiting to start");
    expect(comparisonStatusLabel(view({ status: "running", progress: 60 }))).toContain("60%");
    expect(comparisonStatusLabel(view({ status: "completed" }))).toBe("Completed");
    expect(comparisonStatusLabel(view({ status: "failed" }))).toBe("Failed");
    expect(comparisonStatusLabel(view({ status: "cancelled" }))).toBe("Cancelled");
  });

  it("reports a pending cancellation while work continues", () => {
    // "Cancelling…" rather than "Cancelled": the work observes the request at
    // its next checkpoint, and claiming it stopped would be untrue.
    expect(comparisonStatusLabel(view({ status: "running", cancelRequested: true }))).toBe(
      "Cancelling…",
    );
  });

  it("does not show a result before one exists", () => {
    // A status of completed with no result row is a state an interrupted worker
    // can produce; rendering it would show an empty diff as "no differences".
    expect(canShowResult(view({ status: "completed", hasResult: false }))).toBe(false);
    expect(canShowResult(view({ status: "completed", hasResult: true }))).toBe(true);
    expect(canShowResult(view({ status: "running", hasResult: true }))).toBe(false);
  });

  it("offers cancel only while active and not already requested", () => {
    expect(canCancel(view({ status: "pending" }))).toBe(true);
    expect(canCancel(view({ status: "running" }))).toBe(true);
    expect(canCancel(view({ status: "running", cancelRequested: true }))).toBe(false);
    expect(canCancel(view({ status: "completed" }))).toBe(false);
    expect(canCancel(view({ status: "cancelled" }))).toBe(false);
  });

  it("offers retry only for a terminal failure or cancellation", () => {
    expect(canRetry(view({ status: "failed" }))).toBe(true);
    expect(canRetry(view({ status: "cancelled" }))).toBe(true);
    // A completed comparison has nothing to retry, and a running one is not done.
    expect(canRetry(view({ status: "completed" }))).toBe(false);
    expect(canRetry(view({ status: "running" }))).toBe(false);
  });

  it("shows progress only while active", () => {
    expect(showsProgress(view({ status: "running" }))).toBe(true);
    expect(showsProgress(view({ status: "pending" }))).toBe(true);
    expect(showsProgress(view({ status: "completed" }))).toBe(false);
    expect(showsProgress(view({ status: "failed" }))).toBe(false);
  });

  it("announces state accessibly and consistently with the visible status", () => {
    expect(comparisonAnnouncement(view({ status: "running", progress: 25 }))).toContain("25%");
    expect(comparisonAnnouncement(view({ status: "completed", hasResult: true }))).toContain(
      "completed",
    );
    // The honest announcement for the interrupted case.
    expect(comparisonAnnouncement(view({ status: "completed", hasResult: false }))).toContain(
      "no result is available",
    );
    expect(
      comparisonAnnouncement(view({ status: "failed", error: "extraction broke" })),
    ).toContain("extraction broke");
  });
});

describe("comparison composer", () => {
  it("offers unsupported types disabled with a reason rather than hiding them", () => {
    const options = comparisonTypeOptions();
    const visual = options.find((o) => o.value === "visual");

    // Hidden would read as a product that never had the feature; disabled with
    // an explanation tells the user what is true.
    expect(visual).toBeDefined();
    expect(visual?.supported).toBe(false);
    expect(visual?.reason).toContain("page rendering");

    const textual = options.find((o) => o.value === "textual");
    expect(textual?.supported).toBe(true);
    expect(textual?.reason).toBeNull();
  });

  it("requires two versions", () => {
    const draft = emptyComparisonDraft();
    expect(validateComparisonDraft(draft).ok).toBe(false);
    expect(validateComparisonDraft({ ...draft, leftVersionId: "ver-1" }).ok).toBe(false);
  });

  it("refuses the same version twice", () => {
    const result = validateComparisonDraft({
      leftVersionId: "ver-1",
      rightVersionId: "ver-1",
      type: "textual",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("different");
  });

  it("refuses an unsupported type with the domain's reason", () => {
    const result = validateComparisonDraft({
      leftVersionId: "ver-1",
      rightVersionId: "ver-2",
      type: "visual",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("page rendering");
  });

  it("accepts a valid draft", () => {
    expect(
      validateComparisonDraft({
        leftVersionId: "ver-1",
        rightVersionId: "ver-2",
        type: "structural",
      }).ok,
    ).toBe(true);
  });

  it("disables submit while busy", () => {
    const draft = { leftVersionId: "ver-1", rightVersionId: "ver-2", type: "textual" as const };
    expect(canSubmitComparison(draft, false)).toBe(true);
    expect(canSubmitComparison(draft, true)).toBe(false);
  });

  it("detects the active-comparison limit", () => {
    const active = Array.from({ length: STATISTICS_LIMITS.maxActiveComparisonsPerDocument }, (_, i) =>
      view({ id: `cmp-${i}`, status: "running" }),
    );
    expect(atActiveComparisonLimit(active)).toBe(true);
    expect(atActiveComparisonLimit(active.slice(1))).toBe(false);
    // Terminal operations do not count against the limit.
    expect(atActiveComparisonLimit(active.map((v) => ({ ...v, status: "completed" as const })))).toBe(
      false,
    );
  });
});

describe("difference summary", () => {
  it("distinguishes no differences from a truncated list", () => {
    expect(summarizeDifferences({ added: 0, removed: 0, changed: 0, truncated: false })).toBe(
      "No differences found.",
    );
    const truncated = summarizeDifferences({ added: 10, removed: 2, changed: 1, truncated: true });
    expect(truncated).toContain("10 added");
    // A capped list presented as complete would read as "these are all".
    expect(truncated).toContain("first differences only");
  });

  it("omits categories with nothing in them", () => {
    const summary = summarizeDifferences({ added: 3, removed: 0, changed: 0, truncated: false });
    expect(summary).toContain("3 added");
    expect(summary).not.toContain("removed");
  });
});

describe("error and ordering helpers", () => {
  it("maps failures to actionable messages without leaking internals", () => {
    expect(describeStatisticsError(401)).toContain("Sign in");
    expect(describeStatisticsError(403)).toContain("permission");
    expect(describeStatisticsError(404)).toContain("no longer available");
    expect(describeStatisticsError(500)).toContain("our side");
    // No stack traces, no internal identifiers.
    expect(describeStatisticsError(500)).not.toMatch(/at .+\(/);
  });

  it("orders comparisons newest first with a stable tiebreaker", () => {
    const rows = [
      { id: "cmp-1", createdAt: "2026-08-04T10:00:00.000Z" },
      { id: "cmp-3", createdAt: "2026-08-04T12:00:00.000Z" },
      { id: "cmp-2", createdAt: "2026-08-04T12:00:00.000Z" },
    ];
    expect(sortComparisonsForDisplay(rows).map((r) => r.id)).toEqual(["cmp-3", "cmp-2", "cmp-1"]);
  });

  it("does not mutate the array it was given", () => {
    const rows = [
      { id: "cmp-1", createdAt: "2026-08-04T10:00:00.000Z" },
      { id: "cmp-2", createdAt: "2026-08-04T12:00:00.000Z" },
    ];
    sortComparisonsForDisplay(rows);
    expect(rows[0].id).toBe("cmp-1");
  });
});
