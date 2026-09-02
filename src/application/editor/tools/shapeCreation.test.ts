import { describe, expect, it } from "vitest";

import {
  SHAPE_DEFAULT_MAX,
  SHAPE_DEFAULT_MIN,
  SHAPE_DRAG_THRESHOLD,
  SHAPE_MIN_EXTENT,
  clampToPage,
  defaultShapeSize,
  isPointOnPage,
  isShapeDrag,
  scaleToBounds,
  shapeClickBounds,
  shapeDragBounds,
} from "@/src/application/editor/tools/shapeCreation";
import { makeBounds } from "@/src/domain/editor/geometry";

const A4 = { width: 595, height: 842 };

describe("isShapeDrag", () => {
  it("treats a still pointer as a click", () => {
    expect(isShapeDrag({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false);
  });

  it("treats a small twitch as a click, not a 3x3 shape", () => {
    // The defect this prevents: a 3px tremor during a click used to commit a
    // near-invisible object.
    expect(isShapeDrag({ x: 100, y: 100 }, { x: 102, y: 102 })).toBe(false);
  });

  it("treats travel at or beyond the threshold as a drag", () => {
    expect(isShapeDrag({ x: 0, y: 0 }, { x: SHAPE_DRAG_THRESHOLD, y: 0 })).toBe(true);
    expect(isShapeDrag({ x: 0, y: 0 }, { x: 40, y: 30 })).toBe(true);
  });

  it("measures distance, not per-axis delta (diagonal counts)", () => {
    expect(isShapeDrag({ x: 0, y: 0 }, { x: 5, y: 5 })).toBe(true); // hypot ~7.07
  });
});

describe("defaultShapeSize", () => {
  it("scales with the page's shorter dimension", () => {
    expect(defaultShapeSize(A4)).toBeCloseTo(595 * 0.18, 5);
  });

  it("never exceeds the maximum on a huge page", () => {
    expect(defaultShapeSize({ width: 5000, height: 5000 })).toBe(SHAPE_DEFAULT_MAX);
  });

  it("never drops below the minimum on a small page", () => {
    expect(defaultShapeSize({ width: 200, height: 120 })).toBe(SHAPE_DEFAULT_MIN);
  });

  it("still fits a page smaller than the minimum", () => {
    const size = defaultShapeSize({ width: 30, height: 20 });
    expect(size).toBeLessThanOrEqual(20);
  });

  it("survives a degenerate page", () => {
    expect(defaultShapeSize({ width: 0, height: 0 })).toBe(SHAPE_DEFAULT_MIN);
    expect(defaultShapeSize({ width: Number.NaN, height: 10 })).toBe(SHAPE_DEFAULT_MIN);
  });
});

describe("isPointOnPage", () => {
  it("accepts points on the page including its edges", () => {
    expect(isPointOnPage({ x: 0, y: 0 }, A4)).toBe(true);
    expect(isPointOnPage({ x: 595, y: 842 }, A4)).toBe(true);
    expect(isPointOnPage({ x: 300, y: 400 }, A4)).toBe(true);
  });

  it("rejects the surrounding workspace", () => {
    // The measured defect: a drag started 32px left of the page created an object
    // in the gray canvas.
    expect(isPointOnPage({ x: -1, y: 400 }, A4)).toBe(false);
    expect(isPointOnPage({ x: -32, y: 400 }, A4)).toBe(false);
    expect(isPointOnPage({ x: 300, y: -5 }, A4)).toBe(false);
    expect(isPointOnPage({ x: 596, y: 400 }, A4)).toBe(false);
    expect(isPointOnPage({ x: 300, y: 843 }, A4)).toBe(false);
  });

  it("rejects non-finite coordinates", () => {
    expect(isPointOnPage({ x: Number.NaN, y: 5 }, A4)).toBe(false);
    expect(isPointOnPage({ x: 5, y: Number.POSITIVE_INFINITY }, A4)).toBe(false);
  });
});

describe("clampToPage", () => {
  it("leaves on-page points untouched", () => {
    expect(clampToPage({ x: 120, y: 300 }, A4)).toEqual({ x: 120, y: 300 });
  });

  it("stops a drag that leaves the page at the page edge", () => {
    expect(clampToPage({ x: -50, y: 900 }, A4)).toEqual({ x: 0, y: 842 });
    expect(clampToPage({ x: 700, y: -10 }, A4)).toEqual({ x: 595, y: 0 });
  });
});

describe("shapeDragBounds", () => {
  it("honours the dragged rectangle exactly", () => {
    // The core agreement the 1.2x defect broke: what you drag is what you get.
    expect(shapeDragBounds({ x: 100, y: 120 }, { x: 219, y: 221 }, A4)).toEqual(
      makeBounds(100, 120, 119, 101),
    );
  });

  it("normalizes a drag in any direction", () => {
    const downRight = shapeDragBounds({ x: 100, y: 100 }, { x: 200, y: 180 }, A4);
    const upLeft = shapeDragBounds({ x: 200, y: 180 }, { x: 100, y: 100 }, A4);
    expect(upLeft).toEqual(downRight);
    expect(upLeft).toEqual(makeBounds(100, 100, 100, 80));
  });

  it("clamps a drag that runs off the page", () => {
    const b = shapeDragBounds({ x: 500, y: 800 }, { x: 900, y: 1200 }, A4);
    expect(b.x + b.width).toBeLessThanOrEqual(A4.width);
    expect(b.y + b.height).toBeLessThanOrEqual(A4.height);
  });

  it("never commits a zero-area object", () => {
    const b = shapeDragBounds({ x: 300, y: 300 }, { x: 300, y: 300 }, A4);
    expect(b.width).toBeGreaterThanOrEqual(SHAPE_MIN_EXTENT);
    expect(b.height).toBeGreaterThanOrEqual(SHAPE_MIN_EXTENT);
  });

  it("never commits a 1-dimensional sliver from a purely horizontal drag", () => {
    const b = shapeDragBounds({ x: 100, y: 300 }, { x: 260, y: 300 }, A4);
    expect(b.width).toBe(160);
    expect(b.height).toBeGreaterThanOrEqual(SHAPE_MIN_EXTENT);
  });
});

describe("shapeClickBounds", () => {
  it("centres the shape on the click", () => {
    const b = shapeClickBounds({ x: 300, y: 400 }, 100, A4);
    expect(b.x + b.width / 2).toBeCloseTo(300, 5);
    expect(b.y + b.height / 2).toBeCloseTo(400, 5);
  });

  it("pulls a shape clicked near an edge back onto the page", () => {
    const b = shapeClickBounds({ x: 590, y: 838 }, 100, A4);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(A4.width);
    expect(b.y + b.height).toBeLessThanOrEqual(A4.height);
  });

  it("keeps a shape clicked at the origin fully on the page", () => {
    const b = shapeClickBounds({ x: 0, y: 0 }, 100, A4);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
  });

  it("shrinks to fit a page smaller than the requested size", () => {
    const b = shapeClickBounds({ x: 10, y: 10 }, 500, { width: 80, height: 60 });
    expect(b.width).toBeLessThanOrEqual(80);
    expect(b.height).toBeLessThanOrEqual(60);
  });
});

describe("scaleToBounds", () => {
  it("derives the scale from the object's own bounds, not a constant", () => {
    // The regression guard. A 120-wide factory default dragged to 119 wide must
    // scale by 119/120, NOT by 119/100 (which is what shipped: 143px for a
    // 119px drag).
    const { sx, sy } = scaleToBounds(makeBounds(0, 0, 120, 120), makeBounds(0, 0, 119, 101));
    expect(120 * sx).toBeCloseTo(119, 5);
    expect(120 * sy).toBeCloseTo(101, 5);
  });

  it("is correct for a highlight's non-square factory bounds", () => {
    // Highlight defaults to 160x28; the old constant made it 1.6x wide, 0.28x tall.
    const base = makeBounds(0, 0, 160, 28);
    const { sx, sy } = scaleToBounds(base, makeBounds(0, 0, 200, 40));
    expect(160 * sx).toBeCloseTo(200, 5);
    expect(28 * sy).toBeCloseTo(40, 5);
  });

  it("is identity when the target equals the base", () => {
    const base = makeBounds(0, 0, 120, 120);
    expect(scaleToBounds(base, base)).toEqual({ sx: 1, sy: 1 });
  });

  it("yields a finite scale for degenerate base bounds", () => {
    const { sx, sy } = scaleToBounds(makeBounds(0, 0, 0, 0), makeBounds(0, 0, 50, 50));
    expect(Number.isFinite(sx)).toBe(true);
    expect(Number.isFinite(sy)).toBe(true);
    expect(sx).toBe(1);
    expect(sy).toBe(1);
  });

  it("round-trips any drag: base scaled by the result equals the dragged box", () => {
    const base = makeBounds(0, 0, 120, 120);
    for (const target of [
      makeBounds(0, 0, 10, 300),
      makeBounds(0, 0, 447, 12),
      makeBounds(0, 0, 120, 120),
    ]) {
      const { sx, sy } = scaleToBounds(base, target);
      expect(base.width * sx).toBeCloseTo(target.width, 5);
      expect(base.height * sy).toBeCloseTo(target.height, 5);
    }
  });
});
