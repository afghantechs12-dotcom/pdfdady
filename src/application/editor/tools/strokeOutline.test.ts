import { describe, expect, it } from "vitest";
import type { Point } from "@/src/domain/editor/geometry";
import { pathDataBounds } from "@/src/domain/editor/shapeGeometry";
import {
  MIN_STROKE_WIDTH,
  PRESSURE_MAX_FACTOR,
  PRESSURE_MIN_FACTOR,
  buildStrokeOutline,
  computePressureWidths,
} from "./strokeOutline";

describe("computePressureWidths", () => {
  it("returns one width per point", () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(computePressureWidths(pts, 4)).toHaveLength(3);
  });

  it("slow (dense) points are thicker than fast (sparse) points", () => {
    const slow: Point[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }];
    const fast: Point[] = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 120, y: 0 }];
    const wSlow = computePressureWidths(slow, 4);
    const wFast = computePressureWidths(fast, 4);
    expect(wSlow[1]).toBeGreaterThan(wFast[1]);
  });

  it("clamps factors into [MIN, MAX] · baseWidth", () => {
    const glacial: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    const flick: Point[] = [{ x: 0, y: 0 }, { x: 10000, y: 0 }];
    expect(computePressureWidths(glacial, 4)[0]).toBeCloseTo(4 * PRESSURE_MAX_FACTOR, 6);
    expect(computePressureWidths(flick, 4)[0]).toBeCloseTo(4 * PRESSURE_MIN_FACTOR, 6);
  });

  it("is deterministic (same input → identical output)", () => {
    const pts: Point[] = [{ x: 0, y: 0 }, { x: 7, y: 3 }, { x: 9, y: 12 }];
    expect(computePressureWidths(pts, 3)).toEqual(computePressureWidths(pts, 3));
  });

  it("handles degenerate inputs", () => {
    expect(computePressureWidths([], 4)).toEqual([]);
    expect(computePressureWidths([{ x: 1, y: 1 }], 4)).toEqual([4]);
    // Non-finite base width falls back to 1, still ≥ MIN_STROKE_WIDTH.
    const w = computePressureWidths([{ x: 0, y: 0 }, { x: 1, y: 0 }], NaN);
    expect(w.every((v) => v >= MIN_STROKE_WIDTH)).toBe(true);
  });
});

describe("buildStrokeOutline", () => {
  it("produces a closed path (starts M, ends Z)", () => {
    const d = buildStrokeOutline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      [4, 4, 4],
    )!;
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("a straight horizontal stroke of uniform width w has outline height w", () => {
    const d = buildStrokeOutline(
      [{ x: 0, y: 10 }, { x: 50, y: 10 }, { x: 100, y: 10 }],
      [6, 6, 6],
    )!;
    const b = pathDataBounds(d)!;
    expect(b.height).toBeCloseTo(6, 6);
    expect(b.y).toBeCloseTo(7, 6); // centered about y = 10
    expect(b.width).toBeCloseTo(100, 6);
  });

  it("the outline is symmetric about the centerline", () => {
    const d = buildStrokeOutline([{ x: 0, y: 0 }, { x: 100, y: 0 }], [8, 8])!;
    const b = pathDataBounds(d)!;
    expect(b.y).toBeCloseTo(-4, 6);
    expect(b.y + b.height).toBeCloseTo(4, 6);
  });

  it("clamps invalid widths up to MIN_STROKE_WIDTH", () => {
    const d = buildStrokeOutline([{ x: 0, y: 0 }, { x: 10, y: 0 }], [0, NaN])!;
    const b = pathDataBounds(d)!;
    expect(b.height).toBeCloseTo(MIN_STROKE_WIDTH, 6);
  });

  it("repeats the last width when widths run short", () => {
    const d = buildStrokeOutline(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
      [4],
    )!;
    const b = pathDataBounds(d)!;
    expect(b.height).toBeCloseTo(4, 6);
  });

  it("returns null for fewer than 2 points or an all-identical polyline", () => {
    expect(buildStrokeOutline([], [])).toBeNull();
    expect(buildStrokeOutline([{ x: 5, y: 5 }], [4])).toBeNull();
    expect(buildStrokeOutline([{ x: 5, y: 5 }, { x: 5, y: 5 }], [4, 4])).toBeNull();
  });
});
