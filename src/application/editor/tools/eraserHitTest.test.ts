import { describe, expect, it } from "vitest";
import { IDENTITY_TRANSFORM, compose, makeScale, makeTranslate } from "@/src/domain/editor/geometry";
import {
  DEFAULT_ERASER_RADIUS,
  MAX_ERASER_RADIUS,
  MIN_ERASER_RADIUS,
  clampEraserRadius,
  pointSegmentDistance,
  strokeIntersectsEraser,
  topmostErasableAt,
} from "./eraserHitTest";
import { makeDrawing, makeRect } from "@/src/domain/editor/testFactories";

describe("pointSegmentDistance", () => {
  it("perpendicular distance inside the segment span", () => {
    expect(pointSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 10);
  });

  it("distance to the nearest endpoint outside the span", () => {
    expect(pointSegmentDistance({ x: -4, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 10);
    expect(pointSegmentDistance({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 10);
  });

  it("degenerate zero-length segment measures to the point", () => {
    expect(pointSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 10);
  });
});

describe("strokeIntersectsEraser", () => {
  const stroke = {
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    transform: IDENTITY_TRANSFORM,
    style: { strokeWidth: 4 },
  };

  it("hits when the eraser circle touches the ink (radius + strokeWidth/2)", () => {
    // Ink edge at y = 2 (width 4); eraser radius 5 at y = 7 → touches exactly.
    expect(strokeIntersectsEraser(stroke, { x: 50, y: 7 }, 5)).toBe(true);
    expect(strokeIntersectsEraser(stroke, { x: 50, y: 7.01 }, 5)).toBe(false);
  });

  it("misses far away", () => {
    expect(strokeIntersectsEraser(stroke, { x: 50, y: 50 }, 5)).toBe(false);
  });

  it("maps the eraser through the object transform (translate)", () => {
    const moved = { ...stroke, transform: makeTranslate(200, 300) };
    expect(strokeIntersectsEraser(moved, { x: 250, y: 300 }, 5)).toBe(true);
    expect(strokeIntersectsEraser(moved, { x: 50, y: 0 }, 5)).toBe(false);
  });

  it("scales the eraser radius into local space (2x scale halves the local radius)", () => {
    const scaled = { ...stroke, transform: compose(makeTranslate(0, 0), makeScale(2, 2)) };
    // World y = 18: local point y = 9; local reach = 10/2 + 4/2 = 7 → miss.
    expect(strokeIntersectsEraser(scaled, { x: 100, y: 18 }, 10)).toBe(false);
    // World y = 13: local y = 6.5 ≤ 7 → hit.
    expect(strokeIntersectsEraser(scaled, { x: 100, y: 13 }, 10)).toBe(true);
  });

  it("uses the widest pressure width when widths are present", () => {
    const pressure = { ...stroke, widths: [4, 12] };
    // Reach = 5 + 12/2 = 11 → y = 10 hits (constant-width reach was 7).
    expect(strokeIntersectsEraser(pressure, { x: 50, y: 10 }, 5)).toBe(true);
  });

  it("single-point strokes are erasable as dots", () => {
    const dot = { ...stroke, points: [{ x: 10, y: 10 }] };
    expect(strokeIntersectsEraser(dot, { x: 12, y: 10 }, 4)).toBe(true);
    expect(strokeIntersectsEraser(dot, { x: 30, y: 10 }, 4)).toBe(false);
  });

  it("empty strokes and singular transforms never hit (and never throw)", () => {
    expect(strokeIntersectsEraser({ ...stroke, points: [] }, { x: 0, y: 0 }, 10)).toBe(false);
    const singular = { ...stroke, transform: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } };
    expect(strokeIntersectsEraser(singular, { x: 0, y: 0 }, 10)).toBe(false);
  });
});

describe("clampEraserRadius", () => {
  it("clamps into [MIN, MAX] and defaults non-finite input", () => {
    expect(clampEraserRadius(1)).toBe(MIN_ERASER_RADIUS);
    expect(clampEraserRadius(1000)).toBe(MAX_ERASER_RADIUS);
    expect(clampEraserRadius(20)).toBe(20);
    expect(clampEraserRadius(NaN)).toBe(DEFAULT_ERASER_RADIUS);
  });
});

describe("topmostErasableAt", () => {
  it("returns the topmost (last in paint order) object under the point", () => {
    const bottom = makeRect({ id: "bottom" }); // bounds 0,0 80x60
    const top = makeRect({ id: "top" });
    expect(topmostErasableAt([bottom, top], { x: 10, y: 10 }, 0)).toBe("top");
  });

  it("skips hidden objects", () => {
    const hidden = makeRect({ id: "hidden", visible: false });
    const under = makeRect({ id: "under" });
    expect(topmostErasableAt([under, hidden], { x: 10, y: 10 }, 0)).toBe("under");
  });

  it("skips locked objects", () => {
    const locked = makeRect({ id: "locked", locked: true });
    expect(topmostErasableAt([locked], { x: 10, y: 10 }, 0)).toBeNull();
  });

  it("hits drawings by their ink, not their bounding box", () => {
    // Diagonal stroke 0,0→50,50; the point 40,10 is inside the bbox but ~21
    // units from the ink, so a small eraser misses it.
    const stroke = makeDrawing({ id: "stroke" });
    expect(topmostErasableAt([stroke], { x: 40, y: 10 }, 2)).toBeNull();
    expect(topmostErasableAt([stroke], { x: 25, y: 25 }, 2)).toBe("stroke");
  });

  it("suppresses ids already erased in the same gesture", () => {
    const rect = makeRect({ id: "r1" });
    expect(topmostErasableAt([rect], { x: 10, y: 10 }, 0, new Set(["r1"]))).toBeNull();
  });

  it("returns null over empty space", () => {
    const rect = makeRect({ id: "r1" });
    expect(topmostErasableAt([rect], { x: 500, y: 500 }, 4)).toBeNull();
  });

  it("expands non-drawing hits by the eraser radius", () => {
    const rect = makeRect({ id: "r1" }); // right edge at x=80
    expect(topmostErasableAt([rect], { x: 88, y: 10 }, 10)).toBe("r1");
    expect(topmostErasableAt([rect], { x: 95, y: 10 }, 10)).toBeNull();
  });
});
