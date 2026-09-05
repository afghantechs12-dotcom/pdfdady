/**
 * Shape-tool creation geometry — the pure rules behind a box-drag.
 *
 * WHY THIS EXISTS. The canvas used to compute a shape's committed size inline
 * with a local `DEFAULT_SHAPE_SIZE = 100` constant as the scale divisor, while
 * the object factories default a shape's `localBounds` to 120×120 and a
 * highlight's to 160×28. Nothing connected the two numbers, so every committed
 * shape was scaled by `factoryExtent / 100`:
 *
 *   drag a 119×101 rectangle  ->  commit a 143×121 object   (120 × 1.19)
 *   drag any highlight        ->  1.6× too wide, 0.28× too tall
 *
 * Measured in a real browser, at every zoom. "The visual pointer rectangle and
 * the resulting model coordinates must agree" is not something a constant in the
 * consumer can promise about a default in the producer — so the scale is derived
 * from the object's ACTUAL bounds, and the divisor cannot drift from the factory
 * again.
 *
 * Everything here is pure arithmetic: no DOM, no services, no React. The canvas
 * supplies the two pointer positions and the real base bounds; this module
 * decides click-vs-drag, the default size, page clamping, and the final scale.
 */

import { makeBounds, type Bounds, type Point } from "@/src/domain/editor/geometry";

/**
 * Minimum pointer travel (page units) before a gesture counts as a drag.
 *
 * Below this the user gets a default-size shape at the press point rather than
 * nothing: a 3px twitch during a click is the single most common way to produce
 * an invisible 3×3 object, and "the tool did nothing" is the complaint this
 * whole repair exists to remove. Mirrors `TEXT_DRAG_THRESHOLD`'s intent.
 */
export const SHAPE_DRAG_THRESHOLD = 6;

/** Fraction of the smaller page dimension a click-placed shape spans. */
export const SHAPE_DEFAULT_FRACTION = 0.18;

/** Absolute bounds (page units) for a click-placed shape's size. */
export const SHAPE_DEFAULT_MIN = 48;
export const SHAPE_DEFAULT_MAX = 180;

/** Smallest committed extent on either axis, so no shape is invisible. */
export const SHAPE_MIN_EXTENT = 4;

export interface PageSize {
  width: number;
  height: number;
}

/** True when the pointer moved far enough to mean "drag me a box". */
export function isShapeDrag(from: Point, to: Point, threshold = SHAPE_DRAG_THRESHOLD): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= threshold;
}

/**
 * The size a click-placed (not dragged) shape should have on this page: a
 * fraction of the page's smaller dimension, clamped to a legible range, and
 * never larger than the page itself.
 */
export function defaultShapeSize(page: PageSize): number {
  const shorter = Math.min(page.width, page.height);
  if (!Number.isFinite(shorter) || shorter <= 0) return SHAPE_DEFAULT_MIN;
  const ideal = shorter * SHAPE_DEFAULT_FRACTION;
  const clamped = Math.min(SHAPE_DEFAULT_MAX, Math.max(SHAPE_DEFAULT_MIN, ideal));
  // A page smaller than the floor still gets something that fits on it.
  return Math.min(clamped, shorter);
}

/**
 * True when a point lies on the page surface. The shape tools refuse to start a
 * gesture off-page: an object created in the surrounding gray workspace is not
 * on any page, cannot be exported, and reads as a bug.
 */
export function isPointOnPage(p: Point, page: PageSize): boolean {
  return (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x <= page.width &&
    p.y <= page.height
  );
}

/** Clamps a point onto the page, so a drag leaving the page stops at its edge. */
export function clampToPage(p: Point, page: PageSize): Point {
  return {
    x: Math.min(Math.max(p.x, 0), Math.max(0, page.width)),
    y: Math.min(Math.max(p.y, 0), Math.max(0, page.height)),
  };
}

/**
 * The normalized page-space rectangle a drag describes: origin at the top-left
 * corner regardless of drag direction, both ends clamped onto the page, and a
 * floor on each extent so a fast flick cannot commit a zero-area object.
 */
export function shapeDragBounds(from: Point, to: Point, page: PageSize): Bounds {
  const a = clampToPage(from, page);
  const b = clampToPage(to, page);
  const width = Math.min(page.width, Math.max(Math.abs(b.x - a.x), SHAPE_MIN_EXTENT));
  const height = Math.min(page.height, Math.max(Math.abs(b.y - a.y), SHAPE_MIN_EXTENT));
  const x = Math.min(Math.min(a.x, b.x), page.width - width);
  const y = Math.min(Math.min(a.y, b.y), page.height - height);
  return makeBounds(x, y, width, height);
}

/**
 * Where a click-placed shape of `size` goes: centred on the click, pulled back
 * inside the page. Centring (rather than growing down-right like text) is what
 * makes a single click feel like "put one here" — the shape appears under the
 * cursor, not beside it.
 */
export function shapeClickBounds(at: Point, size: number, page: PageSize): Bounds {
  const w = Math.min(size, Math.max(SHAPE_MIN_EXTENT, page.width));
  const h = Math.min(size, Math.max(SHAPE_MIN_EXTENT, page.height));
  return makeBounds(
    clampAxis(at.x - w / 2, w, page.width),
    clampAxis(at.y - h / 2, h, page.height),
    w,
    h,
  );
}

/**
 * The scale factors that turn an object's OWN base bounds into `target`.
 *
 * This is the fix for the 1.2× defect: the divisor is the real
 * `localBounds` of the object being created, read from the object itself, so a
 * factory changing its default cannot silently resize every shape the user
 * draws. A degenerate base extent yields scale 1 rather than Infinity/NaN.
 */
export function scaleToBounds(base: Bounds, target: Bounds): { sx: number; sy: number } {
  return {
    sx: base.width > 0 ? target.width / base.width : 1,
    sy: base.height > 0 ? target.height / base.height : 1,
  };
}

/** Keeps `[start, start + size]` inside `[0, extent]`, without going negative. */
function clampAxis(start: number, size: number, extent: number): number {
  if (!Number.isFinite(start)) return 0;
  if (!Number.isFinite(extent) || extent <= 0) return Math.max(0, start);
  const max = extent - size;
  if (max <= 0) return Math.max(0, (extent - size) / 2);
  return Math.min(Math.max(start, 0), max);
}
