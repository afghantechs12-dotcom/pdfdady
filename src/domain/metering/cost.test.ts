import { describe, expect, it } from "vitest";
import {
  LOCAL_TOOL_SLUGS,
  REMOTE_JOB_REASON,
  REMOTE_JOB_TOOL_SLUGS,
} from "@/lib/tools/executionPolicy";
import {
  LOCAL_TOOL_COST_PROFILE,
  TOOL_COST_PROFILES,
  costProfileFor,
  costProfileGaps,
  estimateCostUnits,
  isServerCosted,
  measureCostUnits,
} from "./cost";

const MB = 1024 * 1024;

/**
 * The cost table's value is that it is complete and ordinally honest. These
 * tests guard completeness structurally (so a new tool cannot skip it) and
 * ordering by naming the comparisons that must hold for the numbers to mean
 * anything.
 */
describe("cost profile completeness", () => {
  it("has no gaps or strays", () => {
    expect(costProfileGaps()).toEqual([]);
  });

  /**
   * The same discipline REMOTE_JOB_REASON applies to *why* a tool is remote,
   * applied to *what it costs*. Adding a server tool must be a type-and-test
   * failure until both are stated.
   */
  it("covers exactly the remote job tools", () => {
    expect(new Set(Object.keys(TOOL_COST_PROFILES))).toEqual(
      new Set(REMOTE_JOB_TOOL_SLUGS),
    );
  });

  it("stays in step with the reason table", () => {
    expect(new Set(Object.keys(TOOL_COST_PROFILES))).toEqual(
      new Set(Object.keys(REMOTE_JOB_REASON)),
    );
  });

  it("charges every server job a positive fixed cost", () => {
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      expect(TOOL_COST_PROFILES[slug].base).toBeGreaterThan(0);
    }
  });
});

describe("local tools", () => {
  /**
   * A browser tool runs on the user's CPU. Charging it against a server
   * allowance would bill someone for their own laptop.
   */
  it("costs nothing on the server", () => {
    for (const slug of LOCAL_TOOL_SLUGS) {
      expect(costProfileFor(slug)).toBe(LOCAL_TOOL_COST_PROFILE);
      expect(estimateCostUnits({ slug, inputBytes: 90 * MB, pageCount: 400 })).toBe(0);
    }
  });

  it("is not server-costed even if a caller claims remote_job", () => {
    const [local] = [...LOCAL_TOOL_SLUGS];
    expect(isServerCosted(local, "remote_job")).toBe(false);
    expect(isServerCosted(local, "local")).toBe(false);
  });

  it("marks remote tools as server-costed", () => {
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      expect(isServerCosted(slug, "remote_job")).toBe(true);
      expect(isServerCosted(slug, "local")).toBe(false);
    }
  });
});

describe("estimation", () => {
  it("returns zero for an unknown slug rather than inventing a cost", () => {
    expect(estimateCostUnits({ slug: "not-a-tool", inputBytes: 10 * MB })).toBe(0);
    expect(costProfileFor("not-a-tool")).toBeNull();
  });

  it("charges at least one unit for any real server work", () => {
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      expect(estimateCostUnits({ slug, inputBytes: 0 })).toBeGreaterThanOrEqual(1);
      expect(estimateCostUnits({ slug, inputBytes: 1 })).toBeGreaterThanOrEqual(1);
    }
  });

  it("grows with input size", () => {
    const small = estimateCostUnits({ slug: "compress-pdf", inputBytes: 1 * MB });
    const large = estimateCostUnits({ slug: "compress-pdf", inputBytes: 50 * MB });
    expect(large).toBeGreaterThan(small);
  });

  it("grows with page count when pages are known", () => {
    const fewer = estimateCostUnits({ slug: "ocr-pdf", inputBytes: 5 * MB, pageCount: 2 });
    const more = estimateCostUnits({ slug: "ocr-pdf", inputBytes: 5 * MB, pageCount: 200 });
    expect(more).toBeGreaterThan(fewer);
  });

  /**
   * A submission cannot know the page count without parsing the PDF, which is
   * the work being authorized. Absent pages must therefore produce a usable
   * floor, not a NaN and not a throw.
   */
  it("drops the per-page term when pages are unknown", () => {
    const withoutPages = estimateCostUnits({ slug: "ocr-pdf", inputBytes: 5 * MB });
    const withPages = estimateCostUnits({ slug: "ocr-pdf", inputBytes: 5 * MB, pageCount: 30 });
    expect(Number.isFinite(withoutPages)).toBe(true);
    expect(withoutPages).toBeGreaterThan(0);
    expect(withPages).toBeGreaterThan(withoutPages);
  });

  it("returns whole units so a database integer cannot truncate the cost away", () => {
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      const units = estimateCostUnits({ slug, inputBytes: 1234567, pageCount: 3 });
      expect(Number.isInteger(units)).toBe(true);
    }
  });

  it("treats a null or negative byte count as zero bytes, not as a negative cost", () => {
    expect(estimateCostUnits({ slug: "compress-pdf", inputBytes: null })).toBeGreaterThan(0);
    expect(estimateCostUnits({ slug: "compress-pdf", inputBytes: -500 })).toBeGreaterThan(0);
  });
});

describe("ordinal honesty", () => {
  /**
   * These comparisons are the reason the numbers exist. If OCR ever stops being
   * the most expensive per page, either the table is wrong or the product
   * changed — and either way somebody should have to look.
   */
  it("prices OCR as the most expensive per page", () => {
    for (const slug of REMOTE_JOB_TOOL_SLUGS) {
      if (slug === "ocr-pdf") continue;
      expect(TOOL_COST_PROFILES["ocr-pdf"].perPage).toBeGreaterThan(
        TOOL_COST_PROFILES[slug].perPage,
      );
    }
  });

  it("prices a LibreOffice conversion above a qpdf metadata rewrite", () => {
    expect(TOOL_COST_PROFILES["word-to-pdf"].base).toBeGreaterThan(
      TOOL_COST_PROFILES["protect-pdf"].base,
    );
  });

  it("charges no per-page cost for tools that treat the document as one unit", () => {
    expect(TOOL_COST_PROFILES["protect-pdf"].perPage).toBe(0);
    expect(TOOL_COST_PROFILES["unlock-pdf"].perPage).toBe(0);
  });
});

describe("measurement", () => {
  it("uses the same formula as the estimate, with the reported page count", () => {
    expect(
      measureCostUnits({ slug: "compress-pdf", inputBytes: 12 * MB, pageCount: 40 }),
    ).toBe(estimateCostUnits({ slug: "compress-pdf", inputBytes: 12 * MB, pageCount: 40 }));
  });

  /**
   * Billing by wall-clock would charge users for our slow days — a cold
   * LibreOffice start, a noisy neighbour, a retry after a deploy. Duration is
   * recorded for calibration, never priced.
   */
  it("ignores durationMs entirely", () => {
    const fast = measureCostUnits({
      slug: "compress-pdf",
      inputBytes: 10 * MB,
      pageCount: 5,
      durationMs: 120,
    });
    const slow = measureCostUnits({
      slug: "compress-pdf",
      inputBytes: 10 * MB,
      pageCount: 5,
      durationMs: 600_000,
    });
    expect(slow).toBe(fast);
  });

  it("is at least the pre-flight estimate for the same input", () => {
    const slug = "ocr-pdf";
    const estimated = estimateCostUnits({ slug, inputBytes: 8 * MB });
    const measured = measureCostUnits({ slug, inputBytes: 8 * MB, pageCount: 12 });
    expect(measured).toBeGreaterThanOrEqual(estimated);
  });
});
