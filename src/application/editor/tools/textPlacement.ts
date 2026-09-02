/**
 * The default frame for a newly placed text box.
 *
 * WHY THIS EXISTS. `createTextObject` defaults to `makeBounds(0, 0, 200, …)` — a
 * constant that predates the tool having a page to place onto. The review called
 * the result "a low-level primitive": 200pt is a third of an A4 line and most of
 * a small-format page, so the first thing the user does after typing is resize
 * the box. A text box placed by a person clicking a page should already be the
 * width that page's text wants to be.
 *
 * The factory default is deliberately left alone (a large number of tests and
 * serialization fixtures pin it, and a domain factory should not need to know
 * about pages). This module is what the CANVAS uses when a human places text.
 *
 * Pure arithmetic: no DOM, no measurement.
 */

import { makeBounds, type Bounds, type Point } from "@/src/domain/editor/geometry";

/** Fraction of the page width a click-placed text box spans by default. */
export const TEXT_DEFAULT_WIDTH_FRACTION = 0.42;

/** Margin (pt) kept between a placed text box and the page edge. */
export const TEXT_PLACEMENT_MARGIN = 24;

/** Floor for a placed text box's width, so a tiny page still yields a usable box. */
export const TEXT_MIN_WIDTH = 96;

/** Minimum drag distance (pt) before a drag counts as "draw me a text area". */
export const TEXT_DRAG_THRESHOLD = 12;

export interface PageSize {
  width: number;
  height: number;
}

/**
 * The width a click-placed text box should have on this page: a fraction of the
 * page width, never wider than the usable width, never below a legible floor.
 */
export function resolveTextBoxWidth(
  page: PageSize,
  fraction: number = TEXT_DEFAULT_WIDTH_FRACTION,
): number {
  const usable = Math.max(1, page.width - TEXT_PLACEMENT_MARGIN * 2);
  if (!Number.isFinite(page.width) || page.width <= 0) return TEXT_MIN_WIDTH;
  return Math.max(Math.min(TEXT_MIN_WIDTH, usable), Math.min(page.width * fraction, usable));
}

/**
 * Placement for a CLICK (no drag): the box starts at the click point — text grows
 * down-and-right from where you clicked, which is where a caret belongs — but is
 * pulled back inside the page if that would overflow the right or bottom edge.
 *
 * The height is one line; auto-growth on typing is the text layout engine's job,
 * not a guess made at creation time.
 */
export function resolveTextClickPlacement(
  at: Point,
  page: PageSize,
  lineHeight: number,
  fraction: number = TEXT_DEFAULT_WIDTH_FRACTION,
): { position: Point; localBounds: Bounds } {
  const width = resolveTextBoxWidth(page, fraction);
  const height = Math.max(1, lineHeight);
  return {
    position: {
      x: clampAxis(at.x, width, page.width),
      y: clampAxis(at.y, height, page.height),
    },
    localBounds: makeBounds(0, 0, width, height),
  };
}

/**
 * Placement for a DRAG: the user has drawn the text area explicitly, so their
 * rectangle is honoured — normalized (drag in any direction), floored to a usable
 * size, and clamped inside the page.
 */
export function resolveTextDragPlacement(
  from: Point,
  to: Point,
  page: PageSize,
  lineHeight: number,
): { position: Point; localBounds: Bounds } {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const width = Math.max(Math.abs(to.x - from.x), TEXT_MIN_WIDTH);
  const height = Math.max(Math.abs(to.y - from.y), Math.max(1, lineHeight));
  return {
    position: {
      x: clampAxis(x, width, page.width),
      y: clampAxis(y, height, page.height),
    },
    localBounds: makeBounds(0, 0, width, height),
  };
}

/** True when a pointer movement is far enough to mean "drag a text area". */
export function isTextAreaDrag(from: Point, to: Point, threshold = TEXT_DRAG_THRESHOLD): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= threshold;
}

/** Keeps `[start, start + size]` inside the page, without going negative. */
function clampAxis(start: number, size: number, pageExtent: number): number {
  if (!Number.isFinite(start)) return TEXT_PLACEMENT_MARGIN;
  if (!Number.isFinite(pageExtent) || pageExtent <= 0) return Math.max(0, start);
  const max = pageExtent - TEXT_PLACEMENT_MARGIN - size;
  if (max <= 0) return Math.max(0, (pageExtent - size) / 2);
  return Math.min(Math.max(start, 0), max);
}
