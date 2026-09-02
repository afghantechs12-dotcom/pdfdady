import type { Point } from "@/src/domain/editor/geometry";
import type { Viewport } from "@/src/application/editor/coordinates/CoordinateSpace";

/**
 * Pure zoom math for the editor viewport (M6 zoom system). No DOM — everything
 * here runs unchanged in Node tests. The components stay thin: the toolbar and
 * workspace call these with measured container sizes and the active page's
 * DISPLAYED dimensions (rotation already applied via `rotatedPageSize`).
 */

/** The zoom preset ladder (10% … 800%), shared by the dropdown and the ± buttons. */
export const ZOOM_PRESETS: readonly number[] = [
  0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8,
];

/** Zoom clamp range — matches the canvas wheel-zoom clamp. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** Default padding (screen px) kept around the page by the fit modes. */
export const FIT_PADDING = 24;

/**
 * Reserved strip at the canvas bottom, so a fit mode does not lay the page
 * underneath the floating control capsule.
 *
 * Composed from the capsule's real layout budget rather than being a magic
 * number, so a change to the control rhythm is visible here:
 *
 *   1px border + 6px padding + 2px group inset + 36px control
 *              + 2px group inset + 6px padding + 1px border   = 54px
 *
 * plus the 12px gap the capsule floats above the canvas edge. `zoom.test.ts`
 * pins the arithmetic, and the Phase I probe measures the consequence — that at
 * Fit Page the page bottom clears the bar instead of hiding behind it.
 */
export const FLOATING_CONTROLS_HEIGHT = 1 + 6 + 2 + 36 + 2 + 6 + 1;
export const FLOATING_CONTROLS_GAP = 12;
export const CANVAS_BOTTOM_RESERVE = FLOATING_CONTROLS_HEIGHT + FLOATING_CONTROLS_GAP;

/** The sticky fit modes; recomputed on resize/page change until a manual zoom. */
export type FitMode = "fit-width" | "fit-height" | "fit-page";

const EPSILON = 1e-6;

/** A width/height pair (screen px for containers, page units for pages). */
export interface ViewSize {
  width: number;
  height: number;
}

/** Clamps a zoom into [MIN_ZOOM, MAX_ZOOM]; non-finite values fall back to 1. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The next preset above `zoom` (strictly, within epsilon), else MAX_ZOOM. */
export function nextZoomStep(zoom: number): number {
  const z = clampZoom(zoom);
  for (const preset of ZOOM_PRESETS) {
    if (preset > z + EPSILON) return preset;
  }
  return MAX_ZOOM;
}

/** The previous preset below `zoom` (strictly, within epsilon), else MIN_ZOOM. */
export function prevZoomStep(zoom: number): number {
  const z = clampZoom(zoom);
  for (let i = ZOOM_PRESETS.length - 1; i >= 0; i--) {
    if (ZOOM_PRESETS[i] < z - EPSILON) return ZOOM_PRESETS[i];
  }
  return MIN_ZOOM;
}

/** The preset equal to `zoom` (within epsilon), or null when zoom is custom. */
export function matchingPreset(zoom: number): number | null {
  for (const preset of ZOOM_PRESETS) {
    if (Math.abs(preset - zoom) < EPSILON) return preset;
  }
  return null;
}

/**
 * The zoom that fits `pageWidth` into `containerWidth` with `padding` on both
 * sides, clamped. Degenerate inputs (non-positive page or container) yield 1.
 */
export function fitWidthZoom(containerWidth: number, pageWidth: number, padding = FIT_PADDING): number {
  const usable = containerWidth - 2 * padding;
  if (!Number.isFinite(usable) || usable <= 0 || !Number.isFinite(pageWidth) || pageWidth <= 0) {
    return 1;
  }
  return clampZoom(usable / pageWidth);
}

/** The zoom that fits `pageHeight` into `containerHeight` (see {@link fitWidthZoom}). */
export function fitHeightZoom(containerHeight: number, pageHeight: number, padding = FIT_PADDING): number {
  return fitWidthZoom(containerHeight, pageHeight, padding);
}

/** The zoom that fits the whole page: the smaller of fit-width and fit-height. */
export function fitPageZoom(container: ViewSize, page: ViewSize, padding = FIT_PADDING): number {
  return Math.min(
    fitWidthZoom(container.width, page.width, padding),
    fitHeightZoom(container.height, page.height, padding),
  );
}

/** Dispatches a {@link FitMode} to its zoom computation. */
export function fitZoom(mode: FitMode, container: ViewSize, page: ViewSize, padding = FIT_PADDING): number {
  switch (mode) {
    case "fit-width":
      return fitWidthZoom(container.width, page.width, padding);
    case "fit-height":
      return fitHeightZoom(container.height, page.height, padding);
    case "fit-page":
      return fitPageZoom(container, page, padding);
  }
}

/**
 * The pan that centers a page of `page` size at `zoom` in `container`, but
 * never puts the page's top-left above/left of `padding` (so an axis larger
 * than the container is top/left-aligned at the padding instead of centered
 * off-screen).
 */
export function centeredPan(container: ViewSize, page: ViewSize, zoom: number, padding = FIT_PADDING): Point {
  return {
    x: Math.max(padding, (container.width - page.width * zoom) / 2),
    y: Math.max(padding, (container.height - page.height * zoom) / 2),
  };
}

/**
 * Rezooms a viewport keeping the page point under the screen `focus` point
 * stationary (the same math as the canvas' wheel zoom-to-cursor):
 * `pan' = focus − (focus − pan) · (z'/z)`.
 */
export function zoomAboutPoint(viewport: Viewport, focus: Point, newZoom: number): Viewport {
  const z = clampZoom(newZoom);
  const ratio = z / viewport.zoom;
  return {
    zoom: z,
    pan: {
      x: focus.x - (focus.x - viewport.pan.x) * ratio,
      y: focus.y - (focus.y - viewport.pan.y) * ratio,
    },
  };
}

/**
 * The area a fit mode may actually use, after reserving the floating capsule's
 * strip at the bottom.
 *
 * The reserve is subtracted from the HEIGHT only: the capsule is horizontally
 * centred and narrow, so taking width from every fit mode to avoid it would
 * shrink the page for a bar that is nowhere near the left or right edge.
 *
 * A container shorter than the reserve (a collapsed pane mid-animation) would
 * otherwise produce a negative height and a nonsense fit; it floors at 1 and
 * lets `fitWidthZoom`'s own degenerate-input guard take over.
 */
export function usableFitArea(container: ViewSize, bottomReserve = CANVAS_BOTTOM_RESERVE): ViewSize {
  return {
    width: container.width,
    height: Math.max(1, container.height - Math.max(0, bottomReserve)),
  };
}

/**
 * The complete viewport for a fit mode: the zoom AND the pan that centres the
 * page in the area the fit may use.
 *
 * One function rather than two exported halves, because the bottom reserve has
 * to be applied to both. Applying it to the zoom alone still lays the page's
 * bottom edge under the capsule (the page is smaller but centred in the full
 * height); applying it to the pan alone pushes an exactly-fitting page off the
 * top. Both were reachable when this was two calls at the call site — the
 * shipped build did exactly that and the probe measured the page running 66px
 * behind the bar at Fit Page.
 */
export function fitViewport(
  mode: FitMode,
  container: ViewSize,
  page: ViewSize,
  padding = FIT_PADDING,
  bottomReserve = CANVAS_BOTTOM_RESERVE,
): Viewport {
  const area = usableFitArea(container, bottomReserve);
  const zoom = fitZoom(mode, area, page, padding);
  return { zoom, pan: centeredPan(area, page, zoom, padding) };
}
