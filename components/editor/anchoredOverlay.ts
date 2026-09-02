/**
 * Anchored-overlay placement — the pure geometry behind a portalled menu.
 *
 * WHY THIS EXISTS. The toolbar's cluster menus (`Add Shape ▾`, `Draw ▾`) were
 * plain `position: absolute` children of the tool row. That row is
 * `overflow-x-auto` (the honest-degradation backstop for a row too long for its
 * container), and per CSS overflow a non-`visible` value on one axis computes
 * `visible` on the other to `auto` — so the row is a scroll container on BOTH
 * axes and clipped the menu to a 38px strip.
 *
 * The menu still had a real bounding box and was keyboard reachable, so nothing
 * looked broken in the DOM; but hit-testing stops at the clip, and
 * `document.elementFromPoint()` at the item's own centre returned the CANVAS.
 * Every click on "Rectangle" landed on the page instead of the item, so the tool
 * was never activated. That is the entire "Shape does not work" bug.
 *
 * Rendering the menu in a PORTAL removes the ancestor clip by construction — it
 * is no longer a descendant of the scroller — which means its position must be
 * computed from the trigger's viewport rect instead of inherited from an
 * offsetParent. That arithmetic is here, pure and tested, rather than inline in
 * the component: "the menu is on screen" is a property worth asserting without
 * a browser.
 */

/** A viewport-space rectangle (what `getBoundingClientRect()` returns). */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The viewport the overlay must stay inside. */
export interface ViewportSize {
  width: number;
  height: number;
}

export interface OverlaySize {
  width: number;
  height: number;
}

export interface AnchoredPlacement {
  /** Viewport-space left edge for the overlay. */
  left: number;
  /** Viewport-space top edge for the overlay. */
  top: number;
  /** Which side of the anchor the overlay was placed on. */
  side: "below" | "above";
  /**
   * Max height the overlay may use at this position, so a long menu scrolls
   * INTERNALLY rather than running off the bottom of the window.
   */
  maxHeight: number;
}

/** Gap (px) between the anchor and the overlay. */
export const ANCHOR_GAP = 6;

/** Minimum margin (px) kept between the overlay and the viewport edges. */
export const VIEWPORT_MARGIN = 8;

/** Never flip/shrink below this: a menu smaller than this is not usable. */
export const MIN_OVERLAY_HEIGHT = 96;

/**
 * Places an overlay under its anchor, flipping above when there is more room
 * there, and clamping horizontally so it is never off-screen.
 *
 * Preference order matches what a user expects of a dropdown: below the trigger
 * unless below genuinely cannot fit it, in which case use whichever side has
 * more space.
 */
export function placeAnchoredOverlay(
  anchor: AnchorRect,
  overlay: OverlaySize,
  viewport: ViewportSize,
): AnchoredPlacement {
  const spaceBelow = viewport.height - (anchor.y + anchor.height) - ANCHOR_GAP - VIEWPORT_MARGIN;
  const spaceAbove = anchor.y - ANCHOR_GAP - VIEWPORT_MARGIN;

  // Flip only when below cannot show a usable menu AND above is roomier.
  const fitsBelow = spaceBelow >= Math.min(overlay.height, MIN_OVERLAY_HEIGHT);
  const side: "below" | "above" = fitsBelow || spaceBelow >= spaceAbove ? "below" : "above";

  const available = Math.max(0, side === "below" ? spaceBelow : spaceAbove);
  const height = Math.min(overlay.height, available);

  // `top` is what CSS gets, so the two sides constrain differently. Below, the
  // menu is TOP-anchored and grows down, so it may use all the space below.
  // Above, it is visually BOTTOM-anchored: `top` is derived from the height, so
  // handing CSS the full space above would let the content grow back DOWN over
  // the trigger it belongs to. Capping maxHeight at the height used keeps the
  // menu's bottom edge at the anchor.
  return side === "below"
    ? {
        left: clampAxis(anchor.x, overlay.width, viewport.width),
        top: anchor.y + anchor.height + ANCHOR_GAP,
        side,
        maxHeight: available,
      }
    : {
        left: clampAxis(anchor.x, overlay.width, viewport.width),
        top: Math.max(VIEWPORT_MARGIN, anchor.y - ANCHOR_GAP - height),
        side,
        maxHeight: height,
      };
}

/**
 * Keeps `[start, start + size]` inside `[margin, extent - margin]`. A menu wider
 * than the viewport is pinned to the left margin rather than centred, so its
 * first items stay readable.
 */
function clampAxis(start: number, size: number, extent: number): number {
  const max = extent - VIEWPORT_MARGIN - size;
  if (max <= VIEWPORT_MARGIN) return VIEWPORT_MARGIN;
  return Math.min(Math.max(start, VIEWPORT_MARGIN), max);
}
