import { describe, expect, it } from "vitest";
import { placeAnchoredPopover } from "./colorPopoverLayout";

const PANEL = { width: 280, height: 320 };
const VIEW = { width: 1440, height: 900 };

describe("colorPopoverLayout: placeAnchoredPopover", () => {
  it("prefers below the anchor with left edges aligned", () => {
    const placement = placeAnchoredPopover({ x: 400, y: 200, width: 36, height: 32 }, PANEL, VIEW);
    expect(placement.side).toBe("below");
    expect(placement.x).toBe(400);
    expect(placement.y).toBe(200 + 32 + 6);
  });

  it("flips above when the panel would overflow the bottom", () => {
    // A colour row near the bottom of a tall inspector is the common case.
    const placement = placeAnchoredPopover({ x: 400, y: 800, width: 36, height: 32 }, PANEL, VIEW);
    expect(placement.side).toBe("above");
    expect(placement.y).toBe(800 - 6 - 320);
  });

  it("slides left instead of hanging off the right edge", () => {
    // The inspector is docked right, so this is the normal path, not an edge case.
    const placement = placeAnchoredPopover({ x: 1400, y: 200, width: 36, height: 32 }, PANEL, VIEW);
    expect(placement.x).toBe(VIEW.width - PANEL.width - 8);
    expect(placement.x + PANEL.width).toBeLessThanOrEqual(VIEW.width);
  });

  it("never places the panel past the left margin", () => {
    const placement = placeAnchoredPopover({ x: -50, y: 200, width: 36, height: 32 }, PANEL, VIEW);
    expect(placement.x).toBe(8);
  });

  it("picks the roomier side and clamps when the panel fits neither", () => {
    const short = { width: 1440, height: 380 };
    const placement = placeAnchoredPopover({ x: 100, y: 300, width: 36, height: 32 }, PANEL, short);
    // Above has 300-6-8=286; below has 380-8-338=34. Above wins.
    expect(placement.side).toBe("above");
    expect(placement.y).toBeGreaterThanOrEqual(8);
    expect(placement.y).toBeLessThanOrEqual(short.height - PANEL.height - 8);
  });

  it("pins a panel taller than the viewport to the top rather than off it", () => {
    const tall = { width: 280, height: 2000 };
    const placement = placeAnchoredPopover({ x: 100, y: 300, width: 36, height: 32 }, tall, VIEW);
    expect(placement.y).toBe(8);
  });

  it("keeps the panel fully on screen for anchors swept across the viewport", () => {
    for (let x = 0; x <= VIEW.width; x += 80) {
      for (let y = 0; y <= VIEW.height; y += 60) {
        const p = placeAnchoredPopover({ x, y, width: 36, height: 32 }, PANEL, VIEW);
        expect(p.x).toBeGreaterThanOrEqual(8);
        expect(p.x + PANEL.width).toBeLessThanOrEqual(VIEW.width - 8 + 0.001);
        expect(p.y).toBeGreaterThanOrEqual(8);
        expect(p.y + PANEL.height).toBeLessThanOrEqual(VIEW.height - 8 + 0.001);
      }
    }
  });

  it("does not overlap the anchor it is attached to", () => {
    // Covering the swatch you clicked hides the value you are changing.
    const anchor = { x: 400, y: 200, width: 36, height: 32 };
    const below = placeAnchoredPopover(anchor, PANEL, VIEW);
    expect(below.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
    const anchorLow = { x: 400, y: 800, width: 36, height: 32 };
    const above = placeAnchoredPopover(anchorLow, PANEL, VIEW);
    expect(above.y + PANEL.height).toBeLessThanOrEqual(anchorLow.y);
  });
});
