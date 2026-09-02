import { describe, expect, it } from "vitest";
import {
  DASH_PRESETS,
  dashForPreset,
  dashPresetOf,
  describePageSize,
  lockedSize,
  pageSizeLabel,
  positionDelta,
  representativeValue,
  rotationDegOf,
  rotationDelta,
} from "./propertiesPanelLogic";

describe("dash presets (M6.16)", () => {
  it("resolves stored dash arrays back to their preset ids", () => {
    expect(dashPresetOf(undefined)).toBe("solid");
    expect(dashPresetOf([])).toBe("solid");
    expect(dashPresetOf([6, 4])).toBe("dashed");
    expect(dashPresetOf([2, 3])).toBe("dotted");
    expect(dashPresetOf([9, 1])).toBe("custom");
  });

  it("produces the canonical arrays for each preset (fresh copies)", () => {
    expect(dashForPreset("solid", [9, 1])).toBeUndefined();
    expect(dashForPreset("dashed", undefined)).toEqual([6, 4]);
    expect(dashForPreset("dotted", undefined)).toEqual([2, 3]);
    // Choosing "custom" keeps the current pattern untouched.
    expect(dashForPreset("custom", [9, 1])).toEqual([9, 1]);
    // Fresh copy — mutating the result must not corrupt the shared preset.
    const dashed = dashForPreset("dashed", undefined)!;
    dashed[0] = 999;
    expect(DASH_PRESETS.dashed[0]).toBe(6);
  });

  it("round-trips: every preset's array resolves back to its own id", () => {
    for (const id of ["solid", "dashed", "dotted"] as const) {
      expect(dashPresetOf(dashForPreset(id, undefined))).toBe(id);
    }
  });
});

describe("representativeValue (mixed multi-selection)", () => {
  it("uniform values are not mixed", () => {
    expect(representativeValue([80, 80, 80])).toEqual({ value: 80, mixed: false });
    expect(representativeValue([50])).toEqual({ value: 50, mixed: false });
  });

  it("disagreeing values report mixed with the first as representative", () => {
    expect(representativeValue([80, 30])).toEqual({ value: 80, mixed: true });
  });

  it("an empty list is a safe zero", () => {
    expect(representativeValue([])).toEqual({ value: 0, mixed: false });
  });
});

describe("rotation helpers (M6.16)", () => {
  it("converts radians to whole degrees normalized into [-180, 180]", () => {
    expect(rotationDegOf(0)).toBe(0);
    expect(rotationDegOf(Math.PI / 2)).toBe(90);
    expect(rotationDegOf(Math.PI)).toBe(180);
    expect(rotationDegOf(-Math.PI / 2)).toBe(-90);
    expect(rotationDegOf((3 * Math.PI) / 2)).toBe(-90); // 270° wraps
  });

  it("rotationDelta produces the radians that close the gap", () => {
    expect(rotationDelta(0, 90)).toBeCloseTo(Math.PI / 2, 10);
    expect(rotationDelta(45, 45)).toBe(0);
    expect(rotationDelta(90, -90)).toBeCloseTo(-Math.PI, 10);
  });
});

describe("positionDelta (H25 absolute X/Y fields)", () => {
  it("converts an absolute target into the relative move the service takes", () => {
    expect(positionDelta({ x: 100, y: 50 }, { x: 130 })).toEqual({ x: 30, y: 0 });
    expect(positionDelta({ x: 100, y: 50 }, { y: 20 })).toEqual({ x: 0, y: -30 });
    expect(positionDelta({ x: 10, y: 10 }, { x: 0, y: 0 })).toEqual({ x: -10, y: -10 });
  });

  it("returns null for a no-op so Undo never gets an identity entry", () => {
    // Committing a field you didn't change (tab through, blur) must not push a
    // command that makes the next Undo appear to do nothing.
    expect(positionDelta({ x: 100, y: 50 }, { x: 100 })).toBeNull();
    expect(positionDelta({ x: 100, y: 50 }, {})).toBeNull();
    expect(positionDelta({ x: 100, y: 50 }, { x: 100, y: 50 })).toBeNull();
  });

  it("refuses non-finite input rather than moving an object to NaN", () => {
    expect(positionDelta({ x: 0, y: 0 }, { x: Number.NaN })).toBeNull();
    expect(positionDelta({ x: 0, y: 0 }, { y: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("handles negative coordinates (an object dragged off the page origin)", () => {
    expect(positionDelta({ x: -20, y: -5 }, { x: 10, y: 5 })).toEqual({ x: 30, y: 10 });
  });
});

describe("lockedSize (H14 aspect-ratio lock)", () => {
  it("passes both dimensions through untouched when unlocked", () => {
    expect(lockedSize({ w: 200, h: 100 }, { w: 300 }, false)).toEqual({ w: 300, h: 100 });
    expect(lockedSize({ w: 200, h: 100 }, { h: 400 }, false)).toEqual({ w: 200, h: 400 });
  });

  it("derives the partner dimension from the current ratio when locked", () => {
    // 2:1 — editing width to 300 implies height 150.
    expect(lockedSize({ w: 200, h: 100 }, { w: 300 }, true)).toEqual({ w: 300, h: 150 });
    // ...and editing height to 50 implies width 100.
    expect(lockedSize({ w: 200, h: 100 }, { h: 50 }, true)).toEqual({ w: 100, h: 50 });
  });

  it("preserves the ratio within rounding across a locked edit", () => {
    const start = { w: 1024, h: 768 };
    const next = lockedSize(start, { w: 800 }, true)!;
    expect(next.w / next.h).toBeCloseTo(start.w / start.h, 2);
  });

  it("returns a single pair so the commit stays ONE undoable operation", () => {
    // The contract that keeps `setObjectSize(id, w, h)` a single command: the
    // helper never asks the caller to make two calls.
    const next = lockedSize({ w: 200, h: 100 }, { w: 300 }, true);
    expect(next).toEqual({ w: 300, h: 150 });
    expect(Object.keys(next!).sort()).toEqual(["h", "w"]);
  });

  it("does not fight an explicit both-dimension edit even when locked", () => {
    // If the caller supplies both, it means both — the lock only INFERS a
    // missing partner.
    expect(lockedSize({ w: 200, h: 100 }, { w: 50, h: 400 }, true)).toEqual({ w: 50, h: 400 });
  });

  it("rejects zero, negative and non-finite sizes", () => {
    expect(lockedSize({ w: 200, h: 100 }, { w: 0 }, true)).toBeNull();
    expect(lockedSize({ w: 200, h: 100 }, { w: -5 }, false)).toBeNull();
    expect(lockedSize({ w: 200, h: 100 }, { h: Number.NaN }, true)).toBeNull();
  });

  it("refuses a degenerate object rather than committing a zero dimension", () => {
    // A zero-height object has no ratio to preserve, and `setObjectSize` itself
    // bails when a current dimension is 0 (it would divide by zero), so the
    // honest answer is "no commit" rather than a pair the service will discard.
    expect(lockedSize({ w: 200, h: 0 }, { w: 300 }, true)).toBeNull();
    expect(lockedSize({ w: 0, h: 100 }, { h: 50 }, true)).toBeNull();
  });

  it("returns null when nothing changed", () => {
    expect(lockedSize({ w: 200, h: 100 }, { w: 200 }, true)).toBeNull();
    expect(lockedSize({ w: 200, h: 100 }, {}, false)).toBeNull();
  });
});

describe("describePageSize / pageSizeLabel (H23)", () => {
  it("names the standard sizes", () => {
    expect(describePageSize(595, 842)).toBe("A4");
    expect(describePageSize(612, 792)).toBe("Letter");
    expect(describePageSize(612, 1008)).toBe("Legal");
    expect(describePageSize(842, 1191)).toBe("A3");
    expect(describePageSize(420, 595)).toBe("A5");
    expect(describePageSize(792, 1224)).toBe("Tabloid");
  });

  it("is orientation-insensitive", () => {
    // A landscape A4 is still A4; the exact dimensions shown beside the name
    // tell the user the orientation.
    expect(describePageSize(842, 595)).toBe("A4");
    expect(describePageSize(792, 612)).toBe("Letter");
  });

  it("absorbs the sub-point rounding real PDFs carry", () => {
    // A4 is 595.276 × 841.89pt; producers store it rounded a dozen ways.
    expect(describePageSize(595.276, 841.89)).toBe("A4");
    expect(describePageSize(596, 842)).toBe("A4");
    expect(describePageSize(594, 841)).toBe("A4");
  });

  it("returns null for an unrecognized size instead of guessing the nearest", () => {
    expect(describePageSize(500, 700)).toBeNull();
    // Just outside the ±1pt tolerance — not "close enough" to claim A4.
    expect(describePageSize(593, 842)).toBeNull();
    expect(describePageSize(Number.NaN, 842)).toBeNull();
  });

  it("never confuses Letter with Legal (same width, different height)", () => {
    expect(describePageSize(612, 792)).toBe("Letter");
    expect(describePageSize(612, 1008)).toBe("Legal");
  });

  it("always includes the exact dimensions so the label cannot overstate", () => {
    expect(pageSizeLabel(595, 842)).toBe("A4 · 595 × 842 pt");
    // Unnamed: dimensions only, no invented name.
    expect(pageSizeLabel(500, 700)).toBe("500 × 700 pt");
    expect(pageSizeLabel(595.276, 841.89)).toBe("A4 · 595 × 842 pt");
  });
});
