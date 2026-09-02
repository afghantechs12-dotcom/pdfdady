/**
 * Where and how big an inserted image lands on the page.
 *
 * WHY THIS EXISTS. Insertion used to size images against a fixed 240pt box and
 * anchor them at the click point's top-left corner. Two consequences the UX
 * review caught as "inserted images cover content immediately":
 *
 *  1. The box was PAGE-BLIND. 240pt is a reasonable eleventh of an A4 page and
 *     an overwhelming slab on a small-format page (a receipt, a business card,
 *     a cropped extract) — the same constant cannot be right for both.
 *  2. The placement was CORNER-ANCHORED and unclamped, so clicking anywhere in
 *     the right or bottom of the page put part of the image outside it. An object
 *     you must first drag back into view before you can use it is not "inserted".
 *
 * So sizing is expressed as a fraction of PAGE AREA (the brief's 35–45% ceiling),
 * the result is clamped inside the printable page, and the image is centred on
 * the point the user actually clicked. Pure arithmetic — no DOM, no decode — so
 * every branch is unit-testable and the resize path never pays for it.
 */

import type { Point } from "@/src/domain/editor/geometry";

/** The fraction of total page area an inserted image may occupy by default. */
export const IMAGE_INSERT_AREA_FRACTION = 0.4;

/** Margin (pt) kept between an inserted image and the page edge. */
export const IMAGE_INSERT_PAGE_MARGIN = 24;

export interface ImagePlacement {
  /** Top-left corner in page space. */
  position: Point;
  /** Rendered size in page units (pt). */
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

/**
 * Resolves the size an image should render at.
 *
 * Three ceilings, all of which preserve the source aspect ratio — the smallest
 * wins:
 *
 *  - AREA: `width * height <= fraction * pageArea`;
 *  - EXTENT: the image fits inside the page minus its margins, so a panorama on
 *    a portrait page is bounded by the page width rather than by area alone;
 *  - NATURAL: never upscale. Blowing a 48px icon up to fill 40% of a page is not
 *    a service to anyone, and it makes the icon look broken.
 *
 * Degenerate inputs (zero/negative/non-finite natural dimensions, which a failed
 * decode can produce) fall back to a small square rather than returning NaN
 * bounds that would poison the transform math downstream.
 */
export function resolveInsertedImageSize(
  natural: { width: number; height: number },
  page: PageSize,
  fraction: number = IMAGE_INSERT_AREA_FRACTION,
  margin: number = IMAGE_INSERT_PAGE_MARGIN,
): { width: number; height: number } {
  const nw = natural.width;
  const nh = natural.height;
  if (!isPositiveFinite(nw) || !isPositiveFinite(nh)) {
    const fallback = Math.max(1, Math.min(120, usableExtent(page.width, margin)));
    return { width: fallback, height: fallback };
  }

  const aspect = nw / nh;
  const maxW = usableExtent(page.width, margin);
  const maxH = usableExtent(page.height, margin);

  // Area ceiling, solved with height as the free variable:
  //   w = h * aspect,  w * h <= fraction * A   →   h <= sqrt(fraction * A / aspect)
  const areaBudget = Math.max(fraction, 0) * page.width * page.height;
  const areaH = Math.sqrt(areaBudget / aspect);
  const areaW = areaH * aspect;

  // Scale factors relative to the natural size; the smallest ceiling governs.
  const scale = Math.min(
    areaW / nw,
    maxW / nw,
    maxH / nh,
    1, // never upscale
  );

  return {
    width: Math.max(1, nw * scale),
    height: Math.max(1, nh * scale),
  };
}

/**
 * Full placement: sized by {@link resolveInsertedImageSize}, CENTRED on `at`,
 * then clamped so the whole image sits inside the page margins.
 *
 * Centring is what makes click-to-place feel accurate — the user points at where
 * they want the picture, not at where its top-left corner should go. Clamping is
 * applied after centring so a click near an edge slides the image inward instead
 * of letting it hang off; when the image is larger than the usable extent (a
 * page smaller than the margins allow for) it is centred on the page instead of
 * being pinned to a negative coordinate.
 */
export function resolveImagePlacement(
  natural: { width: number; height: number },
  page: PageSize,
  at: Point,
  fraction: number = IMAGE_INSERT_AREA_FRACTION,
  margin: number = IMAGE_INSERT_PAGE_MARGIN,
): ImagePlacement {
  const { width, height } = resolveInsertedImageSize(natural, page, fraction, margin);
  return {
    position: {
      x: clampAxis(at.x - width / 2, width, page.width, margin),
      y: clampAxis(at.y - height / 2, height, page.height, margin),
    },
    width,
    height,
  };
}

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** The page extent available after margins, never below 1. */
function usableExtent(pageExtent: number, margin: number): number {
  if (!isPositiveFinite(pageExtent)) return 1;
  return Math.max(1, pageExtent - margin * 2);
}

/**
 * Clamps one axis so `[start, start + size]` stays within the page margins,
 * centring instead when the object cannot fit.
 */
function clampAxis(start: number, size: number, pageExtent: number, margin: number): number {
  if (!Number.isFinite(start)) return margin;
  const min = margin;
  const max = pageExtent - margin - size;
  if (max < min) return Math.max(0, (pageExtent - size) / 2);
  return Math.min(Math.max(start, min), max);
}
