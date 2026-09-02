import { describe, expect, it } from "vitest";
import {
  IDENTITY_TRANSFORM,
  add,
  boundsCenter,
  boundsContains,
  boundsCorners,
  boundsIntersect,
  clamp,
  compose,
  decompose,
  distance,
  fitContain,
  invert,
  length,
  lengthSq,
  lerp,
  makeBounds,
  makeRotate,
  makeScale,
  makeTranslate,
  sub,
  transformBounds,
  transformPoint,
  transformsEqual,
  unionBounds,
} from "./geometry";

describe("geometry: affine transforms", () => {
  it("identity leaves a point unchanged", () => {
    expect(transformPoint(IDENTITY_TRANSFORM, { x: 3, y: 5 })).toEqual({ x: 3, y: 5 });
  });

  it("translates a point", () => {
    expect(transformPoint(makeTranslate(10, -4), { x: 1, y: 1 })).toEqual({
      x: 11,
      y: -3,
    });
  });

  it("scales a point", () => {
    expect(transformPoint(makeScale(2, 3), { x: 4, y: 5 })).toEqual({ x: 8, y: 15 });
  });

  it("rotates a point 90° clockwise (y-down)", () => {
    const t = makeRotate(Math.PI / 2);
    const p = transformPoint(t, { x: 1, y: 0 });
    // +90° about origin sends (1,0) → (0,1).
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });

  it("compose applies inner first, then outer", () => {
    const scale = makeScale(2, 2);
    const translate = makeTranslate(10, 0);
    const composed = compose(translate, scale);
    // scale(1,1) -> (2,2), then translate -> (12,2).
    expect(transformPoint(composed, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 });
  });

  it("invert reverses a transform", () => {
    const t = compose(makeTranslate(5, 7), compose(makeRotate(0.3), makeScale(2, 4)));
    const inv = invert(t);
    const p = { x: 11, y: -3 };
    const roundTrip = transformPoint(inv, transformPoint(t, p));
    expect(roundTrip.x).toBeCloseTo(p.x, 9);
    expect(roundTrip.y).toBeCloseTo(p.y, 9);
  });

  it("invert throws for a singular (zero-scale) transform", () => {
    expect(() => invert(makeScale(0, 1))).toThrow(/singular/);
  });

  it("transformsEqual distinguishes near-equal from different", () => {
    const t = makeTranslate(1, 2);
    expect(transformsEqual(t, makeTranslate(1, 2))).toBe(true);
    expect(transformsEqual(t, makeTranslate(1, 3))).toBe(false);
  });

  it("decompose recovers translate, scale, rotation", () => {
    const t = compose(makeTranslate(10, 20), compose(makeRotate(0.5), makeScale(3, 2)));
    const d = decompose(t);
    expect(d.translate.x).toBeCloseTo(10, 6);
    expect(d.translate.y).toBeCloseTo(20, 6);
    expect(d.scale.x).toBeCloseTo(3, 6);
    expect(d.scale.y).toBeCloseTo(2, 6);
    expect(d.rotation).toBeCloseTo(0.5, 6);
  });
});

describe("geometry: bounds", () => {
  it("reports corners in TL,TR,BR,BL order", () => {
    const c = boundsCorners(makeBounds(0, 0, 10, 20));
    expect(c).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ]);
  });

  it("center is the midpoint", () => {
    expect(boundsCenter(makeBounds(0, 0, 10, 20))).toEqual({ x: 5, y: 10 });
  });

  it("contains is inclusive top-left, exclusive far edges", () => {
    const b = makeBounds(0, 0, 10, 10);
    expect(boundsContains(b, { x: 0, y: 0 })).toBe(true);
    expect(boundsContains(b, { x: 9.99, y: 9.99 })).toBe(true);
    expect(boundsContains(b, { x: 10, y: 0 })).toBe(false);
    expect(boundsContains(b, { x: -0.01, y: 0 })).toBe(false);
  });

  it("intersect requires real overlap", () => {
    expect(boundsIntersect(makeBounds(0, 0, 10, 10), makeBounds(5, 5, 10, 10))).toBe(true);
    expect(boundsIntersect(makeBounds(0, 0, 10, 10), makeBounds(10, 0, 10, 10))).toBe(false);
  });

  it("transformBounds of a rotated rect is the axis-aligned envelope", () => {
    const b = makeBounds(0, 0, 10, 4);
    const env = transformBounds(makeRotate(Math.PI / 2), b);
    // 90° rotation of a 10x4 rect about origin → envelope 4 wide, 10 tall.
    expect(env.width).toBeCloseTo(4, 6);
    expect(env.height).toBeCloseTo(10, 6);
  });

  it("unionBounds contains both", () => {
    const u = unionBounds(makeBounds(0, 0, 5, 5), makeBounds(10, 10, 5, 5));
    expect(u).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });
});

describe("geometry: vectors", () => {
  it("add/sub/scale/length", () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(sub({ x: 3, y: 4 }, { x: 1, y: 1 })).toEqual({ x: 2, y: 3 });
    expect(lengthSq({ x: 3, y: 4 })).toBe(25);
    expect(length({ x: 3, y: 4 })).toBe(5);
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("lerp interpolates", () => {
    expect(lerp({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
  });

  it("clamp bounds a value", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("geometry: fitContain", () => {
  const box = makeBounds(10, 20, 200, 100);

  it("returns the box unchanged when the aspect ratios already match", () => {
    // The insertion case: createSignature/createImage derive localBounds FROM
    // the natural size, so fitting is a no-op and nothing shifts on screen.
    expect(fitContain(400, 200, box)).toEqual({ x: 10, y: 20, width: 200, height: 100 });
  });

  it("letterboxes a tall asset: full height, centred horizontally", () => {
    const r = fitContain(100, 200, box); // asset 1:2 in a 2:1 box
    expect(r.height).toBe(100);
    expect(r.width).toBe(50);
    expect(r.y).toBe(20);
    expect(r.x).toBe(10 + (200 - 50) / 2);
  });

  it("letterboxes a wide asset: full width, centred vertically", () => {
    const r = fitContain(400, 100, box); // asset 4:1 in a 2:1 box
    expect(r.width).toBe(200);
    expect(r.height).toBe(50);
    expect(r.x).toBe(10);
    expect(r.y).toBe(20 + (100 - 50) / 2);
  });

  it("preserves the asset's aspect ratio exactly", () => {
    for (const [w, h] of [[96, 96], [1920, 1080], [3, 7], [640, 480]]) {
      const r = fitContain(w, h, box);
      expect(r.width / r.height).toBeCloseTo(w / h, 10);
    }
  });

  it("never exceeds the box", () => {
    for (const [w, h] of [[96, 96], [1920, 1080], [3, 7], [10000, 1]]) {
      const r = fitContain(w, h, box);
      expect(r.width).toBeLessThanOrEqual(box.width + 1e-9);
      expect(r.height).toBeLessThanOrEqual(box.height + 1e-9);
      expect(r.x).toBeGreaterThanOrEqual(box.x - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(box.y - 1e-9);
      expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width + 1e-9);
      expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height + 1e-9);
    }
  });

  it("stays centred in the box", () => {
    const r = fitContain(96, 96, box);
    expect(r.x + r.width / 2).toBeCloseTo(box.x + box.width / 2, 10);
    expect(r.y + r.height / 2).toBeCloseTo(box.y + box.height / 2, 10);
  });

  it("upscales a small asset to fill the box (contain, not shrink-only)", () => {
    const r = fitContain(10, 10, box);
    expect(r.height).toBe(100);
    expect(r.width).toBe(100);
  });

  it("falls back to the box for degenerate inputs rather than producing NaN", () => {
    // A caller with unknown natural dimensions must still get a usable rect.
    for (const [w, h] of [[0, 100], [100, 0], [-5, 100], [Number.NaN, 100]]) {
      expect(fitContain(w, h, box)).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    }
    expect(fitContain(100, 100, makeBounds(0, 0, 0, 50))).toEqual({ x: 0, y: 0, width: 0, height: 50 });
  });

  it("does not alias the input box", () => {
    const r = fitContain(400, 200, box);
    expect(r).not.toBe(box);
  });
});
