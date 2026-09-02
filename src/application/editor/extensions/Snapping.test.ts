import { describe, expect, it } from "vitest";
import {
  CompositeSnapEngine,
  GridSnapStrategy,
  NoopSnapEngine,
  unsnapped,
  type SnapRequest,
  type SnapStrategy,
} from "./Snapping";

const req = (pointer: { x: number; y: number }, threshold = 5): SnapRequest => ({
  pointer,
  draggedIds: [],
  threshold,
  zoom: 1,
});

describe("Snapping: GridSnapStrategy", () => {
  it("snaps to the nearest grid intersection within threshold", () => {
    const grid = new GridSnapStrategy(10);
    const result = grid.snap(req({ x: 23, y: 27 }));
    expect(result?.point).toEqual({ x: 20, y: 30 });
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("grid");
  });

  it("returns null when the nearest grid point is outside the threshold", () => {
    const grid = new GridSnapStrategy(10);
    // Pointer (28,28): nearest grid point is (30,30), dx=dy=2. With threshold 1
    // the per-axis distance (2) exceeds the tolerance → no snap.
    expect(grid.snap(req({ x: 28, y: 28 }, 1))).toBeNull();
    // And a point that DOES snap at a larger threshold: (22,22) → (20,20), dx=-2.
    expect(grid.snap(req({ x: 22, y: 22 }, 3))?.point).toEqual({ x: 20, y: 20 });
  });

  it("honors a grid offset", () => {
    const grid = new GridSnapStrategy(10, { x: 5, y: 5 });
    const result = grid.snap(req({ x: 26, y: 26 }));
    // Grid lines at 5,15,25,35 → 26 snaps to 25.
    expect(result?.point).toEqual({ x: 25, y: 25 });
  });

  it("rejects a non-positive grid size", () => {
    expect(() => new GridSnapStrategy(0)).toThrow();
    expect(() => new GridSnapStrategy(-5)).toThrow();
  });
});

describe("Snapping: engines", () => {
  it("NoopSnapEngine never snaps", () => {
    const engine = new NoopSnapEngine();
    const result = engine.snap(req({ x: 23, y: 23 }));
    expect(result.active).toBe(false);
    expect(result.point).toEqual({ x: 23, y: 23 });
  });

  it("unsnapped helper returns an inactive result at the pointer", () => {
    expect(unsnapped({ x: 1, y: 2 })).toEqual({ point: { x: 1, y: 2 }, dx: 0, dy: 0, active: false, source: "" });
  });

  it("CompositeSnapEngine picks the closest snap among strategies", () => {
    // Two grids: a 10-unit grid (snaps 23→20, dx=-3) and a 5-unit grid (snaps 23→25, dx=+2).
    const engine = new CompositeSnapEngine([
      new GridSnapStrategy(10),
      new GridSnapStrategy(5),
    ]);
    const result = engine.snap(req({ x: 23, y: 23 }));
    // The 5-grid is closer (dx=2 vs dx=-3) → snaps to (25,25).
    expect(result.point).toEqual({ x: 25, y: 25 });
    expect(result.active).toBe(true);
  });

  it("CompositeSnapEngine returns unsnapped when nothing is within threshold", () => {
    const engine = new CompositeSnapEngine([new GridSnapStrategy(100)]);
    const result = engine.snap(req({ x: 23, y: 23 }, 5));
    expect(result.active).toBe(false);
  });

  it("CompositeSnapEngine with no strategies is a no-op", () => {
    const engine = new CompositeSnapEngine([]);
    expect(engine.snap(req({ x: 9, y: 9 })).active).toBe(false);
  });

  it("a custom strategy integrates via the composite", () => {
    const marginStrategy: SnapStrategy = {
      id: "margin",
      snap: (r) => {
        if (Math.abs(r.pointer.x) <= r.threshold) {
          return { point: { x: 0, y: r.pointer.y }, dx: -r.pointer.x, dy: 0, active: true, source: "margin" };
        }
        return null;
      },
    };
    const engine = new CompositeSnapEngine([marginStrategy]);
    expect(engine.snap(req({ x: 3, y: 40 })).point).toEqual({ x: 0, y: 40 });
    expect(engine.snap(req({ x: 30, y: 40 }, 5)).active).toBe(false);
  });
});
