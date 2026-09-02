import { beforeEach, describe, expect, it } from "vitest";
import { SplitViewService } from "./SplitViewService";
import { TabService } from "./TabService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import { InMemoryWorkspaceSessionRepository } from "@/src/infrastructure/persistence/InMemoryWorkspaceSessionRepository";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import { SPLIT_VIEW_LIMITS } from "@/src/domain/entities/SplitView";
import { DomainError, NotFoundError } from "@/src/domain/errors";

class TestLogger implements ILogger {
  readonly entries: Array<{ level: string; message: string; fields?: LogFields }> = [];
  debug(message: string, fields?: LogFields): void {
    this.entries.push({ level: "debug", message, fields });
  }
  info(message: string, fields?: LogFields): void {
    this.entries.push({ level: "info", message, fields });
  }
  warn(message: string, fields?: LogFields): void {
    this.entries.push({ level: "warn", message, fields });
  }
  error(message: string, fields?: LogFields): void {
    this.entries.push({ level: "error", message, fields });
  }
  child(): ILogger {
    return this;
  }
}

const ORG = "org-alpha";
const WS_A = "ws-alpha";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "admin" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "admin" | "editor" | "viewer" = "editor"): void {
    this.addWorkspace(workspaceId, this.orgOf.get(workspaceId) ?? ORG);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new DomainError("Forbidden.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new DomainError("You are not a member of this workspace.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(id: string, workspaceId: string, lifecycleState: DocumentRecordLifecycleState = "active"): void {
    const now = new Date();
    this.docs.set(id, {
      id,
      workspaceId,
      organizationId: ORG,
      projectId: null,
      folderId: null,
      name: `${id}.pdf`,
      normalizedName: `${id}.pdf`,
      lifecycleState,
      orderKey: "a0",
      currentVersionId: `${id}-v1`,
      favorite: false,
      lastAccessedAt: null,
      createdById: "user-1",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      trashedAt: null,
      archivedById: null,
      trashedById: null,
    });
  }

  remove(id: string): void {
    this.docs.delete(id);
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(documentId);
    if (!doc || doc.workspaceId !== workspaceId) return null;
    return { ...doc };
  }
}

interface Harness {
  split: SplitViewService;
  tabs: TabService;
  sessions: InMemoryWorkspaceSessionRepository;
  workspaces: FakeWorkspaceService;
  documents: FakeDocumentRecordRepository;
}

function harness(): Harness {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const sessions = new InMemoryWorkspaceSessionRepository();
  const documents = new FakeDocumentRecordRepository();

  workspaces.addWorkspace(WS_A);
  workspaces.grant(WS_A, "user-1");
  workspaces.grant(WS_A, "user-2");
  documents.add("doc-1", WS_A);
  documents.add("doc-2", WS_A);
  documents.add("doc-3", WS_A);

  // The real TabService, not a double: pane assignment must inherit its
  // authorization, bounds and concurrency rather than a test-only imitation.
  const tabs = new TabService(
    logger,
    workspaces as unknown as WorkspaceService,
    sessions,
    documents as unknown as DocumentRecordRepository,
  );
  const split = new SplitViewService(logger, tabs);

  return { split, tabs, sessions, workspaces, documents };
}

/** Creates a session with `count` tabs, all in the primary pane. */
async function seed(h: Harness, count = 2) {
  const a = actor("user-1");
  const session = await h.tabs.createWorkspaceSession(a, WS_A);
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const { tab } = await h.tabs.createTab(a, session.id, `doc-${i}`, `doc-${i}-v1`, `Doc ${i}`);
    ids.push(tab.id);
  }
  return { sessionId: session.id, tabIds: ids };
}

describe("SplitViewService — panes", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("starts single-pane with the primary pane active", async () => {
    const { sessionId } = await seed(h);
    const state = await h.split.getState(actor("user-1"), sessionId);

    expect(state.layout).toBe("single");
    expect(state.activePane).toBe("left");
    expect(state.panes.find((p) => p.id === "left")?.tabs).toHaveLength(2);
    expect(state.panes.find((p) => p.id === "right")?.tabs).toHaveLength(0);
  });

  it("becomes split when a tab is assigned to the right pane", async () => {
    const { sessionId, tabIds } = await seed(h);
    const state = await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");

    expect(state.layout).toBe("split");
    expect(state.panes.find((p) => p.id === "right")?.tabs.map((t) => t.id)).toEqual([tabIds[1]]);
  });

  it("persists the pane assignment across a reload", async () => {
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");

    // Fresh read from storage, no in-memory state involved.
    const reread = await h.split.getState(actor("user-1"), sessionId);
    expect(reread.layout).toBe("split");
  });

  it("rejects an invalid pane id", async () => {
    const { sessionId, tabIds } = await seed(h);
    await expect(
      h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[0], "middle"),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("rejects a tab that is not in the session", async () => {
    const { sessionId } = await seed(h);
    await expect(
      h.split.assignTabToPane(actor("user-1"), sessionId, "tab-missing", "right"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not disclose another user's session", async () => {
    const { sessionId } = await seed(h);
    // user-2 is a member of the Workspace but does not own this session.
    await expect(h.split.getState(actor("user-2"), sessionId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("routes commands to the pane holding the active tab", async () => {
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");

    const focused = await h.split.focusPane(actor("user-1"), sessionId, "right");
    expect(focused.activePane).toBe("right");
    expect(focused.panes.find((p) => p.id === "right")?.active).toBe(true);
    expect(focused.panes.find((p) => p.id === "left")?.active).toBe(false);
  });

  it("switches panes for a keyboard user", async () => {
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");
    await h.split.focusPane(actor("user-1"), sessionId, "left");

    const switched = await h.split.focusOtherPane(actor("user-1"), sessionId);
    expect(switched.activePane).toBe("right");
  });

  it("leaves focus alone when the other pane is empty", async () => {
    const { sessionId } = await seed(h);
    // A single-pane layout: the shortcut must not throw at a keyboard user.
    const state = await h.split.focusOtherPane(actor("user-1"), sessionId);
    expect(state.activePane).toBe("left");
  });

  it("refuses to focus a pane holding nothing", async () => {
    const { sessionId } = await seed(h);
    await expect(
      h.split.focusPane(actor("user-1"), sessionId, "right"),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("moves tabs to the survivor when a pane closes", async () => {
    const { sessionId, tabIds } = await seed(h, 3);
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[2], "right");

    const closed = await h.split.closePane(actor("user-1"), sessionId, "right");

    // Documents are not discarded with the arrangement.
    expect(closed.layout).toBe("single");
    expect(closed.panes.find((p) => p.id === "left")?.tabs).toHaveLength(3);
    expect(closed.panes.find((p) => p.id === "right")?.tabs).toHaveLength(0);
  });

  it("keeps something active after a pane closes", async () => {
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");
    await h.split.focusPane(actor("user-1"), sessionId, "right");

    const closed = await h.split.closePane(actor("user-1"), sessionId, "right");
    expect(closed.panes.find((p) => p.id === "left")?.activeTabId).not.toBeNull();
  });

  it("preserves dirty and conflict state when a pane closes", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(a, sessionId, tabIds[1], "right");
    await h.tabs.updateTabState(a, sessionId, tabIds[1], { dirty: true, conflict: true });

    await h.split.closePane(a, sessionId, "right");

    // Unsaved work must still be signalled after the arrangement collapses.
    const state = await h.tabs.getTabState(a, sessionId, tabIds[1]);
    expect(state?.dirty).toBe(true);
    expect(state?.conflict).toBe(true);
  });
});

describe("SplitViewService — synchronization", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  async function splitSession() {
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(actor("user-1"), sessionId, tabIds[1], "right");
    return { sessionId, tabIds };
  }

  it("is off by default", async () => {
    const { sessionId } = await splitSession();
    expect(h.split.getSyncMode(sessionId)).toBe("off");
  });

  it("rejects an invalid mode", async () => {
    const { sessionId } = await splitSession();
    expect(() => h.split.setSyncMode(sessionId, "telepathy")).toThrow(DomainError);
  });

  it("does not move the other pane when synchronization is off", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await splitSession();

    await h.split.applyViewportChange(a, sessionId, tabIds[0], { activePage: 7 });

    // A new tab starts on page 1; unchanged means it is still there.
    const other = await h.tabs.getTabState(a, sessionId, tabIds[1]);
    expect(other?.activePage).toBe(1);
  });

  it("mirrors the page when page synchronization is on", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await splitSession();
    h.split.setSyncMode(sessionId, "page");

    await h.split.applyViewportChange(a, sessionId, tabIds[0], { activePage: 7 });

    const other = await h.tabs.getTabState(a, sessionId, tabIds[1]);
    expect(other?.activePage).toBe(7);
  });

  it("mirrors zoom without dragging the page along", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await splitSession();
    h.split.setSyncMode(sessionId, "zoom");

    await h.split.applyViewportChange(a, sessionId, tabIds[0], {
      activePage: 9,
      viewport: { scale: 3, offsetX: 5, offsetY: 6 },
    });

    const other = await h.tabs.getTabState(a, sessionId, tabIds[1]);
    expect(other?.viewport?.scale).toBe(3);
    // Still on the page it started on: zoom sync must not drag the page along.
    expect(other?.activePage).toBe(1);
  });

  it("does not answer back when the movement came from synchronization", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await splitSession();
    h.split.setSyncMode(sessionId, "all");

    // A change tagged as sync-originated must not propagate, or the two panes
    // would drive each other indefinitely.
    await h.split.applyViewportChange(a, sessionId, tabIds[1], { activePage: 4 }, "sync");

    const origin = await h.tabs.getTabState(a, sessionId, tabIds[0]);
    expect(origin?.activePage).toBe(1);
  });

  it("keeps independent state per pane when unsynchronized", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await splitSession();

    await h.split.applyViewportChange(a, sessionId, tabIds[0], { activePage: 2 });
    await h.split.applyViewportChange(a, sessionId, tabIds[1], { activePage: 11 });

    expect((await h.tabs.getTabState(a, sessionId, tabIds[0]))?.activePage).toBe(2);
    expect((await h.tabs.getTabState(a, sessionId, tabIds[1]))?.activePage).toBe(11);
  });

  it("forgets synchronization when the session is forgotten", async () => {
    const { sessionId } = await splitSession();
    h.split.setSyncMode(sessionId, "all");
    h.split.forgetSession(sessionId);

    expect(h.split.getSyncMode(sessionId)).toBe("off");
  });
});

describe("SplitViewService — navigation", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("records a page jump in the active pane's history", async () => {
    const a = actor("user-1");
    const { sessionId } = await seed(h, 1);

    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 5 });

    const history = h.split.getHistory(sessionId, "left");
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].pageNumber).toBe(5);
  });

  it("records bookmark, comment and search jumps the same way", async () => {
    const a = actor("user-1");
    const { sessionId } = await seed(h, 1);

    await h.split.navigate(a, sessionId, { kind: "bookmark", pageNumber: 2, targetId: "bm-1" });
    await h.split.navigate(a, sessionId, { kind: "comment", pageNumber: 3, targetId: "th-1" });
    await h.split.navigate(a, sessionId, { kind: "search", pageNumber: 4, targetId: "hit-1" });

    // Back and forward must behave identically regardless of what was clicked.
    const history = h.split.getHistory(sessionId, "left");
    expect(history.entries.map((e) => e.kind)).toEqual(["bookmark", "comment", "search"]);
  });

  it("moves the pane to the navigated page", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h, 1);

    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 8 });

    expect((await h.tabs.getTabState(a, sessionId, tabIds[0]))?.activePage).toBe(8);
  });

  it("rejects an invalid page", async () => {
    const a = actor("user-1");
    const { sessionId } = await seed(h, 1);

    await expect(
      h.split.navigate(a, sessionId, { kind: "page", pageNumber: 0 }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("steps back and forward", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h, 1);
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 2 });
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 6 });

    await h.split.back(a, sessionId);
    expect((await h.tabs.getTabState(a, sessionId, tabIds[0]))?.activePage).toBe(2);

    await h.split.forward(a, sessionId);
    expect((await h.tabs.getTabState(a, sessionId, tabIds[0]))?.activePage).toBe(6);
  });

  it("returns null at the ends of history", async () => {
    const a = actor("user-1");
    const { sessionId } = await seed(h, 1);
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 3 });

    await expect(h.split.back(a, sessionId)).resolves.toBeNull();
    await expect(h.split.forward(a, sessionId)).resolves.toBeNull();
  });

  it("keeps history per pane", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(a, sessionId, tabIds[1], "right");

    await h.split.focusPane(a, sessionId, "left");
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 2 });
    await h.split.focusPane(a, sessionId, "right");
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 9 });

    expect(h.split.getHistory(sessionId, "left").entries.map((e) => e.pageNumber)).toEqual([2]);
    expect(h.split.getHistory(sessionId, "right").entries.map((e) => e.pageNumber)).toEqual([9]);
  });

  it("does not mirror a back-step into the other pane", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(a, sessionId, tabIds[1], "right");
    await h.split.focusPane(a, sessionId, "left");
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 2 });
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 5 });

    h.split.setSyncMode(sessionId, "all");
    await h.split.back(a, sessionId);

    // A history step is not a user scroll; mirroring it would move a pane the
    // user did not touch. It stays on the page it started on.
    expect((await h.tabs.getTabState(a, sessionId, tabIds[1]))?.activePage).toBe(1);
  });

  it("bounds the history", async () => {
    const a = actor("user-1");
    const { sessionId } = await seed(h, 1);
    for (let page = 1; page <= SPLIT_VIEW_LIMITS.maxHistoryEntries + 5; page += 1) {
      await h.split.navigate(a, sessionId, { kind: "page", pageNumber: page });
    }

    expect(h.split.getHistory(sessionId, "left").entries).toHaveLength(
      SPLIT_VIEW_LIMITS.maxHistoryEntries,
    );
  });
});

describe("SplitViewService — restoration", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("restores the pane arrangement", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(a, sessionId, tabIds[1], "right");

    const restored = await h.split.restore(a, sessionId);
    expect(restored.state.layout).toBe("split");
    expect(restored.droppedTabIds).toEqual([]);
  });

  it("drops a tab whose document is gone and reports it", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(a, sessionId, tabIds[1], "right");
    h.documents.remove("doc-2");

    const restored = await h.split.restore(a, sessionId);

    // A pane must not become a way to keep reading a document access was lost to.
    expect(restored.droppedTabIds).toEqual([tabIds[1]]);
    // With nothing left on the right, the layout collapses on its own.
    expect(restored.state.layout).toBe("single");
  });

  it("preserves dirty state through restoration", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.tabs.updateTabState(a, sessionId, tabIds[0], { dirty: true });

    await h.split.restore(a, sessionId);

    expect((await h.tabs.getTabState(a, sessionId, tabIds[0]))?.dirty).toBe(true);
  });

  it("does not restore synchronization or history", async () => {
    const a = actor("user-1");
    const { sessionId, tabIds } = await seed(h);
    await h.split.assignTabToPane(a, sessionId, tabIds[1], "right");
    h.split.setSyncMode(sessionId, "all");
    await h.split.navigate(a, sessionId, { kind: "page", pageNumber: 4 });

    await h.split.restore(a, sessionId);

    // Both describe a browsing session, not the documents: restoring a user
    // into a linked scroll they set up days ago would be wrong.
    expect(h.split.getSyncMode(sessionId)).toBe("off");
    expect(h.split.getHistory(sessionId, "left").entries).toHaveLength(0);
  });

  it("refuses restoration for a session the actor does not own", async () => {
    const { sessionId } = await seed(h);
    await expect(h.split.restore(actor("user-2"), sessionId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
