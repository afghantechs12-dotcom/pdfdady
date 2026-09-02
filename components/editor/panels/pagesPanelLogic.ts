/**
 * Pure logic for the Pages panel (M6): the multi-select reducer (click /
 * Ctrl+click / Shift+click semantics) and the drag-to-reorder target-index
 * math. Extracted from the component so both are unit-testable in Node; the
 * PagesPanel component stays a thin event-wiring layer over these.
 */

/** The panel-local page selection: ids + the Shift-range anchor. */
export interface PagesSelection {
  /** Selected page ids (kept in document page order by the reducer). */
  ids: string[];
  /** The range anchor for Shift+click, or null when nothing is selected. */
  anchorId: string | null;
}

/** The empty selection. */
export const EMPTY_PAGES_SELECTION: PagesSelection = { ids: [], anchorId: null };

/**
 * Drops ids that no longer exist (deleted pages) and re-sorts the survivors
 * into document order. The anchor falls back to the last surviving id.
 */
export function normalizePagesSelection(sel: PagesSelection, pageIds: string[]): PagesSelection {
  const present = new Set(pageIds);
  const ids = pageIds.filter((id) => sel.ids.includes(id) && present.has(id));
  if (ids.length === sel.ids.length && sel.anchorId !== null && present.has(sel.anchorId)) {
    // Fast path: nothing dropped and the anchor is valid — but the order may
    // still have changed after a reorder, so return the re-sorted ids.
    return { ids, anchorId: sel.anchorId };
  }
  const anchorId = sel.anchorId !== null && present.has(sel.anchorId) && ids.includes(sel.anchorId)
    ? sel.anchorId
    : ids[ids.length - 1] ?? null;
  return { ids, anchorId };
}

/**
 * The click reducer. Semantics (matching every pro design tool):
 *  - plain click: select only the clicked page; it becomes the anchor.
 *  - Ctrl/Cmd+click: toggle the clicked page. Toggling ON makes it the anchor;
 *    toggling OFF moves the anchor to the last remaining selected page.
 *  - Shift+click: select the contiguous range between the anchor and the
 *    clicked page (in document order); the anchor is kept so a further
 *    Shift+click re-ranges from the same anchor. Without an anchor it behaves
 *    like a plain click.
 * Ids are always returned in document page order. Unknown ids are ignored.
 */
export function reducePageClick(
  sel: PagesSelection,
  pageIds: string[],
  clickedId: string,
  mods: { ctrl?: boolean; shift?: boolean } = {},
): PagesSelection {
  if (!pageIds.includes(clickedId)) return normalizePagesSelection(sel, pageIds);
  const current = normalizePagesSelection(sel, pageIds);

  if (mods.shift && current.anchorId !== null) {
    const a = pageIds.indexOf(current.anchorId);
    const b = pageIds.indexOf(clickedId);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { ids: pageIds.slice(lo, hi + 1), anchorId: current.anchorId };
  }

  if (mods.ctrl) {
    if (current.ids.includes(clickedId)) {
      const ids = current.ids.filter((id) => id !== clickedId);
      const anchorId =
        current.anchorId === clickedId ? ids[ids.length - 1] ?? null : current.anchorId;
      return { ids, anchorId };
    }
    const ids = pageIds.filter((id) => current.ids.includes(id) || id === clickedId);
    return { ids, anchorId: clickedId };
  }

  return { ids: [clickedId], anchorId: clickedId };
}

/** A measured list item: its top edge and height, in any shared unit (px). */
export interface MeasuredItem {
  top: number;
  height: number;
}

/**
 * The insertion slot for a drag at `pointerY` over vertically stacked items:
 * the number of items whose vertical midpoint is above the pointer. Result is
 * in [0, items.length] — 0 means "before the first item", items.length means
 * "after the last". Items are assumed sorted by `top` (a vertical list).
 */
export function insertionIndexFromPointer(pointerY: number, items: MeasuredItem[]): number {
  let index = 0;
  for (const item of items) {
    if (item.top + item.height / 2 <= pointerY) index++;
  }
  return index;
}

/**
 * Converts an insertion slot (0..n, in the ORIGINAL list) for the item
 * currently at `fromIndex` into the final index to pass to `movePage` (the
 * index after the item is removed from its old position). Dropping into the
 * item's own slot (or the slot right after it) is the identity move.
 */
export function moveTargetIndex(fromIndex: number, insertionIndex: number): number {
  if (insertionIndex === fromIndex || insertionIndex === fromIndex + 1) return fromIndex;
  return insertionIndex > fromIndex ? insertionIndex - 1 : insertionIndex;
}
