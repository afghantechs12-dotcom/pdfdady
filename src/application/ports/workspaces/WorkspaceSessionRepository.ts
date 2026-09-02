import type { WorkspaceSession, WorkspaceSessionTab } from "@/src/domain/entities/WorkspaceSession";

/** Fields a caller may persist. Identity and timestamps are repository-owned. */
export interface WorkspaceSessionUpsertInput {
  workspaceId: string;
  organizationId: string;
  userId: string;
  activeTabId: string | null;
  tabs: WorkspaceSessionTab[];
}

/**
 * Persistence port for M7.12 tab sessions.
 *
 * Every method is Workspace- and user-scoped: a session is addressed by
 * (workspaceId, userId) or by (id, userId), never by id alone. This makes it
 * impossible for a caller to read or mutate another user's session, and keeps
 * cross-Workspace reads out of reach at the adapter boundary.
 */
export interface WorkspaceSessionRepository {
  /** Returns the actor's session for a Workspace, or null when none exists. */
  getForUser(workspaceId: string, userId: string): Promise<WorkspaceSession | null>;

  /** Returns a session by id, scoped to its owner. Null when absent or not owned. */
  getByIdForUser(sessionId: string, userId: string): Promise<WorkspaceSession | null>;

  /** Creates the session for (workspaceId, userId), or returns the existing one. */
  create(input: WorkspaceSessionUpsertInput): Promise<WorkspaceSession>;

  /**
   * Replaces the tab set and active tab of a session the actor owns.
   *
   * `expectedVersion` enforces optimistic concurrency: when supplied and
   * different from the stored version the write is rejected so a stale tab can
   * not clobber a newer session. Returns null when the session does not exist,
   * is not owned by `userId`, or the version check fails.
   */
  update(
    sessionId: string,
    userId: string,
    data: { activeTabId: string | null; tabs: WorkspaceSessionTab[] },
    expectedVersion?: number,
  ): Promise<WorkspaceSession | null>;

  /** Deletes a session the actor owns. Returns true when a row was removed. */
  delete(sessionId: string, userId: string): Promise<boolean>;
}
