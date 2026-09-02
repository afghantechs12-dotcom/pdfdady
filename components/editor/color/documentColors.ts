import { pageObjects } from "@/src/domain/editor/document";
import type { EditorDocument } from "@/src/domain/editor/document";
import type { EditorColor, EditorObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { uniqueSwatches } from "@/src/domain/editor/colorModel";

/**
 * The colours ALREADY IN THE DOCUMENT, offered as swatches.
 *
 * This is the row that makes a colour popover feel like it belongs to the
 * document rather than to the browser: matching an existing accent is the single
 * most common colour task in a real edit, and doing it by re-typing a hex from
 * memory is how documents end up with four almost-identical purples.
 *
 * Every colour-bearing field of every kind is collected — fill, stroke, shadow,
 * text colour, text background, highlight, drawing stroke, annotation. Ordering
 * is document order (page order, then layer stack order), which is stable across
 * calls, so the swatch a user aimed at does not move between openings.
 */
function objectColors(obj: EditorObject): EditorColor[] {
  const out: EditorColor[] = [];
  if (isObjectKind(obj, "text")) {
    out.push(obj.color);
    if (obj.background) out.push(obj.background);
  } else if (isObjectKind(obj, "shape")) {
    if (obj.style.fill) out.push(obj.style.fill);
    if (obj.style.stroke) out.push(obj.style.stroke);
    if (obj.style.shadow) out.push(obj.style.shadow.color);
  } else if (isObjectKind(obj, "highlight")) {
    out.push(obj.color);
  } else if (isObjectKind(obj, "drawing")) {
    if (obj.style.stroke) out.push(obj.style.stroke);
  } else if (isObjectKind(obj, "annotation")) {
    out.push(obj.color);
  }
  // Images and signatures carry no author-chosen colour. A plugin object's
  // colours are unknown to the core, so it contributes none rather than
  // guessing at an arbitrary field name.
  return out;
}

/**
 * Collect the document's palette, de-duplicated and capped by `uniqueSwatches`.
 *
 * `limit` caps the ROW, not the walk: a 500-page document still walks fully, so
 * the result is deterministic rather than "whatever the first N pages had". The
 * walk is O(objects) over plain records with no allocation per page, which is
 * cheap enough to run when the popover opens; it is deliberately not memoised,
 * because a stale palette that omits the colour you just used is worse than a
 * few hundred microseconds.
 */
export function collectDocumentColors(doc: EditorDocument, limit?: number): EditorColor[] {
  const colors: EditorColor[] = [];
  for (const page of doc.pages) {
    // Paint order rather than `Object.values`, so the palette order matches
    // what the user sees stacked on the page. `pageObjects` is the canonical
    // walk (it also skips ids orphaned by a layer edit).
    for (const obj of pageObjects(page)) {
      colors.push(...objectColors(obj));
    }
  }
  return uniqueSwatches(colors, limit);
}
