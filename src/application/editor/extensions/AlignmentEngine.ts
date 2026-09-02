import { boundsCenter, unionBounds, type Bounds, type Vec2 } from "@/src/domain/editor/geometry";
import type { AlignmentSuggestion, IAlignmentEngine } from "./Extensions";

/**
 * Smart alignment — Part 4 of the editor foundation.
 *
 * Given a selection's world {@link Bounds}, the engine derives the six canonical
 * alignment lines (left, right, top, bottom, centerX, centerY) of the selection's
 * *union* bounds. The Properties panel turns a chosen line into concrete per-object
 * move deltas via {@link alignToEdge}, or spaces objects evenly via
 * {@link distributeObjects}. Everything here is pure: no mutation, no state, no
 * DOM — the headless core the UI binds to.
 */

/** Re-export of the alignment-target union so callers don't depend on Extensions.ts. */
export type AlignmentTarget = AlignmentSuggestion["target"];

/**
 * Suggests alignment lines derived from the selection's own union bounds. With
 * fewer than two objects there is nothing meaningful to align (a single object's
 * edges already match its union), so an empty list is returned. The returned
 * positions describe where the selection's edges/center already sit in page
 * space — the UI uses them to snap to or confirm an alignment target.
 */
export class SmartAlignmentEngine implements IAlignmentEngine {
  suggestions(selectionBounds: Bounds[]): AlignmentSuggestion[] {
    if (selectionBounds.length < 2) return [];
    const union = selectionBounds.reduce(unionBounds);
    const center = boundsCenter(union);
    return [
      { target: "left", position: union.x },
      { target: "right", position: union.x + union.width },
      { target: "top", position: union.y },
      { target: "bottom", position: union.y + union.height },
      { target: "centerX", position: center.x },
      { target: "centerY", position: center.y },
    ];
  }
}

/**
 * Computes, for each object's bounds, the page-space move delta that aligns the
 * corresponding edge/center to the selection *union's* matching edge/center.
 * `"left"` lines every object's left edge up with the union left; `"centerX"`
 * lines every object's horizontal center up with the union center; and so on.
 * Returns one delta per input bounds, in input order. An empty input yields an
 * empty result; a single object aligns to itself (a zero delta).
 */
export function alignToEdge(objBounds: Bounds[], edge: AlignmentTarget): Vec2[] {
  if (objBounds.length === 0) return [];
  const union = objBounds.reduce(unionBounds);
  const center = boundsCenter(union);
  const horizontal = edge === "left" || edge === "right" || edge === "centerX";
  const target =
    edge === "left"
      ? union.x
      : edge === "right"
        ? union.x + union.width
        : edge === "top"
          ? union.y
          : edge === "bottom"
            ? union.y + union.height
            : edge === "centerX"
              ? center.x
              : center.y; // centerY
  return objBounds.map((b) => {
    const current =
      edge === "left"
        ? b.x
        : edge === "right"
          ? b.x + b.width
          : edge === "top"
            ? b.y
            : edge === "bottom"
              ? b.y + b.height
              : edge === "centerX"
                ? b.x + b.width / 2
                : b.y + b.height / 2; // centerY
    const delta = target - current;
    return horizontal ? { x: delta, y: 0 } : { x: 0, y: delta };
  });
}

/**
 * Distributes the objects evenly along an axis — equal gaps between successive
 * objects, anchored at the union bounds' start and end (so the leftmost/topmost
 * and rightmost/bottommost objects keep their positions). Objects are sorted by
 * the axis coordinate before spacing is computed, but the returned deltas are
 * re-ordered back to the **original input order**. With fewer than three
 * objects there is no interior gap to tune, so a list of zero deltas is returned
 * (one per input bounds).
 */
export function distributeObjects(objBounds: Bounds[], axis: "horizontal" | "vertical"): Vec2[] {
  const n = objBounds.length;
  // Pre-allocated, zero-initialized result; filled in below for n >= 3.
  const deltas: Vec2[] = objBounds.map(() => ({ x: 0, y: 0 }));
  if (n < 3) return deltas;

  const union = objBounds.reduce(unionBounds);
  const isHorizontal = axis === "horizontal";
  const sizeKey = isHorizontal ? "width" : "height";
  const span = isHorizontal ? union.width : union.height;
  const origin = isHorizontal ? union.x : union.y;

  // Pairs of (bounds, originalIndex) sorted by the axis coordinate (stable: the
  // comparator never returns 0 for distinct indices, so input order wins ties).
  const indexed = objBounds.map((b, i) => ({ b, i }));
  indexed.sort((a, z) => (isHorizontal ? a.b.x - z.b.x : a.b.y - z.b.y));

  const totalSize = indexed.reduce((sum, e) => sum + e.b[sizeKey], 0);
  const gap = (span - totalSize) / (n - 1);

  let cursor = origin;
  for (const { b, i } of indexed) {
    const currentLeft = isHorizontal ? b.x : b.y;
    const delta = cursor - currentLeft;
    deltas[i] = isHorizontal ? { x: delta, y: 0 } : { x: 0, y: delta };
    cursor += b[sizeKey] + gap;
  }
  return deltas;
}
