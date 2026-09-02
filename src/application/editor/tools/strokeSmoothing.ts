import type { Point } from "@/src/domain/editor/geometry";

/**
 * Catmull-Rom → cubic Bézier stroke smoothing (M6 drawing upgrade).
 *
 * A freehand stroke is stored as its raw polyline `points`; smoothing is a
 * DERIVED view computed here (never stored), so the renderer and the PDF
 * exporter both call this module and agree by construction.
 *
 * The uniform Catmull-Rom spline through points P0…Pn is converted to cubic
 * Bézier segments with the standard tension-0.5 mapping:
 *   c1_i = P_i + (P_{i+1} − P_{i−1}) / 6
 *   c2_i = P_{i+1} − (P_{i+2} − P_i) / 6
 * (with the first/last neighbors clamped to the endpoints). The resulting
 * curve interpolates every input point, preserves the endpoints exactly, and
 * is C1-continuous: the incoming and outgoing tangents at each interior point
 * are both (P_{i+1} − P_{i−1}) / 6 — verified in strokeSmoothing.test.ts.
 */

/** One cubic Bézier segment (from → c1 → c2 → to). */
export interface CubicSegment {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

/**
 * The Catmull-Rom cubic segments through `points`. Fewer than 2 points → no
 * segments; exactly 2 → one "straight" cubic (controls on the chord).
 */
export function catmullRomSegments(points: Point[]): CubicSegment[] {
  if (points.length < 2) return [];
  const segs: CubicSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    segs.push({
      from: p1,
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      to: p2,
    });
  }
  return segs;
}

const fmt = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(r === 0 ? 0 : r);
};

/**
 * The smoothed stroke as SVG path data (absolute M/C commands). Degenerate
 * cases: 0 points → "", 1 point → a dot ("M x y"), 2 points → the straight
 * cubic between them.
 */
export function smoothedPathData(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${fmt(points[0].x)} ${fmt(points[0].y)}`;
  const segs = catmullRomSegments(points);
  const parts = [`M ${fmt(segs[0].from.x)} ${fmt(segs[0].from.y)}`];
  for (const s of segs) {
    parts.push(`C ${fmt(s.c1.x)} ${fmt(s.c1.y)} ${fmt(s.c2.x)} ${fmt(s.c2.y)} ${fmt(s.to.x)} ${fmt(s.to.y)}`);
  }
  return parts.join(" ");
}

/** Evaluates one cubic segment at t ∈ [0, 1]. */
export function cubicPoint(seg: CubicSegment, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * seg.from.x + b * seg.c1.x + c * seg.c2.x + d * seg.to.x,
    y: a * seg.from.y + b * seg.c1.y + c * seg.c2.y + d * seg.to.y,
  };
}

/**
 * Resamples the smoothed curve into a denser polyline (used by the pressure
 * outline: smooth the CENTERLINE first, then offset it). `widths`, when given
 * (parallel to `points`), is linearly interpolated onto the samples so the
 * variable-width profile follows the smoothed curve. Deterministic: fixed
 * `samplesPerSegment` (≥1), no randomness.
 */
export function sampleSmoothedCenterline(
  points: Point[],
  widths: number[] | undefined,
  samplesPerSegment = 8,
): { points: Point[]; widths: number[] | undefined } {
  if (points.length < 3) return { points, widths };
  const segs = catmullRomSegments(points);
  const n = Math.max(1, Math.floor(samplesPerSegment));
  const outPoints: Point[] = [points[0]];
  const outWidths: number[] | undefined = widths ? [widths[0] ?? 1] : undefined;
  segs.forEach((seg, i) => {
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      outPoints.push(cubicPoint(seg, t));
      if (outWidths && widths) {
        const w0 = widths[i] ?? widths[widths.length - 1] ?? 1;
        const w1 = widths[i + 1] ?? w0;
        outWidths.push(w0 + (w1 - w0) * t);
      }
    }
  });
  return { points: outPoints, widths: outWidths };
}
