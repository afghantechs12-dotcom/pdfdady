import { describe, expect, it } from "vitest";

import {
  TEXT_MIN_WIDTH,
  TEXT_PLACEMENT_MARGIN,
  isTextAreaDrag,
  resolveTextBoxWidth,
  resolveTextClickPlacement,
  resolveTextDragPlacement,
} from "@/src/application/editor/tools/textPlacement";

const A4 = { width: 595, height: 842 };
const SMALL = { width: 180, height: 120 };

describe("resolveTextBoxWidth", () => {
  it("scales with the page instead of using a fixed 200pt box", () => {
    const onA4 = resolveTextBoxWidth(A4);
    expect(onA4).toBeGreaterThan(200); // the old constant was too narrow for A4
    expect(onA4).toBeLessThanOrEqual(A4.width - TEXT_PLACEMENT_MARGIN * 2);
  });

  it("never exceeds the usable page width", () => {
    expect(resolveTextBoxWidth(SMALL)).toBeLessThanOrEqual(SMALL.width);
  });

  it("keeps a legible floor on a small page", () => {
    expect(resolveTextBoxWidth(SMALL)).toBeGreaterThanOrEqual(
      Math.min(TEXT_MIN_WIDTH, SMALL.width - TEXT_PLACEMENT_MARGIN * 2),
    );
  });

  it("degrades safely for a nonsense page width", () => {
    expect(resolveTextBoxWidth({ width: 0, height: 0 })).toBe(TEXT_MIN_WIDTH);
    expect(resolveTextBoxWidth({ width: Number.NaN, height: 100 })).toBe(TEXT_MIN_WIDTH);
  });
});

describe("resolveTextClickPlacement", () => {
  it("starts the box at the click point", () => {
    const p = resolveTextClickPlacement({ x: 100, y: 200 }, A4, 19);
    expect(p.position).toEqual({ x: 100, y: 200 });
  });

  it("is one line tall (auto-growth happens while typing)", () => {
    const p = resolveTextClickPlacement({ x: 100, y: 200 }, A4, 19);
    expect(p.localBounds.height).toBe(19);
  });

  it("pulls the box back inside the page near the right edge", () => {
    const p = resolveTextClickPlacement({ x: A4.width - 5, y: 200 }, A4, 19);
    expect(p.position.x + p.localBounds.width).toBeLessThanOrEqual(A4.width);
  });

  it("pulls the box back inside the page near the bottom edge", () => {
    const p = resolveTextClickPlacement({ x: 100, y: A4.height - 2 }, A4, 19);
    expect(p.position.y + p.localBounds.height).toBeLessThanOrEqual(A4.height);
  });

  it("never yields a negative origin", () => {
    const p = resolveTextClickPlacement({ x: -50, y: -50 }, A4, 19);
    expect(p.position.x).toBeGreaterThanOrEqual(0);
    expect(p.position.y).toBeGreaterThanOrEqual(0);
  });
});

describe("resolveTextDragPlacement", () => {
  it("honours a dragged rectangle", () => {
    const p = resolveTextDragPlacement({ x: 50, y: 60 }, { x: 350, y: 200 }, A4, 19);
    expect(p.position).toEqual({ x: 50, y: 60 });
    expect(p.localBounds.width).toBe(300);
    expect(p.localBounds.height).toBe(140);
  });

  it("normalizes a drag made up-and-left", () => {
    const p = resolveTextDragPlacement({ x: 350, y: 200 }, { x: 50, y: 60 }, A4, 19);
    expect(p.position).toEqual({ x: 50, y: 60 });
    expect(p.localBounds.width).toBe(300);
  });

  it("floors a microscopic drag to a usable box", () => {
    const p = resolveTextDragPlacement({ x: 50, y: 60 }, { x: 53, y: 62 }, A4, 19);
    expect(p.localBounds.width).toBeGreaterThanOrEqual(TEXT_MIN_WIDTH);
    expect(p.localBounds.height).toBeGreaterThanOrEqual(19);
  });

  it("clamps a dragged area inside the page", () => {
    const p = resolveTextDragPlacement({ x: 500, y: 800 }, { x: 900, y: 1200 }, A4, 19);
    expect(p.position.x + p.localBounds.width).toBeLessThanOrEqual(A4.width);
    expect(p.position.y + p.localBounds.height).toBeLessThanOrEqual(A4.height);
  });
});

describe("isTextAreaDrag", () => {
  it("treats a click (no movement) as not a drag", () => {
    expect(isTextAreaDrag({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
  });

  it("treats jitter under the threshold as not a drag", () => {
    expect(isTextAreaDrag({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
  });

  it("treats a deliberate drag as a drag", () => {
    expect(isTextAreaDrag({ x: 10, y: 10 }, { x: 120, y: 60 })).toBe(true);
  });
});
