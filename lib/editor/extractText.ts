import type { PDFPageProxy } from "pdfjs-dist";
import {
  compose,
  makeBounds,
  makeRotate,
  makeTranslate,
} from "@/src/domain/editor/geometry";
import { createTextObject } from "@/src/domain/editor/objectFactories";
import type { TextObject } from "@/src/domain/editor/objects";
import {
  groupTextItemsIntoLines,
  mapFontToBaseFamily,
  type RawTextItem,
} from "@/src/application/editor/text/TextExtraction";
import {
  assessImportedTextCapability,
  UNKNOWN_SOURCE_TEXT_FACTS,
  type ImportedTextEditMode,
} from "@/src/domain/editor/sourceText";

/**
 * The PDF.js adapter for existing-text extraction.
 *
 * {@link TextExtraction.groupTextItemsIntoLines} is the pure, PDF.js-free core
 * (line grouping + geometry); this module is the thin client-side adapter that
 * pulls a `TextContent` from a PDF.js page, normalizes it into
 * {@link RawTextItem}s, runs the grouping, and builds a READONLY source-text
 * reference for each line.
 *
 * WHAT CHANGED AND WHY. This adapter used to emit fully editable `TextObject`s
 * with an opaque white `background` covering the original. That produced the
 * duplication defect: the original text still rendered (it is baked into the
 * page raster and lives in the exported source page), the copy was re-typeset
 * in a base-14 font so it never aligned exactly, and moving or deleting the copy
 * revealed the original underneath. The white cover also destroyed table rules
 * and images behind the run.
 *
 * Now each line becomes a NON-RENDERING hit region: `sourceText.mode` is
 * `readonly`, `background` is `null`, and both the canvas renderer and the PDF
 * exporter skip drawing it (see `ObjectRenderer` and `PdfExportService`). The
 * original PDF text is the single visible representation. The object still
 * exists so the run is selectable, inspectable, and copyable.
 *
 * Capability is decided by the PURE {@link assessImportedTextCapability}, fed
 * facts this adapter can actually establish. PDF.js `getTextContent()` reports
 * strings, transforms, and advance widths — it does NOT report content-stream
 * operator offsets, embedded-font handles, or encoding tables. So
 * `hasOperatorMapping` is false and `direct` mode is unreachable through this
 * path; that is an honest limitation of the pdf-lib/PDF.js stack, not a
 * placeholder. Nothing here probes page backgrounds either, so `replace` is not
 * offered at import time.
 *
 * The transform for each line is still `T(baseline) · R(θ) · T(0, −ascent)`
 * with `ascent` from the MAPPED base-14 font, and the local box is
 * `makeBounds(0, 0, advance, ascent + descent)`. That geometry stays exact
 * because it is what selection hit-testing draws against, and it is what a
 * future replacement would redact against.
 */

/**
 * The capability facts this adapter can establish from a PDF.js text run.
 *
 * Everything PDF.js does not tell us stays at its {@link UNKNOWN_SOURCE_TEXT_FACTS}
 * value, which disqualifies editing. `boundsTrustworthy` is the one fact we can
 * assert: the line grouping produced a real baseline origin and advance from the
 * item transforms, which is the geometry selection and redaction would use.
 */
function factsForExtractedLine(rotation: number) {
  return {
    ...UNKNOWN_SOURCE_TEXT_FACTS,
    writingMode: "horizontal" as const,
    rotation,
    boundsTrustworthy: true,
  };
}

export interface ExtractTextOptions {
  /** The page width in points (at scale 1) — from the PDF.js viewport. */
  pageWidth: number;
  /** The page height in points (at scale 1) — used to flip PDF y to screen y. */
  pageHeight: number;
  /** The layer id to place the created text objects on. */
  layerId: string;
  /**
   * Optional cap on the number of lines extracted per page, as a safety bound
   * for pathological PDFs with huge text-content streams. Defaults to 2000.
   */
  maxLines?: number;
  /**
   * Optional cap on the number of RAW text items read from the page before
   * grouping. This bounds the CPU/memory of the (synchronous) grouping step —
   * `maxLines` alone bounds only the OUTPUT, not the work. Defaults to 50000.
   */
  maxRawItems?: number;
}

/**
 * Extracts existing text from a PDF.js page and returns a READONLY source-text
 * reference per detected line. Never throws — a failed extraction returns `[]`
 * so the "Open PDF" flow still opens the document (the background raster, which
 * carries the visible original text, is independent).
 *
 * The returned objects do NOT render (see `ObjectRenderer`) and are NOT exported
 * (see `PdfExportService`). They exist so the user can select a run, see what it
 * says, copy it, and be told plainly that it is part of the original PDF. The
 * original text on the page stays the one visible copy.
 *
 * Font, color, and exact metrics remain best-effort (PDF.js font names are often
 * opaque ids and it does not expose fill color stably) — which is precisely why
 * the extracted run is not treated as an editable reproduction of the original.
 *
 * Resource bounds: raw items are capped (`maxRawItems`, default 50000) BEFORE
 * grouping, and grouping caps items-per-line + per-line text length, so a
 * crafted page with a pathologically large text-content stream can't freeze the
 * tab or exhaust memory. Items beyond the caps are dropped (documented
 * truncation, never a crash).
 */
/**
 * The shape of `page.getTextContent()`, derived from the method's return type
 * rather than imported by name. pdfjs-dist's main types entry re-exports only a
 * curated set of types (PDFPageProxy, etc.) and does NOT export `TextContent`,
 * so deriving it from the method keeps this adapter version-robust (the
 * inferred type tracks whatever `getTextContent` returns) without `any`.
 */
type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

export async function extractTextObjects(
  page: PDFPageProxy,
  options: ExtractTextOptions,
): Promise<TextObject[]> {
  let content: TextContent;
  try {
    content = await page.getTextContent();
  } catch {
    return [];
  }

  const maxRawItems = options.maxRawItems ?? 50_000;
  const items: RawTextItem[] = [];
  // Cap raw items BEFORE grouping: `maxLines` only bounds the output, not the
  // (synchronous) grouping work, so without this a crafted page emitting
  // millions of text items would freeze the tab before the line cap applied.
  for (const raw of content.items) {
    if (items.length >= maxRawItems) break;
    // TextMarkedContent entries have no `str`; only TextItem does. A real
    // TextItem carries `str`, a 6-element `transform`, and `width` (PDF.js also
    // reports `height`, but that is the text-matrix vertical scale = the font
    // size, not the ascender — vertical metrics come from `textMetrics`, so it
    // is not carried on RawTextItem).
    if (typeof (raw as { str?: unknown }).str !== "string") continue;
    const item = raw as {
      str: string;
      transform: number[];
      width: number;
      fontName?: string;
    };
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6) continue;
    items.push({
      str: item.str,
      transform: [t[0], t[1], t[2], t[3], t[4], t[5]],
      width: item.width,
      fontName: item.fontName,
    });
  }

  // The pure core needs only pageHeight (to flip PDF y → screen y); pageWidth
  // is adapter-level context kept on ExtractTextOptions for future column/block
  // layout, not consumed by grouping today.
  const lines = groupTextItemsIntoLines(items, options.pageHeight);
  const cap = options.maxLines ?? 2000;
  const objects: TextObject[] = [];
  for (const line of lines.slice(0, cap)) {
    const { fontFamily, fontWeight } = mapFontToBaseFamily(line.fontName);
    const rad = (line.rotation * Math.PI) / 180;
    // The redaction box = ascender + descender of the mapped base-14 font, so it
    // covers the original glyph run (top of ascender to bottom of descender).
    const boxHeight = line.ascent + line.descent;
    // T(baseline) · R(θ) · T(0, −ascent): with `ascent` = the mapped base-14
    // ascender (shared with the render/export baseline anchor via `textMetrics`),
    // the first baseline lands on the original baseline for any rotation.
    const transform = compose(
      makeTranslate(line.baselineX, line.baselineY),
      compose(makeRotate(rad), makeTranslate(0, -line.ascent)),
    );
    const capability = assessImportedTextCapability(factsForExtractedLine(line.rotation));
    const obj = createTextObject(
      { x: 0, y: 0 }, // position is encoded entirely in the transform below
      options.layerId,
      {
        text: line.text,
        fontSize: line.fontSize,
        fontFamily,
        fontWeight,
        color: line.color,
        align: "left",
        lineHeight: 1.2,
        // No background. The old white "redaction" fill was the mask that made
        // the duplication visible (and destroyed table rules behind the run).
        // A readonly run draws nothing at all, so there is nothing to mask.
        background: null,
        sourceText: {
          fontName: line.fontName,
          rotation: line.rotation,
          mode: capability.mode as ImportedTextEditMode,
          reason: capability.reason,
          originalText: line.text,
        },
        // Deliberately NOT locked: a readonly run must stay selectable so the
        // user can click it, read what it says, copy it, and be told why it
        // cannot be edited. Locking would make it invisible to hit-testing and
        // the user would get no explanation at all. It is safe to leave
        // unlocked because the run does not render — dragging it moves an
        // invisible hit region, and the original PDF text never moves.
        name: line.text.slice(0, 24) || "Original PDF text",
        localBounds: makeBounds(0, 0, line.advance, boxHeight),
        transform,
      },
    );
    objects.push(obj);
  }
  return objects;
}
