/**
 * M7.12 workspace tab session domain types.
 *
 * A session is the per-user, per-Workspace record of which documents are open
 * in the workbench and how each one is being viewed. It stores only logical
 * references and bounded view state — never document bytes, data URLs or
 * rendered page images.
 */

/**
 * Hard bounds on session data, shared by the service (which rejects invalid
 * input on write) and the persistence adapters (which drop out-of-bounds tabs
 * on read, so a row written by an older or tampered-with client cannot return
 * unbounded values). One source of truth keeps the two paths from drifting.
 */
export const WORKSPACE_SESSION_LIMITS = {
  maxTabs: 20,
  maxPayloadBytes: 256 * 1024,
  maxTitleLength: 300,
  maxToolLength: 64,
  maxIdLength: 128,
  maxPage: 100_000,
  maxScale: 64,
  minScale: 0.01,
  maxOffset: 1_000_000,
  maxSelectionOffset: 10_000_000,
} as const;

/** Bounded per-tab view state. */
export interface WorkspaceSessionTabState {
  /** 1-based page currently in view. */
  activePage?: number;
  /** Viewport transform. */
  viewport?: {
    scale: number;
    offsetX: number;
    offsetY: number;
  };
  /** Active tool identifier. */
  tool?: string;
  /** Text selection range within the active page. */
  selection?: {
    start: number;
    end: number;
  };
  /** Whether the tab holds unsaved editor changes. */
  dirty?: boolean;
  /** Set when the tab's base version diverged from the document's current version. */
  conflict?: boolean;
  /**
   * Which split-view pane holds this tab (M7.13). Absent means the primary
   * pane, so a session written before split view restores as single-pane.
   *
   * Recorded here rather than in a separate pane store deliberately: two stores
   * that each believed they knew which document was open would eventually
   * disagree, and the disagreement would show as a pane rendering a document the
   * session says is closed.
   */
  paneId?: string;
  /** Last time this tab was focused. */
  lastAccessed: Date;
}

/** One open document in a session. */
export interface WorkspaceSessionTab {
  id: string;
  /** Logical document reference — re-authorized on restore. */
  documentId: string;
  /** Version the tab was opened against. */
  versionId: string;
  title: string;
  state: WorkspaceSessionTabState;
  createdAt: Date;
  updatedAt: Date;
}

/** A user's open-tab set for one Workspace. */
export interface WorkspaceSession {
  id: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  /** Always either null or the id of a tab present in `tabs`. */
  activeTabId: string | null;
  tabs: WorkspaceSessionTab[];
  /** Optimistic-concurrency counter. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Result of re-authorizing a persisted session against live membership.
 * Tabs referencing documents the actor can no longer read are dropped rather
 * than surfaced, so a revoked grant cannot leak a document's existence.
 */
export interface RestoredWorkspaceSession {
  session: WorkspaceSession;
  /** Tab ids removed because their document is gone or no longer readable. */
  droppedTabIds: string[];
}
