import type { ResizeHandle } from "@/src/application/editor/transform/TransformService";

/**
 * The GEOMETRY of selection chrome — which handles a selection may show, how big
 * their pointer targets are, and which side the rotate handle goes on.
 *
 * WHY THIS EXISTS. `SelectionOverlay` drew all eight handles at a fixed 9px
 * visual size with a fixed 24px pointer target, centred on the selection's
 * corners and edge midpoints, regardless of how big the selection actually was on
 * screen. Measured in Chrome (a 180×120pt shape, zoomed out to 25%, so a 45×30
 * screen box), that produced:
 *
 *   - 12 OVERLAPPING pairs of pointer targets, e.g. `nw/n` sharing a 2×24 region
 *     and `nw/w` sharing 24×9. The mid-edge handles were not independently
 *     targetable at all: the top edge is 45px wide and the `n` target alone is
 *     24px of it.
 *   - 24 of 25 points sampled on a 5×5 grid INSIDE the selection returned a
 *     resize handle from `document.elementFromPoint`. Only the exact centre still
 *     returned the object. A small on-screen selection could not be DRAGGED —
 *     every pointer-down in it started a resize instead of a move.
 *
 * That is a functional defect, not a cosmetic one, and it is not rare: it is what
 * every selection looks like once you zoom out to see the whole page.
 *
 * The fix has two independent parts, and both live here as pure functions so the
 * thresholds are testable without a DOM:
 *
 *  1. **Pointer targets reach OUTWARD, not inward.** A handle's target still
 *     measures {@link HANDLE_HIT}px — WCAG 2.2 AA target size is not negotiable —
 *     but at most {@link HANDLE_INWARD_MAX}px of it lies inside the selection, with
 *     the remainder outside. This is also what it means physically: you grab a
 *     corner from outside the shape, not from within it.
 *  2. **Handles a selection cannot host are not drawn.** A mid-edge handle needs
 *     an edge at least `2 × HANDLE_HIT` long to sit clear of its two corners, and
 *     a selection below a few tens of pixels cannot host a handle at all while
 *     keeping a draggable interior. Below those bounds the chrome is a frame, and
 *     resizing happens through the Inspector's W/H fields — which is a real path,
 *     not a dead end.
 *
 * The invariant every function here serves: **a selection always keeps at least
 * {@link DRAG_CORE_MIN}px of interior in each axis that starts a MOVE.** Chrome
 * that eats its own object is chrome that has stopped describing it.
 *
 * @see [[selection-chrome-drag-core]]
 */

/** The pointer target per handle — 24px meets WCAG 2.2 AA (2.5.8) target size. */
export const HANDLE_HIT = 24;

/**
 * How far into the selection a handle's pointer target may reach.
 *
 * The rest of the 24px extends OUTSIDE. 8px is enough to cover the visual
 * handle's inward half (4.5px at full size) with margin, and it costs the
 * interior 16px total rather than 24px.
 */
export const HANDLE_INWARD_MAX = 8;

/** The interior that must survive in each axis so a MOVE is still startable. */
export const DRAG_CORE_MIN = 10;

/** The visual handle at full size. Shrinks with the selection; see {@link handleVisualSize}. */
export const HANDLE_SIZE = 9;

/**
 * The shortest edge that can host a mid-edge handle clear of its two corners.
 *
 * Two adjacent targets along an edge do not overlap when the gap between their
 * centres is at least one target wide. A corner's target reaches
 * {@link HANDLE_INWARD_MAX} inward and a mid-edge target is centred, so the
 * requirement is `edge/2 − HANDLE_HIT/2 ≥ HANDLE_INWARD_MAX`, i.e. edge ≥ 40. The
 * bound is set at `2 × HANDLE_HIT` = 48 instead: it satisfies that with margin and
 * it is the threshold the browser measurement produced directly (a 45px edge
 * overlapped, and it is the value to re-measure if `HANDLE_HIT` ever moves).
 */
export const MID_HANDLE_MIN_EDGE = 2 * HANDLE_HIT;

/** Canonical handle order — matters because later siblings win an SVG hit tie. */
const ALL_HANDLES: readonly ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const CORNERS: readonly ResizeHandle[] = ["nw", "ne", "se", "sw"];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How far a handle's pointer target reaches INSIDE the selection, in screen px.
 *
 * `0` means the selection is too small to host a handle at all: every inward
 * pixel it could spend is needed for the drag core.
 *
 * Both axes are limited by the SHORTER one, because a handle's target is square.
 * A wide, flat selection (a highlight strip, say) therefore gets a shallow target
 * rather than none — the alternative would be an unresizable highlight.
 */
export function handleInwardExtent(width: number, height: number): number {
  const shortest = Math.min(width, height);
  if (!Number.isFinite(shortest) || shortest <= 0) return 0;
  const spendable = Math.floor((shortest - DRAG_CORE_MIN) / 2);
  return clamp(spendable, 0, HANDLE_INWARD_MAX);
}

/**
 * The visual handle's side length for a given inward extent.
 *
 * Capped at `inward × 2` so the square a user SEES never reaches deeper into the
 * selection than the target they can actually press. A visual handle bigger than
 * its own hit area is the same lie as a hit area bigger than its object.
 */
export function handleVisualSize(inward: number): number {
  if (inward <= 0) return 0;
  return Math.min(HANDLE_SIZE, inward * 2);
}

/**
 * Which handles this selection may draw, in canonical order.
 *
 * Corners come first because they are the affordance users aim for; mid-edge
 * handles are added per axis only when that edge can host one clear of its
 * corners. A 300×20 strip gets `n`/`s` but not `e`/`w`, which is the honest
 * answer for a shape that has room to be grabbed one way and not the other.
 */
export function visibleHandles(width: number, height: number): ResizeHandle[] {
  if (handleInwardExtent(width, height) <= 0) return [];
  const allowed = new Set<ResizeHandle>(CORNERS);
  if (width >= MID_HANDLE_MIN_EDGE) {
    allowed.add("n");
    allowed.add("s");
  }
  if (height >= MID_HANDLE_MIN_EDGE) {
    allowed.add("e");
    allowed.add("w");
  }
  return ALL_HANDLES.filter((h) => allowed.has(h));
}

/**
 * The interior left over for starting a MOVE, in screen px.
 *
 * This is the measurement the whole module exists to keep positive. Exported so a
 * test can assert it directly across a sweep of sizes rather than trusting that
 * the thresholds happen to compose.
 */
export function dragCore(width: number, height: number): { width: number; height: number } {
  const inward = handleInwardExtent(width, height);
  return {
    width: Math.max(0, width - inward * 2),
    height: Math.max(0, height - inward * 2),
  };
}

/**
 * Where a handle's `HANDLE_HIT`-sized target sits, given the handle and the
 * selection box, in the same screen space as `box`.
 *
 * The bias is per axis and outward from the selection: a `nw` target is pushed up
 * and left, an `n` target only up, an `e` target only right. A mid-edge handle is
 * centred along the edge it sits on, because there is nothing to bias it away
 * from in that direction.
 */
export function handleHitRect(
  handle: ResizeHandle,
  box: { x: number; y: number; width: number; height: number },
  inward: number,
): { x: number; y: number; size: number } {
  const outward = HANDLE_HIT - inward;
  const west = handle === "nw" || handle === "w" || handle === "sw";
  const east = handle === "ne" || handle === "e" || handle === "se";
  const north = handle === "nw" || handle === "n" || handle === "ne";
  const south = handle === "sw" || handle === "s" || handle === "se";

  const x = west
    ? box.x - outward
    : east
      ? box.x + box.width - inward
      : box.x + box.width / 2 - HANDLE_HIT / 2;
  const y = north
    ? box.y - outward
    : south
      ? box.y + box.height - inward
      : box.y + box.height / 2 - HANDLE_HIT / 2;

  return { x, y, size: HANDLE_HIT };
}

/** The CSS cursor for a resize handle. */
export function handleCursor(handle: ResizeHandle): string {
  switch (handle) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    default:
      return "nwse-resize";
  }
}

/** The gap between the selection's edge and the rotate handle's centre. */
export const ROTATE_OFFSET = 28;

/**
 * The space above the selection the rotate handle needs to be visible.
 *
 * `ROTATE_OFFSET` plus the handle's radius plus a little margin. Measured against
 * the canvas `<svg>`, whose computed `overflow` is `hidden` — so a handle drawn at
 * a negative y is not merely awkward, it is CLIPPED AWAY.
 */
export const ROTATE_ROOM = ROTATE_OFFSET + 6;

/**
 * Which side of the selection the rotate handle goes on.
 *
 * The canvas `<svg>` does not grow with zoom — it stays viewport-sized and the
 * page is panned inside it — so `box.y` is genuinely small whenever the selection
 * sits near the top of what the user can see. Measured at 300% zoom the page's top
 * was 657px ABOVE the svg's own top edge, which is how a fixed `box.y - 28`
 * places a rotate handle outside a clipped element: present in the DOM, invisible
 * and unclickable. The same class of defect as the toolbar menu clipped to 38px.
 *
 * KNOWN LIMIT: a selection TALLER than the visible canvas whose top is above the
 * fold has no room on either side, and this returns `below` for it — off screen.
 * There is no third position that is inside the canvas and not on top of the
 * object, and rotation still has a non-gestural path (the Inspector's Rotation
 * field), so the degradation is a real alternative rather than a dead end.
 */
export function rotateSide(boxTop: number): "above" | "below" {
  return boxTop >= ROTATE_ROOM ? "above" : "below";
}

/** The rotate handle's centre y for a side, in the same space as `box`. */
export function rotateCentreY(
  box: { y: number; height: number },
  side: "above" | "below",
): number {
  return side === "above" ? box.y - ROTATE_OFFSET : box.y + box.height + ROTATE_OFFSET;
}
