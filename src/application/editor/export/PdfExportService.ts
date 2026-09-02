/**
 * The PDF export pipeline for the PDFDadi premium editor (M4).
 *
 * Turns an {@link EditorState} into a real PDF via pdf-lib, drawing each editor
 * object on top of an optional source PDF. The editor works in screen space
 * (origin top-left, +y DOWN — see [[preview-architecture]]); pdf-lib uses PDF
 * user space (origin bottom-left, +y UP). The mapping layer below is the only
 * place that translation lives, so the rest of the editor can keep the
 * coordinate contract its interactive tools rely on.
 *
 * pdf-lib is imported dynamically inside {@link PdfExportService.exportPdf} so
 * the module has no pdf-lib side effects at load time and stays out of the
 * browser bundle's main chunk (mirrors `lib/pdf/*`, which dynamic-imports
 * pdf-lib for the same reason). Type-only imports of pdf-lib's types are erased
 * at compile time and carry no runtime cost.
 *
 * @see [[editor-foundation]] for the object model these draws are derived from.
 */

import type {
  PDFFont,
  PDFPage,
  StandardFonts,
} from "pdf-lib";

import type { EditorColor } from "@/src/domain/editor/objects";
import type { EditorObject } from "@/src/domain/editor/objects";
import type {
  AnnotationObject,
  DrawingObject,
  HighlightObject,
  ImageObject,
  ShapeObject,
  SignatureObject,
  TextObject,
} from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import {
  shapeIsClosed,
  shapePathData,
  transformPathData,
} from "@/src/domain/editor/shapeGeometry";
import { annotationPanel, annotationTextLayout } from "@/src/domain/editor/annotationLayout";
import { deriveDrawingRender } from "@/src/application/editor/tools/drawingGeometry";
import { cropDrawSpec, MAX_CROP_DRAW_COORDINATE, type CropDrawSpec } from "@/src/application/editor/tools/cropMath";
import { validateImageDataUrl } from "@/src/application/editor/imageValidation";
import type { EditorState, EditorPage } from "@/src/domain/editor/document";
import { pageObjects } from "@/src/domain/editor/document";
import { decompose, fitContain, transformPoint } from "@/src/domain/editor/geometry";
import type { Bounds } from "@/src/domain/editor/geometry";
import { base14Ascent } from "@/src/domain/editor/textMetrics";
import { shouldDrawTextObject } from "@/src/domain/editor/importedTextRendering";

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing — no pdf-lib dependency).
// ---------------------------------------------------------------------------

/** Clamps a number to [0, 1]; NaN maps to 0. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * The Unicode code points beyond ASCII that pdf-lib's standard-14 fonts (which
 * use WinAnsiEncoding / CP1252) can encode. Used by {@link winAnsiSafeText} so
 * text containing non-Latin characters (CJK, emoji, etc. — common in existing
 * PDF text extracted by M5 Part 1) doesn't make `drawText` throw and abort the
 * export. Characters outside this set + printable ASCII become '?'.
 */
const WINANSI_EXTRA_CP = new Set<number>([
  0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x0192, 0x02c6,
  0x02dc, 0x201a, 0x201c, 0x201d, 0x2018, 0x2019, 0x2013, 0x2014, 0x2020,
  0x2021, 0x2022, 0x2026, 0x2030, 0x2039, 0x203a, 0x20ac, 0x2122,
]);

/**
 * Returns a WinAnsi-safe copy of `text`: keeps printable ASCII (0x20–0x7E), the
 * Latin-1 supplement (0xA0–0xFF), and the named CP1252 extras (smart quotes,
 * dashes, bullet, ellipsis, €, ™, …); replaces every other code point with '?'.
 * That includes the whole 0x80–0x9F range (the C1 control area — the undefined
 * CP1252 slots 0x81/0x8D/0x8F/0x90/0x9D live here, as do the CP1252-mapped
 * bytes, but those reach the text as their Unicode equivalents in
 * {@link WINANSI_EXTRA_CP}, e.g. 0x80→€ U+20AC), and all non-Latin text (CJK,
 * Cyrillic, Arabic, emoji). This is the honest best-effort for standard-14
 * fonts — the real fix for non-Latin text is embedding a Unicode font (a Part 13
 * export-quality enhancement). The per-object try/catch in `exportPdf` is the
 * final safety net if this misses a code point, so export never aborts.
 */
export function winAnsiSafeText(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      (cp >= 0x20 && cp <= 0x7e) ||
      (cp >= 0xa0 && cp <= 0xff) ||
      WINANSI_EXTRA_CP.has(cp)
    ) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/**
 * Converts an {@link EditorColor} (sRGB 0..1 with alpha) to the three 0..1
 * channels pdf-lib's `rgb()` expects. Channels are clamped to [0, 1]; the alpha
 * channel is clamped too and returned separately (pdf-lib has no alpha in
 * `rgb()` — opacity is conveyed via the per-draw `opacity`/`borderOpacity`
 * options, so callers combine alpha with the object opacity there).
 *
 * @param color The editor color (0..1 r/g/b/a).
 * @returns Clamped `{ r, g, b, a }` in 0..1.
 */
export function editorColorToRgb(color: EditorColor): {
  r: number;
  g: number;
  b: number;
  a: number;
} {
  return {
    r: clamp01(color.r),
    g: clamp01(color.g),
    b: clamp01(color.b),
    a: clamp01(color.a),
  };
}

/**
 * The result of mapping a requested font to the closest pdf-lib StandardFont.
 * `font` is a {@link StandardFonts} member (a string enum value such as
 * `"Helvetica-Bold"`); `italic` is surfaced separately so callers know an
 * oblique posture was chosen.
 */
export interface ResolvedStandardFont {
  font: StandardFonts;
  italic: boolean;
}

/**
 * Normalizes a requested `fontFamily` (which may be a CSS family, a PostScript
 * name, or an empty string) + numeric `fontWeight` into the closest of the 14
 * PDF base-14 fonts. The editor's default font source lists exactly these
 * (see `StandardFontsProvider`), so the mapping is exact for editor-authored
 * text and a best-effort fallback for anything else.
 *
 * Family matching is case-insensitive and tolerates both CSS-style ("Helvetica",
 * "Times New Roman", "Courier New") and PostScript ("Times-Roman") spellings.
 * Weight >= 600 selects a bold variant; an italic/oblique posture is chosen when
 * the family name asks for it. Unknown families fall back to Helvetica (the most
 * neutral sans-serif base font), never throwing.
 *
 * @param fontFamily The requested family (CSS or PostScript name).
 * @param fontWeight Numeric CSS weight (400 = normal, 700 = bold).
 */
export function resolveStandardFont(
  fontFamily: string,
  fontWeight: number,
): ResolvedStandardFont {
  const family = (fontFamily ?? "").trim().toLowerCase();
  // Bold is requested by EITHER a heavy weight (>= 600) OR a "bold" token in the
  // family name (e.g. the PostScript name "Helvetica-Bold"). The token is checked
  // against the original family before it's stripped below, so a bold family name
  // is honored even at weight 400.
  //
  // `bold(?!face)` rather than `\bbold\b`: the base-14 combined-posture names
  // ("Helvetica-BoldOblique", "Times-BoldItalic") have NO word boundary between
  // "bold" and the posture suffix, so `\bbold\b` missed all four of them and
  // exported them at regular weight. Verified against the full 14-font list.
  // The negative lookahead keeps a hypothetical "Boldface" family from matching.
  const bold = fontWeight >= 600 || /bold(?!face)/.test(family);
  const wantsItalic = /italic|oblique/.test(family);

  // Strip posture/weight suffixes to get the base family token. No `\b` around
  // the alternation, for the same reason as the bold test above: in
  // "boldoblique"/"bolditalic" the tokens abut with no boundary between them, so
  // a `\b`-anchored strip left residue ("helvetica boldoblique") behind. The
  // classification below survived that by using `includes`, but `isSymbol`
  // compares the base EXACTLY, so the residue mattered there.
  const base = family
    .replace(/(italic|oblique|bold|regular|normal)/g, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isTimes = base.includes("times") || (base.includes("serif") && !base.includes("sans"));
  const isCourier = base.includes("courier") || base.includes("mono");
  const isSymbol = base === "symbol";
  const isDingbats = base.includes("zapf") || base.includes("dingbat");

  // Order matters: check the rarer fixed names before the generic sans fallback.
  if (isSymbol) return { font: "Symbol" as StandardFonts, italic: false };
  if (isDingbats) return { font: "ZapfDingbats" as StandardFonts, italic: false };

  if (isCourier) {
    if (bold && wantsItalic) return { font: "Courier-BoldOblique" as StandardFonts, italic: true };
    if (bold) return { font: "Courier-Bold" as StandardFonts, italic: false };
    if (wantsItalic) return { font: "Courier-Oblique" as StandardFonts, italic: true };
    return { font: "Courier" as StandardFonts, italic: false };
  }

  if (isTimes) {
    if (bold && wantsItalic) return { font: "Times-BoldItalic" as StandardFonts, italic: true };
    if (bold) return { font: "Times-Bold" as StandardFonts, italic: false };
    if (wantsItalic) return { font: "Times-Italic" as StandardFonts, italic: true };
    return { font: "Times-Roman" as StandardFonts, italic: false };
  }

  // Default + explicit Helvetica/Arial/sans all land here. Unknown families
  // also fall through to Helvetica (the most neutral sans-serif base font).
  if (bold && wantsItalic) return { font: "Helvetica-BoldOblique" as StandardFonts, italic: true };
  if (bold) return { font: "Helvetica-Bold" as StandardFonts, italic: false };
  if (wantsItalic) return { font: "Helvetica-Oblique" as StandardFonts, italic: true };
  return { font: "Helvetica" as StandardFonts, italic: false };
}

// ---------------------------------------------------------------------------
// Coordinate mapping.
// ---------------------------------------------------------------------------

/**
 * The decomposed placement of an object in editor world space. The editor
 * transform is `T(e,f) · R(r) · S(sx,sy)` mapping local space (origin at the
 * object's top-left, +y down) to world space (also +y down). pdf-lib draws from
 * the bottom-left with +y up, so the local origin (0,0) — the object's top-left
 * — lands at pdf `(e, pageHeight - f)`.
 */
interface Placement {
  /** World x of the local origin (= transform.e). */
  e: number;
  /** World y of the local origin (= transform.f), in screen y-down space. */
  f: number;
  /** Decomposed horizontal scale (may be negative for a flipped object). */
  sx: number;
  /** Decomposed vertical scale (may be negative for a flipped object). */
  sy: number;
  /** Rotation in degrees, clockwise in the editor's y-down space. */
  rotationDeg: number;
  /** Local bounds width (the "natural" size before scaling). */
  width: number;
  /** Local bounds height (the "natural" size before scaling). */
  height: number;
}

/** Decomposes an object's transform into the placement used by every draw path. */
function placementOf(obj: EditorObject): Placement {
  const { translate, scale, rotation } = decompose(obj.transform);
  return {
    e: translate.x,
    f: translate.y,
    sx: scale.x,
    sy: scale.y,
    rotationDeg: (rotation * 180) / Math.PI,
    width: obj.localBounds.width,
    height: obj.localBounds.height,
  };
}

/**
 * Maps an editor screen-space y (top-left origin, +y down) to a pdf-lib
 * user-space y (bottom-left origin, +y up) for a page of `pageHeight` points.
 */
function toPdfY(screenY: number, pageHeight: number): number {
  return pageHeight - screenY;
}

// ---------------------------------------------------------------------------
// pdf-lib is dynamically imported inside exportPdf so this module's top level
// stays side-effect free. The PdfLib interface types the imported values via
// `typeof import("pdf-lib").X` (type queries on the module's value exports),
// which is valid in type position and needs no top-level runtime import.
// ---------------------------------------------------------------------------

interface PdfLib {
  PDFDocument: typeof import("pdf-lib").PDFDocument;
  StandardFonts: typeof import("pdf-lib").StandardFonts;
  rgb: typeof import("pdf-lib").rgb;
  degrees: typeof import("pdf-lib").degrees;
  BlendMode: typeof import("pdf-lib").BlendMode;
  // Raw content-stream operators for the clip-based image crop (M6.11).
  pushGraphicsState: typeof import("pdf-lib").pushGraphicsState;
  popGraphicsState: typeof import("pdf-lib").popGraphicsState;
  moveTo: typeof import("pdf-lib").moveTo;
  lineTo: typeof import("pdf-lib").lineTo;
  closePath: typeof import("pdf-lib").closePath;
  clip: typeof import("pdf-lib").clip;
  endPath: typeof import("pdf-lib").endPath;
}

/** Options accepted by {@link PdfExportService.exportPdf}. */
export interface PdfExportOptions {
  /**
   * Optional original PDF bytes to draw the edits onto. Each editor page is
   * matched to a source page via its `sourcePageIndex` (M6 page operations):
   * the pinned source page is copied in so its content is preserved, even after
   * insert/delete/duplicate/reorder (a duplicated page copies the same source
   * page twice). Pages with a null/out-of-range source index — blank inserted
   * pages, or pages whose source no longer has that page — get blank pages.
   * A page with an UNDEFINED `sourcePageIndex` (an in-memory state built
   * before M6) falls back to the page's array index, the pre-M6 mapping.
   */
  sourcePdfBytes?: Uint8Array;
}

/**
 * The export pipeline. Stateless beyond the per-call font cache, so a single
 * instance can be reused for many exports (DI registers it as a singleton,
 * matching the other editor services).
 */
export class PdfExportService {
  /**
   * Exports `state` to a PDF byte array. See the file header for the coordinate
   * mapping and the class JSDoc for the per-kind draw behavior.
   */
  async exportPdf(state: EditorState, options?: PdfExportOptions): Promise<Uint8Array> {
    const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath } = await import("pdf-lib");
    const lib: PdfLib = { PDFDocument, StandardFonts, rgb, degrees, BlendMode, pushGraphicsState, popGraphicsState, moveTo, lineTo, closePath, clip, endPath };

    const doc = await PDFDocument.create();
    const src = options?.sourcePdfBytes
      ? await PDFDocument.load(options.sourcePdfBytes)
      : null;
    const srcPageCount = src ? src.getPageCount() : 0;

    // Cache embedded fonts by StandardFonts value so each base font is embedded
    // at most once per export (re-embedding bloats the file and re-decodes
    // glyphs). The cache is per-call: a fresh export gets fresh fonts.
    const fontCache = new Map<StandardFonts, PDFFont>();
    const embedFont = async (font: StandardFonts): Promise<PDFFont> => {
      const cached = fontCache.get(font);
      if (cached) return cached;
      const embedded = await doc.embedFont(font);
      fontCache.set(font, embedded);
      return embedded;
    };

    for (let i = 0; i < state.document.pages.length; i++) {
      const editorPage = state.document.pages[i];
      const page = await this.addOrCreatePage(doc, src, i, srcPageCount, editorPage);
      // Editor page size is authoritative: copied pages are resized to match so
      // edits drawn in the editor's coordinate model land correctly. NOTE: this
      // assumes a (0,0) MediaBox origin, which holds for the overwhelming
      // majority of PDFs the editor opens; a non-zero origin is a documented
      // limitation (edits would be offset by that origin).
      page.setSize(editorPage.width, editorPage.height);
      if (editorPage.rotation !== 0) {
        page.setRotation(degrees(editorPage.rotation));
      }

      for (const obj of pageObjects(editorPage)) {
        if (!obj.visible) continue; // invisible objects don't render (still "handled")
        // Awaited in paint order so later objects draw on top of earlier ones
        // and so doc.save() below runs only after every draw has settled.
        // One bad object (e.g. text with glyphs a standard-14 font can't encode)
        // is skipped, not fatal — matching the image path's embedAndDrawImage
        // try/catch. This keeps a single unencodable character from aborting the
        // whole export (important now that Part 1 populates obj.text with
        // arbitrary Unicode extracted from existing PDFs).
        try {
          await this.drawObject(page, obj, editorPage.height, lib, embedFont);
        } catch (err) {
          // Surface in the console for debugging but never abort the export.
          console.error("editor export: skipping object", obj.id, err);
        }
      }
    }

    return doc.save();
  }

  /**
   * Resolves the source-page index editor page `i` maps to, or null for a
   * blank page. `sourcePageIndex === undefined` (a pre-M6 in-memory state)
   * falls back to the array index — the historical by-index mapping — while an
   * explicit null (blank inserted page) or an index the source PDF doesn't
   * have yields null (blank). Exported for direct unit testing.
   */
  static resolveSourcePageIndex(
    editorPage: EditorPage,
    i: number,
    srcPageCount: number,
  ): number | null {
    const pinned = editorPage.sourcePageIndex === undefined ? i : editorPage.sourcePageIndex;
    if (pinned === null || pinned < 0 || pinned >= srcPageCount) return null;
    return pinned;
  }

  /**
   * Returns the pdf-lib page for editor page `i`: a copy of its resolved
   * source page when available, otherwise a fresh blank page of the editor
   * page's size. `copyPages` is called per page (not batched), which pdf-lib
   * supports for repeated and out-of-order indices — a duplicated page copies
   * the same source page again as an independent page object. Async because
   * `copyPages` is async.
   */
  private async addOrCreatePage(
    doc: import("pdf-lib").PDFDocument,
    src: import("pdf-lib").PDFDocument | null,
    i: number,
    srcPageCount: number,
    editorPage: EditorPage,
  ): Promise<PDFPage> {
    const sourceIndex = PdfExportService.resolveSourcePageIndex(editorPage, i, srcPageCount);
    if (src && sourceIndex !== null) {
      const [copied] = await doc.copyPages(src, [sourceIndex]);
      return doc.addPage(copied);
    }
    return doc.addPage([editorPage.width, editorPage.height]);
  }

  /**
   * Dispatches an object to its kind-specific draw path. Every built-in kind is
   * handled concretely; plugin-registered kinds (EditorObject is the built-in
   * union plus `PluginEditorObject` with `kind: string`) fall through to the
   * final else — see the comment there. `isObjectKind` is used (not a plain
   * `switch (obj.kind)`) because it narrows out `PluginEditorObject`, whose
   * `kind: string` would otherwise stay in every branch and defeat the type
   * narrowing to the concrete object type.
   */
  private async drawObject(
    page: PDFPage,
    obj: EditorObject,
    pageHeight: number,
    lib: PdfLib,
    embedFont: (font: StandardFonts) => Promise<PDFFont>,
  ): Promise<void> {
    if (isObjectKind(obj, "text")) {
      await this.drawTextObject(page, obj, pageHeight, lib, embedFont);
    } else if (isObjectKind(obj, "image")) {
      await this.drawImageObject(page, obj, pageHeight, lib);
    } else if (isObjectKind(obj, "shape")) {
      this.drawShapeObject(page, obj, pageHeight, lib);
    } else if (isObjectKind(obj, "highlight")) {
      this.drawHighlightObject(page, obj, pageHeight, lib);
    } else if (isObjectKind(obj, "drawing")) {
      this.drawDrawingObject(page, obj, pageHeight, lib);
    } else if (isObjectKind(obj, "annotation")) {
      await this.drawAnnotationObject(page, obj, pageHeight, lib, embedFont);
    } else if (isObjectKind(obj, "signature")) {
      await this.drawSignatureObject(page, obj, pageHeight, lib);
    } else {
      // A plugin-registered kind (the EditorObject union includes
      // PluginEditorObject with `kind: string`). The core export pipeline has
      // no renderer for plugin kinds — they are drawn by the plugin's own
      // render extension on screen, and a PDF renderer for them would be a
      // future extension point. We intentionally do not throw, so one plugin
      // object can't abort a whole export; instead we emit nothing for it.
      // This is the only "no render" path, and it is limited to unknown plugin
      // kinds — every built-in kind above is handled concretely.
    }
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  private async drawTextObject(
    page: PDFPage,
    obj: TextObject,
    pageHeight: number,
    lib: PdfLib,
    embedFont: (font: StandardFonts) => Promise<PDFFont>,
  ): Promise<void> {
    // A READONLY imported run exports NOTHING. Export draws onto a copy of the
    // ORIGINAL source page, so the original glyphs are already in the output —
    // drawing a re-typeset copy over them is what produced duplicated visible
    // text and duplicated searchable text in the exported PDF. Skipping it
    // leaves the source page exactly as it was, which is the honest result for
    // text the editor cannot genuinely edit.
    //
    // The decision comes from the SHARED predicate the canvas renderer also
    // uses, so what the user sees and what they export cannot disagree. Only a
    // `replace` run draws: it carries an independently-probed background fill
    // that permanently removes the original glyphs before the replacement text
    // is drawn over them.
    if (!shouldDrawTextObject(obj)) return;

    const p = placementOf(obj);
    const { rgb, degrees } = lib;
    const font = await embedFont(resolveStandardFont(obj.fontFamily, obj.fontWeight).font);

    // An opaque text-frame background — for a replacement run this is the probed
    // page color that permanently removes the original glyphs. Drawn as the
    // ROTATED local box (same transform as the text), so it covers the original
    // glyph run (ascender + descender of the mapped base-14 font) for any
    // rotation — tight, so it doesn't white out neighboring content the way an
    // axis-aligned AABB would. Drawn before the text so the text sits on top.
    if (obj.background) {
      const bg = editorColorToRgb(obj.background);
      // A replacement's removal fill stays fully opaque regardless of object
      // opacity — a semi-transparent removal would leak the original through.
      const removalOpacity = obj.sourceText != null ? 1 : clamp01(obj.opacity * bg.a);
      page.drawRectangle({
        x: p.e,
        y: toPdfY(p.f, pageHeight),
        width: p.width * p.sx,
        height: -(p.height * p.sy),
        rotate: degrees(-p.rotationDeg),
        color: rgb(bg.r, bg.g, bg.b),
        opacity: removalOpacity,
      });
    }

    const fontSize = obj.fontSize;
    // Ascent (baseline-to-top) in LOCAL units — the y at which the first baseline
    // sits inside the object's local box, and the value the transform's
    // `T(0, −ascent)` shift must match for the baseline to land on the original.
    // For imported runs the transform was built with the mapped base-14 ascender
    // from `textMetrics`, so use the SAME value here (not pdf-lib's
    // `heightAtSize`) — they coincide for the base-14 families, and using the
    // shared module guarantees the transform, the on-screen render, and the
    // export agree by construction. For editor-authored text (no `sourceText`)
    // there is no `T(0, −ascent)` shift in the transform, so pdf-lib's own
    // ascender is fine (and is what M4 used).
    const ascent = obj.sourceText != null
      ? base14Ascent(obj.fontFamily, fontSize)
      : font.heightAtSize(fontSize, { descender: false });

    // Sanitize to WinAnsi so non-Latin glyphs (CJK/emoji common in extracted
    // existing text) don't make widthOfTextAtSize/drawText throw. '?' replaces
    // unencodable code points; the per-object try/catch is the final net.
    const safeText = winAnsiSafeText(obj.text);

    const { r, g, b, a } = editorColorToRgb(obj.color);

    // Draw line-by-line, each baseline anchored through the object transform —
    // the same contract the on-screen renderer uses (tspans split on "\n", first
    // baseline at `ascent`, subsequent baselines advancing by fontSize·lineHeight
    // in LOCAL units). transformPoint carries translation/rotation/scale, so an
    // extracted existing-text object (transform T(baseline)·R(θ)·T(0,−ascent))
    // redraws EXACTLY on the original baseline (the C1/C2 invariant).
    const lines = safeText.split("\n");
    const lineAdvance = fontSize * obj.lineHeight;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      // Horizontal alignment inside the local box, measured with the REAL
      // embedded font metrics (never an approximation).
      let xLocal = 0;
      if (obj.align !== "left") {
        const lineWidth = font.widthOfTextAtSize(line, fontSize);
        const slack = obj.localBounds.width - lineWidth;
        xLocal = obj.align === "center" ? slack / 2 : slack;
      }
      const world = transformPoint(obj.transform, {
        x: xLocal,
        y: ascent + i * lineAdvance,
      });
      page.drawText(line, {
        x: world.x,
        y: toPdfY(world.y, pageHeight),
        size: fontSize * Math.abs(p.sy),
        font,
        color: rgb(r, g, b),
        rotate: degrees(-p.rotationDeg),
        opacity: clamp01(obj.opacity * a),
      });
    }
  }

  
  // -------------------------------------------------------------------------
  // Image (+ crop)
  // -------------------------------------------------------------------------

  private async drawImageObject(
    page: PDFPage,
    obj: ImageObject,
    pageHeight: number,
    lib: PdfLib,
  ): Promise<void> {
    // Crop export (M6.11): pdf-lib cannot embed a sub-rectangle of a source
    // image, so a committed crop is exported as a vector CLIP around the
    // object's box while the FULL image is drawn scaled/offset so exactly the
    // crop region fills the box. Same math as the on-screen renderer
    // (cropDrawSpec is shared), resolution-independent, and the source image
    // bytes are never rewritten.
    await this.embedAndDrawImage(page, obj, obj.src, pageHeight, lib, obj.opacity, cropDrawSpec(obj));
  }

  private async drawSignatureObject(
    page: PDFPage,
    obj: SignatureObject,
    pageHeight: number,
    lib: PdfLib,
  ): Promise<void> {
    // A signature is a visual stamp (not cryptographic — mirrors `signPdf`).
    // `signer` is audit-trail metadata and has no visual representation here.
    //
    // It is LETTERBOXED inside its box, not stretched to fill it: distorting
    // someone's signature misrepresents it. The rect comes from the same
    // `fitContain` helper the on-screen renderer uses, so the two cannot drift
    // — before this, the canvas letterboxed while the export stretched, and a
    // signature came out of the exporter a different shape than the one the
    // user placed. Caught by `scripts/export-fidelity-probe.mts`.
    await this.embedAndDrawImage(page, obj, obj.src, pageHeight, lib, obj.opacity, null, {
      localRect: fitContain(obj.naturalWidth, obj.naturalHeight, obj.localBounds),
    });
  }

  /**
   * Embeds the data-URL image and draws it into the object's world bounds.
   * Returns silently (no throw) when the src is missing, unsupported, or
   * unreadable so one bad image can't abort the whole export.
   */
  private async embedAndDrawImage(
    page: PDFPage,
    obj: EditorObject,
    src: string,
    pageHeight: number,
    lib: PdfLib,
    opacity: number,
    crop?: CropDrawSpec | null,
    /**
     * Draw the image into this LOCAL rect instead of the object's whole local
     * box — used by signatures, which letterbox rather than stretch. Ignored
     * when `crop` is set (a crop already specifies its own local rect).
     */
    placement?: { localRect: Bounds } | null,
  ): Promise<void> {
    if (!src) return;
    const { degrees } = lib;
    const p = placementOf(obj);

    let parsed: ReturnType<typeof validateImageDataUrl>;
    try {
      parsed = validateImageDataUrl(src);
    } catch {
      return;
    }
    const { bytes, mime } = parsed;

    const doc = page.doc;
    let image: import("pdf-lib").PDFImage;
    try {
      if (mime === "image/png") image = await doc.embedPng(bytes);
      else if (mime === "image/jpeg") image = await doc.embedJpg(bytes);
      else return; // Non-PNG/JPEG data URLs can't be embedded by pdf-lib.
    } catch {
      // A corrupt or unreadable image shouldn't abort the whole export; the
      // object's bounds are still occupied, just left blank.
      return;
    }

    // ANCHOR: the world position of the drawn image's local BOTTOM-LEFT corner,
    // with a POSITIVE height. pdf-lib composes `translate(x,y)·rotate(θ)·
    // scale(w,h)` and paints the image into the unit square, so (x,y) is the
    // image's bottom-left in its own pre-rotation frame — unit (0,0).
    //
    // It is NOT the top-left with a negated height. PDF image space places
    // sample row 0 at unit y=1, so a negative height mirrors the rows about the
    // box's horizontal axis. That covers the SAME box, which is why the defect
    // survived: bounds, hit-testing, selection, and every mocked draw assertion
    // stayed correct while the pixels exported upside down. Verified by
    // rasterizing the output — see `scripts/export-fidelity-probe.mts`.
    if (crop) {
      const finiteCropGeometry = [
        crop.offset.x,
        crop.offset.y,
        crop.width,
        crop.height,
        ...crop.clipCorners.flatMap((point) => [point.x, point.y]),
      ].every((value) => Number.isFinite(value) && Math.abs(value) <= MAX_CROP_DRAW_COORDINATE);
      if (!finiteCropGeometry || crop.width <= 0 || crop.height <= 0) return;
      // Clip to the object's box (its world corners, already rotated), then
      // draw the FULL image offset/scaled so the crop region fills the box.
      const [c0, c1, c2, c3] = crop.clipCorners;
      page.pushOperators(
        lib.pushGraphicsState(),
        lib.moveTo(c0.x, toPdfY(c0.y, pageHeight)),
        lib.lineTo(c1.x, toPdfY(c1.y, pageHeight)),
        lib.lineTo(c2.x, toPdfY(c2.y, pageHeight)),
        lib.lineTo(c3.x, toPdfY(c3.y, pageHeight)),
        lib.closePath(),
        lib.clip(),
        lib.endPath(),
      );
      // The pop MUST run even if drawImage throws — exportPdf's per-object
      // try/catch would swallow the error and an unbalanced q/W would clip
      // every later object on the page.
      try {
        // The drawn (full) image occupies the local box
        // [offset, offset + crop.width/height]; its bottom-left is therefore
        // (offset.x, offset.y + crop.height). T_obj∘translate(offset) =
        // translate(T_obj(offset))·R·S, so anchoring on the transformed corner
        // with the object's own rotation is exact.
        const anchor = transformPoint(obj.transform, {
          x: crop.offset.x,
          y: crop.offset.y + crop.height,
        });
        page.drawImage(image, {
          x: anchor.x,
          y: toPdfY(anchor.y, pageHeight),
          width: crop.width * p.sx,
          height: crop.height * p.sy,
          rotate: degrees(-p.rotationDeg),
          opacity: clamp01(opacity),
        });
      } finally {
        page.pushOperators(lib.popGraphicsState());
      }
      return;
    }
    // The local rect the image fills: the whole local box by default, or the
    // caller's letterboxed rect. Same anchor rule either way — the rect's own
    // local BOTTOM-left corner, mapped through the object transform.
    const localRect = placement?.localRect ?? { x: 0, y: 0, width: p.width, height: p.height };
    if (!(localRect.width > 0) || !(localRect.height > 0)) return;
    const anchor = transformPoint(obj.transform, {
      x: localRect.x,
      y: localRect.y + localRect.height,
    });
    page.drawImage(image, {
      x: anchor.x,
      y: toPdfY(anchor.y, pageHeight),
      width: localRect.width * p.sx,
      height: localRect.height * p.sy,
      rotate: degrees(-p.rotationDeg),
      opacity: clamp01(opacity),
    });
  }

  // -------------------------------------------------------------------------
  // Shapes
  // -------------------------------------------------------------------------

  /**
   * Draws ANY {@link ShapeKind} from the canonical geometry module (M6). The
   * shape's LOCAL path data ({@link shapePathData}) is transformed into world
   * space with {@link transformPathData}, then handed to pdf-lib's
   * `drawSvgPath` at x=0, y=pageHeight, scale=1 — `drawSvgPath` applies its
   * built-in scale(1,-1) SVG-y-down→pdf-y-up flip, so a world point (wx, wy)
   * lands at pdf (wx, pageHeight − wy), exactly the editor→pdf mapping. Because
   * the SAME path source drives the on-screen `<path d>` and this export, the
   * two agree by construction for every kind, rotation, and (including
   * non-uniform) scale. Fill is omitted for open kinds; the optional dash +
   * drop shadow are approximated below.
   */
  private drawShapeObject(
    page: PDFPage,
    obj: ShapeObject,
    pageHeight: number,
    lib: PdfLib,
  ): void {
    const { rgb } = lib;
    const p = placementOf(obj);
    const closed = shapeIsClosed(obj);
    const localPath = shapePathData(obj);
    const worldPath = transformPathData(localPath, obj.transform);

    const fill = closed && obj.style.fill ? editorColorToRgb(obj.style.fill) : null;
    let stroke = obj.style.stroke ? editorColorToRgb(obj.style.stroke) : null;
    let strokeWidth = obj.style.strokeWidth;
    // Stroke-only kinds (line/connector/bezier/path/open-arrow) with no stroke
    // fall back to a visible 1px black stroke — the same rule the renderer uses,
    // so an unstyled line is never invisible in either output.
    if (!closed && !stroke) {
      stroke = { r: 0, g: 0, b: 0, a: 1 };
      strokeWidth = strokeWidth || 1;
    }
    const borderWidth = stroke ? Math.abs(strokeWidth * avgScale(p)) : 0;
    const dashArray =
      obj.style.dash && obj.style.dash.length > 0
        ? obj.style.dash.map((d) => Math.abs(d * avgScale(p)))
        : undefined;

    // Drop shadow (M6): pdf-lib has no blur, so the shadow is approximated as an
    // OFFSET DUPLICATE of the path at the shadow color/opacity, drawn first
    // (behind the shape). The blur radius is documented as not reproduced —
    // blur:0 exports exactly; a blurred shadow exports as a hard offset shadow.
    // The offset is applied in WORLD space so it matches the on-screen
    // feDropShadow's screen-space offset direction (both +y down).
    if (obj.style.shadow) {
      const sh = obj.style.shadow;
      const shColor = editorColorToRgb(sh.color);
      const shadowPath = transformPathData(localPath, {
        ...obj.transform,
        e: obj.transform.e + sh.offsetX,
        f: obj.transform.f + sh.offsetY,
      });
      page.drawSvgPath(shadowPath, {
        x: 0,
        y: pageHeight,
        scale: 1,
        color: closed ? rgb(shColor.r, shColor.g, shColor.b) : undefined,
        opacity: closed ? clamp01(obj.opacity * shColor.a) : undefined,
        borderColor: closed ? undefined : rgb(shColor.r, shColor.g, shColor.b),
        borderWidth: closed ? 0 : borderWidth,
        borderOpacity: closed ? undefined : clamp01(obj.opacity * shColor.a),
      });
    }

    page.drawSvgPath(worldPath, {
      x: 0,
      y: pageHeight,
      scale: 1,
      color: fill ? rgb(fill.r, fill.g, fill.b) : undefined,
      opacity: fill ? clamp01(obj.opacity * fill.a) : undefined,
      borderColor: stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth,
      borderOpacity: stroke ? clamp01(obj.opacity * stroke.a) : undefined,
      borderDashArray: dashArray,
    });
  }

  // -------------------------------------------------------------------------
  // Highlight
  // -------------------------------------------------------------------------

  private drawHighlightObject(
    page: PDFPage,
    obj: HighlightObject,
    pageHeight: number,
    lib: PdfLib,
  ): void {
    const p = placementOf(obj);
    const { rgb, degrees, BlendMode } = lib;
    const { r, g, b, a } = editorColorToRgb(obj.color);

    // A highlight is a translucent rectangle. pdf-lib DOES expose BlendMode, so
    // we use Multiply for the authentic marker-pen effect (the on-screen render
    // is also multiply); opacity carries the EditorColor alpha.
    page.drawRectangle({
      x: p.e,
      y: toPdfY(p.f, pageHeight),
      width: p.width * p.sx,
      height: -(p.height * p.sy),
      rotate: degrees(-p.rotationDeg),
      color: rgb(r, g, b),
      opacity: clamp01(obj.opacity * a),
      blendMode: BlendMode.Multiply,
    });
  }

  // -------------------------------------------------------------------------
  // Drawing (freehand polyline)
  // -------------------------------------------------------------------------

  private drawDrawingObject(
    page: PDFPage,
    obj: DrawingObject,
    pageHeight: number,
    lib: PdfLib,
  ): void {
    if (obj.points.length < 2) return;
    const { rgb, BlendMode } = lib;
    const p = placementOf(obj);
    const stroke = obj.style.stroke ? editorColorToRgb(obj.style.stroke) : { r: 0, g: 0, b: 0, a: 1 };

    // The SAME derivation the on-screen renderer uses (M6): smoothing, pressure
    // outline, brush opacity/blend, and the deterministic pencil jitter all come
    // from `deriveDrawingRender`, so the exported stroke matches the screen by
    // construction. The derived LOCAL path is transformed to world space and
    // drawn at x=0, y=pageHeight (see drawShapeObject for the mapping).
    const spec = deriveDrawingRender(obj);
    const worldPath = transformPathData(spec.pathData, obj.transform);
    const opacity = clamp01(obj.opacity * spec.opacityFactor * stroke.a);
    const blendMode = spec.blendMultiply ? BlendMode.Multiply : undefined;
    if (spec.mode === "fill") {
      // Pressure stroke: a closed variable-width outline FILLED with the color.
      page.drawSvgPath(worldPath, {
        x: 0,
        y: pageHeight,
        scale: 1,
        color: rgb(stroke.r, stroke.g, stroke.b),
        opacity,
        blendMode,
      });
      return;
    }
    page.drawSvgPath(worldPath, {
      x: 0,
      y: pageHeight,
      scale: 1,
      borderColor: rgb(stroke.r, stroke.g, stroke.b),
      borderWidth: Math.abs(spec.strokeWidth * avgScale(p)),
      borderOpacity: opacity,
      blendMode,
    });
  }

  // -------------------------------------------------------------------------
  // Annotation (note text + optional pointer)
  // -------------------------------------------------------------------------

  private async drawAnnotationObject(
    page: PDFPage,
    obj: AnnotationObject,
    pageHeight: number,
    lib: PdfLib,
    embedFont: (font: StandardFonts) => Promise<PDFFont>,
  ): Promise<void> {
    const p = placementOf(obj);
    const { rgb, degrees } = lib;
    // Annotations have no family/weight/align in the model; render as Helvetica,
    // left-aligned, 1.2 line height (a neutral default consistent with the note
    // tool's on-screen look).
    const font = await embedFont("Helvetica" as StandardFonts);
    const { r, g, b, a } = editorColorToRgb(obj.color);

    /*
     * THE NOTE PANEL, first, so the text sits on top of it.
     *
     * Drawn from the SAME local path {@link annotationPanel} hands the canvas
     * renderer, transformed to world space by the same `transformPathData` the
     * shape exporter uses — so a rotated or scaled note exports as the panel it
     * looks like, and the two renderers cannot drift apart again. Before this,
     * the exporter drew no panel at all: a yellow sticky note exported as
     * floating text, which is the defect this phase exists to close.
     */
    const panel = annotationPanel(obj);
    if (panel) {
      const worldPath = transformPathData(panel.pathData, obj.transform);
      const bg = panel.background ? editorColorToRgb(panel.background) : null;
      const bd = panel.border ? editorColorToRgb(panel.border) : null;
      page.drawSvgPath(worldPath, {
        x: 0,
        y: pageHeight,
        scale: 1,
        color: bg ? rgb(bg.r, bg.g, bg.b) : undefined,
        opacity: bg ? clamp01(obj.opacity * bg.a) : undefined,
        borderColor: bd ? rgb(bd.r, bd.g, bd.b) : undefined,
        borderWidth: bd ? Math.abs(panel.borderWidth * avgScale(p)) : 0,
        borderOpacity: bd ? clamp01(obj.opacity * bd.a) : undefined,
      });
    }

    /*
     * The first baseline sits `firstLineTop + ascent` below the note's local
     * origin — the text is INSET inside the panel, exactly as the canvas insets
     * it. It used to be placed at y=ascent with x=0, i.e. flush against the
     * top-left corner, so canvas and export disagreed by the padding even in the
     * cases where both drew something.
     */
    const layout = annotationTextLayout(obj);
    const ascent = font.heightAtSize(obj.fontSize, { descender: false });
    const baselineWorld = transformPoint(obj.transform, {
      x: layout.x,
      y: layout.firstLineTop + ascent,
    });
    // Sanitize to WinAnsi (same rationale as text — annotation text may carry
    // non-Latin glyphs the standard font can't encode).
    const safeText = winAnsiSafeText(obj.text);

    page.drawText(safeText, {
      x: baselineWorld.x,
      y: toPdfY(baselineWorld.y, pageHeight),
      size: obj.fontSize * Math.abs(p.sy),
      font,
      color: rgb(r, g, b),
      rotate: degrees(-p.rotationDeg),
      opacity: clamp01(obj.opacity * a),
      lineHeight: layout.lineAdvance * Math.abs(p.sy),
    });

    if (obj.pointerTarget) {
      // Pointer from the note's local origin to the target, both in world space.
      const from = transformPoint(obj.transform, { x: 0, y: 0 });
      const to = transformPoint(obj.transform, obj.pointerTarget);
      page.drawLine({
        start: { x: from.x, y: toPdfY(from.y, pageHeight) },
        end: { x: to.x, y: toPdfY(to.y, pageHeight) },
        thickness: Math.max(1, Math.abs(avgScale(p))),
        color: rgb(r, g, b),
        opacity: clamp01(obj.opacity * a),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Small shared utilities.
// ---------------------------------------------------------------------------

/**
 * The effective uniform scale used for stroke widths. Strictly, a stroke width
 * scales with the component along the stroke direction, but pdf-lib strokes are
 * isotropic; the average of |sx| and |sy| is the honest best-fit for non-uniform
 * scales and exact for uniform scales (the common case).
 */
function avgScale(p: Placement): number {
  return (Math.abs(p.sx) + Math.abs(p.sy)) / 2;
}

