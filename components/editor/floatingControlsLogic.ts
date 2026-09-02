/**
 * Pure derivation logic for the floating bottom canvas controls (P1 Phase I).
 *
 * Extracted from `FloatingCanvasControls` for the same reason `documentLoadState`
 * was extracted from the workspace: the claims worth testing here — "Zoom out is
 * disabled at the minimum", "Next is disabled on the last page", "the readout
 * says what the zoom actually is" — are claims about derivation, and derivation
 * should be checkable without mounting React, faking a ResizeObserver or
 * measuring a canvas.
 *
 * Nothing here owns state. Every function maps the editor's existing viewport /
 * page / fit state onto what the capsule should render, so the capsule cannot
 * disagree with the shortcut manager or the status bar — they read the same
 * numbers through the same helpers.
 */

import { MAX_ZOOM, MIN_ZOOM, type FitMode } from "@/components/editor/viewport/zoom";

/** Tolerance for float comparison against the clamp bounds. */
const EPSILON = 1e-6;

/**
 * Whether stepping the zoom down is still possible.
 *
 * Compared against the real clamp bound rather than the preset ladder: the wheel
 * can land the zoom between presets, and a stepper disabled at 0.11 because
 * "0.1 is the lowest preset" would be lying about a step it can still take.
 */
export function canZoomOut(zoom: number): boolean {
  if (!Number.isFinite(zoom)) return false;
  return zoom > MIN_ZOOM + EPSILON;
}

/** Whether stepping the zoom up is still possible. See {@link canZoomOut}. */
export function canZoomIn(zoom: number): boolean {
  if (!Number.isFinite(zoom)) return false;
  return zoom < MAX_ZOOM - EPSILON;
}

/**
 * The zoom percentage shown in the readout.
 *
 * Rounded, and floored at 1%: `Math.round` alone renders a 0.4% zoom as "0%",
 * which reads as "the page is not displayed" rather than "very small". The clamp
 * makes that unreachable in practice; this is the guard for the arithmetic, not
 * for the UI.
 */
export function zoomReadout(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 100;
  return Math.max(1, Math.round(zoom * 100));
}

/** Whether the Previous-page control should be enabled. `pageNumber` is 1-based. */
export function canGoPrevPage(pageNumber: number, pageCount: number): boolean {
  return pageCount > 1 && pageNumber > 1;
}

/** Whether the Next-page control should be enabled. `pageNumber` is 1-based. */
export function canGoNextPage(pageNumber: number, pageCount: number): boolean {
  return pageCount > 1 && pageNumber < pageCount;
}

/**
 * The disabled reason for a page control, or null when it is enabled.
 *
 * A disabled control that cannot say why is a dead end (I11 asks for a clear
 * reason). This travels into the control's `title`/accessible name so the reason
 * is available to both a pointer user and a screen reader, rather than being
 * inferable only from the greyed pixels.
 */
export function pageNavDisabledReason(
  direction: "prev" | "next",
  pageNumber: number,
  pageCount: number,
): string | null {
  if (direction === "prev") {
    if (canGoPrevPage(pageNumber, pageCount)) return null;
    return pageCount > 1 ? "Already on the first page" : "This document has one page";
  }
  if (canGoNextPage(pageNumber, pageCount)) return null;
  return pageCount > 1 ? "Already on the last page" : "This document has one page";
}

/** The zoom-stepper disabled reason, or null when the step is available. */
export function zoomDisabledReason(direction: "in" | "out", zoom: number): string | null {
  if (direction === "out") {
    return canZoomOut(zoom) ? null : `Minimum zoom (${zoomReadout(MIN_ZOOM)}%)`;
  }
  return canZoomIn(zoom) ? null : `Maximum zoom (${zoomReadout(MAX_ZOOM)}%)`;
}

/** Human labels for the fit modes, used by the trigger and the menu rows. */
export const FIT_MODE_LABELS: Readonly<Record<FitMode, string>> = {
  "fit-page": "Fit page",
  "fit-width": "Fit width",
  "fit-height": "Fit height",
};

/**
 * The label on the zoom/fit trigger.
 *
 * When a fit mode is sticky the mode NAME is what the user chose and what will
 * survive the next resize, so it leads; the percentage follows in parentheses
 * because it is still the live truth about the page size. With a manual zoom
 * there is no mode to name, so the percentage stands alone.
 *
 * This is the fix for a real ambiguity: the pre-Phase-I capsule showed only
 * "78%", so "the window resized and my zoom changed" and "I am in Fit width and
 * that is doing its job" were indistinguishable in the UI.
 */
export function zoomTriggerLabel(zoom: number, fitMode: FitMode | null): string {
  const pct = `${zoomReadout(zoom)}%`;
  return fitMode ? `${FIT_MODE_LABELS[fitMode]} (${pct})` : pct;
}

/** The compact trigger label — percentage only; the mode shows as an accent. */
export function zoomTriggerLabelCompact(zoom: number): string {
  return `${zoomReadout(zoom)}%`;
}

/** The accessible name for the zoom/fit trigger. Always states both facts. */
export function zoomTriggerAccessibleName(zoom: number, fitMode: FitMode | null): string {
  const pct = `${zoomReadout(zoom)}%`;
  return fitMode
    ? `Zoom level: ${pct}, ${FIT_MODE_LABELS[fitMode]}`
    : `Zoom level: ${pct}`;
}

/**
 * Which of the capsule's two pointer-mode buttons is genuinely pressed.
 *
 * WHY THIS EXISTS. The capsule knew only `panActive`, and rendered Select as
 * `active={!panActive}` — "anything that is not Hand is Select". That is false
 * for every other tool the editor has: with Rectangle, Draw, Text or Image
 * placement active the bar still claimed `aria-pressed=true` on Select, so the
 * UI and the screen reader both named the wrong instrument. Measured directly:
 * activate Rectangle from the toolbar, and the bottom bar still reported
 * "Select tool (V)" as pressed while a drag drew a rectangle.
 *
 * The fix is a derivation from the CANONICAL tool id rather than a boolean pair,
 * so there is exactly one truthful answer and no local state to drift:
 *
 *  - `select` → Select pressed
 *  - `hand`   → Hand pressed
 *  - anything else (`rect`, `draw`, `text`, `eraser`, `crop`, …) → NEITHER
 *
 * Neither-pressed is the important case and the one that was wrong: it is how the
 * bar stays honest about a tool it does not itself offer. The active tool is
 * still visible — the toolbar shows it, in the accent style that means "this is
 * your pointer" — so nothing is hidden by the capsule declining to claim it.
 */
export type CapsulePointerMode = "select" | "hand" | "other";

export function resolveCapsulePointerMode(tool: string): CapsulePointerMode {
  if (tool === "select") return "select";
  if (tool === "hand") return "hand";
  return "other";
}

/** True when the capsule's Select button should report itself pressed. */
export function isSelectPressed(tool: string): boolean {
  return resolveCapsulePointerMode(tool) === "select";
}

/** True when the capsule's Hand/Pan button should report itself pressed. */
export function isPanPressed(tool: string): boolean {
  return resolveCapsulePointerMode(tool) === "hand";
}

/**
 * Which control groups the capsule shows at a given container width.
 *
 * Priority order under pressure, most-cut-last: zoom and page navigation are the
 * two reasons the capsule exists, so they never drop. What drops is the
 * duplicated/secondary chrome — the pointer-mode pair (the toolbar has Select
 * and Hand too), the Inspector toggle, and finally the fit menu's presence as a
 * separate button.
 *
 * Widths are the CAPSULE's own container (the canvas region), not the viewport:
 * inside the workbench the editor sits beside the app sidebar, so a 1024px
 * window does not give the canvas 1024px.
 */
export type CapsuleDensity = "full" | "medium" | "compact";

export const CAPSULE_BREAKPOINTS = {
  /** At or above: everything, with the fit mode named on the trigger. */
  full: 900,
  /** At or above: pointer mode drops; zoom + pages + fit + inspector stay. */
  medium: 620,
} as const;

/** Maps a measured canvas width to the capsule's density. */
export function resolveCapsuleDensity(width: number): CapsuleDensity {
  if (!Number.isFinite(width) || width >= CAPSULE_BREAKPOINTS.full) return "full";
  if (width >= CAPSULE_BREAKPOINTS.medium) return "medium";
  return "compact";
}

/** What a given density actually renders. */
export interface CapsuleVisibility {
  /** The Hand/Select pair. */
  pointerMode: boolean;
  /** The zoom stepper + readout + fit menu. Never hidden — the capsule's reason. */
  zoom: boolean;
  /** Page prev / readout / next. Shown whenever the document has >1 page. */
  pages: boolean;
  /** The standalone Fit-page button beside the menu. */
  fitButton: boolean;
  /** The Inspector toggle. */
  inspector: boolean;
  /** Whether the trigger names the active fit mode (vs percentage only). */
  fitModeOnTrigger: boolean;
}

/** Resolves what the capsule shows at a density. */
export function resolveCapsuleVisibility(density: CapsuleDensity): CapsuleVisibility {
  switch (density) {
    case "full":
      return {
        pointerMode: true,
        zoom: true,
        pages: true,
        fitButton: true,
        inspector: true,
        fitModeOnTrigger: true,
      };
    case "medium":
      // Pointer mode goes first: Select/Hand are also in the toolbar and on the
      // keyboard (V/H, and space-to-pan), so this is the only genuinely
      // duplicated group in the capsule.
      return {
        pointerMode: false,
        zoom: true,
        pages: true,
        fitButton: true,
        inspector: true,
        fitModeOnTrigger: false,
      };
    case "compact":
      // Phone width. The fit BUTTON goes (the mode is still reachable inside the
      // zoom menu, so no capability is lost) and so does the Inspector toggle,
      // which the toolbar also offers. What is left is exactly the brief's
      // compact structure: ‹ 2/56 › − 78% + .
      return {
        pointerMode: false,
        zoom: true,
        pages: true,
        fitButton: false,
        inspector: false,
        fitModeOnTrigger: false,
      };
  }
}

/**
 * The page readout text. 1-based, and never renders a nonsense pair.
 *
 * `pageNumber` can momentarily be 0 when the active page id is not in the list
 * (a page was deleted and the new active page has not committed yet), and
 * "0 / 12" is a state the document is never actually in.
 */
export function pageReadout(pageNumber: number, pageCount: number): string {
  const total = Math.max(1, Math.floor(pageCount) || 1);
  const current = Math.min(Math.max(Math.floor(pageNumber) || 1, 1), total);
  return `${current} / ${total}`;
}

/** Clamps a typed page number into the document, or null when unusable. */
export function resolvePageEntry(raw: string, pageCount: number): number | null {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  const total = Math.max(1, Math.floor(pageCount) || 1);
  return Math.min(Math.max(parsed, 1), total);
}
