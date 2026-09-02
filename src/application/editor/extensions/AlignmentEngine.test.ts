import { describe, expect, it } from "vitest";
import type { Bounds, Vec2 } from "@/src/domain/editor/geometry";
import {
  alignToEdge,
  distributeObjects,
  SmartAlignmentEngine,
  type AlignmentTarget,
} from "./AlignmentEngine";

const b = (x: number, y: number, w: number, h: number): Bounds => ({ x, y, width: w, height: h });

/** Applies a list of deltas to a list of bounds, returning the moved bounds. */
const moved = (bounds: Bounds[], deltas: Vec2[]): Bounds[] =>
  bounds.map((bd, i) => ({ x: bd.x + deltas[i].x, y: bd.y + deltas[i].y, width: bd.width, height: bd.height }));

describe("SmartAlignmentEngine.suggestions", () => {
  it("returns no suggestions for 0 or 1 bounds", () => {
    expect(new SmartAlignmentEngine().suggestions([])).toEqual([]);
    expect(new SmartAlignmentEngine().suggestions([b(0, 0, 10, 10)])).toEqual([]);
  });

  it("derives the six alignment lines from the union bounds", () => {
    // Union: x=0, y=5, width=30, height=20 → right=30, bottom=25, center=(15,15).
    const suggestions = new SmartAlignmentEngine().suggestions([b(0, 5, 10, 20), b(20, 5, 10, 20)]);
    expect(suggestions).toEqual([
      { target: "left", position: 0 },
      { target: "right", position: 30 },
      { target: "top", position: 5 },
      { target: "bottom", position: 25 },
      { target: "centerX", position: 15 },
      { target: "centerY", position: 15 },
    ]);
  });

  it("computes the union over three dispersed objects", () => {
    const suggestions = new SmartAlignmentEngine().suggestions([
      b(0, 0, 10, 10),
      b(40, 30, 10, 10),
      b(90, 0, 10, 10),
    ]);
    // Union: x=0, y=0, width=100, height=40 → center=(50,20).
    const byTarget = Object.fromEntries(suggestions.map((s) => [s.target, s.position]));
    expect(byTarget).toEqual({ left: 0, right: 100, top: 0, bottom: 40, centerX: 50, centerY: 20 });
  });
});

describe("alignToEdge", () => {
  // Two 10x10 squares: A at (0,0), B at (20,20). Union: (0,0,30,30); center=(15,15).
  const objs = [b(0, 0, 10, 10), b(20, 20, 10, 10)];

  it.each<[AlignmentTarget, Vec2[]]>([
    ["left", [{ x: 0, y: 0 }, { x: -20, y: 0 }]],
    ["right", [{ x: 20, y: 0 }, { x: 0, y: 0 }]],
    ["top", [{ x: 0, y: 0 }, { x: 0, y: -20 }]],
    ["bottom", [{ x: 0, y: 20 }, { x: 0, y: 0 }]],
    ["centerX", [{ x: 10, y: 0 }, { x: -10, y: 0 }]],
    ["centerY", [{ x: 0, y: 10 }, { x: 0, y: -10 }]],
  ])('aligns "%s" so each object matches the union line', (edge, expected) => {
    const deltas = alignToEdge(objs, edge);
    expect(deltas).toEqual(expected);

    // After applying the deltas, every object's aligned edge/center coincides —
    // the defining invariant of an alignment operation.
    const after = moved(objs, deltas);
    const edgeOf = (bd: Bounds): number =>
      edge === "left" ? bd.x
      : edge === "right" ? bd.x + bd.width
      : edge === "top" ? bd.y
      : edge === "bottom" ? bd.y + bd.height
      : edge === "centerX" ? bd.x + bd.width / 2
      : bd.y + bd.height / 2;
    const values = after.map(edgeOf);
    expect(values.every((v) => Math.abs(v - values[0]) < 1e-9)).toBe(true);
  });

  it("returns an empty list for no objects, and a zero delta for a single object", () => {
    expect(alignToEdge([], "left")).toEqual([]);
    expect(alignToEdge([b(5, 5, 10, 10)], "centerX")).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("distributeObjects", () => {
  it("returns zero deltas for fewer than three objects", () => {
    expect(distributeObjects([], "horizontal")).toEqual([]);
    expect(distributeObjects([b(0, 0, 10, 10)], "horizontal")).toEqual([{ x: 0, y: 0 }]);
    expect(distributeObjects([b(0, 0, 10, 10), b(20, 0, 10, 10)], "horizontal")).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    expect(distributeObjects([b(0, 0, 10, 10), b(0, 20, 10, 10)], "vertical")).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });

  it("spaces four objects with equal gaps and keeps the endpoints fixed", () => {
    // Four 10-wide squares; union runs 0..310. totalSize=40 → gap=(310-40)/3=90.
    const objs = [b(0, 0, 10, 10), b(20, 0, 10, 10), b(80, 0, 10, 10), b(300, 0, 10, 10)];
    const deltas = distributeObjects(objs, "horizontal");

    // Expected targets: 0, 100, 200, 300 → deltas 0, 80, 120, 0.
    expect(deltas).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 120, y: 0 },
      { x: 0, y: 0 },
    ]);

    // Gaps between successive (sorted-by-x) objects must all equal 90.
    const after = moved(objs, deltas).sort((p, q) => p.x - q.x);
    const gaps = after.slice(1).map((bd, i) => bd.x - (after[i].x + after[i].width));
    expect(gaps).toEqual([90, 90, 90]);
  });

  it("returns deltas in the original input order, not the sorted order", () => {
    // Same four objects, shuffled: [obj2(80), obj0(0), obj3(300), obj1(20)].
    const objs = [b(80, 0, 10, 10), b(0, 0, 10, 10), b(300, 0, 10, 10), b(20, 0, 10, 10)];
    const deltas = distributeObjects(objs, "horizontal");

    // Sorted targets: obj0→0 (Δ0), obj1→100 (Δ80), obj2→200 (Δ120), obj3→300 (Δ0).
    // Re-ordered to input [obj2, obj0, obj3, obj1] → [120, 0, 0, 80].
    expect(deltas).toEqual([
      { x: 120, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 80, y: 0 },
    ]);

    // After applying, all gaps are equal regardless of input order.
    const after = moved(objs, deltas).sort((p, q) => p.x - q.x);
    const gaps = after.slice(1).map((bd, i) => bd.x - (after[i].x + after[i].width));
    expect(gaps).toEqual([90, 90, 90]);
  });

  it("distributes vertically along the y axis", () => {
    const objs = [b(0, 0, 10, 10), b(0, 20, 10, 10), b(0, 80, 10, 10), b(0, 300, 10, 10)];
    const deltas = distributeObjects(objs, "vertical");
    expect(deltas.every((d) => d.x === 0)).toBe(true);

    const after = moved(objs, deltas).sort((p, q) => p.y - q.y);
    const gaps = after.slice(1).map((bd, i) => bd.y - (after[i].y + after[i].height));
    expect(gaps).toEqual([90, 90, 90]);
  });
});
