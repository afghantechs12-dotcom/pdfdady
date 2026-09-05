import { invert, transformPoint, type Point } from "@/src/domain/editor/geometry";
import { type DrawingObject, isObjectKind } from "@/src/domain/editor/objects";
import { type EditorPage, pageObjects } from "@/src/domain/editor/document";
import { generateId } from "@/src/domain/editor/ids";
import { jitterPoints, pencilJitter, PENCIL_JITTER_AMPLITUDE } from "./drawingGeometry";
import { catmullRomSegments, sampleSmoothedCenterline, type CubicSegment } from "./strokeSmoothing";
import { pointSegmentDistance } from "./eraserHitTest";

type Interval = [number, number];
const EPS = 1e-9;
/** Surviving centerlines shorter than 0.05 page points are deterministic dust. */
export const MIN_INK_FRAGMENT = 0.05;
/** Maximum chord deviation when flattening constant-width cubic ink. */
export const INK_FLATNESS = 0.05;
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function circleInterval(a: Point, b: Point, c: Point, r: number): Interval[] {
  const dx = b.x - a.x, dy = b.y - a.y, x = a.x - c.x, y = a.y - c.y;
  const aa = dx * dx + dy * dy;
  if (aa < EPS) return x * x + y * y < r * r ? [[0, 1]] : [];
  const bb = 2 * (x * dx + y * dy), cc = x * x + y * y - r * r;
  const disc = bb * bb - 4 * aa * cc;
  if (disc <= 0) return []; // a tangent removes no length
  const lo = Math.max(0, (-bb - Math.sqrt(disc)) / (2 * aa));
  const hi = Math.min(1, (-bb + Math.sqrt(disc)) / (2 * aa));
  return hi - lo > EPS ? [[lo, hi]] : [];
}

function slab(value: number, delta: number, low: number, high: number): Interval | null {
  if (Math.abs(delta) < EPS) return value >= low && value <= high ? [0, 1] : null;
  const a = (low - value) / delta, b = (high - value) / delta;
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(1, Math.max(a, b));
  return hi - lo > EPS ? [lo, hi] : null;
}

/** Exact segment/capsule intersection: endpoint disks plus the swept rectangle. */
export function capsuleIntervals(a: Point, b: Point, from: Point, to: Point, radius: number): Interval[] {
  const out = [...circleInterval(a, b, from, radius), ...circleInterval(a, b, to, radius)];
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy);
  if (len > EPS) {
    const ux = dx / len, uy = dy / len;
    const x = a.x - from.x, y = a.y - from.y, vx = b.x - a.x, vy = b.y - a.y;
    const along = slab(x * ux + y * uy, vx * ux + vy * uy, 0, len);
    const across = slab(-x * uy + y * ux, -vx * uy + vy * ux, -radius, radius);
    if (along && across) {
      const lo = Math.max(along[0], across[0]), hi = Math.min(along[1], across[1]);
      if (hi - lo > EPS) out.push([lo, hi]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const v of out) {
    const last = merged.at(-1);
    if (last && v[0] <= last[1] + EPS) last[1] = Math.max(last[1], v[1]);
    else merged.push([...v]);
  }
  return merged;
}

function flatten(seg: CubicSegment, tolerance: number, out: Point[], depth = 0) {
  if (Math.max(pointSegmentDistance(seg.c1, seg.from, seg.to), pointSegmentDistance(seg.c2, seg.from, seg.to)) <= tolerance) {
    out.push(seg.to);
    return;
  }
  // Canonical scene coordinates are finite and bounded; fail closed if corrupted
  // geometry defeats subdivision instead of silently relaxing the fidelity bound.
  if (depth >= 24) throw new Error("Ink curve exceeds supported precision");
  const a = lerp(seg.from, seg.c1, .5), b = lerp(seg.c1, seg.c2, .5), c = lerp(seg.c2, seg.to, .5);
  const d = lerp(a, b, .5), e = lerp(b, c, .5), mid = lerp(d, e, .5);
  flatten({ from: seg.from, c1: a, c2: d, to: mid }, tolerance, out, depth + 1);
  flatten({ from: mid, c1: e, c2: c, to: seg.to }, tolerance, out, depth + 1);
}

/** Largest singular value: bounds local curve error and transformed cap width. */
function maxScale(o: DrawingObject) {
  const { a, b, c, d } = o.transform;
  const sum = a * a + b * b + c * c + d * d, det = a * d - b * c;
  return Math.sqrt((sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2);
}

function renderedCenterline(o: DrawingObject, scale: number) {
  let points = o.brush === "pencil" ? jitterPoints(o.points) : o.points;
  let widths = o.widths;
  if (o.smoothing && points.length >= 3) {
    if (widths?.length) ({ points, widths } = sampleSmoothedCenterline(points, widths));
    else {
      const out = [points[0]];
      for (const seg of catmullRomSegments(points)) flatten(seg, INK_FLATNESS / scale, out);
      points = out;
    }
  }
  return { points, widths };
}

/**
 * Subtract one swept disk from rendered ink. A miss returns the original object
 * identity (no flattening or history). Fragments stay canonical DrawingObjects;
 * smoothing is baked into bounded polylines, pressure widths are interpolated,
 * and pencil coordinates compensate the renderer's deterministic index jitter.
 */
export function eraseStroke(o: DrawingObject, from: Point, to: Point, radius: number): DrawingObject[] {
  const scale = maxScale(o);
  if (!(scale > 0) || !Number.isFinite(radius) || radius <= 0) return [o];
  const inv = invert(o.transform);
  const source = renderedCenterline(o, scale);
  const pts = source.points.map(p => transformPoint(o.transform, p));
  const widths = source.widths;
  const fragments: { points: Point[]; widths: number[] }[] = [];
  let current: { points: Point[]; widths: number[] } | null = null;
  let changed = false;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const wa = widths?.[i] ?? o.style.strokeWidth, wb = widths?.[i + 1] ?? wa;
    // Conservative cap expansion also handles anisotropic object transforms.
    const cut = capsuleIntervals(a, b, from, to, radius + Math.max(wa, wb, 0) * scale / 2);
    if (cut.length) changed = true;
    const keep: Interval[] = [];
    let t = 0;
    for (const [lo, hi] of cut) { if (lo > t + EPS) keep.push([t, lo]); t = Math.max(t, hi); }
    if (t < 1 - EPS) keep.push([t, 1]);
    for (const [lo, hi] of keep) {
      const p = lerp(a, b, lo), q = lerp(a, b, hi);
      const last = current?.points.at(-1);
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > EPS) {
        current = { points: [p], widths: [wa + (wb - wa) * lo] };
        fragments.push(current);
      }
      current!.points.push(q);
      current!.widths.push(wa + (wb - wa) * hi);
      if (hi < 1 - EPS) current = null;
    }
    if (!keep.length) current = null;
  }
  if (!changed) return [o];
  return fragments.filter(f => f.points.reduce((n, p, i) => n + (i ? Math.hypot(p.x - f.points[i - 1].x, p.y - f.points[i - 1].y) : 0), 0) >= MIN_INK_FRAGMENT).map((f, index) => {
    const local = f.points.map(p => transformPoint(inv, p));
    const points = o.brush === "pencil" ? local.map((p, i) => ({
      x: p.x - pencilJitter(2 * i) * PENCIL_JITTER_AMPLITUDE,
      y: p.y - pencilJitter(2 * i + 1) * PENCIL_JITTER_AMPLITUDE,
    })) : local;
    const xs = local.map(p => p.x), ys = local.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { ...o, id: index === 0 ? o.id : generateId("ink"), points,
      smoothing: false, ...(widths ? { widths: f.widths } : {}),
      localBounds: { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) },
    };
  });
}

/** Page-local ephemeral gesture. Never calls history, persistence or export. */
export class PartialInkGesture {
  readonly replacements = new Map<string, DrawingObject[]>();
  private readonly strokes: DrawingObject[];
  private previous: Point;
  constructor(readonly page: EditorPage, start: Point, readonly radius: number) {
    this.previous = start;
    const unlockedLayers = new Set(page.layerStack.layers.filter(l => l.visible && !l.locked).map(l => l.id));
    this.strokes = pageObjects(page).filter((o): o is DrawingObject => isObjectKind(o, "drawing") && o.visible && !o.locked && unlockedLayers.has(o.layerId));
    this.move(start);
  }
  move(to: Point) {
    for (const original of this.strokes) {
      const before = this.replacements.get(original.id) ?? [original];
      const after = before.flatMap(o => eraseStroke(o, this.previous, to, this.radius));
      if (after.length !== before.length || after.some((o, i) => o !== before[i])) this.replacements.set(original.id, after);
    }
    this.previous = to;
  }
}
