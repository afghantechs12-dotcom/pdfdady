import { beforeEach, describe, expect, it } from "vitest";
import { TabService } from "./TabService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import { InMemoryWorkspaceSessionRepository } from "@/src/infrastructure/persistence/InMemoryWorkspaceSessionRepository";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import { DomainError, NotFoundError } from "@/src/domain/errors";

/** Complete ILogger double — records calls so tests can assert on them if needed. */
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
const WS_B = "ws-beta";

function actor(userId: string, organizationId = ORG): ActorContext {
  return {
    userId,
    organizationId,
    organizationRole: "member",
    organizationDefaultWorkspaceId: null,
  };
}

/**
 * Authorization double that mirrors WorkspaceService.get: membership is an
 * explicit grant per (workspaceId, userId), and a missing grant throws the same
 * DomainError the real service throws.
 */
class FakeWorkspaceService {
  /** workspaceId -> userId -> role */
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

  revoke(workspaceId: string, userId: string): void {
    this.grants.get(workspaceId)?.delete(userId);
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

/** Document double: only the fields TabService reads are populated. */
class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(
    id: string,
    workspaceId: string,
    lifecycleState: DocumentRecordLifecycleState = "active",
  ): DocumentRecord {
    const now = new Date();
    const record: DocumentRecord = {
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
    };
    this.docs.set(id, record);
    return record;
  }

  remove(id: string): void {
    this.docs.delete(id);
  }

  trash(id: string): void {
    const doc = this.docs.get(id);
    if (doc) this.docs.set(id, { ...doc, lifecycleState: "trashed" });
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const doc = this.docs.get(documentId);
    if (!doc || doc.workspaceId !== workspaceId) return null;
    return { ...doc };
  }
}

interface Harness {
  service: TabService;
  sessions: InMemoryWorkspaceSessionRepository;
  workspaces: FakeWorkspaceService;
  documents: FakeDocumentRecordRepository;
  logger: TestLogger;
}

function harness(options?: { maxTabsPerSession?: number; maxSessionPayloadSize?: number }): Harness {
  const logger = new TestLogger();
  const workspaces = new FakeWorkspaceService();
  const sessions = new InMemoryWorkspaceSessionRepository();
  const documents = new FakeDocumentRecordRepository();

  workspaces.addWorkspace(WS_A);
  workspaces.addWorkspace(WS_B);

  const service = new TabService(
    logger,
    workspaces as unknown as WorkspaceService,
    sessions,
    documents as unknown as DocumentRecordRepository,
    options,
  );

  return { service, sessions, workspaces, documents, logger };
}

describe("TabService — sessions", () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
    h.workspaces.grant(WS_A, "user-1");
    h.workspaces.grant(WS_A, "user-2");
    h.workspaces.grant(WS_B, "user-1");
  });

  it("creates an empty session for a member", async () => {
    const session = await h.service.createWorkspaceSession(actor("user-1"), WS_A);

    expect(session.userId).toBe("user-1");
    expect(session.workspaceId).toBe(WS_A);
    expect(session.organizationId).toBe(ORG);
    expect(session.tabs).toEqual([]);
    expect(session.activeTabId).toBeNull();
    expect(session.version).toBe(1);
    expect(session.id).toEqual(expect.any(String));
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  it("is idempotent per (workspace, user)", async () => {
    const first = await h.service.createWorkspaceSession(actor("user-1"), WS_A);
    const second = await h.service.createWorkspaceSession(actor("user-1"), WS_A);

    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version);
  });

  it("keeps sessions separate per user and per workspace", async () => {
    const a1 = await h.service.createWorkspaceSession(actor("user-1"), WS_A);
    const a2 = await h.service.createWorkspaceSession(actor("user-2"), WS_A);
    const b1 = await h.service.createWorkspaceSession(actor("user-1"), WS_B);

    expect(new Set([a1.id, a2.id, b1.id]).size).toBe(3);
    expect(await h.service.getWorkspaceSession(actor("user-1"), a1.id)).not.toBeNull();
  });

  it("does not expose another user's session", async () => {
    const owned = await h.service.createWorkspaceSession(actor("user-1"), WS_A);

    expect(await h.service.getWorkspaceSession(actor("user-2"), owned.id)).toBeNull();
    await expect(h.service.closeTab(actor("user-2"), owned.id, "tab-x")).rejects.toThrow(NotFoundError);
    expect(await h.service.deleteWorkspaceSession(actor("user-2"), owned.id)).toBe(false);
  });

  it("rejects session creation for a non-member", async () => {
    await expect(h.service.createWorkspaceSession(actor("outsider"), WS_A)).rejects.toThrow(DomainError);
  });

  it("hides a session once workspace access is revoked", async () => {
    const session = await h.service.createWorkspaceSession(actor("user-1"), WS_A);
    h.workspaces.revoke(WS_A, "user-1");

    expect(await h.service.getWorkspaceSession(actor("user-1"), session.id)).toBeNull();
  });

  it("rejects a malformed or over-long session id without touching storage", async () => {
    expect(await h.service.getWorkspaceSession(actor("user-1"), "")).toBeNull();
    expect(await h.service.getWorkspaceSession(actor("user-1"), "x".repeat(500))).toBeNull();
  });

  it("deletes only the owner's session", async () => {
    const session = await h.service.createWorkspaceSession(actor("user-1"), WS_A);

    expect(await h.service.deleteWorkspaceSession(actor("user-1"), session.id)).toBe(true);
    expect(await h.service.getWorkspaceSession(actor("user-1"), session.id)).toBeNull();
    expect(await h.service.deleteWorkspaceSession(actor("user-1"), session.id)).toBe(false);
  });
});
describe("TabService — tabs", () => {
  let h: Harness;
  let sessionId: string;

  beforeEach(async () => {
    h = harness({ maxTabsPerSession: 3 });
    h.workspaces.grant(WS_A, "user-1");
    h.workspaces.grant(WS_B, "user-1");
    h.documents.add("doc-1", WS_A);
    h.documents.add("doc-2", WS_A);
    h.documents.add("doc-3", WS_A);
    h.documents.add("doc-4", WS_A);
    h.documents.add("doc-foreign", WS_B);

    sessionId = (await h.service.createWorkspaceSession(actor("user-1"), WS_A)).id;
  });

  it("opens an authorized document and focuses the new tab", async () => {
    const { tab, session } = await h.service.createTab(
      actor("user-1"),
      sessionId,
      "doc-1",
      "doc-1-v1",
      "Report.pdf",
    );

    expect(tab.documentId).toBe("doc-1");
    expect(tab.versionId).toBe("doc-1-v1");
    expect(tab.title).toBe("Report.pdf");
    expect(tab.id).toMatch(/^tab-[0-9a-f-]{36}$/);
    expect(session.tabs).toHaveLength(1);
    expect(session.activeTabId).toBe(tab.id);
    expect(session.version).toBe(2);
  });

  it("rejects a document from another workspace", async () => {
    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-foreign", "v1", "Foreign.pdf"),
    ).rejects.toThrow(NotFoundError);
  });

  it("rejects an unknown document and a trashed document", async () => {
    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-missing", "v1", "Gone.pdf"),
    ).rejects.toThrow(NotFoundError);

    h.documents.trash("doc-1");
    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "Trashed.pdf"),
    ).rejects.toThrow(DomainError);
  });

  it("enforces the maximum tab count", async () => {
    await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "1");
    await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "2");
    await h.service.createTab(actor("user-1"), sessionId, "doc-3", "v1", "3");

    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-4", "v1", "4"),
    ).rejects.toThrow(/at most 3 tabs/);
  });

  it("gives each tab of the same document a distinct id", async () => {
    const first = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    const second = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    expect(second.tab.id).not.toBe(first.tab.id);
    expect(second.session.tabs).toHaveLength(2);
    expect(second.session.activeTabId).toBe(second.tab.id);
  });

  it("rejects an over-long title and embedded content urls", async () => {
    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "x".repeat(400)),
    ).rejects.toThrow(/exceeds/);

    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "data:application/pdf;base64,AAAA"),
    ).rejects.toThrow(/embedded content/);

    await expect(
      h.service.createTab(actor("user-1"), sessionId, "doc-1", "blob:http://x/y", "Blob.pdf"),
    ).rejects.toThrow(/embedded content/);
  });

  it("requires an existing tab to switch", async () => {
    const { tab } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    await expect(h.service.switchTab(actor("user-1"), sessionId, "tab-nope")).rejects.toThrow(
      NotFoundError,
    );

    const switched = await h.service.switchTab(actor("user-1"), sessionId, tab.id);
    expect(switched.activeTabId).toBe(tab.id);
  });

  it("selects the right-hand neighbour when the active tab closes", async () => {
    const a = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    const b = await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "B");
    const c = await h.service.createTab(actor("user-1"), sessionId, "doc-3", "v1", "C");

    await h.service.switchTab(actor("user-1"), sessionId, b.tab.id);
    const afterMiddle = await h.service.closeTab(actor("user-1"), sessionId, b.tab.id);
    expect(afterMiddle.activeTabId).toBe(c.tab.id);

    const afterLast = await h.service.closeTab(actor("user-1"), sessionId, c.tab.id);
    expect(afterLast.activeTabId).toBe(a.tab.id);
  });

  it("keeps the active tab when an inactive tab closes", async () => {
    const a = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    const b = await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "B");

    const closed = await h.service.closeTab(actor("user-1"), sessionId, a.tab.id);
    expect(closed.activeTabId).toBe(b.tab.id);
    expect(closed.tabs).toHaveLength(1);
  });

  it("clears activeTabId when the last tab closes", async () => {
    const only = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    const closed = await h.service.closeTab(actor("user-1"), sessionId, only.tab.id);
    expect(closed.tabs).toEqual([]);
    expect(closed.activeTabId).toBeNull();
  });

  it("rejects closing a tab that is not in the session", async () => {
    await expect(h.service.closeTab(actor("user-1"), sessionId, "tab-ghost")).rejects.toThrow(
      NotFoundError,
    );
  });
});
describe("TabService — reorder, state and updates", () => {
  let h: Harness;
  let sessionId: string;

  beforeEach(async () => {
    h = harness();
    h.workspaces.grant(WS_A, "user-1");
    h.documents.add("doc-1", WS_A);
    h.documents.add("doc-2", WS_A);
    h.documents.add("doc-3", WS_A);
    sessionId = (await h.service.createWorkspaceSession(actor("user-1"), WS_A)).id;
  });

  it("reorders only when given the exact tab set", async () => {
    const a = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    const b = await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "B");
    const c = await h.service.createTab(actor("user-1"), sessionId, "doc-3", "v1", "C");

    const reordered = await h.service.reorderTabs(actor("user-1"), sessionId, [
      c.tab.id,
      a.tab.id,
      b.tab.id,
    ]);
    expect(reordered.tabs.map((t) => t.id)).toEqual([c.tab.id, a.tab.id, b.tab.id]);
    // Reordering must not move focus.
    expect(reordered.activeTabId).toBe(c.tab.id);

    await expect(
      h.service.reorderTabs(actor("user-1"), sessionId, [a.tab.id, b.tab.id]),
    ).rejects.toThrow(/exactly once/);
    await expect(
      h.service.reorderTabs(actor("user-1"), sessionId, [a.tab.id, a.tab.id, b.tab.id]),
    ).rejects.toThrow(/exactly once/);
    await expect(
      h.service.reorderTabs(actor("user-1"), sessionId, [a.tab.id, b.tab.id, "tab-alien"]),
    ).rejects.toThrow(/exactly once/);
  });

  it("merges tab state and preserves unsupplied keys", async () => {
    const { tab } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    await h.service.updateTabState(actor("user-1"), sessionId, tab.id, {
      activePage: 7,
      selection: { start: 10, end: 40 },
      dirty: true,
    });
    const after = await h.service.updateTabState(actor("user-1"), sessionId, tab.id, {
      viewport: { scale: 1.5, offsetX: 20, offsetY: -8 },
    });

    const state = after.tabs.find((t) => t.id === tab.id)!.state;
    expect(state.activePage).toBe(7);
    expect(state.selection).toEqual({ start: 10, end: 40 });
    expect(state.dirty).toBe(true);
    expect(state.viewport).toEqual({ scale: 1.5, offsetX: 20, offsetY: -8 });
    expect(state.lastAccessed).toBeInstanceOf(Date);
  });

  it("preserves dirty and conflict flags across unrelated updates", async () => {
    const { tab } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    await h.service.updateTabState(actor("user-1"), sessionId, tab.id, { dirty: true, conflict: true });

    const switched = await h.service.switchTab(actor("user-1"), sessionId, tab.id);
    const state = switched.tabs.find((t) => t.id === tab.id)!.state;
    expect(state.dirty).toBe(true);
    expect(state.conflict).toBe(true);
  });

  it("rejects out-of-bounds and malformed view state", async () => {
    const { tab } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    const bad: Array<Record<string, unknown>> = [
      { activePage: 0 },
      { activePage: 1_000_000 },
      { activePage: Number.NaN },
      { viewport: { scale: 500, offsetX: 0, offsetY: 0 } },
      { viewport: { scale: 1, offsetX: 5_000_000, offsetY: 0 } },
      { selection: { start: 40, end: 10 } },
      { selection: { start: -1, end: 5 } },
      { tool: "t".repeat(200) },
      { dirty: "yes" },
    ];

    for (const patch of bad) {
      await expect(
        h.service.updateTabState(actor("user-1"), sessionId, tab.id, patch),
      ).rejects.toThrow(DomainError);
    }
  });

  it("rejects state updates for a tab that does not exist", async () => {
    await expect(
      h.service.updateTabState(actor("user-1"), sessionId, "tab-ghost", { activePage: 2 }),
    ).rejects.toThrow(NotFoundError);
  });

  it("returns tab state only to the owner", async () => {
    const { tab } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    expect(await h.service.getTabState(actor("user-1"), sessionId, tab.id)).not.toBeNull();
    expect(await h.service.getTabState(actor("user-9"), sessionId, tab.id)).toBeNull();
    expect(await h.service.getTabState(actor("user-1"), sessionId, "tab-ghost")).toBeNull();
  });

  it("preserves tabs when a partial update omits them", async () => {
    const a = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");
    const b = await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "B");

    const updated = await h.service.updateWorkspaceSession(actor("user-1"), sessionId, {
      activeTabId: a.tab.id,
    });

    expect(updated.tabs.map((t) => t.id)).toEqual([a.tab.id, b.tab.id]);
    expect(updated.activeTabId).toBe(a.tab.id);
  });

  it("clears tabs when an explicit empty array is supplied", async () => {
    await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    const cleared = await h.service.updateWorkspaceSession(actor("user-1"), sessionId, { tabs: [] });

    expect(cleared.tabs).toEqual([]);
    expect(cleared.activeTabId).toBeNull();
  });

  it("never leaves activeTabId pointing at a missing tab", async () => {
    const a = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    const updated = await h.service.updateWorkspaceSession(actor("user-1"), sessionId, {
      activeTabId: "tab-not-here",
    });
    expect(updated.activeTabId).toBe(a.tab.id);
  });

  it("advances version and updatedAt but never createdAt", async () => {
    const created = await h.service.createWorkspaceSession(actor("user-1"), WS_A);
    const { session } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    expect(session.version).toBe(created.version + 1);
    expect(session.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(session.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime() - 1);
  });
});
describe("TabService — concurrency, bounds and restore", () => {
  let h: Harness;
  let sessionId: string;

  beforeEach(async () => {
    h = harness();
    h.workspaces.grant(WS_A, "user-1");
    h.documents.add("doc-1", WS_A);
    h.documents.add("doc-2", WS_A);
    sessionId = (await h.service.createWorkspaceSession(actor("user-1"), WS_A)).id;
  });

  it("does not overwrite a session that changed underneath a stale write", async () => {
    const stale = await h.service.getWorkspaceSession(actor("user-1"), sessionId);
    expect(stale).not.toBeNull();

    // A concurrent writer bumps the version out from under `stale`.
    const winner = await h.sessions.update(
      sessionId,
      "user-1",
      { activeTabId: null, tabs: [] },
      stale!.version,
    );
    expect(winner).not.toBeNull();

    // Replaying the stale version must be refused, not applied.
    const rejected = await h.sessions.update(
      sessionId,
      "user-1",
      { activeTabId: null, tabs: [] },
      stale!.version,
    );
    expect(rejected).toBeNull();

    const current = await h.service.getWorkspaceSession(actor("user-1"), sessionId);
    expect(current!.version).toBe(winner!.version);
  });

  it("enforces the serialized payload size limit", async () => {
    const tiny = harness({ maxSessionPayloadSize: 400 });
    tiny.workspaces.grant(WS_A, "user-1");
    tiny.documents.add("doc-1", WS_A);
    tiny.documents.add("doc-2", WS_A);
    const tinySession = (await tiny.service.createWorkspaceSession(actor("user-1"), WS_A)).id;

    await tiny.service.createTab(actor("user-1"), tinySession, "doc-1", "v1", "A");
    await expect(
      tiny.service.createTab(actor("user-1"), tinySession, "doc-2", "v1", "B".repeat(280)),
    ).rejects.toThrow(/payload exceeds/);
  });

  it("rejects data: and blob: urls anywhere in a supplied tab set", async () => {
    const now = new Date();
    const base = {
      id: "tab-11111111-1111-1111-1111-111111111111",
      documentId: "doc-1",
      versionId: "v1",
      title: "A",
      state: { lastAccessed: now },
      createdAt: now,
      updatedAt: now,
    };

    for (const poisoned of [
      { ...base, title: "data:text/html,<script>alert(1)</script>" },
      { ...base, versionId: "blob:https://evil/x" },
      { ...base, documentId: "data:application/pdf;base64,JVBER" },
      { ...base, state: { lastAccessed: now, tool: "data:text/html,x" } },
    ]) {
      await expect(
        h.service.updateWorkspaceSession(actor("user-1"), sessionId, { tabs: [poisoned] as never }),
      ).rejects.toThrow(/embedded content/);
    }
  });

  it("rejects a duplicate tab id in a supplied tab set", async () => {
    const now = new Date();
    const tab = {
      id: "tab-22222222-2222-2222-2222-222222222222",
      documentId: "doc-1",
      versionId: "v1",
      title: "A",
      state: { lastAccessed: now },
      createdAt: now,
      updatedAt: now,
    };

    await expect(
      h.service.updateWorkspaceSession(actor("user-1"), sessionId, { tabs: [tab, { ...tab }] as never }),
    ).rejects.toThrow(/Duplicate tab id/);
  });

  it("drops tabs whose document is gone or no longer readable on restore", async () => {
    const keep = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "Keep");
    const lose = await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "Lose");

    h.documents.remove("doc-2");

    const { session, droppedTabIds } = await h.service.restoreSession(actor("user-1"), sessionId);

    expect(droppedTabIds).toEqual([lose.tab.id]);
    expect(session.tabs.map((t) => t.id)).toEqual([keep.tab.id]);
    expect(session.activeTabId).toBe(keep.tab.id);
  });

  it("restores an intact session without a write or a version bump", async () => {
    const { session: before } = await h.service.createTab(
      actor("user-1"),
      sessionId,
      "doc-1",
      "v1",
      "Keep",
    );

    const { session, droppedTabIds } = await h.service.restoreSession(actor("user-1"), sessionId);

    expect(droppedTabIds).toEqual([]);
    expect(session.version).toBe(before.version);
  });

  it("preserves dirty state on surviving tabs through restore", async () => {
    const keep = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "Keep");
    await h.service.createTab(actor("user-1"), sessionId, "doc-2", "v1", "Lose");
    await h.service.updateTabState(actor("user-1"), sessionId, keep.tab.id, {
      dirty: true,
      conflict: true,
      activePage: 12,
    });

    h.documents.trash("doc-2");
    const { session } = await h.service.restoreSession(actor("user-1"), sessionId);

    const state = session.tabs.find((t) => t.id === keep.tab.id)!.state;
    expect(state.dirty).toBe(true);
    expect(state.conflict).toBe(true);
    expect(state.activePage).toBe(12);
  });

  it("refuses to restore a session the actor does not own", async () => {
    await expect(h.service.restoreSession(actor("user-2"), sessionId)).rejects.toThrow(NotFoundError);
  });

  it("returns copies that cannot mutate stored state", async () => {
    const { tab } = await h.service.createTab(actor("user-1"), sessionId, "doc-1", "v1", "A");

    const fetched = await h.service.getWorkspaceSession(actor("user-1"), sessionId);
    fetched!.tabs[0].title = "hijacked";
    fetched!.tabs[0].state.dirty = true;
    fetched!.tabs.push({ ...tab, id: "tab-injected" });
    fetched!.activeTabId = "tab-injected";

    const again = await h.service.getWorkspaceSession(actor("user-1"), sessionId);
    expect(again!.tabs).toHaveLength(1);
    expect(again!.tabs[0].title).toBe("A");
    expect(again!.tabs[0].state.dirty).toBe(false);
    expect(again!.activeTabId).toBe(tab.id);
  });

  it("validates candidate payloads without persisting them", () => {
    const now = new Date();
    const tab = {
      id: "tab-33333333-3333-3333-3333-333333333333",
      documentId: "doc-1",
      versionId: "v1",
      title: "A",
      state: { lastAccessed: now },
      createdAt: now,
      updatedAt: now,
    };

    expect(h.service.validateTab(tab)).toBe(true);
    expect(h.service.validateTab({ ...tab, id: "" })).toBe(false);
    expect(h.service.validateTab({ ...tab, title: "data:text/html,x" })).toBe(false);
    expect(h.service.validateTab(null)).toBe(false);

    expect(h.service.validateSession({ activeTabId: tab.id, tabs: [tab] })).toBe(true);
    expect(h.service.validateSession({ activeTabId: "tab-absent", tabs: [tab] })).toBe(false);
    expect(h.service.validateSession({ activeTabId: null, tabs: [] })).toBe(true);
  });

  /**
   * Both real repositories scope getById by workspaceId, so the service's own
   * workspace check is defence in depth. This drives it directly with a
   * repository that ignores the scope, proving the service does not rely on the
   * adapter to enforce the tenant boundary.
   */
  it("rejects a cross-workspace document even if the repository ignores scoping", async () => {
    const logger = new TestLogger();
    const workspaces = new FakeWorkspaceService();
    workspaces.addWorkspace(WS_A);
    workspaces.addWorkspace(WS_B);
    workspaces.grant(WS_A, "user-1");

    const scoped = new FakeDocumentRecordRepository();
    scoped.add("doc-foreign", WS_B);

    const leaky: Pick<DocumentRecordRepository, "getById"> = {
      // Deliberately ignores workspaceId — returns the WS_B document to a WS_A caller.
      getById: (_workspaceId, documentId) => scoped.getById(WS_B, documentId),
    };

    const service = new TabService(
      logger,
      workspaces as unknown as WorkspaceService,
      new InMemoryWorkspaceSessionRepository(),
      leaky as DocumentRecordRepository,
    );

    const leakySession = await service.createWorkspaceSession(actor("user-1"), WS_A);

    await expect(
      service.createTab(actor("user-1"), leakySession.id, "doc-foreign", "v1", "Foreign.pdf"),
    ).rejects.toThrow(NotFoundError);
  });
});

