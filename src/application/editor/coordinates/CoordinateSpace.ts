import type { AffineTransform, Point, Vec2 } from "@/src/domain/editor/geometry";
import { compose, makeScale, makeTranslate } from "@/src/domain/editor/geometry";

/**
 * Pure coordinate-space mappings for the PDFDadi editor.
 *
 * The editor works in three coordinate spaces that meet here:
 *  - SCREEN space: origin top-left, +y down (the canvas/DOM convention shared
 *    with the existing PDF preview — see [[preview-architecture]]). Pointer
 *    events arrive in this space.
 *  - PAGE space: the editor's world space on a page, also top-left +y down, in
 *    PDF points. Object transforms map local → page and {@link worldBounds} is
 *    expressed here. Hit-testing consumes a page-space point.
 *  - PDF-LIB user space: origin bottom-left, +y up — the coordinate system
 *    pdf-lib's `drawRectangle`/`moveText`/`drawPage` APIs expect at export time.
 *
 * The viewport maps page → screen: scale by `zoom`, then translate by `origin`
 * (the screen pixel where page (0,0) sits, with pan already baked in). Deltas
 * (drag vectors) divide by zoom but ignore pan, since a translation cancels out
 * of a difference. Everything here is pure — no DOM, no side effects.
 */

/** The current view: a zoom factor and a pan offset in screen pixels. */
export interface Viewport {
  /** Zoom factor; >= 1 zooms in, < 1 zooms out. */
  zoom: number;
  /** Pan offset in screen pixels (caller bakes this into the page screen origin). */
  pan: Point;
}

/** Where a page's (0,0) lands in screen pixels (pan already applied). */
export interface PageScreenOrigin {
  x: number;
  y: number;
}

/**
 * Maps a screen point to page space. Pan is already baked into `origin`, so
 * `page = (screen - origin) / zoom` component-wise.
 */
export function screenToPage(
  viewport: Viewport,
  origin: PageScreenOrigin,
  screen: Point,
): Point {
  return {
    x: (screen.x - origin.x) / viewport.zoom,
    y: (screen.y - origin.y) / viewport.zoom,
  };
}

/** Maps a page point to screen space: `screen = page * zoom + origin`. */
export function pageToScreen(
  viewport: Viewport,
  origin: PageScreenOrigin,
  page: Point,
): Point {
  return {
    x: page.x * viewport.zoom + origin.x,
    y: page.y * viewport.zoom + origin.y,
  };
}

/**
 * Converts a screen-space drag delta to a page-space delta. Pan cancels in a
 * difference, so only zoom applies: `pageDelta = screenDelta / zoom`.
 */
export function screenToPageDelta(viewport: Viewport, screenDelta: Vec2): Vec2 {
  return {
    x: screenDelta.x / viewport.zoom,
    y: screenDelta.y / viewport.zoom,
  };
}

/**
 * Maps a page-space point (top-left, y-down) to pdf-lib user space
 * (bottom-left, y-up) for a page of the given height: `y' = pageHeight - y`.
 * x is unchanged.
 */
export function pageToPdfLib(p: Point, pageHeight: number): Point {
  return { x: p.x, y: pageHeight - p.y };
}

/**
 * Maps a pdf-lib user-space point (bottom-left, y-up) back to page space
 * (top-left, y-down). The y flip is its own inverse, so `y' = pageHeight - y`;
 * x is unchanged.
 */
export function pdfLibToPage(p: Point, pageHeight: number): Point {
  return { x: p.x, y: pageHeight - p.y };
}

/**
 * Builds the SVG/CSS `matrix(a,b,c,d,e,f)` string that places an object on
 * screen at a given viewport. The screen-space transform is
 * `compose(viewportTransform, obj.transform)` where the viewport transform is
 * `translate(origin) · scale(zoom)` — i.e. the object's local→page transform
 * followed by the page→screen viewport mapping. With a single SVG transform
 * attribute the renderer can paint the object without composing anything itself.
 */
export function objectToSvgMatrix(
  obj: { transform: AffineTransform },
  viewport: Viewport,
  origin: PageScreenOrigin,
): string {
  const viewportTransform = compose(
    makeTranslate(origin.x, origin.y),
    makeScale(viewport.zoom, viewport.zoom),
  );
  const screen = compose(viewportTransform, obj.transform);
  return `matrix(${screen.a},${screen.b},${screen.c},${screen.d},${screen.e},${screen.f})`;
}
