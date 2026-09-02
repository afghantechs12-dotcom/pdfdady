import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext } from "./WorkspaceService";
import type { TabService } from "./TabService";
import type {
  RestoredWorkspaceSession,
  WorkspaceSession,
  WorkspaceSessionTab,
} from "@/src/domain/entities/WorkspaceSession";
import {
  PRIMARY_PANE,
  activePaneOf,
  activeTabAfterPaneClose,
  closePaneAssignments,
  emptyHistory,
  goBack,
  goForward,
  isPaneId,
  isSyncMode,
  layoutOf,
  otherPane,
  paneOfTab,
  pushHistory,
  shouldPropagate,
  synchronizedState,
  tabsInPane,
  validatePage,
  type NavigationEntry,
  type NavigationHistory,
  type NavigationSource,
  type NavigationTarget,
  type PaneId,
  type SplitLayout,
  type SyncMode,
} from "@/src/domain/entities/SplitView";
import { DomainError, NotFoundError } from "@/src/domain/errors";

/** A pane and what it currently holds. */
export interface PaneView {
  id: PaneId;
  tabs: WorkspaceSessionTab[];
  /** The tab shown in this pane, or null when it holds none. */
  activeTabId: string | null;
  /** True when this pane receives commands. */
  active: boolean;
}

export interface SplitViewState {
  sessionId: string;
  layout: SplitLayout;
  activePane: PaneId;
  panes: PaneView[];
}

/**
 * M7.13 split view and navigation.
 *
 * A layer over the M7.12 `TabService` rather than a parallel one. Every durable
 * write goes through that service, which means pane assignment inherits its
 * authorization, its bounds, its optimistic concurrency and its payload limits
 * for free — and there is exactly one place where a session is persisted.
 *
 * What this service owns beyond it:
 *
 * - **Pane assignment**, recorded on the tab's own state so a reload restores
 *   the arrangement without a second store to disagree with.
 * - **Synchronization**, held in memory only. It is a way of looking at two
 *   documents rather than a fact about them, and persisting it would restore a
 *   user into a linked scroll they set up for a comparison they finished days
 *   ago.
 * - **Navigation history**, per pane, bounded and in memory for the same
 *   reason: it describes a browsing session, and an unbounded one grows for as
 *   long as a tab stays open.
 *
 * No PDF bytes, data URLs or rendered page images are stored or accepted here;
 * the session layer rejects them at its own boundary.
 */
export class SplitViewService {
  /** Per-session synchronization mode. Ephemeral by design. */
  private readonly syncModes = new Map<string, SyncMode>();
  /** Per-session, per-pane navigation history. Ephemeral and bounded. */
  private readonly histories = new Map<string, Map<PaneId, NavigationHistory>>();

  constructor(
    private readonly logger: ILogger,
    private readonly tabs: TabService,
  ) {}

  // ---- state ---------------------------------------------------------------

  /** The current split state, derived from the session's tabs. */
  async getState(actor: ActorContext, sessionId: string): Promise<SplitViewState> {
    const session = await this.requireSession(actor, sessionId);
    return this.toState(session);
  }

  private async requireSession(
    actor: ActorContext,
    sessionId: string,
  ): Promise<WorkspaceSession> {
    const session = await this.tabs.getWorkspaceSession(actor, sessionId);
    // The session service already scopes by owner, so an id belonging to
    // another user reads as missing rather than as forbidden.
    if (!session) throw new NotFoundError("Session not found.");
    return session;
  }

  private toState(session: WorkspaceSession): SplitViewState {
    const activePane = activePaneOf(session.tabs, session.activeTabId);
    const panes: PaneView[] = (["left", "right"] as PaneId[]).map((id) => {
      const paneTabs = tabsInPane(session.tabs, id);
      const active = session.tabs.find((tab) => tab.id === session.activeTabId);
      const activeInPane =
        active && paneOfTab(active.state) === id ? active.id : (paneTabs[0]?.id ?? null);
      return { id, tabs: paneTabs, activeTabId: activeInPane, active: id === activePane };
    });

    return {
      sessionId: session.id,
      layout: layoutOf(session.tabs),
      activePane,
      panes,
    };
  }

  // ---- pane assignment -----------------------------------------------------

  /**
   * Moves a tab into a pane.
   *
   * Assigning any tab to the right pane is what creates the split; there is no
   * separate "enable split view" call, because a layout flag that disagreed with
   * the tab set would render an empty half nobody asked for.
   */
  async assignTabToPane(
    actor: ActorContext,
    sessionId: string,
    tabId: string,
    paneId: unknown,
  ): Promise<SplitViewState> {
    if (!isPaneId(paneId)) throw new DomainError("That is not a valid pane.");
    const session = await this.requireSession(actor, sessionId);
    if (!session.tabs.some((tab) => tab.id === tabId)) {
      throw new NotFoundError("Tab not found in session.");
    }

    const updated = await this.tabs.updateTabState(actor, sessionId, tabId, { paneId });
    this.logger.debug("Assigned tab to pane", { sessionId, tabId, paneId });
    return this.toState(updated);
  }

  /**
   * Closes a pane, moving its tabs to the survivor.
   *
   * They move rather than close: a pane is a way of arranging documents, and
   * collapsing the arrangement must not discard the documents — least of all one
   * holding unsaved changes the user could not recover.
   */
  async closePane(
    actor: ActorContext,
    sessionId: string,
    paneId: unknown,
  ): Promise<SplitViewState> {
    if (!isPaneId(paneId)) throw new DomainError("That is not a valid pane.");
    let session = await this.requireSession(actor, sessionId);

    const moves = closePaneAssignments(session.tabs, paneId);
    const nextActive = activeTabAfterPaneClose(session.tabs, paneId, session.activeTabId);

    for (const move of moves) {
      session = await this.tabs.updateTabState(actor, sessionId, move.tabId, {
        paneId: move.paneId,
      });
    }
    if (nextActive !== null && nextActive !== session.activeTabId) {
      session = await this.tabs.switchTab(actor, sessionId, nextActive);
    }

    this.histories.get(sessionId)?.delete(paneId);
    this.logger.debug("Closed pane", { sessionId, paneId, movedTabs: moves.length });
    return this.toState(session);
  }

  /**
   * Focuses a pane, which is what routes subsequent commands.
   *
   * Implemented by activating that pane's tab rather than by storing a separate
   * "focused pane": the active tab and the active pane must never disagree, and
   * deriving one from the other makes that structural.
   */
  async focusPane(
    actor: ActorContext,
    sessionId: string,
    paneId: unknown,
  ): Promise<SplitViewState> {
    if (!isPaneId(paneId)) throw new DomainError("That is not a valid pane.");
    const session = await this.requireSession(actor, sessionId);

    const paneTabs = tabsInPane(session.tabs, paneId);
    if (paneTabs.length === 0) throw new DomainError("That pane holds no documents.");

    const updated = await this.tabs.switchTab(actor, sessionId, paneTabs[0].id);
    return this.toState(updated);
  }

  /** Moves focus to the other pane, for keyboard pane switching. */
  async focusOtherPane(actor: ActorContext, sessionId: string): Promise<SplitViewState> {
    const session = await this.requireSession(actor, sessionId);
    const target = otherPane(activePaneOf(session.tabs, session.activeTabId));
    if (tabsInPane(session.tabs, target).length === 0) {
      // Nothing to focus; the current arrangement stands rather than throwing at
      // a keyboard user who pressed the shortcut in a single-pane layout.
      return this.toState(session);
    }
    return this.focusPane(actor, sessionId, target);
  }

  // ---- synchronization -----------------------------------------------------

  getSyncMode(sessionId: string): SyncMode {
    return this.syncModes.get(sessionId) ?? "off";
  }

  setSyncMode(sessionId: string, mode: unknown): SyncMode {
    if (!isSyncMode(mode)) throw new DomainError("That is not a valid synchronization mode.");
    this.syncModes.set(sessionId, mode);
    return mode;
  }

  /**
   * Applies a pane movement, propagating it to the other pane when synchronized.
   *
   * `source` is load-bearing. Only a user's own movement propagates: a pane that
   * moved *because it was being synchronized* must not answer back, or the two
   * panes would drive each other indefinitely. The propagated write is issued
   * with source `sync`, which is what terminates the chain.
   */
  async applyViewportChange(
    actor: ActorContext,
    sessionId: string,
    tabId: string,
    change: { activePage?: number; viewport?: { scale: number; offsetX: number; offsetY: number } },
    source: NavigationSource = "user",
  ): Promise<SplitViewState> {
    const session = await this.requireSession(actor, sessionId);
    const origin = session.tabs.find((tab) => tab.id === tabId);
    if (!origin) throw new NotFoundError("Tab not found in session.");

    let updated = await this.tabs.updateTabState(actor, sessionId, tabId, change);

    const mode = this.getSyncMode(sessionId);
    if (shouldPropagate(source, mode)) {
      const target = tabsInPane(updated.tabs, otherPane(paneOfTab(origin.state)))[0];
      if (target) {
        const mirrored = synchronizedState(mode, change);
        if (Object.keys(mirrored).length > 0) {
          const merged = {
            ...(mirrored.activePage === undefined ? {} : { activePage: mirrored.activePage }),
            ...(mirrored.viewport === undefined
              ? {}
              : {
                  viewport: {
                    scale: mirrored.viewport.scale ?? target.state.viewport?.scale ?? 1,
                    offsetX: mirrored.viewport.offsetX ?? target.state.viewport?.offsetX ?? 0,
                    offsetY: mirrored.viewport.offsetY ?? target.state.viewport?.offsetY ?? 0,
                  },
                }),
          };
          // Written with source "sync", so the mirrored pane does not propagate
          // onward and the loop terminates after one hop.
          updated = await this.tabs.updateTabState(actor, sessionId, target.id, merged);
        }
      }
    }

    return this.toState(updated);
  }

  // ---- navigation ----------------------------------------------------------

  private historyFor(sessionId: string, pane: PaneId): NavigationHistory {
    const paneMap = this.histories.get(sessionId);
    return paneMap?.get(pane) ?? emptyHistory();
  }

  private setHistory(sessionId: string, pane: PaneId, history: NavigationHistory): void {
    let paneMap = this.histories.get(sessionId);
    if (!paneMap) {
      paneMap = new Map();
      this.histories.set(sessionId, paneMap);
    }
    paneMap.set(pane, history);
  }

  getHistory(sessionId: string, pane: PaneId): NavigationHistory {
    return this.historyFor(sessionId, pane);
  }

  /**
   * Navigates the active pane to a target and records it in history.
   *
   * Page, bookmark, comment and search jumps all land here, so back and forward
   * behave identically regardless of what the user clicked to get somewhere.
   */
  async navigate(
    actor: ActorContext,
    sessionId: string,
    target: NavigationTarget,
  ): Promise<SplitViewState> {
    const page = validatePage(target.pageNumber);
    if (page === null) throw new DomainError("That page number is not valid.");

    const session = await this.requireSession(actor, sessionId);
    const pane = activePaneOf(session.tabs, session.activeTabId);
    const tab = session.tabs.find((t) => t.id === session.activeTabId);
    if (!tab) throw new DomainError("No document is open in the active pane.");

    const entry: NavigationEntry = {
      documentId: tab.documentId,
      pageNumber: page,
      kind: target.kind,
      targetId: target.targetId ?? null,
    };
    this.setHistory(sessionId, pane, pushHistory(this.historyFor(sessionId, pane), entry));

    return this.applyViewportChange(actor, sessionId, tab.id, { activePage: page }, "user");
  }

  /** Steps the active pane back. Returns null when there is nowhere to go. */
  async back(actor: ActorContext, sessionId: string): Promise<SplitViewState | null> {
    return this.step(actor, sessionId, "back");
  }

  async forward(actor: ActorContext, sessionId: string): Promise<SplitViewState | null> {
    return this.step(actor, sessionId, "forward");
  }

  private async step(
    actor: ActorContext,
    sessionId: string,
    direction: "back" | "forward",
  ): Promise<SplitViewState | null> {
    const session = await this.requireSession(actor, sessionId);
    const pane = activePaneOf(session.tabs, session.activeTabId);
    const history = this.historyFor(sessionId, pane);

    const result = direction === "back" ? goBack(history) : goForward(history);
    if (result.entry === null) return null;
    this.setHistory(sessionId, pane, result.history);

    // The tab the entry belongs to, which may not be the active one if the pane
    // has since switched documents.
    const tab = session.tabs.find((t) => t.documentId === result.entry!.documentId);
    if (!tab) return this.toState(session);

    // Source "history" so a back-step is not mirrored into the other pane as
    // though the user had scrolled there.
    return this.applyViewportChange(
      actor,
      sessionId,
      tab.id,
      { activePage: result.entry.pageNumber },
      "history",
    );
  }

  // ---- restoration ---------------------------------------------------------

  /**
   * Restores a session and its pane arrangement.
   *
   * Delegates document re-authorization to `TabService.restoreSession`, so a
   * revoked grant drops the tab here exactly as it does for single-pane
   * restoration — a pane must not become a way to keep reading a document the
   * actor lost access to. Dirty and conflict flags survive, since unsaved work
   * still needs signalling after a reload.
   *
   * Synchronization and history deliberately do not survive: both describe a
   * browsing session rather than the documents.
   */
  async restore(
    actor: ActorContext,
    sessionId: string,
  ): Promise<{ state: SplitViewState; droppedTabIds: string[] }> {
    const restored: RestoredWorkspaceSession = await this.tabs.restoreSession(actor, sessionId);

    this.syncModes.delete(sessionId);
    this.histories.delete(sessionId);

    // A restore that dropped every right-pane tab collapses to single-pane on
    // its own, because the layout is derived from what actually survived.
    return {
      state: this.toState(restored.session),
      droppedTabIds: restored.droppedTabIds,
    };
  }

  /** Forgets a session's ephemeral state. Called when a session is closed. */
  forgetSession(sessionId: string): void {
    this.syncModes.delete(sessionId);
    this.histories.delete(sessionId);
  }
}

export { PRIMARY_PANE };
