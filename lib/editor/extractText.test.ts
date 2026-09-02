import { describe, expect, it } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import { extractTextObjects } from "./extractText";
import { mapFontToBaseFamily } from "@/src/application/editor/text/TextExtraction";
import { base14Ascent, base14Descent } from "@/src/domain/editor/textMetrics";
import { READONLY_REASON } from "@/src/domain/editor/sourceText";

/**
 * Integration tests for the PDF.js extraction adapter (M5 Part 1).
 *
 * These verify the adapter's resource bounds (F1/F4 from the Security review):
 * - maxRawItems caps the input BEFORE grouping (F1)
 * - maxLines caps the output TextObject count per page
 * - The cross-page budget in loadPdf.ts enforces a global object limit (F4)
 *
 * The pure grouping logic is tested in TextExtraction.test.ts; this file tests
 * the PDF.js-facing boundary and the caps that prevent a malicious PDF from
 * freezing the tab or exhausting memory.
 */

describe("extractTextObjects adapter", () => {
  it("caps raw items BEFORE grouping (maxRawItems) so a huge TextContent can't hang", async () => {
    // 100,000 items on DISTINCT baselines (pdfY = 800 - i*2). Without the
    // maxRawItems cap, grouping would process all 100k items and produce ~100k
    // lines. With maxRawItems = 1000, only the first 1000 items reach grouping,
    // so the object count is EXACTLY 1000 — proving the cap binds. (Asserting
    // merely < itemCount would pass even if the break guard were removed and all
    // items collapsed to a single line.)
    const itemCount = 100_000;
    const mockPage = {
      getTextContent: async () => ({
        items: Array.from({ length: itemCount }, (_, i) => ({
          str: "x",
          transform: [12, 0, 0, 12, 50, 800 - i * 2],
          width: 5,
          height: 12,
        })),
      }),
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "layer-0",
      maxRawItems: 1000,
    });

    expect(objects).toHaveLength(1000);
    expect(objects.length).toBeLessThan(itemCount);
  });

  it("caps output lines (maxLines) per page", async () => {
    // Mock a page with 5000 distinct baselines (5000 lines). Only maxLines should
    // be returned.
    const mockPage = {
      getTextContent: async () => ({
        items: Array.from({ length: 5000 }, (_, i) => ({
          str: "line",
          transform: [12, 0, 0, 12, 50, 800 - i * 2],
          width: 30,
          height: 12,
        })),
      }),
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "layer-0",
      maxLines: 100,
    });

    expect(objects).toHaveLength(100);
  });

  it("returns empty array when getTextContent throws (non-fatal)", async () => {
    const mockPage = {
      getTextContent: async () => {
        throw new Error("PDF.js error");
      },
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "layer-0",
    });

    expect(objects).toEqual([]);
  });

  it("filters out TextMarkedContent entries (no str field)", async () => {
    const mockPage = {
      getTextContent: async () => ({
        items: [
          { str: "real", transform: [12, 0, 0, 12, 50, 800], width: 30, height: 9.6 },
          { type: "beginMarkedContent" }, // no str
          { str: "also-real", transform: [12, 0, 0, 12, 100, 800], width: 30, height: 9.6 },
        ],
      }),
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "layer-0",
    });

    expect(objects.length).toBeGreaterThan(0);
    // Both real items are on the same baseline, so they merge into one line.
    expect(objects[0].text).toContain("real");
  });

  it("filters out items with malformed transforms", async () => {
    const mockPage = {
      getTextContent: async () => ({
        items: [
          { str: "bad", transform: [12, 0], width: 30, height: 9.6 }, // only 2 elements
          { str: "good", transform: [12, 0, 0, 12, 50, 800], width: 30, height: 9.6 },
        ],
      }),
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "layer-0",
    });

    expect(objects).toHaveLength(1);
    expect(objects[0].text).toBe("good");
  });

  it("places a horizontal line with the baseline-on-original transform + readonly geometry (C1/C2 guard)", async () => {
    // One horizontal item: pdfX 50, pdfY 800, size 12, width 30, Helvetica,
    // pageHeight 842. The transform MUST encode the baseline position + the
    // ascent shift, and the ascent MUST be the base-14 ascender (not the font
    // size). These assertions catch both C1 (factory dropping overrides.transform
    // → identity → e=0, f=0) and C2 (ascent = fontSize → f = 42 - 12, height =
    // 12 × 1.25 = 15) regressions, which the old `toBeDefined()` checks did not.
    //
    // The geometry still matters even though a readonly run does not render: it
    // is what selection hit-testing uses, and what a future replacement would
    // have to redact against.
    const mockPage = {
      getTextContent: async () => ({
        items: [{ str: "Test", transform: [12, 0, 0, 12, 50, 800], width: 30, height: 12, fontName: "Helvetica" }],
      }),
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "test-layer",
    });

    expect(objects).toHaveLength(1);
    const obj = objects[0];
    expect(obj.kind).toBe("text");
    expect(obj.layerId).toBe("test-layer");
    expect(obj.text).toBe("Test");
    // NO background. The old opaque-white "redaction" fill is exactly what made
    // the duplication visible and destroyed graphics behind the run.
    expect(obj.background).toBeNull();
    // Provenance + font mapping: the PDF.js fontName is preserved on sourceText,
    // and the editable family is the mapped base-14 family (not the raw name).
    // The run is readonly — PDF.js gives no operator mapping, so nothing here
    // can honestly claim the original text is editable.
    expect(obj.sourceText).toEqual({
      fontName: "Helvetica",
      rotation: 0,
      mode: "readonly",
      reason: READONLY_REASON,
      originalText: "Test",
    });
    // Selectable, so the user can inspect it and learn why it is readonly.
    // Locking it would hide it from hit-testing entirely.
    expect(obj.locked).toBe(false);
    expect(obj.fontFamily).toBe(mapFontToBaseFamily("Helvetica").fontFamily);

    const ascent = base14Ascent("Helvetica", 12);
    const descent = base14Descent("Helvetica", 12);
    // C1 guard: the composed transform is honored, NOT identity. baselineX = 50,
    // baselineY = 842 - 800 = 42, so transform = T(50, 42)·R(0)·T(0, −ascent) =
    // {a:1, b:0, c:0, d:1, e:50, f:42 − ascent}.
    expect(obj.transform.a).toBeCloseTo(1, 5);
    expect(obj.transform.b).toBeCloseTo(0, 5);
    expect(obj.transform.c).toBeCloseTo(0, 5);
    expect(obj.transform.d).toBeCloseTo(1, 5);
    expect(obj.transform.e).toBeCloseTo(50, 5); // identity would give 0
    expect(obj.transform.f).toBeCloseTo(42 - ascent, 5); // C2: −ascent, not −fontSize

    // C2 guard: the local box = advance × (ascent + descent), covering the
    // glyph run — NOT advance × (fontSize × 1.25).
    expect(obj.localBounds.x).toBe(0);
    expect(obj.localBounds.y).toBe(0);
    expect(obj.localBounds.width).toBeCloseTo(30, 5);
    expect(obj.localBounds.height).toBeCloseTo(ascent + descent, 5);
  });

  it("places a 90°-rotated line with the rotation-correct transform + local box", async () => {
    // One vertical item: transform [0,12,-12,0, 100,800] (90°, size 12), width 20.
    // rotation = 90°, baselineX = 100, baselineY = 42, ascent ≈ 8.616.
    // transform = T(100,42)·R(π/2)·T(0,−ascent) = {a:0, b:1, c:-1, d:0,
    // e:100+ascent, f:42} — the ascent shift rotates into +x for vertical text.
    const mockPage = {
      getTextContent: async () => ({
        items: [{ str: "Vert", transform: [0, 12, -12, 0, 100, 800], width: 20, height: 12, fontName: "Helvetica" }],
      }),
    } as unknown as PDFPageProxy;

    const objects = await extractTextObjects(mockPage, {
      pageWidth: 595,
      pageHeight: 842,
      layerId: "test-layer",
    });

    expect(objects).toHaveLength(1);
    const obj = objects[0];
    const ascent = base14Ascent("Helvetica", 12);
    const descent = base14Descent("Helvetica", 12);
    expect(obj.sourceText).toEqual({
      fontName: "Helvetica",
      rotation: 90,
      mode: "readonly",
      reason: READONLY_REASON,
      originalText: "Vert",
    });
    // 90° rotation matrix: a=0, b=1, c=-1, d=0; e = baselineX + ascent, f = baselineY.
    expect(obj.transform.a).toBeCloseTo(0, 5);
    expect(obj.transform.b).toBeCloseTo(1, 5);
    expect(obj.transform.c).toBeCloseTo(-1, 5);
    expect(obj.transform.d).toBeCloseTo(0, 5);
    expect(obj.transform.e).toBeCloseTo(100 + ascent, 5);
    expect(obj.transform.f).toBeCloseTo(42, 5);
    // advance (20) is along the baseline direction; box height = ascent + descent.
    expect(obj.localBounds.width).toBeCloseTo(20, 5);
    expect(obj.localBounds.height).toBeCloseTo(ascent + descent, 5);
  });
});
