import { describe, expect, it } from "vitest";
import type { Point } from "@/src/domain/editor/geometry";
import {
  catmullRomSegments,
  cubicPoint,
  sampleSmoothedCenterline,
  smoothedPathData,
} from "./strokeSmoothing";

const pts: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 20 },
  { x: 30, y: 10 },
  { x: 50, y: 40 },
];

describe("catmullRomSegments", () => {
  it("produces n-1 segments through the input points (interpolation)", () => {
    const segs = catmullRomSegments(pts);
    expect(segs).toHaveLength(3);
    segs.forEach((s, i) => {
      expect(s.from).toEqual(pts[i]);
      expect(s.to).toEqual(pts[i + 1]);
    });
  });

  it("preserves the endpoints exactly", () => {
    const segs = catmullRomSegments(pts);
    expect(cubicPoint(segs[0], 0)).toEqual(pts[0]);
    const end = cubicPoint(segs[segs.length - 1], 1);
    expect(end.x).toBeCloseTo(pts[pts.length - 1].x, 10);
    expect(end.y).toBeCloseTo(pts[pts.length - 1].y, 10);
  });

  it("is C1-continuous at interior points (in/out tangents match)", () => {
    const segs = catmullRomSegments(pts);
    for (let i = 0; i < segs.length - 1; i++) {
      const a = segs[i];
      const b = segs[i + 1];
      // Incoming tangent at the joint: 3(to − c2); outgoing: 3(c1 − from).
      const inX = 3 * (a.to.x - a.c2.x);
      const inY = 3 * (a.to.y - a.c2.y);
      const outX = 3 * (b.c1.x - b.from.x);
      const outY = 3 * (b.c1.y - b.from.y);
      expect(inX).toBeCloseTo(outX, 10);
      expect(inY).toBeCloseTo(outY, 10);
    }
  });

  it("degenerate inputs: 0 or 1 point → no segments; 2 points → one segment", () => {
    expect(catmullRomSegments([])).toHaveLength(0);
    expect(catmullRomSegments([{ x: 1, y: 1 }])).toHaveLength(0);
    expect(catmullRomSegments([{ x: 0, y: 0 }, { x: 5, y: 5 }])).toHaveLength(1);
  });

  it("a 2-point stroke smooths to the straight chord", () => {
    const segs = catmullRomSegments([{ x: 0, y: 0 }, { x: 12, y: 0 }]);
    const mid = cubicPoint(segs[0], 0.5);
    expect(mid.x).toBeCloseTo(6, 10);
    expect(mid.y).toBeCloseTo(0, 10);
  });
});

describe("smoothedPathData", () => {
  it("emits one M plus a C per segment", () => {
    const d = smoothedPathData(pts);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect((d.match(/C/g) ?? []).length).toBe(3);
  });

  it("degenerate cases: empty string for none, a dot for one point", () => {
    expect(smoothedPathData([])).toBe("");
    expect(smoothedPathData([{ x: 3, y: 4 }])).toBe("M 3 4");
  });
});

describe("sampleSmoothedCenterline", () => {
  it("passes short polylines through unchanged", () => {
    const two: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
    const { points, widths } = sampleSmoothedCenterline(two, [2, 3]);
    expect(points).toBe(two);
    expect(widths).toEqual([2, 3]);
  });

  it("resamples n segments into n·samples + 1 points, endpoints preserved", () => {
    const { points } = sampleSmoothedCenterline(pts, undefined, 4);
    expect(points).toHaveLength(3 * 4 + 1);
    expect(points[0]).toEqual(pts[0]);
    expect(points[points.length - 1].x).toBeCloseTo(50, 10);
    expect(points[points.length - 1].y).toBeCloseTo(40, 10);
  });

  it("interpolates widths onto the samples (monotone between knots)", () => {
    const widths = [2, 4, 2, 6];
    const out = sampleSmoothedCenterline(pts, widths, 2);
    expect(out.widths).toHaveLength(7);
    expect(out.widths![0]).toBe(2);
    expect(out.widths![2]).toBeCloseTo(4, 10); // knot at segment end
    expect(out.widths![1]).toBeCloseTo(3, 10); // midpoint between 2 and 4
    expect(out.widths![6]).toBeCloseTo(6, 10);
  });
});
