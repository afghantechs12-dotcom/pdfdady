/**
 * Where an anchored popover goes. Pure, so the placement rules are unit-tested
 * rather than eyeballed at one window size.
 *
 * The rules, in priority order:
 *  1. Prefer BELOW the anchor, left edges aligned — the reading-order default.
 *  2. If it would overflow the bottom, flip ABOVE. Flipping is preferred over
 *     shrinking or scrolling: a colour popover that scrolls internally hides
 *     the swatch grid, which is the part people came for.
 *  3. If neither side fits, take the side with more room and clamp — a popover
 *     that is partly cut off still beats one placed off-screen entirely.
 *  4. Clamp horizontally into the viewport last, so a right-edge anchor slides
 *     the panel left instead of hanging off the edge.
 *
 * The inspector lives at the right edge of the editor, so rule 4 is the common
 * case, not an edge case.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoverPlacement {
  x: number;
  y: number;
  /** Which side of the anchor the panel ended up on — drives the entry transform origin. */
  side: "above" | "below";
}

export function placeAnchoredPopover(
  anchor: Rect,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 6,
  margin = 8,
): PopoverPlacement {
  const belowY = anchor.y + anchor.height + gap;
  const aboveY = anchor.y - gap - panel.height;
  const roomBelow = viewport.height - margin - (anchor.y + anchor.height + gap);
  const roomAbove = anchor.y - gap - margin;

  let side: "above" | "below";
  if (roomBelow >= panel.height) side = "below";
  else if (roomAbove >= panel.height) side = "above";
  else side = roomBelow >= roomAbove ? "below" : "above";

  const rawY = side === "below" ? belowY : aboveY;
  // Clamp so the panel body stays on screen even in the doesn't-fit-either-way
  // case. `Math.max(margin, ...)` runs last so a too-tall panel is pinned to the
  // top rather than pushed off it.
  const y = Math.max(margin, Math.min(rawY, viewport.height - panel.height - margin));
  const x = Math.max(margin, Math.min(anchor.x, viewport.width - panel.width - margin));
  return { x, y, side };
}
