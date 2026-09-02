import { describe, expect, it } from "vitest";
import {
  COMPARISON_SUPPORT,
  STATISTICS_LIMITS,
  canTransitionComparison,
  compareStructural,
  compareTextual,
  computeStatistics,
  countWords,
  emptyCounts,
  emptySummary,
  isBoundedStatisticsId,
  isComparisonStatus,
  isComparisonSupported,
  isComparisonType,
  isStatisticsStatus,
  isTerminalComparisonStatus,
  parseCounts,
  progressForStatus,
  serializeCounts,
  statisticsListLimit,
  unsupportedComparisonReason,
  validateComparisonError,
  validateCount,
  validateFileSize,
  validateProgress,
  type ComparisonSide,
  type ComparisonStatus,
} from "./DocumentStatistics";

function side(
  versionId: string,
  pages: Record<number, string>,
  pageCount: number | null = null,
): ComparisonSide {
  return {
    versionId,
    pages: new Map(Object.entries(pages).map(([page, text]) => [Number(page), text])),
    pageCount,
  };
}

describe("Count validation", () => {
  it("accepts a non-negative integer", () => {
    expect(validateCount(0)).toBe(0);
    expect(validateCount(42)).toBe(42);
  });

  it("treats absence as unmeasured rather than zero", () => {
    // "Not measured" and "measured, none found" are different facts.
    expect(validateCount(null)).toBeNull();
    expect(validateCount(undefined)).toBeNull();
  });

  it("refuses negatives, fractions and non-numbers", () => {
    expect(validateCount(-1)).toBeNull();
    expect(validateCount(1.5)).toBeNull();
    expect(validateCount("7")).toBeNull();
    expect(validateCount(Number.NaN)).toBeNull();
    expect(validateCount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("bounds a count so a tampered input cannot be unbounded", () => {
    expect(validateCount(STATISTICS_LIMITS.maxCount)).toBe(STATISTICS_LIMITS.maxCount);
    expect(validateCount(STATISTICS_LIMITS.maxCount + 1)).toBeNull();
  });

  it("gives file size its own larger bound", () => {
    expect(validateFileSize(STATISTICS_LIMITS.maxFileSize)).toBe(STATISTICS_LIMITS.maxFileSize);
    expect(validateFileSize(STATISTICS_LIMITS.maxFileSize + 1)).toBeNull();
    expect(validateFileSize(-5)).toBeNull();
  });
});

describe("Word counting", () => {
  it("counts words separated by ordinary whitespace", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  padded   words  ")).toBe(2);
  });

  it("returns zero for empty or whitespace-only text", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n\t ")).toBe(0);
  });

  it("does not count pure punctuation as a word", () => {
    expect(countWords("--- ... !!!")).toBe(0);
    expect(countWords("hello --- world")).toBe(2);
  });

  it("counts a hyphenated token once", () => {
    expect(countWords("well-known result")).toBe(2);
  });

  it("separates words on non-breaking and ideographic spaces", () => {
    expect(countWords("alpha beta")).toBe(2);
    expect(countWords("alpha　beta")).toBe(2);
  });

  it("counts numeric tokens", () => {
    expect(countWords("page 42 of 99")).toBe(4);
  });
});

describe("computeStatistics", () => {
  it("computes real values from supplied content", () => {
    const result = computeStatistics({
      segments: [
        { pageNumber: 1, text: "hello world", imageCount: 2, annotationCount: 1 },
        { pageNumber: 2, text: "second page here", imageCount: 1, annotationCount: 0 },
      ],
      fileSize: 4096,
      bookmarkCount: 3,
      attachmentCount: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts.wordCount).toBe(5);
    expect(result.counts.textCharacterCount).toBe("hello world".length + "second page here".length);
    expect(result.counts.imageCount).toBe(3);
    expect(result.counts.annotationCount).toBe(1);
    expect(result.counts.pageCount).toBe(2);
    expect(result.counts.fileSize).toBe(4096);
    expect(result.counts.bookmarkCount).toBe(3);
    expect(result.counts.attachmentCount).toBe(1);
  });

  it("emits no sample or default figures for absent input", () => {
    // The fabricated service this replaced returned pageCount 10 and
    // textCharCount 15000 for every document. Nothing here invents a number.
    const result = computeStatistics({ segments: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.counts).toEqual(emptyCounts());
    for (const value of Object.values(result.counts)) expect(value).toBeNull();
  });

  it("distinguishes a measured zero from an unmeasured count", () => {
    const result = computeStatistics({
      segments: [{ pageNumber: 1, text: "text", imageCount: 0 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Images were counted and there were none.
    expect(result.counts.imageCount).toBe(0);
    // Annotations were never counted.
    expect(result.counts.annotationCount).toBeNull();
  });

  it("prefers the manifest page count over observed pages", () => {
    // A scanned page with no extractable text still exists.
    const result = computeStatistics({
      segments: [{ pageNumber: 1, text: "only page one has text" }],
      manifestPageCount: 12,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.counts.pageCount).toBe(12);
  });

  it("falls back to the highest observed page when the manifest is silent", () => {
    const result = computeStatistics({
      segments: [
        { pageNumber: 1, text: "a" },
        { pageNumber: 5, text: "b" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.counts.pageCount).toBe(5);
  });

  it("counts characters as code points", () => {
    const result = computeStatistics({ segments: [{ pageNumber: 1, text: "😀😀" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.counts.textCharacterCount).toBe(2);
  });

  it("refuses a non-array segment list", () => {
    const result = computeStatistics({ segments: null as unknown as [] });
    expect(result.ok).toBe(false);
  });

  it("refuses too many segments", () => {
    const segments = Array.from({ length: STATISTICS_LIMITS.maxSegments + 1 }, () => ({
      text: "x",
    }));
    expect(computeStatistics({ segments }).ok).toBe(false);
  });

  it("refuses an invalid page number, image count or annotation count", () => {
    expect(computeStatistics({ segments: [{ pageNumber: 0, text: "a" }] }).ok).toBe(false);
    expect(computeStatistics({ segments: [{ pageNumber: -3, text: "a" }] }).ok).toBe(false);
    expect(computeStatistics({ segments: [{ imageCount: -1 }] }).ok).toBe(false);
    expect(computeStatistics({ segments: [{ annotationCount: 1.5 }] }).ok).toBe(false);
  });

  it("refuses text beyond the measurable limit", () => {
    const chunk = "a".repeat(1_000_000);
    const segments = Array.from({ length: 60 }, () => ({ text: chunk }));
    const result = computeStatistics({ segments });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/limit/i);
  });

  it("is reproducible for the same input", () => {
    const source = {
      segments: [{ pageNumber: 1, text: "same text", imageCount: 1 }],
      fileSize: 100,
    };
    expect(computeStatistics(source)).toEqual(computeStatistics(source));
  });
});

describe("Counts serialization", () => {
  it("round-trips a full count set", () => {
    const counts = {
      pageCount: 3,
      textCharacterCount: 100,
      wordCount: 20,
      imageCount: 2,
      annotationCount: 1,
      bookmarkCount: 4,
      attachmentCount: 0,
      fileSize: 9999,
    };
    expect(parseCounts(serializeCounts(counts))).toEqual(counts);
  });

  it("round-trips nulls as nulls, not zeros", () => {
    expect(parseCounts(serializeCounts(emptyCounts()))).toEqual(emptyCounts());
  });

  it("serializes deterministically", () => {
    const counts = { ...emptyCounts(), pageCount: 2, wordCount: 5 };
    expect(serializeCounts(counts)).toBe(serializeCounts(counts));
  });

  it("degrades an unreadable stored value to unmeasured", () => {
    expect(parseCounts("not json")).toEqual(emptyCounts());
    expect(parseCounts("")).toEqual(emptyCounts());
    expect(parseCounts(null)).toEqual(emptyCounts());
    expect(parseCounts("[]")).toEqual(emptyCounts());
  });

  it("drops an individual invalid field rather than failing the whole read", () => {
    const parsed = parseCounts('{"pageCount":5,"wordCount":-3,"imageCount":"many"}');
    expect(parsed.pageCount).toBe(5);
    expect(parsed.wordCount).toBeNull();
    expect(parsed.imageCount).toBeNull();
  });
});

describe("Statistics status", () => {
  it("recognizes only the three statuses", () => {
    expect(isStatisticsStatus("pending")).toBe(true);
    expect(isStatisticsStatus("ready")).toBe(true);
    expect(isStatisticsStatus("failed")).toBe(true);
    expect(isStatisticsStatus("done")).toBe(false);
  });
});

describe("Comparison support", () => {
  it("recognizes the four comparison types", () => {
    for (const type of ["structural", "textual", "visual", "editor"]) {
      expect(isComparisonType(type)).toBe(true);
    }
    expect(isComparisonType("semantic")).toBe(false);
  });

  it("reports visual comparison as unsupported in this build", () => {
    // Returning an empty diff instead would read as "these pages are identical",
    // which is the opposite claim.
    expect(isComparisonSupported("visual")).toBe(false);
    expect(COMPARISON_SUPPORT.visual).toBe(false);
  });

  it("reports structural, textual and editor comparison as supported", () => {
    expect(isComparisonSupported("structural")).toBe(true);
    expect(isComparisonSupported("textual")).toBe(true);
    expect(isComparisonSupported("editor")).toBe(true);
  });

  it("explains an unsupported type in actionable words", () => {
    const reason = unsupportedComparisonReason("visual");
    expect(reason).toMatch(/rendering/i);
    expect(reason).toMatch(/structural/i);
    expect(unsupportedComparisonReason("textual")).toBeNull();
  });
});

describe("Comparison state transitions", () => {
  it("allows the forward path", () => {
    expect(canTransitionComparison("pending", "running")).toBe(true);
    expect(canTransitionComparison("running", "completed")).toBe(true);
    expect(canTransitionComparison("running", "failed")).toBe(true);
    expect(canTransitionComparison("running", "cancelled")).toBe(true);
    expect(canTransitionComparison("pending", "cancelled")).toBe(true);
  });

  it("refuses to complete a cancelled operation", () => {
    // Delivering a result the user declined to wait for.
    expect(canTransitionComparison("cancelled", "completed")).toBe(false);
    expect(canTransitionComparison("cancelled", "running")).toBe(false);
  });

  it("refuses to rewrite any terminal state", () => {
    const terminal: ComparisonStatus[] = ["completed", "failed", "cancelled"];
    for (const from of terminal) {
      for (const to of ["pending", "running", "completed", "failed", "cancelled"] as const) {
        expect(canTransitionComparison(from, to)).toBe(false);
      }
    }
  });

  it("refuses to move backwards to pending", () => {
    expect(canTransitionComparison("running", "pending")).toBe(false);
  });

  it("identifies terminal states", () => {
    expect(isTerminalComparisonStatus("pending")).toBe(false);
    expect(isTerminalComparisonStatus("running")).toBe(false);
    expect(isTerminalComparisonStatus("completed")).toBe(true);
    expect(isTerminalComparisonStatus("failed")).toBe(true);
    expect(isTerminalComparisonStatus("cancelled")).toBe(true);
  });

  it("recognizes only the five statuses", () => {
    expect(isComparisonStatus("running")).toBe(true);
    expect(isComparisonStatus("paused")).toBe(false);
  });
});

describe("Progress", () => {
  it("bounds progress to 0..100", () => {
    expect(validateProgress(0)).toBe(0);
    expect(validateProgress(100)).toBe(100);
    expect(validateProgress(-1)).toBeNull();
    expect(validateProgress(101)).toBeNull();
    expect(validateProgress("50")).toBeNull();
    expect(validateProgress(Number.NaN)).toBeNull();
  });

  it("rounds a fractional progress report", () => {
    expect(validateProgress(33.6)).toBe(34);
  });

  it("forces progress to agree with a terminal status", () => {
    // A client must never see "completed, 60%".
    expect(progressForStatus("completed", 60)).toBe(100);
    expect(progressForStatus("pending", 80)).toBe(0);
  });

  it("keeps a reported value while running", () => {
    expect(progressForStatus("running", 45)).toBe(45);
  });

  it("treats an unusable report as zero rather than trusting it", () => {
    expect(progressForStatus("running", -5)).toBe(0);
    expect(progressForStatus("running", 500)).toBe(0);
  });
});

describe("Structural comparison", () => {
  it("reports added and removed pages", () => {
    const left = side("v1", { 1: "a", 2: "b" });
    const right = side("v2", { 1: "a", 2: "b", 3: "c" });
    const { summary } = compareStructural(left, right);
    expect(summary.pagesAdded).toEqual([3]);
    expect(summary.pagesRemoved).toEqual([]);
    expect(summary.added).toBe(1);
  });

  it("reports a changed page without a word-level diff", () => {
    const { summary, differences } = compareStructural(
      side("v1", { 1: "before" }),
      side("v2", { 1: "after" }),
    );
    expect(summary.changed).toBe(1);
    expect(differences[0].kind).toBe("changed");
    // Structural comparison answers "what moved", not "what words differ".
    expect(differences[0].excerpt).toBeNull();
  });

  it("finds no differences between identical versions", () => {
    const { summary, differences } = compareStructural(
      side("v1", { 1: "same", 2: "same too" }),
      side("v2", { 1: "same", 2: "same too" }),
    );
    expect(summary).toEqual(emptySummary());
    expect(differences).toEqual([]);
  });

  it("counts a manifest page with no extracted text as existing", () => {
    // Omitting it would report a real scanned page as removed.
    const left = side("v1", { 1: "text" }, 3);
    const right = side("v2", { 1: "text" }, 3);
    const { summary } = compareStructural(left, right);
    expect(summary.pagesRemoved).toEqual([]);
    expect(summary.pagesAdded).toEqual([]);
  });

  it("detects a page removed relative to the manifest count", () => {
    const { summary } = compareStructural(
      side("v1", { 1: "a", 2: "b" }, 2),
      side("v2", { 1: "a" }, 1),
    );
    expect(summary.pagesRemoved).toEqual([2]);
  });

  it("bounds the difference list and reports truncation", () => {
    const pages: Record<number, string> = {};
    for (let page = 1; page <= STATISTICS_LIMITS.maxDifferences + 50; page += 1) {
      pages[page] = `content ${page}`;
    }
    const { summary, differences } = compareStructural(side("v1", {}), side("v2", pages));
    expect(differences.length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxDifferences);
    expect(summary.truncated).toBe(true);
  });
});

describe("Textual comparison", () => {
  it("reports added and removed lines with excerpts", () => {
    const { summary, differences } = compareTextual(
      side("v1", { 1: "kept line\nremoved line" }),
      side("v2", { 1: "kept line\nadded line" }),
    );
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
    const added = differences.find((d) => d.kind === "added");
    const removed = differences.find((d) => d.kind === "removed");
    expect(added?.excerpt).toBe("added line");
    expect(removed?.excerpt).toBe("removed line");
  });

  it("finds nothing between identical text", () => {
    const { summary, differences } = compareTextual(
      side("v1", { 1: "same\nlines" }),
      side("v2", { 1: "same\nlines" }),
    );
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
    expect(differences).toEqual([]);
  });

  it("does not report reordered lines on a page as changes", () => {
    // Lines are compared as multisets per page, so moved text is not both an
    // addition and a removal.
    const { summary } = compareTextual(
      side("v1", { 1: "alpha\nbeta" }),
      side("v2", { 1: "beta\nalpha" }),
    );
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
  });

  it("counts a duplicated line as one addition", () => {
    const { summary } = compareTextual(
      side("v1", { 1: "line" }),
      side("v2", { 1: "line\nline" }),
    );
    expect(summary.added).toBe(1);
  });

  it("ignores blank lines and surrounding whitespace", () => {
    const { summary } = compareTextual(
      side("v1", { 1: "text" }),
      side("v2", { 1: "\n\n  text  \n\n" }),
    );
    expect(summary.added).toBe(0);
    expect(summary.removed).toBe(0);
  });

  it("truncates a long excerpt rather than storing an unbounded line", () => {
    const long = "x".repeat(STATISTICS_LIMITS.maxExcerptLength + 100);
    const { differences } = compareTextual(side("v1", {}), side("v2", { 1: long }));
    const excerpt = differences[0].excerpt ?? "";
    expect([...excerpt].length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxExcerptLength + 1);
  });

  it("keeps an excerpt as plain text, never markup", () => {
    const { differences } = compareTextual(
      side("v1", {}),
      side("v2", { 1: "<script>alert(1)</script>" }),
    );
    // Stored verbatim as text; the renderer emits a text node.
    expect(differences[0].excerpt).toBe("<script>alert(1)</script>");
  });

  it("attributes differences to their page", () => {
    const { differences } = compareTextual(
      side("v1", { 1: "a", 2: "b" }),
      side("v2", { 1: "a", 2: "changed" }),
    );
    expect(differences.every((d) => d.pageNumber === 2)).toBe(true);
  });
});

describe("Error and identifier validation", () => {
  it("bounds and normalizes a failure reason", () => {
    expect(validateComparisonError("  something   broke  ")).toBe("something broke");
    expect(validateComparisonError("")).toBeNull();
    expect(validateComparisonError(null)).toBeNull();
    const long = validateComparisonError("e".repeat(STATISTICS_LIMITS.maxErrorLength + 100)) ?? "";
    expect([...long].length).toBe(STATISTICS_LIMITS.maxErrorLength);
  });

  it("accepts a bounded id and refuses an empty or oversized one", () => {
    expect(isBoundedStatisticsId("ver-1")).toBe(true);
    expect(isBoundedStatisticsId("")).toBe(false);
    expect(isBoundedStatisticsId("   ")).toBe(false);
    expect(isBoundedStatisticsId(null)).toBe(false);
    expect(isBoundedStatisticsId("v".repeat(STATISTICS_LIMITS.maxIdLength + 1))).toBe(false);
  });

  it("bounds list limits so a bad limit narrows rather than widens", () => {
    expect(statisticsListLimit(undefined)).toBe(STATISTICS_LIMITS.defaultListLimit);
    expect(statisticsListLimit(5)).toBe(5);
    expect(statisticsListLimit(0)).toBe(1);
    expect(statisticsListLimit(-1)).toBe(1);
    expect(statisticsListLimit(Number.NaN)).toBe(1);
    expect(statisticsListLimit(100_000)).toBe(STATISTICS_LIMITS.maxListLimit);
  });
});
