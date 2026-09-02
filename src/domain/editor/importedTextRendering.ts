/**
 * The single authority on whether an imported text run is DRAWN.
 *
 * WHY THIS IS SHARED. The duplication defect existed because three layers each
 * decided independently what to paint: the canvas drew a re-typeset copy, the
 * exporter drew another one onto a page that already contained the original, and
 * the page raster carried the original underneath both. Any two of those
 * disagreeing produces a visible double.
 *
 * So the rule lives here, in one pure function, and both `ObjectRenderer` (SVG)
 * and `PdfExportService` (pdf-lib) call it. They cannot drift, because there is
 * only one decision to drift from — and it is unit-testable without a DOM or a
 * PDF toolchain.
 *
 * THE RULE. Exactly one visible representation per imported run:
 *
 *  - `readonly` → the ORIGINAL is the visible copy. We draw nothing.
 *  - `replace`  → the original is permanently removed by the run's own removal
 *                 fill, and the replacement is the visible copy. We draw it.
 *  - `direct`   → the original operator itself was rewritten, so the page
 *                 already shows the edit. We draw nothing on top of it.
 *  - not imported (editor-authored text) → always drawn; this module has no
 *                 opinion about text the user created.
 */

import type { TextObject } from "@/src/domain/editor/objects";

/**
 * True when this text object should be painted by the canvas and the exporter.
 *
 * Deliberately independent of selection, focus, hover, and edit state: a run
 * that draws only while deselected (or only while selected) is exactly the
 * "duplicate appears when you click it" behavior this replaces. Visibility of an
 * imported run is a property of the DOCUMENT, not of the interaction.
 */
export function shouldDrawTextObject(obj: TextObject): boolean {
  const source = obj.sourceText;
  if (source == null) return true; // editor-authored text
  return source.mode === "replace";
}

/**
 * True when the object is an imported run the user may not edit — the case the
 * UI must explain rather than silently disable.
 */
export function isReadonlySourceText(obj: TextObject): boolean {
  const source = obj.sourceText;
  return source != null && source.mode !== "replace";
}
