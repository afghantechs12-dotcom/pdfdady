import type { WorkspaceSession, WorkspaceSessionTab } from "@/src/domain/entities/WorkspaceSession";
import type {
  WorkspaceSessionRepository,
  WorkspaceSessionUpsertInput,
} from "@/src/application/ports/workspaces/WorkspaceSessionRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-session-${counter}`;
}

/** Deep copy so callers cannot mutate stored state through a returned reference. */
function cloneTab(tab: WorkspaceSessionTab): WorkspaceSessionTab {
  return {
    ...tab,
    state: {
      ...tab.state,
      viewport: tab.state.viewport ? { ...tab.state.viewport } : undefined,
      selection: tab.state.selection ? { ...tab.state.selection } : undefined,
      lastAccessed: new Date(tab.state.lastAccessed),
    },
    createdAt: new Date(tab.createdAt),
    updatedAt: new Date(tab.updatedAt),
  };
}

function clone(session: WorkspaceSession): WorkspaceSession {
  return {
    ...session,
    tabs: session.tabs.map(cloneTab),
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  };
}

/**
 * In-memory WorkspaceSessionRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter's scoping rules exactly, including the
 * (workspaceId, userId) uniqueness constraint and the optimistic version check.
 */
export class InMemoryWorkspaceSessionRepository implements WorkspaceSessionRepository {
  private readonly sessions = new Map<string, WorkspaceSession>();

  async getForUser(workspaceId: string, userId: string): Promise<WorkspaceSession | null> {
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId && session.userId === userId) return clone(session);
    }
    return null;
  }

  async getByIdForUser(sessionId: string, userId: string): Promise<WorkspaceSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    return clone(session);
  }

  async create(input: WorkspaceSessionUpsertInput): Promise<WorkspaceSession> {
    const existing = await this.getForUser(input.workspaceId, input.userId);
    if (existing) return existing;

    const now = new Date();
    const session: WorkspaceSession = {
      id: uid(),
      userId: input.userId,
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      activeTabId: input.activeTabId,
      tabs: input.tabs.map(cloneTab),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return clone(session);
  }

  async update(
    sessionId: string,
    userId: string,
    data: { activeTabId: string | null; tabs: WorkspaceSessionTab[] },
    expectedVersion?: number,
  ): Promise<WorkspaceSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return null;
    if (expectedVersion !== undefined && session.version !== expectedVersion) return null;

    // updatedAt must strictly advance even when two writes land in the same
    // millisecond, so callers can order revisions reliably.
    const now = new Date();
    const advanced =
      now.getTime() > session.updatedAt.getTime() ? now : new Date(session.updatedAt.getTime() + 1);

    const updated: WorkspaceSession = {
      ...session,
      activeTabId: data.activeTabId,
      tabs: data.tabs.map(cloneTab),
      version: session.version + 1,
      // createdAt is deliberately carried over unchanged.
      updatedAt: advanced,
    };
    this.sessions.set(sessionId, updated);
    return clone(updated);
  }

  async delete(sessionId: string, userId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return false;
    return this.sessions.delete(sessionId);
  }
}
