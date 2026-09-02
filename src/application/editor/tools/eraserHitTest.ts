import type { AffineTransform, Point } from "@/src/domain/editor/geometry";
import { decompose, invert, transformPoint } from "@/src/domain/editor/geometry";
import type { EditorObject } from "@/src/domain/editor/objects";
import { isObjectKind } from "@/src/domain/editor/objects";
import { worldBounds } from "@/src/domain/editor/document";

/**
 * Pure hit-testing for the object eraser (M6). The eraser is a STROKE eraser:
 * dragging it over freehand ink deletes each intersected DrawingObject whole
 * (the professional "object eraser" behavior for ink).
 *
 * Intersection is computed in OBJECT-LOCAL space: the page-space eraser center
 * is mapped through the inverse of the object's transform, the eraser radius
 * is divided by the transform's mean |scale|, and the stroke hits when the
 * distance from the local point to any polyline segment is within
 * `eraserRadius + strokeWidth / 2` (half the ink's own width — the visible
 * ink edge counts, not just the centerline). Per-point pressure widths use
 * the stroke's widest point, so thick ink is as erasable as it looks.
 */

/** Distance from point `p` to the segment `a`→`b`. */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/** The structural subset of DrawingObject the eraser needs. */
export interface ErasableStroke {
  points: Point[];
  transform: AffineTransform;
  style: { strokeWidth: number };
  widths?: number[];
}

/**
 * True when the eraser circle (page-space `center`, `radiusPage`) touches the
 * stroke's ink. Degenerate transforms (zero scale) report no hit rather than
 * throwing.
 */
export function strokeIntersectsEraser(
  stroke: ErasableStroke,
  center: Point,
  radiusPage: number,
): boolean {
  if (stroke.points.length === 0) return false;
  let local: Point;
  let meanScale: number;
  try {
    local = transformPoint(invert(stroke.transform), center);
    const { scale } = decompose(stroke.transform);
    meanScale = (Math.abs(scale.x) + Math.abs(scale.y)) / 2;
  } catch {
    return false; // singular transform — nothing sensible to hit
  }
  if (!(meanScale > 0)) return false;
  const radiusLocal = radiusPage / meanScale;
  const maxWidth =
    stroke.widths && stroke.widths.length > 0
      ? Math.max(stroke.style.strokeWidth, ...stroke.widths.filter((w) => Number.isFinite(w)))
      : stroke.style.strokeWidth;
  const reach = radiusLocal + Math.max(0, maxWidth) / 2;

  if (stroke.points.length === 1) {
    return Math.hypot(local.x - stroke.points[0].x, local.y - stroke.points[0].y) <= reach;
  }
  for (let i = 0; i < stroke.points.length - 1; i++) {
    if (pointSegmentDistance(local, stroke.points[i], stroke.points[i + 1]) <= reach) return true;
  }
  return false;
}

/** Eraser radius slider bounds (screen px). */
export const MIN_ERASER_RADIUS = 4;
export const MAX_ERASER_RADIUS = 64;
export const DEFAULT_ERASER_RADIUS = 16;

/** Clamps an eraser radius into the supported range. */
export function clampEraserRadius(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_ERASER_RADIUS;
  return r < MIN_ERASER_RADIUS ? MIN_ERASER_RADIUS : r > MAX_ERASER_RADIUS ? MAX_ERASER_RADIUS : r;
}

/**
 * The topmost erasable object under the eraser circle, or null. `objects` is
 * the page's paint-ordered list (bottom-first); iteration runs top-down so the
 * front-most hit wins. Hidden and locked objects are never erasable; drawings
 * hit by their actual ink (via {@link strokeIntersectsEraser}), everything else
 * by its world bounds expanded by the eraser radius. Page backgrounds are not
 * objects, so they can never be hit. `exclude` suppresses duplicate deletes for
 * ids already erased earlier in the same drag gesture.
 */
export function topmostErasableAt(
  objects: EditorObject[],
  center: Point,
  radiusPage: number,
  exclude?: ReadonlySet<string>,
): string | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (exclude?.has(obj.id)) continue;
    if (!obj.visible || obj.locked) continue;
    if (isObjectKind(obj, "drawing")) {
      if (strokeIntersectsEraser(obj, center, radiusPage)) return obj.id;
      continue;
    }
    const b = worldBounds(obj);
    if (
      center.x >= b.x - radiusPage &&
      center.x <= b.x + b.width + radiusPage &&
      center.y >= b.y - radiusPage &&
      center.y <= b.y + b.height + radiusPage
    ) {
      return obj.id;
    }
  }
  return null;
}
