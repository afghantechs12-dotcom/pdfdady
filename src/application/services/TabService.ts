import { randomUUID } from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { WorkspaceSessionRepository } from "@/src/application/ports/workspaces/WorkspaceSessionRepository";
import type {
  RestoredWorkspaceSession,
  WorkspaceSession,
  WorkspaceSessionTab,
  WorkspaceSessionTabState,
} from "@/src/domain/entities/WorkspaceSession";
import { WORKSPACE_SESSION_LIMITS } from "@/src/domain/entities/WorkspaceSession";
import { isPaneId } from "@/src/domain/entities/SplitView";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import { DomainError, NotFoundError } from "@/src/domain/errors";

export type {
  RestoredWorkspaceSession,
  WorkspaceSession,
  WorkspaceSessionTab,
  WorkspaceSessionTabState,
} from "@/src/domain/entities/WorkspaceSession";

const DEFAULT_MAX_TABS = WORKSPACE_SESSION_LIMITS.maxTabs;
const DEFAULT_MAX_PAYLOAD_BYTES = WORKSPACE_SESSION_LIMITS.maxPayloadBytes;
const MAX_TITLE_LENGTH = WORKSPACE_SESSION_LIMITS.maxTitleLength;
const MAX_TOOL_LENGTH = WORKSPACE_SESSION_LIMITS.maxToolLength;
const MAX_ID_LENGTH = WORKSPACE_SESSION_LIMITS.maxIdLength;
const MAX_PAGE = WORKSPACE_SESSION_LIMITS.maxPage;
const MAX_SCALE = WORKSPACE_SESSION_LIMITS.maxScale;
const MAX_OFFSET = WORKSPACE_SESSION_LIMITS.maxOffset;
const MAX_SELECTION_OFFSET = WORKSPACE_SESSION_LIMITS.maxSelectionOffset;

/**
 * Session state holds logical references only. A `data:`/`blob:` URL in a text
 * field is how document bytes or rendered page images would sneak into the
 * payload, so those are rejected outright.
 */
const CONTENT_URL_PATTERN = /^\s*(?:data|blob):/i;

export interface TabServiceOptions {
  /** Hard cap on open tabs per session. */
  maxTabsPerSession?: number;
  /** Hard cap on the serialized tab payload, in bytes. */
  maxSessionPayloadSize?: number;
}

/**
 * Partial session update. Presence of a key is meaningful: omitting `tabs`
 * preserves the stored tab set, while passing `tabs: []` clears it.
 */
export interface WorkspaceSessionPayloadUpdate {
  activeTabId?: string | null;
  tabs?: WorkspaceSessionTab[];
}

/** Rejects ids that are absent, over-long, or carry embedded content. */
function assertSafeId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError(`${field} is required.`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new DomainError(`${field} exceeds ${MAX_ID_LENGTH} characters.`);
  }
  if (CONTENT_URL_PATTERN.test(value)) {
    throw new DomainError(`${field} must not contain embedded content.`);
  }
  return value;
}

/** Bounded free text (tab titles, tool names). */
function assertBoundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new DomainError(`${field} must be a string.`);
  if (value.length > max) throw new DomainError(`${field} exceeds ${max} characters.`);
  if (CONTENT_URL_PATTERN.test(value)) {
    throw new DomainError(`${field} must not contain embedded content.`);
  }
  return value;
}

function assertBoundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new DomainError(`${field} must be a finite number.`);
  }
  if (value < min || value > max) {
    throw new DomainError(`${field} must be between ${min} and ${max}.`);
  }
  return value;
}

/** Validates and normalizes bounded per-tab view state. */
function normalizeTabState(state: unknown, field: string): WorkspaceSessionTabState {
  if (!state || typeof state !== "object") throw new DomainError(`${field} must be an object.`);
  const s = state as Record<string, unknown>;

  const normalized: WorkspaceSessionTabState = {
    lastAccessed: s.lastAccessed instanceof Date ? s.lastAccessed : new Date(),
  };

  if (s.activePage !== undefined) {
    normalized.activePage = assertBoundedNumber(s.activePage, `${field}.activePage`, 1, MAX_PAGE);
  }
  if (s.viewport !== undefined) {
    const v = s.viewport as Record<string, unknown>;
    if (!v || typeof v !== "object") throw new DomainError(`${field}.viewport must be an object.`);
    normalized.viewport = {
      scale: assertBoundedNumber(
        v.scale,
        `${field}.viewport.scale`,
        WORKSPACE_SESSION_LIMITS.minScale,
        MAX_SCALE,
      ),
      offsetX: assertBoundedNumber(v.offsetX, `${field}.viewport.offsetX`, -MAX_OFFSET, MAX_OFFSET),
      offsetY: assertBoundedNumber(v.offsetY, `${field}.viewport.offsetY`, -MAX_OFFSET, MAX_OFFSET),
    };
  }
  if (s.tool !== undefined) {
    normalized.tool = assertBoundedText(s.tool, `${field}.tool`, MAX_TOOL_LENGTH);
  }
  if (s.selection !== undefined) {
    const sel = s.selection as Record<string, unknown>;
    if (!sel || typeof sel !== "object") throw new DomainError(`${field}.selection must be an object.`);
    const start = assertBoundedNumber(sel.start, `${field}.selection.start`, 0, MAX_SELECTION_OFFSET);
    const end = assertBoundedNumber(sel.end, `${field}.selection.end`, 0, MAX_SELECTION_OFFSET);
    if (end < start) throw new DomainError(`${field}.selection.end must not precede start.`);
    normalized.selection = { start, end };
  }
  if (s.dirty !== undefined) {
    if (typeof s.dirty !== "boolean") throw new DomainError(`${field}.dirty must be a boolean.`);
    normalized.dirty = s.dirty;
  }
  if (s.conflict !== undefined) {
    if (typeof s.conflict !== "boolean") throw new DomainError(`${field}.conflict must be a boolean.`);
    normalized.conflict = s.conflict;
  }
  if (s.paneId !== undefined) {
    // An unrecognized pane degrades to the primary one rather than being
    // stored: a row written by a newer build must not widen this to a pane
    // this build cannot render.
    if (!isPaneId(s.paneId)) throw new DomainError(`${field}.paneId is not a valid pane.`);
    normalized.paneId = s.paneId;
  }

  return normalized;
}

/** Validates and normalizes a single tab descriptor. */
function normalizeTab(tab: unknown, field: string): WorkspaceSessionTab {
  if (!tab || typeof tab !== "object") throw new DomainError(`${field} must be an object.`);
  const t = tab as Record<string, unknown>;
  return {
    id: assertSafeId(t.id, `${field}.id`),
    documentId: assertSafeId(t.documentId, `${field}.documentId`),
    versionId: assertBoundedText(t.versionId ?? "", `${field}.versionId`, MAX_ID_LENGTH),
    title: assertBoundedText(t.title ?? "", `${field}.title`, MAX_TITLE_LENGTH),
    state: normalizeTabState(t.state, `${field}.state`),
    createdAt: t.createdAt instanceof Date ? t.createdAt : new Date(),
    updatedAt: t.updatedAt instanceof Date ? t.updatedAt : new Date(),
  };
}

/**
 * M7.12 workspace tab sessions.
 *
 * Persists which documents a user has open in a Workspace and how each is being
 * viewed, so a reload restores the workbench. Every read and write is
 * authorized against live Workspace membership, and restoration re-checks each
 * referenced document so a revoked grant drops the tab instead of leaking it.
 */
export class TabService {
  private readonly maxTabsPerSession: number;
  private readonly maxSessionPayloadSize: number;

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly sessions: WorkspaceSessionRepository,
    private readonly documents: DocumentRecordRepository,
    options: TabServiceOptions = {},
  ) {
    this.maxTabsPerSession = options.maxTabsPerSession ?? DEFAULT_MAX_TABS;
    this.maxSessionPayloadSize = options.maxSessionPayloadSize ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  /** Validates a candidate tab set: count, uniqueness, shape, and payload size. */
  private validateTabs(tabs: unknown): WorkspaceSessionTab[] {
    if (!Array.isArray(tabs)) throw new DomainError("tabs must be an array.");
    if (tabs.length > this.maxTabsPerSession) {
      throw new DomainError(`A session may hold at most ${this.maxTabsPerSession} tabs.`);
    }

    const normalized = tabs.map((tab, i) => normalizeTab(tab, `tabs[${i}]`));

    const ids = new Set<string>();
    for (const tab of normalized) {
      if (ids.has(tab.id)) throw new DomainError(`Duplicate tab id "${tab.id}".`);
      ids.add(tab.id);
    }

    const bytes = Buffer.byteLength(JSON.stringify(normalized), "utf8");
    if (bytes > this.maxSessionPayloadSize) {
      throw new DomainError(`Session payload exceeds ${this.maxSessionPayloadSize} bytes.`);
    }

    return normalized;
  }

  /**
   * Keeps the active tab pointing at a tab that exists. When the referenced tab
   * is gone the caller-supplied preference wins, otherwise focus falls to the
   * first remaining tab so the result is deterministic.
   */
  private resolveActiveTabId(tabs: WorkspaceSessionTab[], preferred: string | null): string | null {
    if (preferred && tabs.some((t) => t.id === preferred)) return preferred;
    return tabs.length > 0 ? tabs[0].id : null;
  }

  /**
   * Loads a session the actor owns and re-checks Workspace access.
   *
   * Access loss and absence are deliberately indistinguishable: both yield null
   * (or NotFound at the callers that throw), so a caller cannot probe whether a
   * session id exists in a Workspace they were removed from.
   */
  private async loadOwnedSession(
    actor: ActorContext,
    sessionId: string,
    write: boolean,
  ): Promise<WorkspaceSession | null> {
    if (typeof sessionId !== "string" || sessionId.trim() === "" || sessionId.length > MAX_ID_LENGTH) {
      return null;
    }

    const session = await this.sessions.getByIdForUser(sessionId, actor.userId);
    if (!session) return null;
    if (session.organizationId !== actor.organizationId) return null;

    try {
      await this.workspaces.get(actor, session.workspaceId, write);
    } catch (error) {
      // Only membership/authorization failures fail closed; infrastructure
      // errors must surface rather than masquerade as "no session".
      if (error instanceof DomainError) return null;
      throw error;
    }

    return session;
  }

  private async requireOwnedSession(
    actor: ActorContext,
    sessionId: string,
    write: boolean,
  ): Promise<WorkspaceSession> {
    const session = await this.loadOwnedSession(actor, sessionId, write);
    if (!session) throw new NotFoundError("Session not found.");
    return session;
  }

  /** Persists a new tab set, keeping the active tab valid. */
  private async persist(
    session: WorkspaceSession,
    tabs: WorkspaceSessionTab[],
    preferredActiveTabId: string | null,
  ): Promise<WorkspaceSession> {
    const validated = this.validateTabs(tabs);
    const activeTabId = this.resolveActiveTabId(validated, preferredActiveTabId);

    const updated = await this.sessions.update(
      session.id,
      session.userId,
      { activeTabId, tabs: validated },
      session.version,
    );
    if (!updated) {
      throw new DomainError("Session was modified concurrently; reload and retry.");
    }
    return updated;
  }

  /**
   * Returns the actor's session for a Workspace, creating an empty one on first
   * use. Requires write access, since it may create a row.
   */
  async createWorkspaceSession(actor: ActorContext, workspaceId: string): Promise<WorkspaceSession> {
    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    if (workspace.organizationId !== actor.organizationId) {
      throw new DomainError("Cross-organization session creation is not permitted.");
    }

    const session = await this.sessions.create({
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      userId: actor.userId,
      activeTabId: null,
      tabs: [],
    });

    this.logger.debug("Created workspace session", { workspaceId, sessionId: session.id });
    return session;
  }

  /** Returns a session the actor owns, or null when absent or inaccessible. */
  async getWorkspaceSession(actor: ActorContext, sessionId: string): Promise<WorkspaceSession | null> {
    const session = await this.loadOwnedSession(actor, sessionId, false);
    if (!session) return null;

    this.logger.debug("Retrieved workspace session", { sessionId });
    return session;
  }

  /**
   * Returns the actor's existing session for a Workspace without creating one.
   *
   * The read counterpart to `createWorkspaceSession`. It exists so a page or
   * route can ask "is there a session here?" without provisioning one as a side
   * effect of asking — a read that creates leaves an empty session behind every
   * navigation. Read access is sufficient, and the repository scopes the lookup
   * to (workspaceId, userId), so this cannot reach another user's session.
   */
  async getWorkspaceSessionForWorkspace(
    actor: ActorContext,
    workspaceId: string,
  ): Promise<WorkspaceSession | null> {
    const { workspace } = await this.workspaces.get(actor, workspaceId, false);
    if (workspace.organizationId !== actor.organizationId) return null;

    const session = await this.sessions.getForUser(workspace.id, actor.userId);
    if (!session) return null;
    // Defence in depth: the adapter already scopes by both, but a session whose
    // organization does not match the actor's must never be returned.
    if (session.organizationId !== actor.organizationId) return null;

    return session;
  }

  /**
   * Applies a partial update to a session.
   *
   * Presence-aware: a key absent from `updates` leaves the stored value alone,
   * while an explicitly supplied one replaces it — so `tabs: []` clears the tab
   * set and omitting `tabs` preserves it. Identity, ownership and `createdAt`
   * are never caller-writable; `version` and `updatedAt` advance on every write.
   */
  async updateWorkspaceSession(
    actor: ActorContext,
    sessionId: string,
    updates: WorkspaceSessionPayloadUpdate,
  ): Promise<WorkspaceSession> {
    const session = await this.requireOwnedSession(actor, sessionId, true);

    const tabsSupplied = Object.prototype.hasOwnProperty.call(updates, "tabs");
    const activeSupplied = Object.prototype.hasOwnProperty.call(updates, "activeTabId");

    const nextTabs = tabsSupplied ? this.validateTabs(updates.tabs) : session.tabs;
    const preferredActive = activeSupplied ? updates.activeTabId ?? null : session.activeTabId;

    const updated = await this.persist(session, nextTabs, preferredActive);

    this.logger.debug("Updated workspace session", {
      sessionId,
      updateKeys: Object.keys(updates),
    });
    return updated;
  }

  /**
   * Opens a document in a new tab.
   *
   * The document must exist in the session's own Workspace, which is what stops
   * a tab from referencing a document across a Workspace or tenant boundary.
   */
  async createTab(
    actor: ActorContext,
    sessionId: string,
    documentId: string,
    versionId: string,
    title: string,
  ): Promise<{ tab: WorkspaceSessionTab; session: WorkspaceSession }> {
    const session = await this.requireOwnedSession(actor, sessionId, true);
    assertSafeId(documentId, "documentId");

    const document = await this.documents.getById(session.workspaceId, documentId);
    if (!document || document.workspaceId !== session.workspaceId) {
      throw new NotFoundError("Document not found in this workspace.");
    }
    if (document.lifecycleState === "trashed") {
      throw new DomainError("Cannot open a trashed document.");
    }

    if (session.tabs.length >= this.maxTabsPerSession) {
      throw new DomainError(`A session may hold at most ${this.maxTabsPerSession} tabs.`);
    }

    const now = new Date();
    const tab: WorkspaceSessionTab = {
      id: `tab-${randomUUID()}`,
      documentId,
      versionId: assertBoundedText(versionId ?? "", "versionId", MAX_ID_LENGTH),
      title: assertBoundedText(title ?? "", "title", MAX_TITLE_LENGTH),
      state: { activePage: 1, tool: "select", dirty: false, lastAccessed: now },
      createdAt: now,
      updatedAt: now,
    };

    // A newly opened tab takes focus.
    const updated = await this.persist(session, [...session.tabs, tab], tab.id);

    this.logger.debug("Created workspace session tab", { sessionId, documentId, tabId: tab.id });
    return { tab, session: updated };
  }

  /**
   * Closes a tab. When the active tab is closed focus moves to its right-hand
   * neighbour, or to the new last tab when it was rightmost — the same rule
   * browsers use, and deterministic either way.
   */
  async closeTab(actor: ActorContext, sessionId: string, tabId: string): Promise<WorkspaceSession> {
    const session = await this.requireOwnedSession(actor, sessionId, true);

    const index = session.tabs.findIndex((t) => t.id === tabId);
    if (index === -1) throw new NotFoundError("Tab not found in session.");

    const remaining = session.tabs.filter((t) => t.id !== tabId);

    let preferredActive = session.activeTabId;
    if (session.activeTabId === tabId) {
      const neighbour = remaining[index] ?? remaining[remaining.length - 1];
      preferredActive = neighbour ? neighbour.id : null;
    }

    const updated = await this.persist(session, remaining, preferredActive);

    this.logger.debug("Closed workspace session tab", {
      sessionId,
      tabId,
      closedBy: actor.userId,
    });
    return updated;
  }

  /** Focuses a tab and stamps its last-accessed time. */
  async switchTab(actor: ActorContext, sessionId: string, tabId: string): Promise<WorkspaceSession> {
    const session = await this.requireOwnedSession(actor, sessionId, true);

    const target = session.tabs.find((t) => t.id === tabId);
    if (!target) throw new NotFoundError("Tab not found in session.");

    const now = new Date();
    const tabs = session.tabs.map((t) =>
      t.id === tabId ? { ...t, state: { ...t.state, lastAccessed: now }, updatedAt: now } : t,
    );

    const updated = await this.persist(session, tabs, tabId);

    this.logger.debug("Switched to workspace session tab", {
      sessionId,
      tabId,
      switchedBy: actor.userId,
    });
    return updated;
  }

  /**
   * Reorders the tab strip. `orderedTabIds` must be a permutation of the
   * session's current tab ids, so a reorder can neither add nor drop a tab.
   */
  async reorderTabs(
    actor: ActorContext,
    sessionId: string,
    orderedTabIds: string[],
  ): Promise<WorkspaceSession> {
    const session = await this.requireOwnedSession(actor, sessionId, true);

    if (!Array.isArray(orderedTabIds) || orderedTabIds.length !== session.tabs.length) {
      throw new DomainError("Tab order must list every open tab exactly once.");
    }
    const seen = new Set(orderedTabIds);
    if (seen.size !== orderedTabIds.length) {
      throw new DomainError("Tab order must list every open tab exactly once.");
    }

    const byId = new Map(session.tabs.map((t) => [t.id, t]));
    const reordered: WorkspaceSessionTab[] = [];
    for (const id of orderedTabIds) {
      const tab = byId.get(id);
      if (!tab) throw new DomainError("Tab order must list every open tab exactly once.");
      reordered.push(tab);
    }

    const updated = await this.persist(session, reordered, session.activeTabId);

    this.logger.debug("Reordered workspace session tabs", { sessionId, tabCount: reordered.length });
    return updated;
  }

  /** Returns one tab's view state, or null when the session or tab is absent. */
  async getTabState(
    actor: ActorContext,
    sessionId: string,
    tabId: string,
  ): Promise<WorkspaceSessionTabState | null> {
    const session = await this.loadOwnedSession(actor, sessionId, false);
    if (!session) return null;

    const tab = session.tabs.find((t) => t.id === tabId);
    if (!tab) return null;

    this.logger.debug("Retrieved tab state", { sessionId, tabId });
    return tab.state;
  }

  /**
   * Merges partial view state into a tab. Unsupplied keys are preserved, so a
   * scroll update cannot silently clear the dirty flag or the selection.
   */
  async updateTabState(
    actor: ActorContext,
    sessionId: string,
    tabId: string,
    state: Partial<WorkspaceSessionTabState>,
  ): Promise<WorkspaceSession> {
    const session = await this.requireOwnedSession(actor, sessionId, true);

    const target = session.tabs.find((t) => t.id === tabId);
    if (!target) throw new NotFoundError("Tab not found in session.");

    const merged = normalizeTabState(
      { ...target.state, ...state, lastAccessed: new Date() },
      "state",
    );
    const now = new Date();
    const tabs = session.tabs.map((t) =>
      t.id === tabId ? { ...t, state: merged, updatedAt: now } : t,
    );

    const updated = await this.persist(session, tabs, session.activeTabId);

    this.logger.debug("Updated tab state", {
      sessionId,
      tabId,
      stateKeys: Object.keys(state),
    });
    return updated;
  }

  /**
   * Restores a session for a new browser session.
   *
   * Every tab is re-authorized against the live document set: tabs whose
   * document was deleted, trashed, or is no longer readable are dropped and
   * reported, never returned. Dirty and conflict flags on surviving tabs are
   * preserved so unsaved work is still signalled after a reload.
   */
  async restoreSession(actor: ActorContext, sessionId: string): Promise<RestoredWorkspaceSession> {
    const session = await this.requireOwnedSession(actor, sessionId, true);

    const surviving: WorkspaceSessionTab[] = [];
    const droppedTabIds: string[] = [];

    for (const tab of session.tabs) {
      const document = await this.documents.getById(session.workspaceId, tab.documentId);
      if (!document || document.workspaceId !== session.workspaceId || document.lifecycleState === "trashed") {
        droppedTabIds.push(tab.id);
        continue;
      }
      surviving.push(tab);
    }

    if (droppedTabIds.length === 0) {
      this.logger.debug("Restored workspace session", { sessionId, droppedTabCount: 0 });
      return { session, droppedTabIds };
    }

    const updated = await this.persist(session, surviving, session.activeTabId);

    this.logger.debug("Restored workspace session", {
      sessionId,
      droppedTabCount: droppedTabIds.length,
    });
    return { session: updated, droppedTabIds };
  }

  /** Discards a session the actor owns. */
  async deleteWorkspaceSession(actor: ActorContext, sessionId: string): Promise<boolean> {
    const session = await this.loadOwnedSession(actor, sessionId, true);
    if (!session) return false;

    const deleted = await this.sessions.delete(session.id, actor.userId);
    this.logger.debug("Deleted workspace session", { sessionId, deleted });
    return deleted;
  }

  /**
   * Validates a candidate session payload without persisting it. Returns false
   * rather than throwing so callers can use it as a guard.
   */
  validateSession(session: { activeTabId?: string | null; tabs?: unknown }): boolean {
    try {
      const tabs = this.validateTabs(session.tabs ?? []);
      if (session.activeTabId != null && !tabs.some((t) => t.id === session.activeTabId)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Validates a candidate tab descriptor without persisting it. */
  validateTab(tab: unknown): boolean {
    try {
      normalizeTab(tab, "tab");
      return true;
    } catch {
      return false;
    }
  }
}
