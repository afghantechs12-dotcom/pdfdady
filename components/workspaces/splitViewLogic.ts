import {
  PANE_IDS,
  SPLIT_VIEW_LIMITS,
  SYNC_MODES,
  isPaneId,
  otherPane,
  type NavigationHistory,
  type PaneId,
  type SplitLayout,
  type SyncMode,
} from "@/src/domain/entities/SplitView";

/**
 * Presentation logic for the M7.13 split workspace view.
 *
 * Separated from the React component so the rules can be tested without a DOM:
 * which pane a keyboard shortcut moves to, how a pane's tab strip is labelled,
 * when the layout must collapse for a narrow screen, and what the back and
 * forward controls announce.
 *
 * The narrow-screen rule is the one worth stating up front: below the split
 * breakpoint the layout falls back to a *single visible pane* while the
 * underlying assignment is left untouched. Reassigning tabs on a resize would
 * silently rearrange a user's workspace because they rotated their phone.
 */

/** Below this width a two-pane layout has no room to be useful. */
export const SPLIT_MIN_WIDTH = 768;

export interface PaneTabView {
  id: string;
  title: string;
  documentId: string;
  dirty: boolean;
  conflict: boolean;
}

export interface PaneViewModel {
  id: PaneId;
  tabs: PaneTabView[];
  activeTabId: string | null;
  active: boolean;
}

/**
 * Whether both panes can be shown at this width.
 *
 * The assignment itself is never changed by this — only what is rendered — so
 * widening the window restores the arrangement the user set up.
 */
export function canShowBothPanes(viewportWidth: number): boolean {
  return viewportWidth >= SPLIT_MIN_WIDTH;
}

/** The panes actually rendered, given the layout and the available width. */
export function visiblePanes(
  layout: SplitLayout,
  activePane: PaneId,
  viewportWidth: number,
): PaneId[] {
  if (layout === "single") return ["left"];
  if (!canShowBothPanes(viewportWidth)) return [activePane];
  return [...PANE_IDS];
}

/** True when the layout is split but the screen can only show one pane. */
export function isCollapsedForWidth(layout: SplitLayout, viewportWidth: number): boolean {
  return layout === "split" && !canShowBothPanes(viewportWidth);
}

/** The accessible label for a pane region. */
export function paneLabel(pane: PaneId, layout: SplitLayout): string {
  if (layout === "single") return "Document";
  return pane === "left" ? "Left pane" : "Right pane";
}

/** The accessible label for a pane's tab, including unsaved state. */
export function paneTabLabel(tab: PaneTabView): string {
  const parts = [tab.title || "Untitled document"];
  if (tab.dirty) parts.push("unsaved changes");
  if (tab.conflict) parts.push("version conflict");
  return parts.join(", ");
}

/** What the pane-switch shortcut would move to, or null when there is nowhere. */
export function paneSwitchTarget(
  layout: SplitLayout,
  activePane: PaneId,
  panes: readonly PaneViewModel[],
): PaneId | null {
  if (layout === "single") return null;
  const target = otherPane(activePane);
  return panes.find((pane) => pane.id === target && pane.tabs.length > 0) ? target : null;
}

/** The label for the pane-switch control. */
export function paneSwitchLabel(target: PaneId | null): string {
  if (target === null) return "Switch pane";
  return target === "right" ? "Switch to right pane" : "Switch to left pane";
}

/**
 * Whether a keyboard event should switch panes.
 *
 * Alt+Arrow rather than Ctrl or Cmd: the browser and the editor already claim
 * most Ctrl/Cmd combinations, and a shortcut that fights the platform is one a
 * user cannot rely on.
 */
export function isPaneSwitchShortcut(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): PaneId | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft") return "left";
  if (event.key === "ArrowRight") return "right";
  return null;
}

/** Whether a key should activate a control, for non-button elements. */
export function isActivationKey(key: string): boolean {
  return key === "Enter" || key === " " || key === "Spacebar";
}

export interface SyncOption {
  value: SyncMode;
  label: string;
  description: string;
}

/** The synchronization choices offered, in the order shown. */
export function syncOptions(): SyncOption[] {
  const describe: Record<SyncMode, { label: string; description: string }> = {
    off: { label: "Independent", description: "Each pane scrolls and zooms on its own." },
    page: { label: "Same page", description: "Both panes show the same page number." },
    scroll: { label: "Linked scrolling", description: "Scrolling one pane scrolls the other." },
    zoom: { label: "Linked zoom", description: "Zooming one pane zooms the other." },
    all: { label: "Fully linked", description: "Page, scrolling and zoom stay together." },
  };
  return SYNC_MODES.map((value) => ({ value, ...describe[value] }));
}

export function syncModeLabel(mode: SyncMode): string {
  return syncOptions().find((option) => option.value === mode)?.label ?? "Independent";
}

/** Whether synchronization can be offered at all. */
export function canSynchronize(layout: SplitLayout): boolean {
  // Nothing to keep in step with in a single-pane layout.
  return layout === "split";
}

/** Whether the split control should offer to open or close the second pane. */
export function splitToggleLabel(layout: SplitLayout): string {
  return layout === "split" ? "Close split view" : "Open split view";
}

export function canOpenSplit(tabCount: number): boolean {
  // Splitting with one document would put the same tab in both halves.
  return tabCount >= 2;
}

export interface HistoryControlsView {
  canGoBack: boolean;
  canGoForward: boolean;
  backLabel: string;
  forwardLabel: string;
}

/** The back/forward control state for a pane. */
export function historyControls(history: NavigationHistory): HistoryControlsView {
  const back = history.cursor > 0;
  const forward = history.cursor >= 0 && history.cursor < history.entries.length - 1;
  return {
    canGoBack: back,
    canGoForward: forward,
    backLabel: back ? "Go back" : "No previous location",
    forwardLabel: forward ? "Go forward" : "No next location",
  };
}

/** A readable description of where a history entry points. */
export function describeHistoryEntry(entry: {
  kind: string;
  pageNumber: number;
  targetId: string | null;
}): string {
  switch (entry.kind) {
    case "bookmark":
      return `Bookmark on page ${entry.pageNumber}`;
    case "comment":
      return `Comment on page ${entry.pageNumber}`;
    case "search":
      return `Search result on page ${entry.pageNumber}`;
    default:
      return `Page ${entry.pageNumber}`;
  }
}

/** The live-region announcement after a pane change. */
export function paneAnnouncement(pane: PaneId, layout: SplitLayout): string {
  if (layout === "single") return "Single pane view.";
  return pane === "left" ? "Left pane focused." : "Right pane focused.";
}

/** Maps a failed request to a message a user can act on. Never a stack trace. */
export function describeSplitViewError(status: number, message?: string): string {
  if (status === 401) return "Sign in to continue.";
  if (status === 403) return "You do not have permission to do that.";
  if (status === 404) return "That view is no longer available.";
  if (status === 409) return "This view was changed elsewhere. Reload to continue.";
  if (status === 422) return message ?? "That input was not accepted.";
  if (status >= 500) return "Something went wrong on our side. Try again in a moment.";
  return message ?? "That action could not be completed.";
}

/** Validates a pane id arriving from outside, e.g. a drag payload. */
export function readPaneId(value: unknown): PaneId | null {
  return isPaneId(value) ? value : null;
}

/** How many history entries a pane may accumulate, for display. */
export const MAX_HISTORY_ENTRIES = SPLIT_VIEW_LIMITS.maxHistoryEntries;
