import { describe, expect, it } from "vitest";
import { niceTickInterval, SmartRulerEngine } from "./RulerEngine";
import type { RulerTick } from "./Extensions";

describe("niceTickInterval", () => {
  it.each<[number, number]>([
    [100, 10], // raw=10 → 10
    [1000, 100], // raw=100 → 100
    [0.5, 0.05], // raw=0.05 → 0.05 (5 × 0.01)
    [2500, 500], // raw=250 → 500 (5 × 100)
    [20, 2], // raw=2 → 2
    [800, 100], // raw=80 → 100 (rounds up to next power of ten)
    [3, 0.5], // raw=0.3 → 0.5 (5 × 0.1)
  ])("returns a nice interval for span %s", (span, expected) => {
    expect(niceTickInterval(span)).toBeCloseTo(expected, 9);
  });

  it("honors a custom targetTicks count", () => {
    // span=100 with 5 target ticks → raw=20 → nice interval 20.
    expect(niceTickInterval(100, 5)).toBeCloseTo(20, 9);
    // span=1000 with 4 target ticks → raw=250 → nice interval 500.
    expect(niceTickInterval(1000, 4)).toBeCloseTo(500, 9);
  });

  it("falls back to 1 for degenerate spans", () => {
    expect(niceTickInterval(0)).toBe(1);
    expect(niceTickInterval(-100)).toBe(1);
    expect(niceTickInterval(Number.POSITIVE_INFINITY)).toBe(1);
    expect(niceTickInterval(100, 0)).toBe(1);
  });
});

describe("SmartRulerEngine.ticksFor", () => {
  const engine = new SmartRulerEngine();

  it("produces ticks within the range with no duplicate positions", () => {
    const ticks = engine.ticksFor(0, 100, "horizontal");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(40);

    for (const t of ticks) {
      expect(t.position).toBeGreaterThanOrEqual(-1e-9);
      expect(t.position).toBeLessThanOrEqual(100 + 1e-9);
    }
    const positions = ticks.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("labels major ticks and leaves minor ticks empty", () => {
    const ticks = engine.ticksFor(0, 100, "horizontal");
    const majors = ticks.filter((t) => t.major);
    const minors = ticks.filter((t) => !t.major);
    expect(majors.length).toBeGreaterThan(0);
    expect(minors.length).toBeGreaterThan(0);
    for (const m of majors) expect(m.label).not.toBe("");
    for (const mi of minors) expect(mi.label).toBe("");
  });

  it("places major labels at every fifth tick (multiples of 5× interval)", () => {
    const ticks = engine.ticksFor(0, 100, "horizontal");
    // interval=10 → majors at 0, 50, 100 (multiples of 50).
    const majorLabels = ticks.filter((t) => t.major).map((t) => t.label);
    expect(majorLabels).toEqual(["0", "50", "100"]);
  });

  it("handles a sub-unit span with fractional labels", () => {
    const ticks = engine.ticksFor(0, 0.5, "vertical");
    expect(ticks.length).toBeLessThan(40);
    // interval=0.05 → majors at multiples of 0.25: 0 and 0.25 and 0.5.
    const majors = ticks.filter((t) => t.major);
    expect(majors.map((t) => t.label)).toEqual(["0", "0.25", "0.5"]);
  });

  it("returns identical ticks for both orientations", () => {
    const horizontal = engine.ticksFor(0, 2500, "horizontal");
    const vertical = engine.ticksFor(0, 2500, "vertical");
    expect(vertical).toEqual(horizontal);
  });

  it("returns no ticks for a degenerate or inverted range", () => {
    expect(engine.ticksFor(50, 50, "horizontal")).toEqual([]);
    expect(engine.ticksFor(100, 0, "horizontal")).toEqual([]);
  });

  it("includes the endpoint when it lands exactly on a tick", () => {
    const ticks = engine.ticksFor(0, 100, "horizontal");
    const last = ticks[ticks.length - 1];
    expect(last.position).toBeCloseTo(100, 9);
  });

  it("coarsens the interval when zoomed out via pixelsPerUnit", () => {
    const zoomedOut = new SmartRulerEngine({ pixelsPerUnit: 0.5 });
    const atZoom = engine.ticksFor(0, 200, "horizontal");
    const zoomedOutTicks = zoomedOut.ticksFor(0, 200, "horizontal");
    // Zooming out (fewer px per unit) yields fewer, coarser ticks.
    expect(zoomedOutTicks.length).toBeLessThan(atZoom.length);
    // And every tick is still within range.
    for (const t of zoomedOutTicks) {
      expect(t.position).toBeGreaterThanOrEqual(-1e-9);
      expect(t.position).toBeLessThanOrEqual(200 + 1e-9);
    }
  });

  it("produces well-formed ticks across a large span", () => {
    const ticks: RulerTick[] = engine.ticksFor(0, 5000, "horizontal");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(40);
    // No duplicate positions and all majors carry labels.
    const positions = ticks.map((t) => t.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(ticks.filter((t) => t.major).every((t) => t.label !== "")).toBe(true);
  });
});
