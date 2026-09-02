import { describe, expect, it } from "vitest";
import {
  CROP_HANDLES,
  MIN_CROP_SIZE,
  adjustCrop,
  cropDrawSpec,
  cropRectToLocal,
  fullCrop,
  handleAnchor,
  moveCrop,
  sanitizeCrop,
} from "./cropMath";
import { makeBounds, makeTranslate } from "@/src/domain/editor/geometry";

const NAT_W = 400;
const NAT_H = 300;
const base = { x: 100, y: 50, width: 200, height: 150 };

describe("fullCrop + sanitizeCrop", () => {
  it("fullCrop covers the whole image", () => {
    expect(fullCrop(NAT_W, NAT_H)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("sanitize falls back to the full image for null/degenerate/non-finite crops", () => {
    expect(sanitizeCrop(null, NAT_W, NAT_H)).toEqual(fullCrop(NAT_W, NAT_H));
    expect(sanitizeCrop(undefined, NAT_W, NAT_H)).toEqual(fullCrop(NAT_W, NAT_H));
    expect(sanitizeCrop({ x: 0, y: 0, width: 2, height: 2 }, NAT_W, NAT_H)).toEqual(fullCrop(NAT_W, NAT_H));
    expect(sanitizeCrop({ x: NaN, y: 0, width: 100, height: 100 }, NAT_W, NAT_H)).toEqual(fullCrop(NAT_W, NAT_H));
  });

  it("sanitize clamps an out-of-image crop back inside", () => {
    const out = sanitizeCrop({ x: 350, y: 280, width: 200, height: 100 }, NAT_W, NAT_H);
    expect(out.x + out.width).toBeLessThanOrEqual(NAT_W);
    expect(out.y + out.height).toBeLessThanOrEqual(NAT_H);
    expect(out.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
  });
});

describe("adjustCrop", () => {
  it("east handle grows the right edge only", () => {
    const out = adjustCrop(base, "e", 30, 999, NAT_W, NAT_H);
    expect(out).toEqual({ x: 100, y: 50, width: 230, height: 150 });
  });

  it("north-west handle moves both top and left edges", () => {
    const out = adjustCrop(base, "nw", 10, 20, NAT_W, NAT_H);
    expect(out).toEqual({ x: 110, y: 70, width: 190, height: 130 });
  });

  it("clamps edges to the image borders", () => {
    const out = adjustCrop(base, "se", 1000, 1000, NAT_W, NAT_H);
    expect(out.x + out.width).toBe(NAT_W);
    expect(out.y + out.height).toBe(NAT_H);
    const out2 = adjustCrop(base, "nw", -1000, -1000, NAT_W, NAT_H);
    expect(out2.x).toBe(0);
    expect(out2.y).toBe(0);
  });

  it("never shrinks below MIN_CROP_SIZE on either axis", () => {
    const out = adjustCrop(base, "w", 1000, 0, NAT_W, NAT_H);
    expect(out.width).toBe(MIN_CROP_SIZE);
    const out2 = adjustCrop(base, "n", 0, 1000, NAT_W, NAT_H);
    expect(out2.height).toBe(MIN_CROP_SIZE);
  });

  it("every handle produces a rect inside the image", () => {
    for (const h of CROP_HANDLES) {
      for (const [dx, dy] of [[500, 500], [-500, -500], [37, -12]] as const) {
        const out = adjustCrop(base, h, dx, dy, NAT_W, NAT_H);
        expect(out.x).toBeGreaterThanOrEqual(0);
        expect(out.y).toBeGreaterThanOrEqual(0);
        expect(out.x + out.width).toBeLessThanOrEqual(NAT_W);
        expect(out.y + out.height).toBeLessThanOrEqual(NAT_H);
        expect(out.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
        expect(out.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
      }
    }
  });
});

describe("moveCrop", () => {
  it("translates preserving size, clamped inside the image", () => {
    expect(moveCrop(base, 20, -10, NAT_W, NAT_H)).toEqual({ x: 120, y: 40, width: 200, height: 150 });
    const clamped = moveCrop(base, 10000, 10000, NAT_W, NAT_H);
    expect(clamped).toEqual({ x: 200, y: 150, width: 200, height: 150 });
  });
});

describe("handleAnchor", () => {
  it("maps handles to their unit-square anchors", () => {
    expect(handleAnchor("nw")).toEqual({ fx: 0, fy: 0 });
    expect(handleAnchor("se")).toEqual({ fx: 1, fy: 1 });
    expect(handleAnchor("n")).toEqual({ fx: 0.5, fy: 0 });
    expect(handleAnchor("w")).toEqual({ fx: 0, fy: 0.5 });
  });
});

describe("cropDrawSpec (shared overlay/export geometry)", () => {
  const baseObj = {
    transform: makeTranslate(100, 50),
    localBounds: makeBounds(0, 0, 100, 50), // displays the crop region
    naturalWidth: 400,
    naturalHeight: 200,
  };

  it("returns null without a crop, with a degenerate image, or full-image crop", () => {
    expect(cropDrawSpec({ ...baseObj, crop: null })).toBeNull();
    expect(cropDrawSpec({ ...baseObj })).toBeNull();
    expect(cropDrawSpec({ ...baseObj, naturalWidth: 0, crop: makeBounds(0, 0, 10, 10) })).toBeNull();
    expect(cropDrawSpec({ ...baseObj, crop: makeBounds(0, 0, 400, 200) })).toBeNull();
  });

  it("offsets and scales the full image so the crop fills the local box", () => {
    // Crop the right half: x 200..400 → kx = 100/200 = 0.5.
    const spec = cropDrawSpec({ ...baseObj, crop: makeBounds(200, 0, 200, 200) })!;
    expect(spec.offset).toEqual({ x: -100, y: 0 }); // -200 * 0.5
    expect(spec.width).toBe(200); // 400 * 0.5
    expect(spec.height).toBe(50); // 200 * (50/200)
  });

  it("clip corners are the object's world box corners in TL,TR,BR,BL order", () => {
    const spec = cropDrawSpec({ ...baseObj, crop: makeBounds(10, 10, 100, 100) })!;
    expect(spec.clipCorners).toEqual([
      { x: 100, y: 50 },
      { x: 200, y: 50 },
      { x: 200, y: 100 },
      { x: 100, y: 100 },
    ]);
  });

  it("sanitizes an out-of-range crop before deriving", () => {
    const spec = cropDrawSpec({ ...baseObj, crop: makeBounds(-50, -50, 1000, 1000) });
    // Sanitized to the full image → equivalent to no crop.
    expect(spec).toBeNull();
  });
});

describe("cropRectToLocal (overlay draft window)", () => {
  it("maps the persisted crop to exactly the local box", () => {
    const base = makeBounds(100, 40, 200, 100);
    expect(cropRectToLocal(base, base, 100, 50)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("maps a shrunken draft inside the box proportionally", () => {
    const base = makeBounds(0, 0, 200, 100);
    const draft = makeBounds(50, 25, 100, 50);
    expect(cropRectToLocal(draft, base, 100, 50)).toEqual({ x: 25, y: 12.5, width: 50, height: 25 });
  });

  it("maps a draft larger than the persisted crop outside the box", () => {
    const base = makeBounds(100, 0, 100, 100);
    const draft = makeBounds(0, 0, 300, 100);
    const local = cropRectToLocal(draft, base, 100, 100);
    expect(local.x).toBe(-100);
    expect(local.width).toBe(300);
  });
});
