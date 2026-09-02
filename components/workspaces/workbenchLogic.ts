/**
 * Pure logic for the Workspace document workbench.
 *
 * The workbench is the one place where a client mirrors durable server state —
 * the M7.12 session and its tabs — into React. Every rule about how that mirror
 * is allowed to behave lives here, testable without a DOM, a fetch or a
 * container.
 *
 * The rule the rest follows from: the server's session is the authority. The
 * client may propose changes and must reconcile with what comes back; it may
 * not invent tabs, keep tabs the server dropped, or hold view state the session
 * layer would reject.
 */

/** A tab as the client mirrors it. Logical references only — never bytes. */
export interface WorkbenchTab {
  id: string;
  documentId: string;
  versionId: string;
  title: string;
  dirty: boolean;
  conflict: boolean;
  paneId: "left" | "right";
}

/** The session shape the routes return, reduced to what the workbench uses. */
export interface WorkbenchSession {
  id: string;
  activeTabId: string | null;
  tabs: WorkbenchTab[];
  version: number;
}

/** A pane and the tabs assigned to it, in session order. */
export interface WorkbenchPane {
  id: "left" | "right";
  tabs: WorkbenchTab[];
  activeTabId: string | null;
}

/**
 * Splits the tab set into panes.
 *
 * Derived from the tabs rather than stored: a separate pane model would be a
 * second source of truth about what is open, and the two would eventually
 * disagree. A tab with no recorded pane belongs to the left one, so a session
 * written before split view existed restores as single-pane.
 */
export function panesFromSession(session: WorkbenchSession): WorkbenchPane[] {
  const left = session.tabs.filter((tab) => tab.paneId !== "right");
  const right = session.tabs.filter((tab) => tab.paneId === "right");

  const activeIn = (tabs: WorkbenchTab[]): string | null => {
    if (session.activeTabId && tabs.some((tab) => tab.id === session.activeTabId)) {
      return session.activeTabId;
    }
    return tabs[0]?.id ?? null;
  };

  return [
    { id: "left", tabs: left, activeTabId: activeIn(left) },
    { id: "right", tabs: right, activeTabId: activeIn(right) },
  ];
}

/** True when both panes hold at least one tab. */
export function isSplit(session: WorkbenchSession): boolean {
  return panesFromSession(session).every((pane) => pane.tabs.length > 0);
}

/** Which pane currently receives commands, derived from the active tab. */
export function activePaneOf(session: WorkbenchSession): "left" | "right" {
  const active = session.tabs.find((tab) => tab.id === session.activeTabId);
  return active?.paneId === "right" ? "right" : "left";
}

/**
 * Finds the tab already showing a document, if any.
 *
 * Opening a document that is already open should focus its tab rather than
 * create a second one: two tabs on one document would each hold their own
 * editor state, and the user would have no way to tell which one their edits
 * went into.
 */
export function findTabForDocument(
  session: WorkbenchSession,
  documentId: string,
): WorkbenchTab | null {
  return session.tabs.find((tab) => tab.documentId === documentId) ?? null;
}

/** What opening a document should do, given what is already open. */
export type OpenIntent =
  | { action: "focus"; tabId: string }
  | { action: "create" }
  | { action: "refuse"; reason: string };

/**
 * Decides how to open a document.
 *
 * The tab cap is enforced here as well as by the service, so a user gets an
 * explanation instead of a rejected request. The message names the limit rather
 * than saying "failed" — a cap the user cannot see is a cap they cannot work
 * around by closing something.
 */
export function openIntent(
  session: WorkbenchSession,
  documentId: string,
  maxTabs: number,
): OpenIntent {
  const existing = findTabForDocument(session, documentId);
  if (existing) return { action: "focus", tabId: existing.id };
  if (session.tabs.length >= maxTabs) {
    return {
      action: "refuse",
      reason: `You can have ${maxTabs} documents open at once. Close a tab to open another.`,
    };
  }
  return { action: "create" };
}

/**
 * Which tab should become active after one is closed.
 *
 * The neighbour in the same pane, preferring the one to the left — closing a
 * tab should leave the user next to where they were, not jumped to the other
 * pane or dropped onto an empty workbench while other tabs remain open.
 */
export function activeTabAfterClose(
  session: WorkbenchSession,
  closedTabId: string,
): string | null {
  const closed = session.tabs.find((tab) => tab.id === closedTabId);
  if (!closed) return session.activeTabId;
  if (session.activeTabId !== closedTabId) return session.activeTabId;

  const pane = closed.paneId === "right" ? "right" : "left";
  const inPane = session.tabs.filter((tab) => (tab.paneId === "right" ? "right" : "left") === pane);
  const index = inPane.findIndex((tab) => tab.id === closedTabId);
  const neighbour = inPane[index - 1] ?? inPane[index + 1] ?? null;
  if (neighbour) return neighbour.id;

  // The pane is now empty; fall back to any surviving tab.
  const survivor = session.tabs.find((tab) => tab.id !== closedTabId);
  return survivor?.id ?? null;
}

/**
 * Reconciles a session the server returned into the client's mirror.
 *
 * The server's tab set wins outright. A tab the server dropped — because its
 * document was deleted, trashed, or is no longer readable — must not survive on
 * the client: keeping it would leave a tab whose content can never load, and
 * whose mere presence discloses that a document the user can no longer read
 * still exists.
 *
 * Local dirty flags are the one thing carried forward, and only for tabs the
 * server still knows about: the client knows about unsaved edits the server has
 * not been told of yet, and dropping that flag would remove the only warning a
 * user gets before closing unsaved work.
 */
export function reconcileSession(
  previous: WorkbenchSession | null,
  incoming: WorkbenchSession,
): WorkbenchSession {
  if (!previous) return incoming;

  const localDirty = new Map(previous.tabs.map((tab) => [tab.id, tab.dirty]));
  return {
    ...incoming,
    tabs: incoming.tabs.map((tab) => ({
      ...tab,
      dirty: tab.dirty || (localDirty.get(tab.id) ?? false),
    })),
  };
}

/** Tab ids present before a reconcile and gone after it. */
export function droppedTabIds(
  previous: WorkbenchSession | null,
  incoming: WorkbenchSession,
): string[] {
  if (!previous) return [];
  const surviving = new Set(incoming.tabs.map((tab) => tab.id));
  return previous.tabs.filter((tab) => !surviving.has(tab.id)).map((tab) => tab.id);
}

/**
 * The message announcing that tabs were dropped on restore.
 *
 * Reported rather than swallowed: a user who left five documents open and
 * returns to four is owed an explanation, and silence would read as data loss.
 */
export function droppedTabsMessage(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? "1 tab was closed because its document is no longer available."
    : `${count} tabs were closed because their documents are no longer available.`;
}
