import { describe, expect, it } from "vitest";
import { InMemoryGuideEngine } from "./Extensions";
import { type SnapRequest } from "./Snapping";
import {
  CenterSnapStrategy,
  createDefaultSnapStrategies,
  GuideSnapStrategy,
  MarginSnapStrategy,
  ObjectSnapStrategy,
  PageSnapStrategy,
} from "./SnapStrategies";
import type { Bounds } from "@/src/domain/editor/geometry";

/** Builds a SnapRequest with sensible defaults (threshold 5, zoom 1, no dragged ids). */
const req = (
  pointer: { x: number; y: number },
  opts: { threshold?: number; draggedIds?: string[] } = {},
): SnapRequest => ({
  pointer,
  draggedIds: opts.draggedIds ?? [],
  threshold: opts.threshold ?? 5,
  zoom: 1,
});

/** Bounds literal helper — keeps object fixtures terse and readable. */
const bounds = (x: number, y: number, width: number, height: number): Bounds => ({
  x,
  y,
  width,
  height,
});

describe("SnapStrategies: PageSnapStrategy", () => {
  it("snaps x to 0 when the pointer is near the left edge", () => {
    const page = new PageSnapStrategy({ width: 200, height: 300 });
    const result = page.snap(req({ x: 3, y: 150 }));
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("page");
    expect(result?.point).toEqual({ x: 0, y: 150 });
    expect(result?.dx).toBe(-3);
    expect(result?.dy).toBe(0);
  });

  it("snaps x to width when the pointer is near the right edge", () => {
    const page = new PageSnapStrategy({ width: 200, height: 300 });
    const result = page.snap(req({ x: 197, y: 150 }));
    expect(result?.point).toEqual({ x: 200, y: 150 });
    expect(result?.dx).toBe(3);
  });

  it("snaps y to 0 when the pointer is near the top edge (partial-axis snap)", () => {
    const page = new PageSnapStrategy({ width: 200, height: 300 });
    const result = page.snap(req({ x: 100, y: 2 }));
    expect(result?.active).toBe(true);
    expect(result?.point).toEqual({ x: 100, y: 0 });
    expect(result?.dx).toBe(0);
    expect(result?.dy).toBe(-2);
  });

  it("returns null when the pointer is far from every edge on both axes", () => {
    const page = new PageSnapStrategy({ width: 200, height: 300 });
    expect(page.snap(req({ x: 100, y: 150 }))).toBeNull();
  });

  it("returns null on one axis while snapping the other (partial snap leaves the far axis unchanged)", () => {
    const page = new PageSnapStrategy({ width: 200, height: 300 });
    // x near 0, y in the middle of nowhere → only x snaps, y is untouched.
    const result = page.snap(req({ x: 4, y: 150 }));
    expect(result?.active).toBe(true);
    expect(result?.point).toEqual({ x: 0, y: 150 });
    expect(result?.dy).toBe(0);
  });

  it("honors a constructor threshold that overrides the request threshold", () => {
    // Request threshold 5 would not snap a pointer at x=8 (abs 8 > 5), but the
    // constructor override of 10 should still snap it to 0.
    const page = new PageSnapStrategy({ width: 200, height: 300 }, 10);
    const result = page.snap(req({ x: 8, y: 150 }, { threshold: 5 }));
    expect(result?.active).toBe(true);
    expect(result?.point).toEqual({ x: 0, y: 150 });
  });
});

describe("SnapStrategies: MarginSnapStrategy", () => {
  it("snaps to the left margin line (x = margin), not to 0", () => {
    const margin = new MarginSnapStrategy({ width: 200, height: 200 });
    // Default margin 36; pointer x=38 is within 5 of 36.
    const result = margin.snap(req({ x: 38, y: 100 }));
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("margin");
    expect(result?.point).toEqual({ x: 36, y: 100 });
    expect(result?.dx).toBe(-2);
    expect(result?.dy).toBe(0);
  });

  it("does not snap to the raw page edge at 0", () => {
    const margin = new MarginSnapStrategy({ width: 200, height: 200 });
    // Pointer x=3 is near 0 but the nearest margin candidate is 36 (abs 33 > 5).
    expect(margin.snap(req({ x: 3, y: 100 }))).toBeNull();
  });

  it("snaps to the right margin line (x = width − margin)", () => {
    const margin = new MarginSnapStrategy({ width: 200, height: 200 });
    // width − margin = 164; pointer x=165 is within 5.
    const result = margin.snap(req({ x: 165, y: 100 }));
    expect(result?.point).toEqual({ x: 164, y: 100 });
    expect(result?.dx).toBe(-1);
  });

  it("uses a custom margin when supplied", () => {
    const margin = new MarginSnapStrategy({ width: 200, height: 200 }, 50);
    // Left margin at 50; pointer x=47 snaps to 50.
    const result = margin.snap(req({ x: 47, y: 100 }));
    expect(result?.point).toEqual({ x: 50, y: 100 });
    expect(result?.dx).toBe(3);
  });
});

describe("SnapStrategies: ObjectSnapStrategy", () => {
  it("snaps to another object's right edge", () => {
    const others = () => [{ id: "a", bounds: bounds(100, 100, 50, 50) }];
    const object = new ObjectSnapStrategy(others);
    // Right edge at x=150; pointer x=148 is within 5. y=100 sits on the top edge.
    const result = object.snap(req({ x: 148, y: 100 }));
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("object");
    expect(result?.point).toEqual({ x: 150, y: 100 });
    expect(result?.dx).toBe(2);
    expect(result?.dy).toBe(0);
  });

  it("snaps to another object's center", () => {
    const others = () => [{ id: "a", bounds: bounds(100, 100, 50, 50) }];
    const object = new ObjectSnapStrategy(others);
    // Center x = 125; pointer x=123 snaps to 125.
    const result = object.snap(req({ x: 123, y: 100 }));
    expect(result?.point).toEqual({ x: 125, y: 100 });
    expect(result?.dx).toBe(2);
  });

  it("ignores objects whose id is in draggedIds", () => {
    const others = () => [{ id: "a", bounds: bounds(100, 100, 50, 50) }];
    const object = new ObjectSnapStrategy(others);
    // "a" is being dragged → no candidates remain → no snap.
    expect(object.snap(req({ x: 148, y: 100 }, { draggedIds: ["a"] }))).toBeNull();
  });

  it("ignores dragged objects but still snaps to other objects", () => {
    const others = () => [
      { id: "a", bounds: bounds(100, 100, 50, 50) },
      { id: "b", bounds: bounds(300, 300, 40, 40) },
    ];
    const object = new ObjectSnapStrategy(others);
    // "a" is dragged; pointer near b's left edge at x=300.
    const result = object.snap(req({ x: 302, y: 300 }, { draggedIds: ["a"] }));
    expect(result?.active).toBe(true);
    expect(result?.point).toEqual({ x: 300, y: 300 });
  });
});

describe("SnapStrategies: GuideSnapStrategy", () => {
  it("snaps to a vertical guide's x and a horizontal guide's y", () => {
    const engine = new InMemoryGuideEngine();
    engine.addGuide({ orientation: "vertical", position: 100 });
    engine.addGuide({ orientation: "horizontal", position: 200 });
    const guide = new GuideSnapStrategy(engine);
    const result = guide.snap(req({ x: 102, y: 198 }));
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("guide");
    expect(result?.point).toEqual({ x: 100, y: 200 });
    expect(result?.dx).toBe(-2);
    expect(result?.dy).toBe(2);
  });

  it("a vertical guide only snaps x, leaving y unchanged (partial-axis snap)", () => {
    const engine = new InMemoryGuideEngine();
    engine.addGuide({ orientation: "vertical", position: 100 });
    const guide = new GuideSnapStrategy(engine);
    // y=500 has no horizontal guide → y stays; x snaps to 100.
    const result = guide.snap(req({ x: 102, y: 500 }));
    expect(result?.active).toBe(true);
    expect(result?.point).toEqual({ x: 100, y: 500 });
    expect(result?.dy).toBe(0);
  });

  it("returns null when there are no guides", () => {
    const guide = new GuideSnapStrategy(new InMemoryGuideEngine());
    expect(guide.snap(req({ x: 50, y: 50 }))).toBeNull();
  });
});

describe("SnapStrategies: CenterSnapStrategy", () => {
  it("snaps to the page center", () => {
    const center = new CenterSnapStrategy({ width: 200, height: 200 });
    // Page center (100,100); pointer x=102 snaps to 100; y=100 is already on center.
    const result = center.snap(req({ x: 102, y: 100 }));
    expect(result?.active).toBe(true);
    expect(result?.source).toBe("center");
    expect(result?.point).toEqual({ x: 100, y: 100 });
    expect(result?.dx).toBe(-2);
    expect(result?.dy).toBe(0);
  });

  it("snaps to another object's center", () => {
    const others = () => [{ id: "a", bounds: bounds(200, 200, 40, 40) }];
    const center = new CenterSnapStrategy({ width: 400, height: 400 }, others);
    // Object center (220,220); pointer x=222 snaps to 220 (closer than page center 200).
    const result = center.snap(req({ x: 222, y: 220 }));
    expect(result?.point).toEqual({ x: 220, y: 220 });
    expect(result?.dx).toBe(-2);
    expect(result?.dy).toBe(0);
  });

  it("ignores objects whose id is in draggedIds (page center only remains)", () => {
    const others = () => [{ id: "a", bounds: bounds(200, 200, 40, 40) }];
    const center = new CenterSnapStrategy({ width: 400, height: 400 }, others);
    // "a" dragged → only page center (200,200) is a candidate; pointer 222 is far from 200.
    expect(center.snap(req({ x: 222, y: 220 }, { draggedIds: ["a"] }))).toBeNull();
  });

  it("still snaps to the page center when no other objects are supplied", () => {
    const center = new CenterSnapStrategy({ width: 200, height: 200 });
    const result = center.snap(req({ x: 97, y: 103 }));
    expect(result?.point).toEqual({ x: 100, y: 100 });
    expect(result?.dx).toBe(3);
    expect(result?.dy).toBe(-3);
  });
});

describe("SnapStrategies: createDefaultSnapStrategies", () => {
  it("returns five strategies with the expected ids in order", () => {
    const strategies = createDefaultSnapStrategies({
      pageSize: { width: 595, height: 842 },
      getOtherObjects: () => [],
      guideEngine: new InMemoryGuideEngine(),
    });
    expect(strategies).toHaveLength(5);
    expect(strategies.map((s) => s.id)).toEqual([
      "page",
      "margin",
      "object",
      "guide",
      "center",
    ]);
  });

  it("wires the strategies with the supplied context (page strategy snaps)", () => {
    const engine = new InMemoryGuideEngine();
    engine.addGuide({ orientation: "vertical", position: 50 });
    const strategies = createDefaultSnapStrategies({
      pageSize: { width: 100, height: 100 },
      margin: 20,
      getOtherObjects: () => [{ id: "a", bounds: bounds(40, 40, 10, 10) }],
      guideEngine: engine,
    });
    // Page strategy: pointer near right edge (x=97) snaps to 100.
    const pageResult = strategies[0].snap(req({ x: 97, y: 50 }));
    expect(pageResult?.point).toEqual({ x: 100, y: 50 });
    // Margin strategy with margin 20: left margin at 20; pointer x=22 snaps to 20.
    const marginResult = strategies[1].snap(req({ x: 22, y: 50 }));
    expect(marginResult?.point).toEqual({ x: 20, y: 50 });
    // Guide strategy: vertical guide at x=50; pointer x=52 snaps to 50.
    const guideResult = strategies[3].snap(req({ x: 52, y: 50 }));
    expect(guideResult?.point).toEqual({ x: 50, y: 50 });
  });
});
