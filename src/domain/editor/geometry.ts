/**
 * 2D geometry primitives for the PDFDadi editor foundation.
 *
 * The editor works in a screen-space coordinate system with its origin at the
 * TOP-LEFT and +y pointing DOWN (matching the canvas/DOM convention used by the
 * existing PDF preview — see [[preview-architecture]]). This is intentionally
 * distinct from pdf-lib's bottom-left user space; a mapping layer translates
 * between the two at render/export time, preserving the coordinate contract the
 * interactive tools already rely on (`visualFractionToUserSpace`).
 *
 * Affine transforms are stored as the six coefficients [a, b, c, d, e, f] of the
 * homogenous matrix
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 * so a point (x, y) maps to (a*x + c*y + e, b*x + d*y + f). This is the same
 * layout used by SVG / Canvas `setTransform` / CSS matrix(), which keeps the
 * render layer a one-liner when objects are eventually painted.
 */

/** A 2D point in editor space. */
export interface Point {
  x: number;
  y: number;
}

/** A 2D vector (mathematically identical to Point; the alias communicates intent). */
export type Vec2 = Point;

/**
 * An axis-aligned bounding box in editor space. `width`/`height` are always
 * non-negative; `x`/`y` is the top-left corner.
 */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A 2D affine transform as [a, b, c, d, e, f] (see file header for the matrix). */
export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** The identity transform (no translation, scale, or rotation). */
export const IDENTITY_TRANSFORM: AffineTransform = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
};

const EPSILON = 1e-9;

/** True when every transform coefficient is finite and its determinant is safely invertible. */
export function isInvertibleTransform(t: AffineTransform, epsilon = EPSILON): boolean {
  if (![t.a, t.b, t.c, t.d, t.e, t.f].every(Number.isFinite)) return false;
  const det = t.a * t.d - t.b * t.c;
  return Number.isFinite(det) && Math.abs(det) >= epsilon;
}

/** Constructs an affine transform from its six matrix coefficients. */
export function makeTransform(
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number,
): AffineTransform {
  return { a, b, c, d, e, f };
}

/** Translation by (tx, ty). */
export function makeTranslate(tx: number, ty: number): AffineTransform {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

/** Non-uniform scale by (sx, sy) about the origin. */
export function makeScale(sx: number, sy: number): AffineTransform {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

/** Rotation by `radians` (clockwise in the screen-space y-down system) about the origin. */
export function makeRotate(radians: number): AffineTransform {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/**
 * Composes two transforms: `compose(outer, inner)` produces the transform that
 * applies `inner` first, then `outer` (i.e. outer(inner(p))). This matches the
 * conventional matrix product `outer * inner` and the reading order you'd use
 * when nesting transforms ("translate to the object, then rotate, then scale").
 */
export function compose(
  outer: AffineTransform,
  inner: AffineTransform,
): AffineTransform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

/** Applies a transform to a point. */
export function transformPoint(t: AffineTransform, p: Point): Point {
  return {
    x: t.a * p.x + t.c * p.y + t.e,
    y: t.b * p.x + t.d * p.y + t.f,
  };
}

/**
 * Applies a transform to a vector (translation component ignored — a vector has
 * no position). Used for direction vectors such as resize handles.
 */
export function transformVector(t: AffineTransform, v: Vec2): Vec2 {
  return {
    x: t.a * v.x + t.c * v.y,
    y: t.b * v.x + t.d * v.y,
  };
}

/**
 * Inverts an affine transform. Throws for singular (non-invertible) transforms,
 * which would only arise from a degenerate scale of 0 — i.e. a programmatic
 * error, not user input — so we surface it rather than silently returning junk.
 */
export function invert(t: AffineTransform): AffineTransform {
  const det = t.a * t.d - t.b * t.c;
  if (!isInvertibleTransform(t)) {
    throw new Error("Cannot invert a singular affine transform (determinant ~0).");
  }
  const invDet = 1 / det;
  return {
    a: t.d * invDet,
    b: -t.b * invDet,
    c: -t.c * invDet,
    d: t.a * invDet,
    e: (t.c * t.f - t.d * t.e) * invDet,
    f: (t.b * t.e - t.a * t.f) * invDet,
  };
}

/** Returns true when two transforms are equal within a small epsilon. */
export function transformsEqual(
  a: AffineTransform,
  b: AffineTransform,
  epsilon = EPSILON,
): boolean {
  return (
    Math.abs(a.a - b.a) < epsilon &&
    Math.abs(a.b - b.b) < epsilon &&
    Math.abs(a.c - b.c) < epsilon &&
    Math.abs(a.d - b.d) < epsilon &&
    Math.abs(a.e - b.e) < epsilon &&
    Math.abs(a.f - b.f) < epsilon
  );
}

/** Decomposes a transform into [translate, scale, rotation radians]. */
export function decompose(t: AffineTransform): {
  translate: Vec2;
  scale: Vec2;
  rotation: number;
} {
  const translate: Vec2 = { x: t.e, y: t.f };
  const scale: Vec2 = {
    x: Math.sqrt(t.a * t.a + t.b * t.b),
    y: Math.sqrt(t.c * t.c + t.d * t.d),
  };
  // atan2(b, a) gives the rotation; sign of the determinant reveals a flip.
  const det = t.a * t.d - t.b * t.c;
  const rotation = Math.atan2(t.b, t.a);
  if (det < 0) {
    // A reflection is folded into the y scale so callers see a positive scale.
    scale.y = -scale.y;
  }
  return { translate, scale, rotation };
}

/** Builds a Bounds from a top-left corner and a size. */
export function makeBounds(x: number, y: number, width: number, height: number): Bounds {
  return { x, y, width, height };
}

/**
 * The largest rect with the aspect ratio `contentWidth : contentHeight` that
 * fits inside `box`, centred — i.e. letterboxed ("contain"), never distorted,
 * never cropped.
 *
 * THIS IS THE SHARED SOURCE OF TRUTH for fitting an asset inside an object box.
 * Both the on-screen renderer and the PDF exporter must call it rather than
 * expressing the rule twice: a signature that letterboxed on screen but
 * stretched on export was a real shipped divergence, caught by
 * `scripts/export-fidelity-probe.mts` and now guarded by
 * `geometry.test.ts` + `imageOrientation.test.ts`.
 *
 * Degenerate inputs (a non-positive content or box dimension) return the box
 * itself, so a caller with unknown natural dimensions still gets a usable rect
 * instead of NaN.
 */
export function fitContain(contentWidth: number, contentHeight: number, box: Bounds): Bounds {
  if (
    !(contentWidth > 0) ||
    !(contentHeight > 0) ||
    !(box.width > 0) ||
    !(box.height > 0)
  ) {
    return { ...box };
  }
  const scaleFactor = Math.min(box.width / contentWidth, box.height / contentHeight);
  const width = contentWidth * scaleFactor;
  const height = contentHeight * scaleFactor;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** Returns the four corners of a bounds, in TL, TR, BR, BL order. */
export function boundsCorners(b: Bounds): [Point, Point, Point, Point] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.width, y: b.y },
    { x: b.x + b.width, y: b.y + b.height },
    { x: b.x, y: b.y + b.height },
  ];
}

/** The center of a bounds. */
export function boundsCenter(b: Bounds): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** True when `b` contains `p` (inclusive on the top/left, exclusive on far edges). */
export function boundsContains(b: Bounds, p: Point): boolean {
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

/** True when two bounds overlap. Touching edges do not count as overlap. */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Computes the axis-aligned bounding box of a bounds after a transform. */
export function transformBounds(t: AffineTransform, b: Bounds): Bounds {
  const corners = boundsCorners(b).map((p) => transformPoint(t, p));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The union of two bounds (the smallest bounds containing both). */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  const minX = Math.min(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxX = Math.max(a.x + a.width, b.x + b.width);
  const maxY = Math.max(a.y + a.height, b.y + b.height);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Vector addition. */
export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** Vector subtraction (a - b). */
export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** Scalar multiplication of a vector. */
export function scale(v: Vec2, s: number): Vec2 {
  return { x: v.x * s, y: v.y * s };
}

/** Squared length of a vector (avoids a sqrt for distance comparisons). */
export function lengthSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y;
}

/** Euclidean length of a vector. */
export function length(v: Vec2): number {
  return Math.sqrt(lengthSq(v));
}

/** Distance between two points. */
export function distance(a: Point, b: Point): number {
  return length(sub(a, b));
}

/** Linear interpolation between two points by t in [0, 1]. */
export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Clamps a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
