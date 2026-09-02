import type { AffineTransform, Point } from "@/src/domain/editor/geometry";
import { compose, makeRotate, makeScale, makeTranslate } from "@/src/domain/editor/geometry";
import type { PageScreenOrigin, Viewport } from "./CoordinateSpace";

/**
 * Pure page-rotation mappings for the PDFDadi editor (M6 canvas rotation).
 *
 * Editor objects live in UNROTATED page coordinates (top-left origin, +y down,
 * PDF points) — the space every transform, hit-test, and export draw uses. A
 * page's `rotation` (0/90/180/270, mirroring pdf-lib's /Rotate) is a DISPLAY
 * attribute: the whole page surface (background + objects together) is rotated
 * clockwise by `rotation` when shown, exactly as a PDF viewer displays a page
 * whose /Rotate is set — which is what export does via `page.setRotation`.
 *
 * This module is that display mapping, factored pure so it is unit-testable in
 * Node and shared by the canvas (rendering + pointer input) and the thumbnails:
 *
 *  - {@link rotatedPageSize}: the displayed extent (w/h swap at 90/270).
 *  - {@link rotatePagePoint} / {@link unrotatePagePoint}: page ↔ display-page
 *    coordinates (closed-form, exact inverses).
 *  - {@link pageRotationTransform}: the same mapping as an affine transform.
 *  - {@link pageRotationScreenTransform}: the SCREEN-space group transform that
 *    rotates content already positioned via `page * zoom + origin`, so existing
 *    render code stays unchanged inside one rotated `<g>`.
 *
 * Agreement with export (verified in PageRotation.test.ts): a PDF viewer
 * displays a /Rotate=r page by rotating it r degrees clockwise. For a w×h page,
 * a PDF user-space point (xu, yu) (bottom-left, +y up) therefore lands at
 * display point (top-left, +y down):
 *   r=0: (xu, h−yu) · r=90: (yu, xu) · r=180: (w−xu, yu) · r=270: (h−yu, w−xu)
 * With editor page coords p = (xu, h−yu) (the pageToPdfLib y-flip),
 * `rotatePagePoint(r, w, h, p)` reproduces exactly those display points — so
 * what the canvas shows for a rotated page is what the exported PDF shows.
 */

/** The valid page rotations (mirrors `EditorPage["rotation"]`). */
export type PageRotationDegrees = 0 | 90 | 180 | 270;

/** A width/height pair in page units. */
export interface Size {
  width: number;
  height: number;
}

/** The displayed extent of a rotated page: w/h swap at 90/270. */
export function rotatedPageSize(rotation: PageRotationDegrees, size: Size): Size {
  return rotation === 90 || rotation === 270
    ? { width: size.height, height: size.width }
    : { width: size.width, height: size.height };
}

/**
 * Maps an UNROTATED page point to its displayed position (both top-left
 * origin, +y down; the displayed extent is {@link rotatedPageSize}).
 * Closed-form clockwise rotation, so no matrix round-off:
 * 90: (x,y)→(h−y, x) · 180: (x,y)→(w−x, h−y) · 270: (x,y)→(y, w−x).
 */
export function rotatePagePoint(
  rotation: PageRotationDegrees,
  pageWidth: number,
  pageHeight: number,
  p: Point,
): Point {
  switch (rotation) {
    case 90:
      return { x: pageHeight - p.y, y: p.x };
    case 180:
      return { x: pageWidth - p.x, y: pageHeight - p.y };
    case 270:
      return { x: p.y, y: pageWidth - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/**
 * The exact inverse of {@link rotatePagePoint}: maps a displayed point back to
 * unrotated page coordinates. This is the mapping pointer input goes through so
 * editing keeps working on a rotated page (a click lands on the object that is
 * visually under the cursor).
 */
export function unrotatePagePoint(
  rotation: PageRotationDegrees,
  pageWidth: number,
  pageHeight: number,
  p: Point,
): Point {
  switch (rotation) {
    case 90:
      return { x: p.y, y: pageHeight - p.x };
    case 180:
      return { x: pageWidth - p.x, y: pageHeight - p.y };
    case 270:
      return { x: pageWidth - p.y, y: p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/**
 * {@link rotatePagePoint} as an affine transform (page → displayed page, both
 * in page units): a clockwise rotation about the origin followed by the
 * translation that puts the rotated extent's top-left back at (0,0).
 */
export function pageRotationTransform(
  rotation: PageRotationDegrees,
  pageWidth: number,
  pageHeight: number,
): AffineTransform {
  const rad = (rotation * Math.PI) / 180;
  const shift =
    rotation === 90
      ? { x: pageHeight, y: 0 }
      : rotation === 180
        ? { x: pageWidth, y: pageHeight }
        : rotation === 270
          ? { x: 0, y: pageWidth }
          : { x: 0, y: 0 };
  return compose(makeTranslate(shift.x, shift.y), makeRotate(rad));
}

/**
 * The SCREEN-space transform that rotates a page surface whose content was
 * positioned with the UNROTATED mapping `screen = page * zoom + origin`.
 *
 * Formally `G = T(origin) · S(zoom) · Rot · S(1/zoom) · T(−origin)`, so that
 * `G(page * zoom + origin) = rotatePagePoint(page) * zoom + origin`. Apply it
 * as one `<g transform>` (or CSS matrix) around the existing render output and
 * the whole surface — background, objects, selection chrome — rotates
 * coherently while the inner positioning code stays untouched.
 */
export function pageRotationScreenTransform(
  rotation: PageRotationDegrees,
  pageWidth: number,
  pageHeight: number,
  viewport: Viewport,
  origin: PageScreenOrigin,
): AffineTransform {
  const z = viewport.zoom;
  const rot = pageRotationTransform(rotation, pageWidth, pageHeight);
  return compose(
    makeTranslate(origin.x, origin.y),
    compose(
      makeScale(z, z),
      compose(rot, compose(makeScale(1 / z, 1 / z), makeTranslate(-origin.x, -origin.y))),
    ),
  );
}

/**
 * Serializes a transform as the `matrix(a,b,c,d,e,f)` string shared by SVG
 * `transform` and CSS `transform` (same coefficient order in both).
 */
export function toMatrixString(t: AffineTransform): string {
  return `matrix(${t.a},${t.b},${t.c},${t.d},${t.e},${t.f})`;
}
