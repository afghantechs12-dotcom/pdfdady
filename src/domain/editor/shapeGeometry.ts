import type { AffineTransform, Bounds, Point } from "./geometry";
import { clamp, transformPoint } from "./geometry";
import type { ArrowHeadType, ConnectorKind, ShapeKind, ShapeObject } from "./objects";

/**
 * The CANONICAL shape geometry module (M6 shape library).
 *
 * For every {@link ShapeKind} this module produces the SVG path data string in
 * LOCAL coordinates (origin at the object's top-left, the space of
 * `localBounds`). Both consumers — the on-screen SVG renderer
 * (`ObjectRenderer`) and the PDF exporter (`PdfExportService`, via pdf-lib's
 * `drawSvgPath`) — call {@link shapePathData}, so what you see on screen is
 * what the exported PDF contains by construction.
 *
 * Only the command subset `M L C Q Z` (absolute) is emitted. pdf-lib's SVG
 * path parser and the browser both support it exactly; curves that SVG would
 * express with arcs (ellipse, rounded corners) are emitted as cubic Béziers
 * using the standard circle-approximation constant {@link KAPPA} so the two
 * consumers cannot diverge on arc flattening.
 *
 * The module also owns the small path-data toolkit the editor needs around
 * that contract: {@link parsePathData} / {@link serializePathData} for the
 * `M L C Q Z` subset, {@link transformPathData} (used by export to map local
 * paths into world space), and {@link pathDataBounds}, which computes TIGHT
 * bounds using the exact Bézier extrema (derivative roots), not sampling.
 */

// ---------------------------------------------------------------------------
// Parameter clamping (shared by geometry, UI controls, and serialization).
// ---------------------------------------------------------------------------

/** Circle-from-cubic-Béziers constant: 4/3·tan(π/8). */
export const KAPPA = 0.5522847498307936;

export const MIN_POLYGON_SIDES = 3;
export const MAX_POLYGON_SIDES = 12;
export const DEFAULT_POLYGON_SIDES = 6;

export const MIN_STAR_POINTS = 4;
export const MAX_STAR_POINTS = 12;
export const DEFAULT_STAR_POINTS = 5;

export const MIN_INNER_RATIO = 0.1;
export const MAX_INNER_RATIO = 0.9;
export const DEFAULT_INNER_RATIO = 0.5;

export const DEFAULT_HEAD_SIZE = 16;
export const DEFAULT_TAIL_POSITION = 0.3;

/** Clamps a polygon side count into [3, 12] (default 6; non-finite → default). */
export function clampSides(sides: number | undefined): number {
  if (sides === undefined || !Number.isFinite(sides)) return DEFAULT_POLYGON_SIDES;
  return clamp(Math.round(sides), MIN_POLYGON_SIDES, MAX_POLYGON_SIDES);
}

/** Clamps a star point count into [4, 12] (default 5; non-finite → default). */
export function clampStarPoints(points: number | undefined): number {
  if (points === undefined || !Number.isFinite(points)) return DEFAULT_STAR_POINTS;
  return clamp(Math.round(points), MIN_STAR_POINTS, MAX_STAR_POINTS);
}

/** Clamps a star inner ratio into [0.1, 0.9] (default 0.5; non-finite → default). */
export function clampInnerRatio(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return DEFAULT_INNER_RATIO;
  return clamp(ratio, MIN_INNER_RATIO, MAX_INNER_RATIO);
}

/** Clamps an arrow head size into [2, maxAllowed] (default 16; non-finite → default). */
export function clampHeadSize(size: number | undefined, maxAllowed: number): number {
  const base = size === undefined || !Number.isFinite(size) ? DEFAULT_HEAD_SIZE : size;
  return clamp(base, 2, Math.max(2, maxAllowed));
}

/** Clamps a speech-bubble tail position into [0.05, 0.95] (default 0.3). */
export function clampTailPosition(pos: number | undefined): number {
  if (pos === undefined || !Number.isFinite(pos)) return DEFAULT_TAIL_POSITION;
  return clamp(pos, 0.05, 0.95);
}

// ---------------------------------------------------------------------------
// Number formatting — 3 decimals keeps paths compact and deterministic.
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  // Normalize -0 to 0 so serialized paths are stable.
  return String(r === 0 ? 0 : r);
}

// ---------------------------------------------------------------------------
// Per-kind path builders. All take localBounds width/height (w, h ≥ 0) and
// return absolute-command path data in local coordinates.
// ---------------------------------------------------------------------------

/** A plain rectangle (also handles cornerRadius = 0 for roundedRectPath). */
export function rectPath(w: number, h: number): string {
  return `M 0 0 L ${fmt(w)} 0 L ${fmt(w)} ${fmt(h)} L 0 ${fmt(h)} Z`;
}

/**
 * A rounded rectangle. `radius` is clamped to [0, min(w,h)/2]; corners are
 * quarter-circle cubic Béziers (KAPPA), matching the browser's `rx` rendering.
 */
export function roundedRectPath(w: number, h: number, radius: number): string {
  const r = clamp(Number.isFinite(radius) ? radius : 0, 0, Math.min(w, h) / 2);
  if (r <= 0) return rectPath(w, h);
  const k = KAPPA * r;
  return [
    `M ${fmt(r)} 0`,
    `L ${fmt(w - r)} 0`,
    `C ${fmt(w - r + k)} 0 ${fmt(w)} ${fmt(r - k)} ${fmt(w)} ${fmt(r)}`,
    `L ${fmt(w)} ${fmt(h - r)}`,
    `C ${fmt(w)} ${fmt(h - r + k)} ${fmt(w - r + k)} ${fmt(h)} ${fmt(w - r)} ${fmt(h)}`,
    `L ${fmt(r)} ${fmt(h)}`,
    `C ${fmt(r - k)} ${fmt(h)} 0 ${fmt(h - r + k)} 0 ${fmt(h - r)}`,
    `L 0 ${fmt(r)}`,
    `C 0 ${fmt(r - k)} ${fmt(r - k)} 0 ${fmt(r)} 0`,
    "Z",
  ].join(" ");
}

/** An ellipse inscribed in the w×h box, as four cubic Bézier arcs. */
export function ellipsePath(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const kx = KAPPA * rx;
  const ky = KAPPA * ry;
  return [
    `M ${fmt(cx + rx)} ${fmt(cy)}`,
    `C ${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)}`,
    `C ${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - rx)} ${fmt(cy)}`,
    `C ${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)}`,
    `C ${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + rx)} ${fmt(cy)}`,
    "Z",
  ].join(" ");
}

/**
 * A circle of diameter min(w, h), centered in the box (a "circle" stays a
 * circle even when its bounds are stretched non-uniformly by editing the W/H
 * fields; the transform's own scale may still make it elliptical on purpose).
 */
export function circlePath(w: number, h: number): string {
  const d = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const r = d / 2;
  const k = KAPPA * r;
  return [
    `M ${fmt(cx + r)} ${fmt(cy)}`,
    `C ${fmt(cx + r)} ${fmt(cy + k)} ${fmt(cx + k)} ${fmt(cy + r)} ${fmt(cx)} ${fmt(cy + r)}`,
    `C ${fmt(cx - k)} ${fmt(cy + r)} ${fmt(cx - r)} ${fmt(cy + k)} ${fmt(cx - r)} ${fmt(cy)}`,
    `C ${fmt(cx - r)} ${fmt(cy - k)} ${fmt(cx - k)} ${fmt(cy - r)} ${fmt(cx)} ${fmt(cy - r)}`,
    `C ${fmt(cx + k)} ${fmt(cy - r)} ${fmt(cx + r)} ${fmt(cy - k)} ${fmt(cx + r)} ${fmt(cy)}`,
    "Z",
  ].join(" ");
}

/** An isoceles triangle: apex top-center, base along the bottom edge. */
export function trianglePath(w: number, h: number): string {
  return `M ${fmt(w / 2)} 0 L ${fmt(w)} ${fmt(h)} L 0 ${fmt(h)} Z`;
}

/** A straight line across the box (default TL→BR; explicit points override). */
export function linePath(w: number, h: number, points?: Point[]): string {
  const p0 = points?.[0] ?? { x: 0, y: 0 };
  const p1 = points?.[1] ?? { x: w, y: h };
  return `M ${fmt(p0.x)} ${fmt(p0.y)} L ${fmt(p1.x)} ${fmt(p1.y)}`;
}

/**
 * A horizontal arrow pointing right, spanning the box (rotate the object to
 * aim it). "triangle" is a CLOSED 7-vertex polygon (shaft + solid head);
 * "open" is an OPEN stroke (shaft line + two head strokes).
 */
export function arrowPath(
  w: number,
  h: number,
  headSize: number | undefined,
  headType: ArrowHeadType = "triangle",
): string {
  const head = clampHeadSize(headSize, Math.max(2, w * 0.9));
  const cy = h / 2;
  if (headType === "open") {
    const half = Math.min(head * 0.6, h / 2);
    return [
      `M 0 ${fmt(cy)} L ${fmt(w)} ${fmt(cy)}`,
      `M ${fmt(w - head)} ${fmt(cy - half)} L ${fmt(w)} ${fmt(cy)} L ${fmt(w - head)} ${fmt(cy + half)}`,
    ].join(" ");
  }
  // Solid: shaft thickness 40% of height, head spans the full height.
  const t = Math.max(1, h * 0.4);
  const shaftEnd = Math.max(0, w - head);
  return [
    `M 0 ${fmt(cy - t / 2)}`,
    `L ${fmt(shaftEnd)} ${fmt(cy - t / 2)}`,
    `L ${fmt(shaftEnd)} 0`,
    `L ${fmt(w)} ${fmt(cy)}`,
    `L ${fmt(shaftEnd)} ${fmt(h)}`,
    `L ${fmt(shaftEnd)} ${fmt(cy + t / 2)}`,
    `L 0 ${fmt(cy + t / 2)}`,
    "Z",
  ].join(" ");
}

/** The vertices of a regular n-gon inscribed in the w×h box, first vertex at the top. */
export function polygonVertices(w: number, h: number, sides: number | undefined): Point[] {
  const n = clampSides(sides);
  const cx = w / 2;
  const cy = h / 2;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    out.push({ x: cx + (w / 2) * Math.cos(angle), y: cy + (h / 2) * Math.sin(angle) });
  }
  return out;
}

/**
 * A polygon: explicit `points` (≥3 — the legacy pre-v6 shape) win; otherwise a
 * regular n-gon of `sides` inscribed in the box.
 */
export function polygonPath(w: number, h: number, sides: number | undefined, points?: Point[]): string {
  const pts = points && points.length >= 3 ? points : polygonVertices(w, h, sides);
  const cmds = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p.x)} ${fmt(p.y)}`);
  return `${cmds.join(" ")} Z`;
}

/** The alternating outer/inner vertices of a star inscribed in the w×h box. */
export function starVertices(
  w: number,
  h: number,
  points: number | undefined,
  innerRatio: number | undefined,
): Point[] {
  const n = clampStarPoints(points);
  const ratio = clampInnerRatio(innerRatio);
  const cx = w / 2;
  const cy = h / 2;
  const out: Point[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? 1 : ratio;
    const angle = -Math.PI / 2 + (Math.PI * i) / n;
    out.push({ x: cx + (w / 2) * r * Math.cos(angle), y: cy + (h / 2) * r * Math.sin(angle) });
  }
  return out;
}

/** A star of `points` points (outer radius = box, inner = ratio·outer), tip up. */
export function starPath(
  w: number,
  h: number,
  points: number | undefined,
  innerRatio: number | undefined,
): string {
  const pts = starVertices(w, h, points, innerRatio);
  const cmds = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${fmt(p.x)} ${fmt(p.y)}`);
  return `${cmds.join(" ")} Z`;
}

/**
 * A speech bubble: a rounded-rect body over the top of the box with a
 * triangular tail dropping to the bottom edge. `tailPosition` (0–1) places the
 * tail tip along the bottom; the tail occupies the bottom 22% of the height
 * (clamped to 24 local units).
 */
export function speechBubblePath(w: number, h: number, tailPosition: number | undefined): string {
  const tail = clamp(h * 0.22, 2, 24);
  const bodyH = Math.max(1, h - tail);
  const r = clamp(Math.min(w, bodyH) * 0.15, 0, Math.min(w, bodyH) / 2);
  const k = KAPPA * r;
  const tipX = clamp(clampTailPosition(tailPosition) * w, 0, w);
  const tailHalf = clamp(w * 0.08, 2, 16);
  // Tail base sits on the body's bottom edge, clamped inside the straight span.
  const baseLeft = clamp(tipX - tailHalf, r, Math.max(r, w - r - 2 * tailHalf));
  const baseRight = Math.min(baseLeft + 2 * tailHalf, w - r);
  return [
    `M ${fmt(r)} 0`,
    `L ${fmt(w - r)} 0`,
    `C ${fmt(w - r + k)} 0 ${fmt(w)} ${fmt(r - k)} ${fmt(w)} ${fmt(r)}`,
    `L ${fmt(w)} ${fmt(bodyH - r)}`,
    `C ${fmt(w)} ${fmt(bodyH - r + k)} ${fmt(w - r + k)} ${fmt(bodyH)} ${fmt(w - r)} ${fmt(bodyH)}`,
    `L ${fmt(baseRight)} ${fmt(bodyH)}`,
    `L ${fmt(tipX)} ${fmt(h)}`,
    `L ${fmt(baseLeft)} ${fmt(bodyH)}`,
    `L ${fmt(r)} ${fmt(bodyH)}`,
    `C ${fmt(r - k)} ${fmt(bodyH)} 0 ${fmt(bodyH - r + k)} 0 ${fmt(bodyH - r)}`,
    `L 0 ${fmt(r)}`,
    `C 0 ${fmt(r - k)} ${fmt(r - k)} 0 ${fmt(r)} 0`,
    "Z",
  ].join(" ");
}

/** Appends an open V arrowhead at `tip` for a segment arriving from `from`. */
function arrowHeadAt(from: Point, tip: Point, size: number): string {
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return "";
  const ux = dx / len;
  const uy = dy / len;
  // Two barbs at ±150° from the incoming direction.
  const barb = (sign: 1 | -1): Point => {
    const angle = Math.atan2(uy, ux) + sign * (Math.PI - Math.PI / 6);
    return { x: tip.x + size * Math.cos(angle), y: tip.y + size * Math.sin(angle) };
  };
  const b1 = barb(1);
  const b2 = barb(-1);
  return `M ${fmt(b1.x)} ${fmt(b1.y)} L ${fmt(tip.x)} ${fmt(tip.y)} L ${fmt(b2.x)} ${fmt(b2.y)}`;
}

/**
 * A connector between two local points (default TL→BR of the box; explicit
 * `points[0]`/`points[1]` override). "elbow" routes horizontally-first through
 * the midpoint x. Arrowheads render as open V strokes so the whole connector
 * is a single stroked path (screen and PDF agree).
 */
export function connectorPath(
  w: number,
  h: number,
  kind: ConnectorKind = "straight",
  options?: { points?: Point[]; startArrow?: boolean; endArrow?: boolean; headSize?: number },
): string {
  const start = options?.points?.[0] ?? { x: 0, y: 0 };
  const end = options?.points?.[1] ?? { x: w, y: h };
  const head = clampHeadSize(options?.headSize, Math.max(2, Math.hypot(end.x - start.x, end.y - start.y) / 2));
  const parts: string[] = [];
  let beforeEnd: Point = start;
  let afterStart: Point = end;
  if (kind === "elbow") {
    const midX = (start.x + end.x) / 2;
    parts.push(
      `M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(midX)} ${fmt(start.y)} L ${fmt(midX)} ${fmt(end.y)} L ${fmt(end.x)} ${fmt(end.y)}`,
    );
    beforeEnd = { x: midX, y: end.y };
    afterStart = { x: midX, y: start.y };
  } else {
    parts.push(`M ${fmt(start.x)} ${fmt(start.y)} L ${fmt(end.x)} ${fmt(end.y)}`);
  }
  if (options?.endArrow) {
    const seg = arrowHeadAt(beforeEnd, end, head);
    if (seg) parts.push(seg);
  }
  if (options?.startArrow) {
    const seg = arrowHeadAt(afterStart, start, head);
    if (seg) parts.push(seg);
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Path-data toolkit (M L C Q Z subset — the contract of this module).
// ---------------------------------------------------------------------------

/** One parsed absolute path command. */
export type PathCommand =
  | { cmd: "M" | "L"; x: number; y: number }
  | { cmd: "Q"; x1: number; y1: number; x: number; y: number }
  | { cmd: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { cmd: "Z" };

/**
 * Parses absolute `M L C Q Z` path data. Tolerant of extra whitespace/commas;
 * malformed or unsupported segments (relative commands, arcs, non-finite
 * numbers) are skipped rather than thrown so a corrupt save never blocks
 * rendering — the result is simply the valid prefix subset.
 */
export function parsePathData(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  if (typeof d !== "string" || d.length === 0) return out;
  const tokens = d.match(/[MLCQZ]|-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? [];
  let i = 0;
  const num = (): number | null => {
    if (i >= tokens.length) return null;
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    i++;
    return n;
  };
  while (i < tokens.length) {
    const t = tokens[i];
    // Only absolute commands are supported; anything else ends the parse of
    // this segment (skip token and continue scanning for the next command).
    if (t === "M" || t === "L") {
      i++;
      // Consume repeated coordinate pairs (SVG treats extra M pairs as L).
      let first = true;
      for (;;) {
        const save = i;
        const x = num();
        const y = num();
        if (x === null || y === null) {
          i = save;
          break;
        }
        out.push({ cmd: t === "M" && first ? "M" : "L", x, y });
        first = false;
      }
    } else if (t === "Q") {
      i++;
      for (;;) {
        const save = i;
        const x1 = num();
        const y1 = num();
        const x = num();
        const y = num();
        if (x1 === null || y1 === null || x === null || y === null) {
          i = save;
          break;
        }
        out.push({ cmd: "Q", x1, y1, x, y });
      }
    } else if (t === "C") {
      i++;
      for (;;) {
        const save = i;
        const x1 = num();
        const y1 = num();
        const x2 = num();
        const y2 = num();
        const x = num();
        const y = num();
        if (x1 === null || y1 === null || x2 === null || y2 === null || x === null || y === null) {
          i = save;
          break;
        }
        out.push({ cmd: "C", x1, y1, x2, y2, x, y });
      }
    } else if (t === "Z" || t === "z") {
      i++;
      out.push({ cmd: "Z" });
    } else {
      i++; // unsupported token — skip
    }
  }
  return out;
}

/** Serializes parsed commands back to a path-data string. */
export function serializePathData(cmds: PathCommand[]): string {
  return cmds
    .map((c) => {
      switch (c.cmd) {
        case "M":
        case "L":
          return `${c.cmd} ${fmt(c.x)} ${fmt(c.y)}`;
        case "Q":
          return `Q ${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x)} ${fmt(c.y)}`;
        case "C":
          return `C ${fmt(c.x1)} ${fmt(c.y1)} ${fmt(c.x2)} ${fmt(c.y2)} ${fmt(c.x)} ${fmt(c.y)}`;
        case "Z":
          return "Z";
      }
    })
    .join(" ");
}

/** Applies an affine transform to every coordinate of a path-data string. */
export function transformPathData(d: string, t: AffineTransform): string {
  const mapped = parsePathData(d).map((c): PathCommand => {
    switch (c.cmd) {
      case "M":
      case "L": {
        const p = transformPoint(t, { x: c.x, y: c.y });
        return { cmd: c.cmd, x: p.x, y: p.y };
      }
      case "Q": {
        const p1 = transformPoint(t, { x: c.x1, y: c.y1 });
        const p = transformPoint(t, { x: c.x, y: c.y });
        return { cmd: "Q", x1: p1.x, y1: p1.y, x: p.x, y: p.y };
      }
      case "C": {
        const p1 = transformPoint(t, { x: c.x1, y: c.y1 });
        const p2 = transformPoint(t, { x: c.x2, y: c.y2 });
        const p = transformPoint(t, { x: c.x, y: c.y });
        return { cmd: "C", x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
      }
      case "Z":
        return c;
    }
  });
  return serializePathData(mapped);
}

/** Extrema parameters t ∈ (0,1) of one cubic component (derivative roots). */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) = 3[(−p0+3p1−3p2+p3)t² + 2(p0−2p1+p2)t + (p1−p0)]
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const out: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) {
      const t = -c / b;
      if (t > 0 && t < 1) out.push(t);
    }
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  for (const t of [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]) {
    if (t > 0 && t < 1) out.push(t);
  }
  return out;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/** Extremum parameter t ∈ (0,1) of one quadratic component, if any. */
function quadExtremum(p0: number, p1: number, p2: number): number[] {
  // B'(t) = 2[(p0−2p1+p2)t + (p1−p0)]
  const denom = p0 - 2 * p1 + p2;
  if (Math.abs(denom) < 1e-12) return [];
  const t = (p0 - p1) / denom;
  return t > 0 && t < 1 ? [t] : [];
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

/**
 * The TIGHT bounds of a path: anchor points plus the EXACT Bézier extrema
 * (derivative roots — not sampling, so bounds are correct for any curvature).
 * Returns null for a path with no drawable points.
 */
export function pathDataBounds(d: string): Bounds | null {
  const cmds = parsePathData(d);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  let cur: Point | null = null;
  for (const c of cmds) {
    switch (c.cmd) {
      case "M":
      case "L":
        include(c.x, c.y);
        cur = { x: c.x, y: c.y };
        break;
      case "Q": {
        const from = cur ?? { x: c.x, y: c.y };
        include(from.x, from.y);
        include(c.x, c.y);
        for (const t of quadExtremum(from.x, c.x1, c.x)) include(quadAt(from.x, c.x1, c.x, t), quadAt(from.y, c.y1, c.y, t));
        for (const t of quadExtremum(from.y, c.y1, c.y)) include(quadAt(from.x, c.x1, c.x, t), quadAt(from.y, c.y1, c.y, t));
        cur = { x: c.x, y: c.y };
        break;
      }
      case "C": {
        const from = cur ?? { x: c.x, y: c.y };
        include(from.x, from.y);
        include(c.x, c.y);
        for (const t of cubicExtrema(from.x, c.x1, c.x2, c.x)) {
          include(cubicAt(from.x, c.x1, c.x2, c.x, t), cubicAt(from.y, c.y1, c.y2, c.y, t));
        }
        for (const t of cubicExtrema(from.y, c.y1, c.y2, c.y)) {
          include(cubicAt(from.x, c.x1, c.x2, c.x, t), cubicAt(from.y, c.y1, c.y2, c.y, t));
        }
        cur = { x: c.x, y: c.y };
        break;
      }
      case "Z":
        break;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Normalizes stored bezier/path data into a localBounds-relative form: the
 * path is translated so its tight bounds' top-left sits at (0,0). Returns the
 * normalized path plus the tight size ({@link ShapeObject.localBounds} should
 * match it). Empty/invalid data yields a degenerate 1×1 "M 0 0" placeholder.
 */
export function normalizePathData(d: string): { pathData: string; width: number; height: number } {
  const bounds = pathDataBounds(d);
  if (!bounds) return { pathData: "M 0 0", width: 1, height: 1 };
  const shifted = transformPathData(d, { a: 1, b: 0, c: 0, d: 1, e: -bounds.x, f: -bounds.y });
  return { pathData: shifted, width: Math.max(bounds.width, 1), height: Math.max(bounds.height, 1) };
}

// ---------------------------------------------------------------------------
// The single entry points the renderer + exporter consume.
// ---------------------------------------------------------------------------

/** The subset of ShapeObject the geometry needs (kept structural for tests). */
export interface ShapeGeometrySource {
  shape: ShapeKind;
  localBounds: { width: number; height: number };
  points?: Point[];
  style?: { cornerRadius?: number };
  sides?: number;
  starPoints?: number;
  innerRatio?: number;
  headSize?: number;
  headType?: ArrowHeadType;
  tailPosition?: number;
  connectorKind?: ConnectorKind;
  startArrow?: boolean;
  endArrow?: boolean;
  pathData?: string;
}

/**
 * The canonical SVG path data (local coordinates) for a shape object. This is
 * THE single source of truth: `ObjectRenderer` renders it in a `<path d>` and
 * `PdfExportService` hands its world-transformed form to pdf-lib's
 * `drawSvgPath`, so the screen and the exported PDF agree by construction.
 */
export function shapePathData(obj: ShapeGeometrySource): string {
  const w = Math.max(obj.localBounds.width, 0);
  const h = Math.max(obj.localBounds.height, 0);
  switch (obj.shape) {
    case "rect":
      return roundedRectPath(w, h, obj.style?.cornerRadius ?? 0);
    case "roundedRect":
      return roundedRectPath(w, h, obj.style?.cornerRadius ?? Math.min(w, h) * 0.15);
    case "ellipse":
      return ellipsePath(w, h);
    case "circle":
      return circlePath(w, h);
    case "triangle":
      return trianglePath(w, h);
    case "line":
      return linePath(w, h, obj.points);
    case "arrow":
      return arrowPath(w, h, obj.headSize, obj.headType ?? "triangle");
    case "polygon":
      return polygonPath(w, h, obj.sides, obj.points);
    case "star":
      return starPath(w, h, obj.starPoints, obj.innerRatio);
    case "speechBubble":
      return speechBubblePath(w, h, obj.tailPosition);
    case "connector":
      return connectorPath(w, h, obj.connectorKind ?? "straight", {
        points: obj.points && obj.points.length >= 2 ? obj.points : undefined,
        startArrow: obj.startArrow ?? false,
        endArrow: obj.endArrow ?? true,
        headSize: obj.headSize,
      });
    case "bezier":
    case "path":
      return obj.pathData && obj.pathData.length > 0 ? obj.pathData : "M 0 0";
  }
}

/**
 * Whether a shape kind renders as a CLOSED (fillable) outline. Open kinds
 * (line, open-head arrow, connector, bezier/path drawings) are stroke-only:
 * the renderer sets fill "none" and the exporter omits the fill color.
 */
export function isClosedShape(shape: ShapeKind, headType?: ArrowHeadType): boolean {
  switch (shape) {
    case "line":
    case "connector":
      return false;
    case "arrow":
      return (headType ?? "triangle") === "triangle";
    case "bezier":
    case "path":
      return false;
    default:
      return true;
  }
}

/** Convenience overload for full ShapeObjects. */
export function shapeIsClosed(obj: Pick<ShapeObject, "shape" | "headType">): boolean {
  return isClosedShape(obj.shape, obj.headType);
}

/** The ordered list of all shape kinds (toolbar dropdown + cycling order). */
export const ALL_SHAPE_KINDS: readonly ShapeKind[] = [
  "rect",
  "roundedRect",
  "ellipse",
  "circle",
  "triangle",
  "line",
  "arrow",
  "polygon",
  "star",
  "speechBubble",
  "connector",
  "bezier",
  "path",
] as const;

/** Human-readable labels for shape kinds (toolbar + factories). */
export const SHAPE_KIND_LABELS: Record<ShapeKind, string> = {
  rect: "Rectangle",
  roundedRect: "Rounded rectangle",
  ellipse: "Ellipse",
  circle: "Circle",
  triangle: "Triangle",
  line: "Line",
  arrow: "Arrow",
  polygon: "Polygon",
  star: "Star",
  speechBubble: "Speech bubble",
  connector: "Connector",
  bezier: "Bezier curve",
  path: "Freeform path",
};
