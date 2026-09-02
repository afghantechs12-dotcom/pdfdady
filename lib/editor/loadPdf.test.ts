import { beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_FORMAT_VERSION } from "@/src/domain/editor/document";
import { getPdfDoc } from "@/lib/pdf/render";
import { loadPdfIntoEditor, pageExtractionBudget } from "./loadPdf";

vi.mock("@/lib/pdf/render", () => ({
  getPdfDoc: vi.fn(),
  renderPageToCanvas: vi.fn(),
  isRenderCancelled: vi.fn(() => false),
}));

/**
 * Tests for the Open-PDF cross-page extraction budget (M5 Part 1 / F4 resource
 * bound). `pageExtractionBudget` is the PURE policy the per-page loop consults:
 * it decides whether a page extracts at all and the per-page line cap that keeps
 * the running total under the document-wide budget. Pure so it is testable
 * without a DOM/PDF.js (loadPdfIntoEditor itself needs a canvas + worker).
 *
 * The M6 `sourcePageIndex` seeding IS covered here end-to-end by mocking the
 * PDF.js adapter and using page dimensions over MAX_PAGE_DIM, which skips the
 * canvas rasterization path — the only part of the flow that needs a DOM.
 */

describe("pageExtractionBudget", () => {
  const BUDGET = 20_000;
  const PER_PAGE = 2_000;

  it("extracts with the full per-page cap when the budget is untouched", () => {
    expect(pageExtractionBudget(0, BUDGET, PER_PAGE)).toEqual({ extract: true, maxLines: 2_000 });
  });

  it("scales the per-page cap by the remaining budget near the limit", () => {
    // 19000 already extracted → 1000 left → cap is the remaining, not 2000.
    expect(pageExtractionBudget(19_000, BUDGET, PER_PAGE)).toEqual({ extract: true, maxLines: 1_000 });
  });

  it("grants only the last remaining slot when one away from the budget", () => {
    expect(pageExtractionBudget(19_999, BUDGET, PER_PAGE)).toEqual({ extract: true, maxLines: 1 });
  });

  it("stops extracting exactly when the budget is reached", () => {
    expect(pageExtractionBudget(20_000, BUDGET, PER_PAGE)).toEqual({ extract: false, maxLines: 0 });
  });

  it("stays stopped once over the budget", () => {
    expect(pageExtractionBudget(25_000, BUDGET, PER_PAGE)).toEqual({ extract: false, maxLines: 0 });
  });

  it("uses the per-page cap when it is smaller than the remaining budget", () => {
    // Budget 50000, per-page 2000 → per-page cap binds (not the remaining 50000).
    expect(pageExtractionBudget(0, 50_000, PER_PAGE)).toEqual({ extract: true, maxLines: 2_000 });
  });
});

describe("loadPdfIntoEditor: sourcePageIndex seeding (M6)", () => {
  beforeEach(() => vi.mocked(getPdfDoc).mockReset());

  /** A fake PDF.js doc whose pages exceed MAX_PAGE_DIM (skips canvas work). */
  function mockDoc(numPages: number) {
    vi.mocked(getPdfDoc).mockResolvedValue({
      numPages,
      getPage: async () => ({
        getViewport: () => ({ width: 20_000, height: 20_000 }),
        rotate: 0,
      }),
    } as unknown as Awaited<ReturnType<typeof getPdfDoc>>);
  }

  const fakeFile = () =>
    ({ name: "test.pdf", arrayBuffer: async () => new ArrayBuffer(4) }) as unknown as File;

  it("pins editor page i to source PDF page i (0-based)", async () => {
    mockDoc(3);
    const { state } = await loadPdfIntoEditor(fakeFile(), { extractText: false });
    expect(state.document.pages).toHaveLength(3);
    expect(state.document.pages.map((p) => p.sourcePageIndex)).toEqual([0, 1, 2]);
    expect(state.document.version).toBe(EDITOR_FORMAT_VERSION);
  });

  it("keeps the first page active and records the source name", async () => {
    mockDoc(2);
    const { state, sourceBytes } = await loadPdfIntoEditor(fakeFile(), { extractText: false });
    expect(state.activePageId).toBe(state.document.pages[0].id);
    expect(state.document.metadata.sourceName).toBe("test.pdf");
    expect(sourceBytes).toHaveLength(4);
  });
});
