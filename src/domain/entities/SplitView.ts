/**
 * M7.13 split view and navigation.
 *
 * Builds on the M7.12 session rather than beside it. There is deliberately no
 * second persistence model for panes: a tab's pane is recorded on the tab
 * itself, and the *active* pane is derived from the active tab. Two stores that
 * each believed they knew which document was open would eventually disagree,
 * and the disagreement would surface as a pane rendering a document the session
 * says is closed.
 *
 * What follows from that:
 *
 * - `paneId` is bounded to two stable values. Panes are positions, not
 *   identities, so "left" and "right" survive a reload without needing ids
 *   allocated, persisted or garbage-collected.
 * - Synchronization is *ephemeral*. It is a way of looking at two documents, not
 *   a fact about them, and persisting it would restore a user into a linked
 *   scroll they set up once for a comparison they finished days ago.
 * - Navigation history is ephemeral and bounded for the same reason: it
 *   describes a browsing session, and an unbounded one is a memory leak that
 *   grows for as long as a tab stays open.
 */

export const SPLIT_VIEW_LIMITS = {
  /** Most entries kept per pane's navigation history. */
  maxHistoryEntries: 50,
  /** Longest accepted identifier in any pane predicate. */
  maxIdLength: 128,
  /** Highest page a navigation entry may address. */
  maxPage: 100_000,
  /** Viewport bounds, matching the session's own limits. */
  minScale: 0.01,
  maxScale: 64,
  maxOffset: 1_000_000,
} as const;

/**
 * The panes, as fixed positions.
 *
 * A closed enumeration rather than allocated ids: with two positions there is
 * nothing to allocate, nothing to leak, and a persisted `paneId` from an older
 * build either matches one of these or is discarded.
 */
export const PANE_IDS = ["left", "right"] as const;
export type PaneId = (typeof PANE_IDS)[number];

export function isPaneId(value: unknown): value is PaneId {
  return typeof value === "string" && (PANE_IDS as readonly string[]).includes(value);
}

/** The primary pane, and the one a single-pane layout uses. */
export const PRIMARY_PANE: PaneId = "left";

export function otherPane(pane: PaneId): PaneId {
  return pane === "left" ? "right" : "left";
}

/** Single or two-pane. Derived from the tab set, never stored separately. */
export type SplitLayout = "single" | "split";

/** What may be kept in step between panes when synchronization is on. */
export const SYNC_MODES = ["off", "page", "scroll", "zoom", "all"] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export function isSyncMode(value: unknown): value is SyncMode {
  return typeof value === "string" && (SYNC_MODES as readonly string[]).includes(value);
}

export function syncsPage(mode: SyncMode): boolean {
  return mode === "page" || mode === "all";
}

export function syncsScroll(mode: SyncMode): boolean {
  return mode === "scroll" || mode === "all";
}

export function syncsZoom(mode: SyncMode): boolean {
  return mode === "zoom" || mode === "all";
}

/**
 * Why a pane moved.
 *
 * Every navigation carries its origin, and the origin is what stops a
 * synchronization feedback loop: a pane that moved *because the other pane
 * moved* does not propagate onward. Without this, two synchronized panes would
 * each answer the other's scroll forever.
 */
export type NavigationSource = "user" | "sync" | "restore" | "history";

/** Where a jump was aimed. */
export type NavigationTargetKind = "page" | "bookmark" | "comment" | "search";

export interface NavigationTarget {
  kind: NavigationTargetKind;
  /** 1-based page the target resolves to. */
  pageNumber: number;
  /** The anchor's own id, when it has one (bookmark, comment thread, hit). */
  targetId?: string | null;
}

export interface NavigationEntry {
  documentId: string;
  pageNumber: number;
  kind: NavigationTargetKind;
  targetId: string | null;
}

/**
 * One pane's navigation history.
 *
 * A cursor into a bounded list rather than two stacks: back and forward are
 * positions in one sequence, and modelling them as separate stacks makes the
 * "navigate after going back truncates the forward path" rule easy to get wrong.
 */
export interface NavigationHistory {
  entries: NavigationEntry[];
  /** Index of the current entry, or -1 when the history is empty. */
  cursor: number;
}

export function emptyHistory(): NavigationHistory {
  return { entries: [], cursor: -1 };
}

/** Bounds a page number. Returns null when it is not usable. */
export function validatePage(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 1 || value > SPLIT_VIEW_LIMITS.maxPage) return null;
  return value;
}

export function isBoundedPaneId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= SPLIT_VIEW_LIMITS.maxIdLength
  );
}

/**
 * Records a navigation.
 *
 * Three rules, each of which exists because its absence is a bug a user would
 * feel:
 *
 * 1. Navigating after going back **truncates** the forward path. Keeping it
 *    would offer a "forward" that leads somewhere the user has abandoned.
 * 2. Navigating to where you already are is **not** a new entry. Otherwise
 *    pressing back appears to do nothing, because it steps between two
 *    identical positions.
 * 3. The list is bounded from the front, so a long session drops its oldest
 *    entries rather than growing without limit.
 */
export function pushHistory(
  history: NavigationHistory,
  entry: NavigationEntry,
): NavigationHistory {
  const current = history.cursor >= 0 ? history.entries[history.cursor] : null;
  if (
    current &&
    current.documentId === entry.documentId &&
    current.pageNumber === entry.pageNumber &&
    current.targetId === entry.targetId
  ) {
    return history;
  }

  // Everything after the cursor is a path the user stepped back from.
  const kept = history.entries.slice(0, history.cursor + 1);
  kept.push(entry);

  const overflow = kept.length - SPLIT_VIEW_LIMITS.maxHistoryEntries;
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { entries, cursor: entries.length - 1 };
}

export function canGoBack(history: NavigationHistory): boolean {
  return history.cursor > 0;
}

export function canGoForward(history: NavigationHistory): boolean {
  return history.cursor >= 0 && history.cursor < history.entries.length - 1;
}

/** Steps back. Returns the unchanged history when there is nowhere to go. */
export function goBack(
  history: NavigationHistory,
): { history: NavigationHistory; entry: NavigationEntry | null } {
  if (!canGoBack(history)) return { history, entry: null };
  const cursor = history.cursor - 1;
  return { history: { ...history, cursor }, entry: history.entries[cursor] };
}

export function goForward(
  history: NavigationHistory,
): { history: NavigationHistory; entry: NavigationEntry | null } {
  if (!canGoForward(history)) return { history, entry: null };
  const cursor = history.cursor + 1;
  return { history: { ...history, cursor }, entry: history.entries[cursor] };
}

/** The pane a tab belongs to, defaulting to primary for older rows. */
export function paneOfTab(state: { paneId?: string }): PaneId {
  return isPaneId(state.paneId) ? state.paneId : PRIMARY_PANE;
}

/**
 * The layout implied by a tab set.
 *
 * Derived rather than stored: a layout flag that said "split" while no tab
 * occupied the right pane would render an empty half nobody asked for.
 */
export function layoutOf(tabs: ReadonlyArray<{ state: { paneId?: string } }>): SplitLayout {
  return tabs.some((tab) => paneOfTab(tab.state) === "right") ? "split" : "single";
}

/** Tabs assigned to one pane, in their existing order. */
export function tabsInPane<T extends { state: { paneId?: string } }>(
  tabs: readonly T[],
  pane: PaneId,
): T[] {
  return tabs.filter((tab) => paneOfTab(tab.state) === pane);
}

/**
 * Which pane a command applies to.
 *
 * The pane holding the active tab. Commands route by *focus*, not by position,
 * so a keyboard user who moved to the right pane does not have their next action
 * silently applied to the left.
 */
export function activePaneOf(
  tabs: ReadonlyArray<{ id: string; state: { paneId?: string } }>,
  activeTabId: string | null,
): PaneId {
  if (activeTabId === null) return PRIMARY_PANE;
  const active = tabs.find((tab) => tab.id === activeTabId);
  return active ? paneOfTab(active.state) : PRIMARY_PANE;
}

/**
 * Whether a movement should propagate to the other pane.
 *
 * The feedback-loop guard. Only a user's own movement propagates: a pane that
 * moved because it was being synchronized must not answer back, or the two panes
 * would drive each other indefinitely.
 */
export function shouldPropagate(source: NavigationSource, mode: SyncMode): boolean {
  if (mode === "off") return false;
  return source === "user";
}

export interface ViewportState {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * The state a synchronized pane should adopt, given what changed in the other.
 *
 * Returns only the fields the mode actually covers, so a page-only
 * synchronization does not quietly drag the zoom level along with it.
 */
export function synchronizedState(
  mode: SyncMode,
  from: { activePage?: number; viewport?: ViewportState },
): { activePage?: number; viewport?: Partial<ViewportState> } {
  const next: { activePage?: number; viewport?: Partial<ViewportState> } = {};
  if (syncsPage(mode) && from.activePage !== undefined) {
    next.activePage = from.activePage;
  }
  if (from.viewport !== undefined) {
    const viewport: Partial<ViewportState> = {};
    if (syncsZoom(mode)) viewport.scale = from.viewport.scale;
    if (syncsScroll(mode)) {
      viewport.offsetX = from.viewport.offsetX;
      viewport.offsetY = from.viewport.offsetY;
    }
    if (Object.keys(viewport).length > 0) next.viewport = viewport;
  }
  return next;
}

/**
 * How a pane's tabs are redistributed when it closes.
 *
 * They move to the surviving pane rather than closing with it. A pane is a way
 * of arranging documents, and collapsing the arrangement must not discard the
 * documents — least of all a tab holding unsaved changes, which the user would
 * have no way to recover.
 */
export function closePaneAssignments<T extends { id: string; state: { paneId?: string } }>(
  tabs: readonly T[],
  closing: PaneId,
): Array<{ tabId: string; paneId: PaneId }> {
  const survivor = otherPane(closing);
  return tabs
    .filter((tab) => paneOfTab(tab.state) === closing)
    .map((tab) => ({ tabId: tab.id, paneId: survivor }));
}

/**
 * The tab that should be active after a pane closes.
 *
 * Prefers the surviving pane's own active tab; falls back to a moved one. Never
 * null while any tab remains — an empty active slot renders as a workbench with
 * documents open and none of them showing.
 */
export function activeTabAfterPaneClose<T extends { id: string; state: { paneId?: string } }>(
  tabs: readonly T[],
  closing: PaneId,
  activeTabId: string | null,
): string | null {
  if (tabs.length === 0) return null;
  const active = tabs.find((tab) => tab.id === activeTabId);
  // The active tab survives the close; only its pane changes.
  if (active && paneOfTab(active.state) !== closing) return active.id;

  const survivor = tabsInPane(tabs, otherPane(closing));
  if (survivor.length > 0) return survivor[0].id;
  return tabs[0]?.id ?? null;
}
