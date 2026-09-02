/**
 * Adaptive right-panel layout for the editor surfaces.
 *
 * ## Why there is exactly ONE right panel
 *
 * The previous contract docked TWO independent right panels — Properties and the
 * Document inspector — once the viewport reached 1600px. Measured against the
 * real chrome that was 640px of permanent furniture on the right edge, and it
 * produced two separate 320px columns whose tab strips and headers repeated the
 * same visual vocabulary side by side. The user's report was that the editor felt
 * "boxed in": the page — the only thing being edited — was the smallest region on
 * screen at the widest windows.
 *
 * So the dock is now singular. One Inspector, one 320px column, one tab strip
 * (`Properties · Outline · Comments · Versions`), at every width that affords a
 * dock at all. Everything reclaimed goes to the canvas.
 *
 * The one rule kept verbatim from the old contract, because it was a real bug
 * fixed at real cost: **widening the window must never shrink the canvas.** The
 * shipped layout docked the document inspector at Tailwind's `2xl` (1536px)
 * while properties docked at `lg`, so 1440px gave 696px of canvas and 1536px
 * gave 504px — growing the window took 192px away from the page. A single dock
 * makes that inversion structurally impossible (the docked count can only be 0
 * or 1, and only ever rises with width), and the tests still pin it.
 *
 * Pure functions, no DOM: the thresholds and the fallback behaviour are the
 * parts worth testing, and both are easy to get wrong at the boundary.
 */

/**
 * Whether the width affords a docked Inspector at all.
 *
 * Two values, not three: with a single dock there is no "wide enough for a
 * second panel" state left to model, and keeping a `dual` mode that no longer
 * changed the layout would be a lie the next reader has to disprove.
 */
export type PanelMode = "overlay" | "docked";

export const PANEL_BREAKPOINTS = {
  /** At or above this width, the Inspector may dock beside the canvas. */
  docked: 1200,
} as const;

/** Maps a viewport width to the layout mode. */
export function resolvePanelMode(width: number): PanelMode {
  return width >= PANEL_BREAKPOINTS.docked ? "docked" : "overlay";
}

/** How the Inspector is presenting itself right now. */
export type PanelPresentation = "docked" | "drawer" | "closed";

export interface PanelLayout {
  /** The single right-hand Inspector. */
  inspector: PanelPresentation;
}

/**
 * Resolves the Inspector's presentation.
 *
 * `inspectorDocked` is the user's persisted wish to keep the dock open — worth
 * persisting, because collapsing a panel the user always collapses is a real
 * preference. `drawerOpen` is a transient overlay and is deliberately NOT
 * restored from storage: "I peeked at comments on a phone" is not a durable
 * layout preference.
 */
export function resolvePanelLayout(opts: {
  mode: PanelMode;
  /** The persisted wish to keep the Inspector docked where a dock exists. */
  inspectorDocked: boolean;
  /** Whether the Inspector is currently open as a temporary overlay. */
  drawerOpen: boolean;
}): PanelLayout {
  const { mode, inspectorDocked, drawerOpen } = opts;

  if (mode === "docked") {
    // A drawer is meaningless where the panel can dock: the dock preference is
    // the single source of truth for "is the Inspector showing" at this width.
    return { inspector: inspectorDocked ? "docked" : drawerOpen ? "drawer" : "closed" };
  }

  // Below the breakpoint nothing docks: every pixel of width belongs to the page.
  return { inspector: drawerOpen ? "drawer" : "closed" };
}

/**
 * Whether a transient drawer must be force-closed after a resize.
 *
 * Dragging a window wider until the Inspector docks should not leave a floating
 * copy of that same panel over the canvas.
 */
export function drawerAfterResize(drawerOpen: boolean, layout: PanelLayout): boolean {
  if (!drawerOpen) return false;
  return layout.inspector !== "docked";
}

/* ------------------------------------------------------------------------- *
 * The Inspector's tab model
 * ------------------------------------------------------------------------- */

/**
 * The Inspector's tabs, flattened.
 *
 * `Properties` describes the SELECTION; the other three describe the DOCUMENT
 * and are served by the workspace inspector. They are modelled as one flat list
 * rather than a Properties/Document split with the document's own tabs nested
 * inside, because nested tab strips make the user pay two clicks and a mental
 * model to reach "Comments" — and the flat strip is what makes the single dock
 * feel like one panel instead of two panels stacked in a trench coat.
 */
export type InspectorTabId = "properties" | "outline" | "comments" | "versions";

/** The document-scoped tabs, in strip order. Owned by the workspace inspector. */
export const DOCUMENT_INSPECTOR_TABS: readonly InspectorTabId[] = ["outline", "comments", "versions"];

/** The selection-scoped tab. Always available — there is always a selection state. */
export const PROPERTIES_TAB: InspectorTabId = "properties";

/**
 * Which tabs exist right now.
 *
 * The standalone editor has no workspace document behind it, so it has no
 * outline, comments or versions to show. It gets a one-tab Inspector rather than
 * three tabs that would each have to explain why they are empty — an affordance
 * that leads nowhere is worse than an absent one.
 */
export function resolveInspectorTabs(hasDocumentPanel: boolean): readonly InspectorTabId[] {
  return hasDocumentPanel ? [PROPERTIES_TAB, ...DOCUMENT_INSPECTOR_TABS] : [PROPERTIES_TAB];
}

/**
 * Resolves the tab actually shown, given what the user last requested.
 *
 * The requested tab can become unavailable while it is open — closing a
 * workspace document, or a standalone editor mounting with a remembered
 * `comments` tab. Falling back to `properties` keeps the panel showing
 * something true instead of rendering a blank body for a tab that no longer
 * exists.
 */
export function resolveActiveInspectorTab(
  requested: InspectorTabId,
  available: readonly InspectorTabId[],
): InspectorTabId {
  return available.includes(requested) ? requested : PROPERTIES_TAB;
}

/** True when `tab` is served by the workspace document inspector. */
export function isDocumentInspectorTab(tab: InspectorTabId): boolean {
  return DOCUMENT_INSPECTOR_TABS.includes(tab);
}

/** localStorage key for the durable dock preference. */
export const INSPECTOR_DOCK_KEY = "pdfdadi.editor.inspectorDocked";

/**
 * How an Inspector tab renders itself: with an icon, a word, or both.
 *
 * WHY THIS IS A FUNCTION OF TAB COUNT AND NOT OF VIEWPORT WIDTH. The dock is a
 * fixed 320px at every width at which it docks, so the space one tab gets is
 * decided by how many tabs share the strip — never by how wide the window is.
 * An earlier revision hid the label below a 1320px VIEWPORT (`max-[1320px]:hidden`),
 * which is the wrong axis: at a 1600px viewport the labels were shown and then
 * silently truncated to "Proper…" / "Comm…", measured at 49px of box for 55px and
 * 58px of text. Primary navigation must not quietly lose its own name.
 *
 * THE BUDGET, measured in Chrome at the shipped 11px semibold:
 *
 *   dock 320px − 1px `border-l`                    = 319px content
 *   − the 31px "Collapse inspector" button          = 288px for the strip
 *
 *   per tab, icon + label:  12px `px-1.5` + 14px icon + 6px `gap-1.5` + 58px = 90px
 *   per tab, label only:    12px `px-1.5` +                             58px = 70px
 *   per tab, icon only:     12px `px-1.5` + 14px icon                        = 26px
 *
 * 58px is the widest shipped label ("Comments"; "Properties" 55, "Versions" 47,
 * "Outline" 38). So three tabs fit icon + label (270 ≤ 288) and four fit the
 * label alone (280 ≤ 288), which is why the icon — and not the word — is what
 * yields first: the icon is decorative next to the label it sits beside, and a
 * missing decoration is not a defect while a truncated word is. It also matches
 * the left rail, whose tabs are text-only and content-sized for the same reason.
 *
 * `icon-only` is the genuine last resort — unreachable with today's four tabs,
 * kept so a fifth could never reintroduce the ellipsis. It is the brief's
 * "icon + tooltip compact mode", and the tab keeps `title` + `aria-label` there.
 */
export type InspectorTabPresentation = "icon-and-label" | "label-only" | "icon-only";

/** The strip's usable width in px: the 320px dock, less its border and the collapse button. */
export const INSPECTOR_STRIP_WIDTH = 288;

/** Per-tab px cost of each presentation at the shipped type scale. See `InspectorTabPresentation`. */
export const INSPECTOR_TAB_COST: Record<InspectorTabPresentation, number> = {
  "icon-and-label": 90,
  "label-only": 70,
  "icon-only": 26,
};

export function inspectorTabPresentation(tabCount: number): InspectorTabPresentation {
  // A non-positive or non-finite count means "no strip to lay out". Returning the
  // richest presentation keeps a single tab from being rendered as a bare glyph on
  // the strength of a bad measurement.
  if (!Number.isFinite(tabCount) || tabCount <= 0) return "icon-and-label";
  if (tabCount * INSPECTOR_TAB_COST["icon-and-label"] <= INSPECTOR_STRIP_WIDTH) return "icon-and-label";
  if (tabCount * INSPECTOR_TAB_COST["label-only"] <= INSPECTOR_STRIP_WIDTH) return "label-only";
  return "icon-only";
}

/**
 * The left rail's width, in px, for a given editor container width.
 *
 * The rail is a fixed strip, so on a narrow laptop it and the 320px inspector
 * are a fixed tax on the canvas: measured at 1366px, a 184px rail plus the
 * inspector left the canvas 862px — 63% of the frame, under the 65-80% the
 * design brief asks for. Rather than collapse the rail automatically (a panel
 * that vanishes as you resize is worse than a narrow one), it steps down to a
 * width that still shows a legible thumbnail:
 *
 *   >= 1500  184px   comfortable: thumbnail + number + room for the tab labels
 *   1280-1499 160px  the reference sidebar's own width
 *    < 1280  148px   the floor where a portrait A4 thumbnail is still readable
 *
 * Below `PANEL_BREAKPOINTS.docked` the inspector stops docking entirely, so the
 * canvas gets that 320px back and the rail can stay at its comfortable width.
 */
export function resolveLeftRailWidth(containerWidth: number): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 184;
  // Nothing docks on the right below the breakpoint, so width is not scarce here.
  if (containerWidth < PANEL_BREAKPOINTS.docked) return 184;
  if (containerWidth >= 1500) return 184;
  if (containerWidth >= 1280) return 160;
  return 148;
}
