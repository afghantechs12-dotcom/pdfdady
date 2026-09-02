import { describe, expect, it } from "vitest";

import {
  IMAGE_INSERT_AREA_FRACTION,
  IMAGE_INSERT_PAGE_MARGIN,
  resolveImagePlacement,
  resolveInsertedImageSize,
} from "@/src/application/editor/tools/imagePlacement";

/** A4 in points — the page size the defaults are tuned against. */
const A4 = { width: 595, height: 842 };
/** A deliberately small page: the case a fixed 240pt box got wrong. */
const SMALL = { width: 200, height: 150 };

const area = (s: { width: number; height: number }) => s.width * s.height;
const aspect = (s: { width: number; height: number }) => s.width / s.height;

describe("resolveInsertedImageSize", () => {
  it("keeps a large photo within the page-area budget", () => {
    const size = resolveInsertedImageSize({ width: 4000, height: 3000 }, A4);
    expect(area(size)).toBeLessThanOrEqual(area(A4) * IMAGE_INSERT_AREA_FRACTION + 1);
  });

  it("preserves the source aspect ratio (no squashing into a square)", () => {
    const landscape = resolveInsertedImageSize({ width: 4000, height: 1000 }, A4);
    expect(aspect(landscape)).toBeCloseTo(4, 5);

    const portrait = resolveInsertedImageSize({ width: 1000, height: 4000 }, A4);
    expect(aspect(portrait)).toBeCloseTo(0.25, 5);
  });

  it("fits inside the page extent, not merely the area budget", () => {
    // A 20:1 panorama can satisfy the area budget while being far wider than
    // the page; the extent ceiling is what catches it.
    const size = resolveInsertedImageSize({ width: 8000, height: 400 }, A4);
    expect(size.width).toBeLessThanOrEqual(A4.width - IMAGE_INSERT_PAGE_MARGIN * 2);
    expect(aspect(size)).toBeCloseTo(20, 5);
  });

  it("never upscales a small image", () => {
    const size = resolveInsertedImageSize({ width: 48, height: 48 }, A4);
    expect(size).toEqual({ width: 48, height: 48 });
  });

  it("scales relative to the PAGE, so a small page gets a smaller image", () => {
    const onA4 = resolveInsertedImageSize({ width: 4000, height: 3000 }, A4);
    const onSmall = resolveInsertedImageSize({ width: 4000, height: 3000 }, SMALL);
    expect(onSmall.width).toBeLessThan(onA4.width);
    expect(area(onSmall)).toBeLessThanOrEqual(area(SMALL) * IMAGE_INSERT_AREA_FRACTION + 1);
  });

  it("returns a safe square for a failed decode rather than NaN bounds", () => {
    for (const bad of [
      { width: 0, height: 0 },
      { width: -10, height: 20 },
      { width: Number.NaN, height: 100 },
      { width: Number.POSITIVE_INFINITY, height: 100 },
    ]) {
      const size = resolveInsertedImageSize(bad, A4);
      expect(Number.isFinite(size.width)).toBe(true);
      expect(Number.isFinite(size.height)).toBe(true);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });
});

describe("resolveImagePlacement", () => {
  const natural = { width: 4000, height: 3000 };

  it("centres the image on the clicked point", () => {
    const at = { x: 300, y: 400 };
    const p = resolveImagePlacement(natural, A4, at);
    expect(p.position.x + p.width / 2).toBeCloseTo(at.x, 5);
    expect(p.position.y + p.height / 2).toBeCloseTo(at.y, 5);
  });

  it("never places the image partly off-page — any corner click", () => {
    const corners = [
      { x: 0, y: 0 },
      { x: A4.width, y: 0 },
      { x: 0, y: A4.height },
      { x: A4.width, y: A4.height },
      { x: -500, y: -500 },
      { x: 9999, y: 9999 },
    ];
    for (const at of corners) {
      const p = resolveImagePlacement(natural, A4, at);
      expect(p.position.x).toBeGreaterThanOrEqual(IMAGE_INSERT_PAGE_MARGIN - 0.001);
      expect(p.position.y).toBeGreaterThanOrEqual(IMAGE_INSERT_PAGE_MARGIN - 0.001);
      expect(p.position.x + p.width).toBeLessThanOrEqual(A4.width - IMAGE_INSERT_PAGE_MARGIN + 0.001);
      expect(p.position.y + p.height).toBeLessThanOrEqual(A4.height - IMAGE_INSERT_PAGE_MARGIN + 0.001);
    }
  });

  it("centres on the page when the image cannot fit the margins", () => {
    // Margins alone exceed this page, so clamping has no valid range.
    const tiny = { width: 30, height: 30 };
    const p = resolveImagePlacement({ width: 100, height: 100 }, tiny, { x: 0, y: 0 });
    expect(p.position.x).toBeGreaterThanOrEqual(0);
    expect(p.position.y).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.width)).toBe(true);
  });

  it("keeps the aspect ratio of the placed result", () => {
    const p = resolveImagePlacement(natural, A4, { x: 300, y: 400 });
    expect(p.width / p.height).toBeCloseTo(4 / 3, 5);
  });

  it("honours an explicit smaller area fraction", () => {
    const big = resolveImagePlacement(natural, A4, { x: 300, y: 400 }, 0.4);
    const small = resolveImagePlacement(natural, A4, { x: 300, y: 400 }, 0.1);
    expect(small.width).toBeLessThan(big.width);
  });
});
