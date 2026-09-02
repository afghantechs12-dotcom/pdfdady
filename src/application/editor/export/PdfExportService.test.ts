import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFPage, StandardFonts } from "pdf-lib";

import {
  addObjectToPage,
  createEditorState,
  getActivePage,
} from "@/src/domain/editor/document";
import type { EditorPage, EditorState } from "@/src/domain/editor/document";
import {
  makeAnnotation,
  makeDrawing,
  makeHighlight,
  makeImage,
  makeRect,
  makeTextObject,
  resetFactory,
} from "@/src/domain/editor/testFactories";
import type { ImageObject, SignatureObject } from "@/src/domain/editor/objects";
import { IDENTITY_TRANSFORM, makeBounds, makeTranslate } from "@/src/domain/editor/geometry";
import { base14Ascent, base14Descent } from "@/src/domain/editor/textMetrics";
import { extractTextObjects } from "@/lib/editor/extractText";

import { shapePathData, transformPathData } from "@/src/domain/editor/shapeGeometry";
import { deriveDrawingRender } from "@/src/application/editor/tools/drawingGeometry";

import {
  PdfExportService,
  editorColorToRgb,
  resolveStandardFont,
  winAnsiSafeText,
} from "./PdfExportService";

/**
 * A known-good 1x1 RGB PNG that pdf-lib's embedPng accepts (verified against
 * pdf-lib ^1.17.1). Kept as raw bytes so the test doesn't depend on an external
 * asset or a hand-typed base64 string that might be malformed.
 */
const ONE_PX_PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
  0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
  0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0x00, 0x05, 0xfe, 0x02,
  0xfe, 0xdc, 0xcc, 0x59, 0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/** The 1x1 PNG as a `data:image/png;base64,...` URL (what ImageObject.src holds). */
function onePxPngDataUrl(): string {
  // Buffer is available in the vitest node env.
  return `data:image/png;base64,${Buffer.from(ONE_PX_PNG_BYTES).toString("base64")}`;
}

/** Adds a single object to the active page of `state` and returns the new state. */
function addObject(state: EditorState, obj: Parameters<typeof addObjectToPage>[1]): EditorState {
  const page = addObjectToPage(getActivePage(state), obj);
  return { ...state, document: { ...state.document, pages: [page] } };
}

/** Replaces the document's pages (used to build multi-page states). */
function withPages(state: EditorState, pages: EditorPage[]): EditorState {
  return { ...state, document: { ...state.document, pages } };
}

/** Builds a blank page of a given size with its own id (no source PDF page). */
function blankPage(id: string, width = 595, height = 842): EditorPage {
  return { ...createEditorState(id, id).document.pages[0], id, width, height };
}

/** Builds an editor page pinned to a source PDF page (the Open-PDF shape). */
function sourcePage(id: string, sourcePageIndex: number, width = 595, height = 842): EditorPage {
  return { ...blankPage(id, width, height), sourcePageIndex };
}

/** Builds a source PDF with `count` blank pages and returns its bytes. */
async function makeSourcePdf(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([595, 842]);
  return doc.save();
}

describe("editorColorToRgb", () => {
  it("passes 0..1 channels through unchanged", () => {
    expect(editorColorToRgb({ r: 0.5, g: 0.25, b: 0.75, a: 0.4 })).toEqual({
      r: 0.5,
      g: 0.25,
      b: 0.75,
      a: 0.4,
    });
  });

  it("clamps out-of-range channels and alpha to [0, 1]", () => {
    expect(editorColorToRgb({ r: 1.2, g: -0.3, b: 0, a: 2 })).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    });
  });

  it("maps NaN channels to 0", () => {
    expect(editorColorToRgb({ r: NaN, g: 0, b: 0, a: 0 })).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 0,
    });
  });
});

describe("resolveStandardFont", () => {
  it("maps Helvetica + normal weight to Helvetica", () => {
    expect(resolveStandardFont("Helvetica", 400)).toEqual({
      font: StandardFonts.Helvetica,
      italic: false,
    });
  });

  it("maps Helvetica + weight 700 to Helvetica-Bold", () => {
    expect(resolveStandardFont("Helvetica", 700)).toEqual({
      font: StandardFonts.HelveticaBold,
      italic: false,
    });
  });

  it("maps a PostScript bold family name to the bold variant regardless of weight", () => {
    expect(resolveStandardFont("Helvetica-Bold", 400)).toEqual({
      font: StandardFonts.HelveticaBold,
      italic: false,
    });
  });

  it("maps an oblique family to the oblique variant and sets the italic flag", () => {
    expect(resolveStandardFont("Helvetica-Oblique", 400)).toEqual({
      font: StandardFonts.HelveticaOblique,
      italic: true,
    });
  });

  it("maps Times-Roman and a bold weight to Times-Bold", () => {
    expect(resolveStandardFont("Times-Roman", 700)).toEqual({
      font: StandardFonts.TimesRomanBold,
      italic: false,
    });
    expect(resolveStandardFont("Times-Roman", 400).font).toBe(StandardFonts.TimesRoman);
  });

  it("maps Courier and a bold+italic request to Courier-BoldOblique", () => {
    expect(resolveStandardFont("Courier-Oblique", 700)).toEqual({
      font: StandardFonts.CourierBoldOblique,
      italic: true,
    });
  });

  it("falls back to Helvetica for an unknown family", () => {
    expect(resolveStandardFont("Comic Sans MS", 400)).toEqual({
      font: StandardFonts.Helvetica,
      italic: false,
    });
  });

  it("falls back to Helvetica for an empty family", () => {
    expect(resolveStandardFont("", 400).font).toBe(StandardFonts.Helvetica);
  });

  it("honors the bold half of a COMBINED posture name (P1 Phase H regression)", () => {
    // The bug: the bold test was `/\bbold\b/`, and in "boldoblique" /
    // "bolditalic" there is no word boundary between the weight token and the
    // posture token. So all four combined base-14 names — every one of which the
    // font dropdown offers by name — resolved to the NON-bold oblique face and
    // exported at regular weight. Found while wiring the Italic control, which
    // produces exactly these families.
    expect(resolveStandardFont("Helvetica-BoldOblique", 400)).toEqual({
      font: StandardFonts.HelveticaBoldOblique,
      italic: true,
    });
    expect(resolveStandardFont("Times-BoldItalic", 400)).toEqual({
      font: StandardFonts.TimesRomanBoldItalic,
      italic: true,
    });
    expect(resolveStandardFont("Courier-BoldOblique", 400)).toEqual({
      font: StandardFonts.CourierBoldOblique,
      italic: true,
    });
  });

  it("resolves every base-14 family to ITSELF at the default weight", () => {
    // The strongest statement of the mapping: the editor's own font list is
    // exactly base-14, so picking any entry by name must round-trip. This is
    // what makes the Italic toggle (which moves the family within this matrix)
    // safe, and it pins Symbol/ZapfDingbats against the suffix-stripping change.
    const identity: Array<[string, StandardFonts]> = [
      ["Helvetica", StandardFonts.Helvetica],
      ["Helvetica-Bold", StandardFonts.HelveticaBold],
      ["Helvetica-Oblique", StandardFonts.HelveticaOblique],
      ["Helvetica-BoldOblique", StandardFonts.HelveticaBoldOblique],
      ["Times-Roman", StandardFonts.TimesRoman],
      ["Times-Bold", StandardFonts.TimesRomanBold],
      ["Times-Italic", StandardFonts.TimesRomanItalic],
      ["Times-BoldItalic", StandardFonts.TimesRomanBoldItalic],
      ["Courier", StandardFonts.Courier],
      ["Courier-Bold", StandardFonts.CourierBold],
      ["Courier-Oblique", StandardFonts.CourierOblique],
      ["Courier-BoldOblique", StandardFonts.CourierBoldOblique],
      ["Symbol", StandardFonts.Symbol],
      ["ZapfDingbats", StandardFonts.ZapfDingbats],
    ];
    for (const [family, expected] of identity) {
      expect(resolveStandardFont(family, 400).font, family).toBe(expected);
    }
  });

  it("keeps the glyph fonts upright and un-bolded whatever is asked of them", () => {
    // Symbol/ZapfDingbats have no bold or oblique variant; a heavy weight must
    // not push them onto some other family.
    expect(resolveStandardFont("Symbol", 700).font).toBe(StandardFonts.Symbol);
    expect(resolveStandardFont("ZapfDingbats", 700).font).toBe(StandardFonts.ZapfDingbats);
    expect(resolveStandardFont("Symbol", 700).italic).toBe(false);
  });
});

describe("winAnsiSafeText", () => {
  it("keeps printable ASCII (0x20–0x7E) unchanged", () => {
    expect(winAnsiSafeText("Hello World 123!")).toBe("Hello World 123!");
  });

  it("keeps Latin-1 supplement letters (0xA0–0xFF)", () => {
    // 'é' U+00E9, 'ï' U+00EF, 'ñ' U+00F1 are all in 0xA0–0xFF.
    expect(winAnsiSafeText("café naïve niño")).toBe("café naïve niño");
  });

  it("keeps the named CP1252 extras (smart quotes, dashes, bullet, ellipsis, €, ™)", () => {
    // U+2018/2019/201C/201D quotes, U+2013/2014 dashes, U+2022 bullet, U+2026
    // ellipsis, U+20AC euro, U+2122 trademark — all in WINANSI_EXTRA_CP.
    expect(winAnsiSafeText("“smart” ‘quotes’ – — • … €™")).toBe("“smart” ‘quotes’ – — • … €™");
  });

  it("replaces CJK characters with '?'", () => {
    // U+4F60 (你), U+597D (好) — not WinAnsi-encodable.
    expect(winAnsiSafeText("你好")).toBe("??");
  });

  it("replaces emoji with '?'", () => {
    // U+1F389 (🎉) — not WinAnsi-encodable.
    expect(winAnsiSafeText("🎉")).toBe("?");
  });

  it("replaces the undefined CP1252 C1 control slots (0x80–0x9F) with '?'", () => {
    // U+0081, U+008D, U+008F, U+0090, U+009D — the undefined CP1252 slots, in the
    // 0x80–0x9F range that falls through every keep-branch to '?'. Built from
    // code points (not raw literals) so the test is robust to C1-control stripping.
    const c1 = String.fromCodePoint(0x81, 0x8d, 0x8f, 0x90, 0x9d);
    expect(winAnsiSafeText(c1)).toBe("?????");
  });

  it("sanitizes a mixed WinAnsi + non-WinAnsi string (the Part 1 existing-text case)", () => {
    // "Hello" (ASCII) + space + 你好 (CJK → ??) + space + 🎉 (emoji → ?).
    expect(winAnsiSafeText("Hello 你好 🎉")).toBe("Hello ?? ?");
  });

  it("handles an empty string", () => {
    expect(winAnsiSafeText("")).toBe("");
  });
});

describe("PdfExportService.exportPdf", () => {
  beforeEach(() => resetFactory());

  it("produces a non-empty PDF whose magic bytes are %PDF-", async () => {
    let state = createEditorState();
    state = addObject(state, makeTextObject());
    state = addObject(state, makeRect());

    const bytes = await new PdfExportService().exportPdf(state);
    expect(bytes.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("a 2-object state on one page exports a single-page PDF", async () => {
    let state = createEditorState();
    state = addObject(state, makeTextObject());
    state = addObject(state, makeRect());

    const bytes = await new PdfExportService().exportPdf(state);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("a multi-page state exports a PDF with the matching page count", async () => {
    const p1 = blankPage("page-1");
    const p2 = blankPage("page-2");
    const p3 = blankPage("page-3");
    const state = withPages(createEditorState("doc", "page-1"), [p1, p2, p3]);

    const bytes = await new PdfExportService().exportPdf(state);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("draws a highlight object without throwing and emits a valid PDF", async () => {
    let state = createEditorState();
    state = addObject(state, makeHighlight());
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws a freehand drawing object without throwing and emits a valid PDF", async () => {
    let state = createEditorState();
    state = addObject(state, makeDrawing());
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws an image object (PNG data URL) without throwing and emits a valid PDF", async () => {
    let state = createEditorState();
    const image = makeImage({ src: onePxPngDataUrl() } as Partial<ImageObject>);
    state = addObject(state, image);
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws a signature object (PNG data URL) without throwing and emits a valid PDF", async () => {
    let state = createEditorState();
    const signature: SignatureObject = {
      id: "sig-1",
      kind: "signature",
      layerId: "layer-1",
      name: "Signature",
      transform: makeTranslate(40, 40),
      localBounds: makeBounds(0, 0, 120, 60),
      opacity: 1,
      visible: true,
      locked: false,
      metadata: {},
      src: onePxPngDataUrl(),
      naturalWidth: 120,
      naturalHeight: 60,
      signer: "Ada",
    };
    state = addObject(state, signature);
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws an annotation with a pointer target without throwing", async () => {
    let state = createEditorState();
    state = addObject(state, makeAnnotation({
      id: "note-1",
      transform: IDENTITY_TRANSFORM,
      localBounds: makeBounds(0, 0, 80, 24),
      text: "See this spot",
      fontSize: 12,
      color: { r: 0.86, g: 0.15, b: 0.15, a: 1 },
      pointerTarget: { x: 200, y: 300 },
    }));
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("preserves source PDF content when sourcePdfBytes is provided (copyPages)", async () => {
    // Build a source PDF with one page containing a drawn rectangle, so the
    // copied page carries real content the editor edits draw on top of.
    const srcDoc = await PDFDocument.create();
    const srcPage = srcDoc.addPage([595, 842]);
    srcPage.drawRectangle({ x: 10, y: 10, width: 100, height: 50, color: undefined });
    const sourceBytes = await srcDoc.save();

    let state = createEditorState();
    // The Open-PDF shape: the editor page is PINNED to source page 0 (M6 —
    // createPage now defaults sourcePageIndex to null = blank, so the pin is
    // explicit). Sized to match the source so the copied page isn't resized.
    state = withPages(state, [sourcePage("page-1", 0, 595, 842)]);
    state = addObject(state, makeTextObject({ transform: makeTranslate(50, 50) }));

    const bytes = await new PdfExportService().exportPdf(state, { sourcePdfBytes: sourceBytes });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
    // The page kept the source size (a copied page that was resized to match the editor).
    const out = reloaded.getPage(0);
    expect(out.getSize().width).toBe(595);
    expect(out.getSize().height).toBe(842);
  });

  it("creates blank pages for editor pages beyond the source page count", async () => {
    const sourceBytes = await makeSourcePdf(1); // one source page

    // Page 1 is pinned to source page 0; pages 2 and 3 have no source (M6:
    // blank pages carry sourcePageIndex null instead of relying on the index).
    const state = withPages(
      createEditorState("doc", "page-1"),
      [sourcePage("page-1", 0), blankPage("page-2"), blankPage("page-3")],
    );

    const bytes = await new PdfExportService().exportPdf(state, { sourcePdfBytes: sourceBytes });
    const reloaded = await PDFDocument.load(bytes);
    // Editor has 3 pages; source has 1 → page 1 copied, pages 2 and 3 blank.
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("skips invisible objects without error", async () => {
    let state = createEditorState();
    state = addObject(state, makeRect({ visible: false }));
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws a text object with an opaque background (existing-text redaction) without error", async () => {
    let state = createEditorState();
    state = addObject(
      state,
      makeTextObject({
        text: "Existing text",
        background: { r: 1, g: 1, b: 1, a: 1 },
        sourceText: { fontName: "Helvetica", rotation: 0 },
      }),
    );
    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("draws a rotated existing-text object (background + rotation) without error", async () => {
    // A 90°-rotated existing-text object exercises the rotated background rect +
    // the rotation-aware text draw path together.
    const state = createEditorState();
    const page = getActivePage(state);
    const { compose, makeRotate, makeTranslate, makeBounds } = await import("@/src/domain/editor/geometry");
    const transform = compose(
      makeTranslate(300, 400),
      compose(makeRotate(Math.PI / 2), makeTranslate(0, -9.6)),
    );
    const obj = makeTextObject({
      text: "Vertical",
      background: { r: 1, g: 1, b: 1, a: 1 },
      sourceText: { rotation: 90 },
      transform,
      localBounds: makeBounds(0, 0, 60, 12),
    });
    const withObj = {
      ...state,
      document: { ...state.document, pages: [addObjectToPage(page, obj)] },
    };
    const bytes = await new PdfExportService().exportPdf(withObj);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("sanitizes non-WinAnsi characters so one bad glyph doesn't abort export (F2 hardening)", async () => {
    // M5 Part 1 extracts existing text from real PDFs, which may contain CJK/emoji
    // or other glyphs Standard-14 fonts can't encode. winAnsiSafeText replaces
    // unencodable code points with '?', and the per-object try/catch in exportPdf
    // prevents a throw from aborting the entire export.
    let state = createEditorState();
    state = addObject(
      state,
      makeTextObject({
        text: "Hello 你好 🎉", // mix of WinAnsi + non-WinAnsi
        background: { r: 1, g: 1, b: 1, a: 1 },
      }),
    );
    state = addObject(state, makeTextObject({ text: "Safe text" }));

    const bytes = await new PdfExportService().exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    // Both objects should have drawn (or been skipped cleanly if sanitization failed);
    // the export completes without throwing.
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("skips a throwing object without aborting the export (per-object try/catch, F2)", async () => {
    // The exportPdf loop wraps each drawObject in try/catch so one failing object
    // is skipped, not fatal. winAnsiSafeText makes text throws near-impossible to
    // trigger black-box (it sanitizes every code point to WinAnsi first), so this
    // forces a throw via the draw path to prove the catch is wired: the FIRST
    // object's draw rejects, the second draws normally, and export still produces
    // a valid PDF. (The direct winAnsiSafeText unit test above proves sanitization
    // itself; this proves the defense-in-depth net around it.)
    let state = createEditorState();
    state = addObject(state, makeTextObject({ text: "Throws" }));
    state = addObject(state, makeTextObject({ text: "Safe text" }));

    const svc = new PdfExportService();
    const drawObject = vi.spyOn(
      svc as unknown as { drawObject: (...args: unknown[]) => Promise<void> },
      "drawObject",
    );
    drawObject.mockImplementationOnce(() => Promise.reject(new Error("simulated draw failure")));

    const bytes = await svc.exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    // drawObject was called for both objects — the first threw (caught + skipped),
    // the second drew. The export did not abort.
    expect(drawObject).toHaveBeenCalledTimes(2);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("does NOT draw readonly imported text — the original source page is left untouched", async () => {
    // This replaces the old "redacts-then-redraws" test, which asserted the
    // duplication defect: it required export to stamp a white rectangle over the
    // original glyphs and redraw a base-14 approximation on top. Export composes
    // onto a copy of the ORIGINAL source page, so the original text is already in
    // the output — redrawing it produced two visible copies (misaligned, because
    // the copy is re-typeset) and two searchable copies.
    //
    // The honest behavior: a readonly run contributes NOTHING to the export. No
    // text, no rectangle. The page keeps exactly the content it shipped with.
    const mockPage = {
      getTextContent: async () => ({
        items: [{ str: "Hello", transform: [12, 0, 0, 12, 50, 800], width: 30, height: 12, fontName: "Helvetica" }],
      }),
    } as unknown as import("pdfjs-dist").PDFPageProxy;
    const objects = await extractTextObjects(mockPage, { pageWidth: 595, pageHeight: 842, layerId: "layer-1" });
    expect(objects).toHaveLength(1);
    expect(objects[0].sourceText?.mode).toBe("readonly");

    let state = createEditorState();
    state = withPages(state, [blankPage("page-1", 595, 842)]);
    state = addObject(state, objects[0]);

    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const drawRectSpy = vi.spyOn(PDFPage.prototype, "drawRectangle");
    try {
      const bytes = await new PdfExportService().exportPdf(state);
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");

      // No redrawn copy of the original text.
      expect(drawTextSpy.mock.calls.some((c) => c[0]?.includes("Hello"))).toBe(false);
      // No white mask. A universal white fill is wrong anyway — it destroys table
      // rules, images, and colored backgrounds that sit behind the run.
      const whiteRect = drawRectSpy.mock.calls.find((c) => {
        const o = c[0] as { color?: { red: number; green: number; blue: number } };
        return o?.color && o.color.red === 1 && o.color.green === 1 && o.color.blue === 1;
      });
      expect(whiteRect).toBeUndefined();
    } finally {
      drawTextSpy.mockRestore();
      drawRectSpy.mockRestore();
    }
  });

  it("draws a replacement run's removal fill and its replacement text", async () => {
    // The `replace` mode is the one case where drawing IS correct: the removal
    // fill is an independently-probed page color that permanently removes the
    // original, and the replacement text is the user's own content. The baseline
    // geometry (C1/C2) still has to be exact, so those assertions carry over from
    // the old test — they were always about coordinates, not about masking.
    const mockPage = {
      getTextContent: async () => ({
        items: [{ str: "Hello", transform: [12, 0, 0, 12, 50, 800], width: 30, height: 12, fontName: "Helvetica" }],
      }),
    } as unknown as import("pdfjs-dist").PDFPageProxy;
    const extracted = await extractTextObjects(mockPage, { pageWidth: 595, pageHeight: 842, layerId: "layer-1" });
    // Promote to a replacement, as starting a Replace-text operation would.
    const replacement = {
      ...extracted[0],
      text: "Goodbye",
      locked: false,
      background: { r: 1, g: 1, b: 1, a: 1 },
      sourceText: { ...extracted[0].sourceText!, mode: "replace" as const },
    };

    let state = createEditorState();
    state = withPages(state, [blankPage("page-1", 595, 842)]);
    state = addObject(state, replacement);

    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const drawRectSpy = vi.spyOn(PDFPage.prototype, "drawRectangle");
    try {
      await new PdfExportService().exportPdf(state);

      // C1 + C2: transform = T(50, 42)·R(0)·T(0, −ascent); the first baseline is
      // transformPoint(transform, (0, ascent)) = (50, 42) → toPdfY(42, 842) = 800,
      // the ORIGINAL baseline. A C1 regression lands it at the page corner; a C2
      // regression (ascent = fontSize) lands it ~0.28×fontSize high.
      const textCall = drawTextSpy.mock.calls.find((c) => c[0]?.includes("Goodbye"));
      if (!textCall) throw new Error("replacement drawText call not found");
      expect((textCall[1] as { y: number }).y).toBeCloseTo(800, 1);

      // The removal rect covers the original glyph run: drawn at the ascender top
      // (pdf y = 842 − (42 − ascent) = 808.616) extending DOWN by ascent + descent.
      const ascent = base14Ascent("Helvetica", 12);
      const descent = base14Descent("Helvetica", 12);
      const rectCall = drawRectSpy.mock.calls.find((c) => {
        const o = c[0] as { color?: { red: number; green: number; blue: number } };
        return o?.color && o.color.red === 1 && o.color.green === 1 && o.color.blue === 1;
      });
      if (!rectCall) throw new Error("removal drawRectangle call not found");
      const rectOpts = rectCall[0] as { x: number; y: number; width: number; height: number };
      expect(rectOpts.x).toBeCloseTo(50, 1);
      expect(rectOpts.y).toBeCloseTo(842 - (42 - ascent), 1); // 808.616
      // height is negative (pdf-lib: extends downward from y); magnitude ≈ box height.
      expect(Math.abs(rectOpts.height)).toBeCloseTo(ascent + descent, 1);
      expect(rectOpts.width).toBeCloseTo(30, 1);
    } finally {
      drawTextSpy.mockRestore();
      drawRectSpy.mockRestore();
    }
  });

  it("leaves the exported page byte-identical to the source when every run is readonly", async () => {
    // The strongest statement of the export rule: importing a PDF and exporting
    // it WITHOUT editing anything must not alter the page. Previously this
    // stamped a white rectangle and a redrawn line of text for every text run on
    // every page — a lossy round-trip that destroyed graphics behind the text.
    const mockPage = {
      getTextContent: async () => ({
        items: [
          { str: "Line one", transform: [12, 0, 0, 12, 50, 800], width: 40, height: 12, fontName: "Helvetica" },
          { str: "Line two", transform: [12, 0, 0, 12, 50, 780], width: 40, height: 12, fontName: "Helvetica" },
        ],
      }),
    } as unknown as import("pdfjs-dist").PDFPageProxy;
    const objects = await extractTextObjects(mockPage, { pageWidth: 595, pageHeight: 842, layerId: "layer-1" });
    expect(objects).toHaveLength(2);

    let state = createEditorState();
    state = withPages(state, [blankPage("page-1", 595, 842)]);
    for (const obj of objects) state = addObject(state, obj);

    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    const drawRectSpy = vi.spyOn(PDFPage.prototype, "drawRectangle");
    try {
      await new PdfExportService().exportPdf(state);
      // Nothing was painted at all: no text, no masks.
      expect(drawTextSpy).not.toHaveBeenCalled();
      expect(drawRectSpy).not.toHaveBeenCalled();
    } finally {
      drawTextSpy.mockRestore();
      drawRectSpy.mockRestore();
    }
  });

  it("exports a user's added text alongside readonly imported runs", async () => {
    // "Add text" must keep working next to readonly source text — the readonly
    // rule suppresses only the imported runs, never the user's own content.
    const mockPage = {
      getTextContent: async () => ({
        items: [{ str: "Imported", transform: [12, 0, 0, 12, 50, 800], width: 40, height: 12, fontName: "Helvetica" }],
      }),
    } as unknown as import("pdfjs-dist").PDFPageProxy;
    const imported = await extractTextObjects(mockPage, { pageWidth: 595, pageHeight: 842, layerId: "layer-1" });

    let state = createEditorState();
    state = withPages(state, [blankPage("page-1", 595, 842)]);
    state = addObject(state, imported[0]);
    state = addObject(state, makeTextObject({ text: "My own note", sourceText: null }));

    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    try {
      await new PdfExportService().exportPdf(state);
      const drawn = drawTextSpy.mock.calls.map((c) => c[0]);
      expect(drawn.some((t) => t?.includes("My own note"))).toBe(true);
      // The imported run is still not duplicated into the output.
      expect(drawn.some((t) => t?.includes("Imported"))).toBe(false);
    } finally {
      drawTextSpy.mockRestore();
    }
  });

  it("does not duplicate searchable text: a readonly run contributes no second text operator", async () => {
    // Duplicated SEARCHABLE text is the invisible half of the defect — copy/paste
    // and search from the exported file returned every line twice. Since the
    // readonly run emits no drawText, the output carries exactly the source
    // page's own text operators.
    const mockPage = {
      getTextContent: async () => ({
        items: [{ str: "Searchable", transform: [12, 0, 0, 12, 50, 800], width: 50, height: 12, fontName: "Helvetica" }],
      }),
    } as unknown as import("pdfjs-dist").PDFPageProxy;
    const objects = await extractTextObjects(mockPage, { pageWidth: 595, pageHeight: 842, layerId: "layer-1" });

    let state = createEditorState();
    state = withPages(state, [blankPage("page-1", 595, 842)]);
    state = addObject(state, objects[0]);

    const drawTextSpy = vi.spyOn(PDFPage.prototype, "drawText");
    try {
      await new PdfExportService().exportPdf(state);
      const occurrences = drawTextSpy.mock.calls.filter((c) => c[0]?.includes("Searchable")).length;
      expect(occurrences).toBe(0);
    } finally {
      drawTextSpy.mockRestore();
    }
  });
});

describe("PdfExportService: sourcePageIndex mapping (M6 page operations)", () => {
  beforeEach(() => resetFactory());

  /** Runs an export and returns the flat list of source indices copyPages requested, in order. */
  async function exportAndCaptureCopies(
    state: EditorState,
    sourceBytes: Uint8Array,
  ): Promise<{ copied: number[]; bytes: Uint8Array }> {
    const copySpy = vi.spyOn(PDFDocument.prototype, "copyPages");
    try {
      const bytes = await new PdfExportService().exportPdf(state, { sourcePdfBytes: sourceBytes });
      const copied = copySpy.mock.calls.flatMap((call) => call[1] as number[]);
      return { copied, bytes };
    } finally {
      copySpy.mockRestore();
    }
  }

  describe("resolveSourcePageIndex", () => {
    it("uses the pinned index when set and in range", () => {
      expect(PdfExportService.resolveSourcePageIndex(sourcePage("p", 2), 0, 3)).toBe(2);
    });

    it("treats an UNDEFINED sourcePageIndex as the array index (pre-M6 states)", () => {
      const { sourcePageIndex: _legacy, ...rest } = blankPage("p");
      void _legacy;
      const legacy = rest as EditorPage;
      expect(legacy.sourcePageIndex).toBeUndefined();
      expect(PdfExportService.resolveSourcePageIndex(legacy, 1, 3)).toBe(1);
      expect(PdfExportService.resolveSourcePageIndex(legacy, 5, 3)).toBeNull(); // index beyond source
    });

    it("maps a null sourcePageIndex (blank inserted page) to null", () => {
      expect(PdfExportService.resolveSourcePageIndex(blankPage("p"), 0, 3)).toBeNull();
    });

    it("maps an out-of-range pinned index (deleted source page) to null", () => {
      expect(PdfExportService.resolveSourcePageIndex(sourcePage("p", 3), 0, 3)).toBeNull();
      expect(PdfExportService.resolveSourcePageIndex(sourcePage("p", -1), 0, 3)).toBeNull();
    });
  });

  it("reordered pages copy their pinned source pages in editor order", async () => {
    const sourceBytes = await makeSourcePdf(3);
    // Editor order after a reorder: source pages 2, 0, 1.
    const state = withPages(createEditorState("doc", "p-a"), [
      sourcePage("p-a", 2),
      sourcePage("p-b", 0),
      sourcePage("p-c", 1),
    ]);

    const { copied, bytes } = await exportAndCaptureCopies(state, sourceBytes);
    expect(copied).toEqual([2, 0, 1]);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("a duplicated page copies the same source page twice", async () => {
    const sourceBytes = await makeSourcePdf(2);
    const state = withPages(createEditorState("doc", "p-a"), [
      sourcePage("p-a", 0),
      sourcePage("p-a-copy", 0), // the duplicate keeps its source's index
      sourcePage("p-b", 1),
    ]);

    const { copied, bytes } = await exportAndCaptureCopies(state, sourceBytes);
    expect(copied).toEqual([0, 0, 1]);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("a deleted page's source page is absent from the export", async () => {
    const sourceBytes = await makeSourcePdf(3);
    // Editor deleted the middle page: only source pages 0 and 2 remain.
    const state = withPages(createEditorState("doc", "p-a"), [
      sourcePage("p-a", 0),
      sourcePage("p-c", 2),
    ]);

    const { copied, bytes } = await exportAndCaptureCopies(state, sourceBytes);
    expect(copied).toEqual([0, 2]);
    expect(copied).not.toContain(1);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("a blank inserted page produces an empty page of its own size (no copy)", async () => {
    const sourceBytes = await makeSourcePdf(2);
    const state = withPages(createEditorState("doc", "p-a"), [
      sourcePage("p-a", 0),
      blankPage("p-blank", 300, 400), // sourcePageIndex null → blank
      sourcePage("p-b", 1),
    ]);

    const { copied, bytes } = await exportAndCaptureCopies(state, sourceBytes);
    // Only the two pinned pages were copied; the blank page was created fresh.
    expect(copied).toEqual([0, 1]);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(3);
    expect(reloaded.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
  });

  it("pages WITHOUT the field (pre-M6 in-memory states) still map by array index", async () => {
    const sourceBytes = await makeSourcePdf(2);
    // Simulate a state built before sourcePageIndex existed: strip the field.
    const legacyPages = [blankPage("p-a"), blankPage("p-b")].map((page) => {
      const { sourcePageIndex: _s, ...rest } = page;
      void _s;
      return rest as EditorPage;
    });
    const state = withPages(createEditorState("doc", "p-a"), legacyPages);

    const { copied, bytes } = await exportAndCaptureCopies(state, sourceBytes);
    expect(copied).toEqual([0, 1]); // by-index fallback preserved
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(2);
  });
});

describe("PdfExportService: M6 shape library + brushes", () => {
  beforeEach(() => resetFactory());

  it("exports every shape kind without throwing and emits a valid PDF", async () => {
    let state = createEditorState();
    const kinds = [
      "rect", "roundedRect", "ellipse", "circle", "triangle", "line", "arrow",
      "polygon", "star", "speechBubble", "connector", "bezier", "path",
    ] as const;
    for (const [i, shape] of kinds.entries()) {
      state = addObject(
        state,
        makeRect({
          shape,
          transform: makeTranslate(10 + i * 5, 10 + i * 5),
          ...(shape === "bezier" || shape === "path"
            ? { pathData: "M 0 0 C 20 0 40 30 60 30 L 80 60" }
            : {}),
        }),
      );
    }
    const svc = new PdfExportService();
    const bytes = await svc.exportPdf(state);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });

  it("draws the shape path through the SHARED geometry (spy sees the transformed canonical path)", async () => {
    const star = makeRect({
      shape: "star",
      starPoints: 5,
      innerRatio: 0.5,
      transform: makeTranslate(100, 200),
    });
    const state = addObject(createEditorState(), star);
    const svc = new PdfExportService();
    const spy = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    try {
      await svc.exportPdf(state);
      expect(spy).toHaveBeenCalledTimes(1);
      const expected = transformPathData(shapePathData(star), star.transform);
      expect(spy.mock.calls[0][0]).toBe(expected);
    } finally {
      spy.mockRestore();
    }
  });

  it("approximates a drop shadow as an offset duplicate drawn before the shape", async () => {
    const shadowed = makeRect({
      style: {
        fill: { r: 1, g: 0, b: 0, a: 1 },
        stroke: null,
        strokeWidth: 0,
        cornerRadius: 0,
        shadow: { offsetX: 5, offsetY: 7, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      },
      transform: makeTranslate(50, 60),
    });
    const state = addObject(createEditorState(), shadowed);
    const svc = new PdfExportService();
    const spy = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    try {
      await svc.exportPdf(state);
      expect(spy).toHaveBeenCalledTimes(2); // shadow first, then the shape
      const local = shapePathData(shadowed);
      const shadowPath = transformPathData(local, {
        ...shadowed.transform,
        e: shadowed.transform.e + 5,
        f: shadowed.transform.f + 7,
      });
      const shapePath = transformPathData(local, shadowed.transform);
      expect(spy.mock.calls[0][0]).toBe(shadowPath);
      expect(spy.mock.calls[1][0]).toBe(shapePath);
    } finally {
      spy.mockRestore();
    }
  });

  it("maps a dash pattern to borderDashArray scaled by the object's scale", async () => {
    const dashed = makeRect({
      style: {
        fill: null,
        stroke: { r: 0, g: 0, b: 1, a: 1 },
        strokeWidth: 2,
        cornerRadius: 0,
        dash: [4, 3],
      },
    });
    const state = addObject(createEditorState(), dashed);
    const svc = new PdfExportService();
    const spy = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    try {
      await svc.exportPdf(state);
      const opts = spy.mock.calls[0][1] as { borderDashArray?: number[] };
      expect(opts.borderDashArray).toEqual([4, 3]); // identity scale
    } finally {
      spy.mockRestore();
    }
  });

  it("exports a pressure (variable-width) stroke as a FILLED outline via the shared derivation", async () => {
    const stroke = makeDrawing({
      points: [
        { x: 0, y: 0 },
        { x: 20, y: 5 },
        { x: 40, y: 0 },
      ],
      widths: [2, 4, 2],
    });
    const state = addObject(createEditorState(), stroke);
    const svc = new PdfExportService();
    const spy = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    try {
      await svc.exportPdf(state);
      expect(spy).toHaveBeenCalledTimes(1);
      const spec = deriveDrawingRender(stroke);
      expect(spec.mode).toBe("fill");
      expect(spy.mock.calls[0][0]).toBe(transformPathData(spec.pathData, stroke.transform));
      const opts = spy.mock.calls[0][1] as { color?: unknown; borderColor?: unknown };
      expect(opts.color).toBeDefined(); // filled, not stroked
      expect(opts.borderColor).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("exports a highlighter stroke with Multiply blend and the brush opacity factor", async () => {
    const stroke = makeDrawing({
      brush: "highlighter",
      points: [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
      ],
      style: { fill: null, stroke: { r: 1, g: 0.9, b: 0, a: 1 }, strokeWidth: 12, cornerRadius: 0 },
    });
    const state = addObject(createEditorState(), stroke);
    const svc = new PdfExportService();
    const spy = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    try {
      await svc.exportPdf(state);
      const opts = spy.mock.calls[0][1] as { blendMode?: string; borderOpacity?: number };
      expect(opts.blendMode).toBe("Multiply");
      expect(opts.borderOpacity).toBeCloseTo(0.35, 5);
    } finally {
      spy.mockRestore();
    }
  });

  it("exports a smoothed pencil stroke deterministically (same bytes for the same object)", async () => {
    const mk = () =>
      makeDrawing({
        brush: "pencil",
        smoothing: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 8 },
          { x: 20, y: 2 },
          { x: 30, y: 9 },
        ],
      });
    resetFactory();
    const a = addObject(createEditorState(), mk());
    resetFactory();
    const b = addObject(createEditorState(), mk());
    const svc = new PdfExportService();
    const spyPaths: string[] = [];
    const spy = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    try {
      await svc.exportPdf(a);
      await svc.exportPdf(b);
      for (const call of spy.mock.calls) spyPaths.push(call[0] as string);
      expect(spyPaths).toHaveLength(2);
      expect(spyPaths[0]).toBe(spyPaths[1]); // deterministic jitter, no randomness
    } finally {
      spy.mockRestore();
    }
  });
});
