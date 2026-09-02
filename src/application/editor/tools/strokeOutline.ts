import type { Point } from "@/src/domain/editor/geometry";

/**
 * Variable-width stroke outline builder (M6 pressure simulation).
 *
 * A pressure stroke stores per-point widths alongside its centerline points;
 * this module turns centerline + widths into a CLOSED outline polygon (left
 * side forward, right side backward) rendered as a filled path. Both the SVG
 * renderer and the PDF exporter consume the same outline, so the ink looks
 * identical on screen and in the exported file.
 *
 * Pressure itself is SIMULATED deterministically from geometry: there are no
 * timestamps in the stored model, so speed is approximated by the distance
 * between consecutive sampled points (pointer events sample at a roughly
 * constant rate, making segment length a faithful velocity proxy). Slower
 * movement → thicker ink, like a real pen. The mapping and its clamps are
 * fixed constants, so the same stroke always produces the same widths.
 */

/** Minimum rendered ink width — keeps degenerate widths visible and valid. */
export const MIN_STROKE_WIDTH = 0.5;

/** Velocity mapping constants (page units per sampled segment). */
export const PRESSURE_REF_SPEED = 24;
export const PRESSURE_MAX_FACTOR = 1.4;
export const PRESSURE_MIN_FACTOR = 0.55;

const clampNum = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/**
 * Deterministic velocity-based per-point widths for a stroke of `baseWidth`.
 * Width_i = baseWidth · clamp(MAX − speed_i / REF, MIN, MAX), where speed_i is
 * the mean length of the segments adjacent to point i (one-sided at the
 * endpoints). Slower (short segments) → factor near MAX (thicker); fast
 * flicks → factor at MIN. Every width is ≥ {@link MIN_STROKE_WIDTH}.
 */
export function computePressureWidths(points: Point[], baseWidth: number): number[] {
  const base = Number.isFinite(baseWidth) && baseWidth > 0 ? baseWidth : 1;
  if (points.length === 0) return [];
  if (points.length === 1) return [Math.max(base, MIN_STROKE_WIDTH)];
  const segLen: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    segLen.push(Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y));
  }
  return points.map((_, i) => {
    const before = i > 0 ? segLen[i - 1] : segLen[0];
    const after = i < segLen.length ? segLen[i] : segLen[segLen.length - 1];
    const speed = (before + after) / 2;
    const factor = clampNum(PRESSURE_MAX_FACTOR - speed / PRESSURE_REF_SPEED, PRESSURE_MIN_FACTOR, PRESSURE_MAX_FACTOR);
    return Math.max(base * factor, MIN_STROKE_WIDTH);
  });
}

const fmt = (n: number): string => {
  const r = Math.round(n * 1000) / 1000;
  return String(r === 0 ? 0 : r);
};

/**
 * Builds the closed outline polygon for a variable-width stroke.
 *
 * Each point is offset ±width/2 along its normal (the perpendicular of the
 * averaged adjacent segment direction — one-sided at the endpoints); the
 * outline walks the left offsets forward and the right offsets backward, then
 * closes. Returns null for fewer than 2 distinct points (callers fall back to
 * a constant-width stroke). Widths shorter than `points` repeat their last
 * value; non-finite/small widths clamp to {@link MIN_STROKE_WIDTH}.
 */
export function buildStrokeOutline(points: Point[], widths: number[]): string | null {
  if (points.length < 2) return null;
  const dirs: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      // Degenerate direction: reuse the previous direction (or +x for the first).
      dirs.push(dirs.length > 0 ? dirs[dirs.length - 1] : { x: 1, y: 0 });
    } else {
      dirs.push({ x: dx / len, y: dy / len });
    }
  }
  // If EVERY direction was degenerate (all points identical), no outline.
  const allSame = points.every((p) => p.x === points[0].x && p.y === points[0].y);
  if (allSame) return null;

  const widthAt = (i: number): number => {
    const raw = widths[Math.min(i, widths.length - 1)];
    return Number.isFinite(raw) && raw > MIN_STROKE_WIDTH ? raw : MIN_STROKE_WIDTH;
  };

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const n = { x: -dirs[i].y, y: dirs[i].x };
    const half = widthAt(i) / 2;
    left.push({ x: points[i].x + n.x * half, y: points[i].y + n.y * half });
    right.push({ x: points[i].x - n.x * half, y: points[i].y - n.y * half });
  }
  const parts: string[] = [`M ${fmt(left[0].x)} ${fmt(left[0].y)}`];
  for (let i = 1; i < left.length; i++) parts.push(`L ${fmt(left[i].x)} ${fmt(left[i].y)}`);
  for (let i = right.length - 1; i >= 0; i--) parts.push(`L ${fmt(right[i].x)} ${fmt(right[i].y)}`);
  parts.push("Z");
  return parts.join(" ");
}
