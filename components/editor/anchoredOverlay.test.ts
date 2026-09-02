import { describe, expect, it } from "vitest";

import {
  ANCHOR_GAP,
  MIN_OVERLAY_HEIGHT,
  VIEWPORT_MARGIN,
  placeAnchoredOverlay,
} from "@/components/editor/anchoredOverlay";

const VIEWPORT = { width: 1600, height: 900 };
/** A toolbar cluster trigger, roughly where the real one sits. */
const TRIGGER = { x: 589, y: 59, width: 120, height: 38 };
/** The real shapes menu: 11 items at 40px plus padding. */
const SHAPES_MENU = { width: 208, height: 320 };

describe("placeAnchoredOverlay", () => {
  it("places the menu below its trigger with a gap", () => {
    const p = placeAnchoredOverlay(TRIGGER, SHAPES_MENU, VIEWPORT);
    expect(p.side).toBe("below");
    expect(p.top).toBe(TRIGGER.y + TRIGGER.height + ANCHOR_GAP);
  });

  it("left-aligns with the trigger when there is room", () => {
    const p = placeAnchoredOverlay(TRIGGER, SHAPES_MENU, VIEWPORT);
    expect(p.left).toBe(TRIGGER.x);
  });

  it("keeps a menu near the right edge fully on screen", () => {
    const nearRight = { x: 1560, y: 59, width: 120, height: 38 };
    const p = placeAnchoredOverlay(nearRight, SHAPES_MENU, VIEWPORT);
    expect(p.left + SHAPES_MENU.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
    expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it("never positions the menu off the left edge", () => {
    const nearLeft = { x: -40, y: 59, width: 120, height: 38 };
    const p = placeAnchoredOverlay(nearLeft, SHAPES_MENU, VIEWPORT);
    expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it("pins a menu wider than the viewport to the left margin", () => {
    const p = placeAnchoredOverlay(TRIGGER, { width: 2000, height: 200 }, VIEWPORT);
    expect(p.left).toBe(VIEWPORT_MARGIN);
  });

  it("flips above when below cannot show a usable menu", () => {
    // A trigger near the bottom of a short window: below has ~30px.
    const lowTrigger = { x: 400, y: 820, width: 120, height: 38 };
    const p = placeAnchoredOverlay(lowTrigger, SHAPES_MENU, VIEWPORT);
    expect(p.side).toBe("above");
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(lowTrigger.y);
  });

  it("stays below when below is tight but still roomier than above", () => {
    // Trigger at the very top: above has almost nothing, so below wins even
    // though it cannot show the whole menu.
    const topTrigger = { x: 400, y: 4, width: 120, height: 38 };
    const p = placeAnchoredOverlay(topTrigger, { width: 208, height: 2000 }, VIEWPORT);
    expect(p.side).toBe("below");
  });

  it("reports a maxHeight so a long menu scrolls internally instead of overflowing", () => {
    const p = placeAnchoredOverlay(TRIGGER, { width: 208, height: 4000 }, VIEWPORT);
    expect(p.maxHeight).toBeLessThan(4000);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it("never returns a position above the top margin", () => {
    const p = placeAnchoredOverlay({ x: 10, y: 0, width: 40, height: 10 }, SHAPES_MENU, VIEWPORT);
    expect(p.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it("keeps the whole menu on screen for every trigger position along the toolbar", () => {
    // The property that matters: wherever the trigger is, the menu is visible.
    for (let x = 0; x <= VIEWPORT.width; x += 50) {
      const p = placeAnchoredOverlay({ x, y: 59, width: 120, height: 38 }, SHAPES_MENU, VIEWPORT);
      expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      expect(p.left + SHAPES_MENU.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
      expect(p.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      expect(p.top + Math.min(SHAPES_MENU.height, p.maxHeight)).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });

  it("keeps the menu on screen at every supported viewport width", () => {
    for (const width of [390, 768, 1024, 1200, 1366, 1440, 1600, 1920]) {
      const p = placeAnchoredOverlay(
        { x: Math.min(589, width - 130), y: 59, width: 120, height: 38 },
        SHAPES_MENU,
        { width, height: 900 },
      );
      expect(p.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      // A menu wider than the viewport is pinned, not pushed off-screen.
      expect(p.left).toBeLessThanOrEqual(Math.max(VIEWPORT_MARGIN, width - VIEWPORT_MARGIN));
    }
  });

  it("survives a tiny viewport without producing NaN or negative geometry", () => {
    const p = placeAnchoredOverlay(TRIGGER, SHAPES_MENU, { width: 200, height: 120 });
    expect(Number.isFinite(p.left)).toBe(true);
    expect(Number.isFinite(p.top)).toBe(true);
    expect(p.maxHeight).toBeGreaterThanOrEqual(0);
  });

  it("uses the flip threshold rather than requiring the full height to fit", () => {
    // Room for MIN_OVERLAY_HEIGHT below but not the whole menu: stay below and
    // scroll, because flipping a partly-fitting menu is more disorienting.
    const y = VIEWPORT.height - 38 - ANCHOR_GAP - VIEWPORT_MARGIN - MIN_OVERLAY_HEIGHT - 1;
    const p = placeAnchoredOverlay({ x: 400, y, width: 120, height: 38 }, SHAPES_MENU, VIEWPORT);
    expect(p.side).toBe("below");
  });
});
