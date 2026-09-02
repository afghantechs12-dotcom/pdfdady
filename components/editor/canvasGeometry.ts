/**
 * Editor canvas geometry — the pixels the page actually gets.
 *
 * ## The defect this module exists to fix
 *
 * Growing the window used to SHRINK the canvas. Measured on the shipped build,
 * with the left rail at 176px and the Inspector dock at 320px:
 *
 *   viewport 1199  ->  rail 176, Inspector not docked, canvas 1023
 *   viewport 1200  ->  rail 176, Inspector docked,      canvas  704
 *
 * One extra pixel of viewport cost 319 pixels of page. `editorPanelLayout`
 * already carried a test named "never shrinks the canvas as the viewport grows",
 * and it was green throughout — because it counted DOCKED PANELS (0 or 1) rather
 * than pixels. A count that can only rise is not the same claim as a width that
 * can only rise, and the difference is exactly where the bug lived. That test was
 * a proxy; this module deals in the real number.
 *
 * ## Why the threshold is not the bug
 *
 * The obvious fix — move or stage the dock threshold — cannot work, and it is
 * worth writing down why so nobody spends another session on it. For a hard
 * threshold `T` and a dock of width `D`, monotonicity at the boundary demands
 *
 *   T - rail - D  >=  (T - 1) - rail        i.e.   -D >= -1
 *
 * which is false for every `D > 1`, at every `T`, for every rail width. No
 * threshold placement and no rail adjustment can absorb a 320px column that
 * appears from nowhere. (This is also why the left rail's stepped
 * `resolveLeftRailWidth` is deliberately NOT wired: a rail that GROWS with width
 * introduces the same violation in miniature — see the monotonicity test.)
 *
 * The real fault is therefore not "where does the Inspector dock" but "the
 * Inspector's VISIBILITY changed because the window was resized". At 1199 the
 * Inspector was closed; at 1200 the persisted dock preference re-asserted itself
 * and it appeared. Compare like with like and the inversion evaporates:
 *
 *   Inspector hidden:   1199 -> 1023   1200 -> 1024    (grows)
 *   Inspector showing:  1199 ->  703   1200 ->  704    (grows)
 *
 * because a drawer at 1199 COVERS the same 320px strip the dock occupies at 1200.
 * So the contract is: width may change how the Inspector is presented (drawer vs
 * dock) but never WHETHER it is presented. That keeps both curves monotonic, and
 * it is what `preserveInspectorVisibility` enforces.
 *
 * Pure arithmetic: no DOM, no React. The claims here are worth checking at every
 * pixel around the boundary, which is not something a browser test can do.
 */

import type { PanelPresentation } from "@/components/editor/editorPanelLayout";

/** The docked Inspector column's width, in px. Mirrors `w-[320px]`. */
export const INSPECTOR_DOCK_WIDTH = 320;

/**
 * The left rail's width when expanded, in px. Mirrors `w-[180px]`.
 *
 * CONSTANT on purpose. A rail that steps up at wider viewports takes pixels from
 * the canvas at the step, which is the same inversion this module forbids. The
 * VALUE moved 176 -> 180 in the final visual pass (the 176px rail clipped two of
 * its three tab labels once the collapse button joined that row); constancy, not
 * the particular number, is what monotonicity depends on.
 */
export const LEFT_RAIL_WIDTH = 180;

/** The collapsed rail's edge strip, in px. Mirrors `w-11`. */
export const LEFT_RAIL_COLLAPSED_WIDTH = 44;

/** The drawer's CSS width: `w-[min(320px,88vw)]`. */
export const DRAWER_VIEWPORT_FRACTION = 0.88;

/**
 * How wide the Inspector drawer renders at a given container width.
 *
 * It matters for usable width because the drawer is an OVERLAY: it does not take
 * part in flex layout, but it does sit on top of the canvas, so the page cannot
 * use the strip underneath it.
 */
export function inspectorDrawerWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  return Math.min(INSPECTOR_DOCK_WIDTH, containerWidth * DRAWER_VIEWPORT_FRACTION);
}

export interface CanvasGeometryInput {
  /** The editor frame's width in px. */
  containerWidth: number;
  /** The left rail's width in px (0 when the rail is not rendered at all). */
  railWidth: number;
  /** How the Inspector is presenting itself. */
  inspector: PanelPresentation;
}

/**
 * The width the PAGE can actually use, in px.
 *
 * "Usable" deliberately counts the drawer against the canvas even though the
 * drawer is absolutely positioned. The old layout-width reading called the
 * canvas 1023px wide while 320px of it was hidden under an open drawer, which is
 * how a 319px regression hid behind a green test.
 */
export function usableCanvasWidth(input: CanvasGeometryInput): number {
  const { containerWidth, railWidth, inspector } = input;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  const rail = Number.isFinite(railWidth) ? Math.max(0, railWidth) : 0;
  const inspectorCost =
    inspector === "docked"
      ? INSPECTOR_DOCK_WIDTH
      : inspector === "drawer"
        ? inspectorDrawerWidth(containerWidth)
        : 0;
  return Math.max(0, containerWidth - rail - inspectorCost);
}

/** True when the Inspector is showing at all, however it is presented. */
export function isInspectorVisible(inspector: PanelPresentation): boolean {
  return inspector !== "closed";
}

/**
 * The dock/drawer state to use after a width change, preserving VISIBILITY.
 *
 * This is the fix for the inversion. Resizing may promote a drawer into a dock
 * (same panel, better presentation) or demote a dock into a drawer, but it must
 * never turn a hidden Inspector into a visible one — that is the transition that
 * silently took 320px from the page.
 *
 * NOTE on the demotion case: `inspectorDocked` is a DURABLE user preference, not
 * a description of the current frame. Below the dock threshold nothing docks
 * regardless of its value (`resolvePanelLayout` ignores it in overlay mode), so
 * the preference is passed through UNCHANGED rather than being cleared. Clearing
 * it looked equivalent and was not: dragging a window narrow and back wide again
 * left the Inspector shut, because the demotion had destroyed the very preference
 * the promotion reads. Measured — 1600 (docked) → 1024 → 1600 came back with no
 * dock and a 320px-wider canvas than the user had chosen.
 *
 * @param wasVisible whether the Inspector was showing BEFORE the width changed
 * @param nextMode   the presentation mode the new width affords
 * @param persistedDock the user's durable "keep it docked" preference
 */
export function preserveInspectorVisibility(opts: {
  wasVisible: boolean;
  nextMode: "docked" | "overlay";
  persistedDock: boolean;
}): { inspectorDocked: boolean; drawerOpen: boolean } {
  const { wasVisible, nextMode, persistedDock } = opts;
  if (nextMode === "docked") {
    // Dock only what was already on screen. A user who never opened the
    // Inspector keeps every pixel of the page when they widen the window; the
    // toggle is still one click away, and the toolbar still shows its state.
    return { inspectorDocked: wasVisible && persistedDock, drawerOpen: false };
  }
  // Below the threshold nothing docks; a visible Inspector becomes a drawer so it
  // stays reachable rather than vanishing mid-resize. The durable preference
  // rides through untouched so widening restores what the user chose.
  return { inspectorDocked: persistedDock, drawerOpen: wasVisible };
}
