import { beforeEach, describe, expect, it } from "vitest";
import { CommandPaletteService } from "./CommandPaletteService";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { CommandContext, CommandDescriptor } from "@/src/domain/entities/CommandPalette";
import { COMMAND_LIMITS } from "@/src/domain/entities/CommandPalette";
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
const ORG_OTHER = "org-beta";
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

class FakeWorkspaceService {
  private readonly grants = new Map<string, Map<string, "owner" | "editor" | "viewer">>();
  private readonly orgOf = new Map<string, string>();

  addWorkspace(workspaceId: string, organizationId = ORG): void {
    this.orgOf.set(workspaceId, organizationId);
    if (!this.grants.has(workspaceId)) this.grants.set(workspaceId, new Map());
  }
  grant(workspaceId: string, userId: string, role: "owner" | "editor" | "viewer" = "editor"): void {
    if (!this.grants.has(workspaceId)) this.addWorkspace(workspaceId);
    this.grants.get(workspaceId)!.set(userId, role);
  }
  async get(a: ActorContext, workspaceId: string, write = false) {
    const organizationId = this.orgOf.get(workspaceId);
    if (!organizationId) throw new NotFoundError("Workspace not found.");
    if (organizationId !== a.organizationId) throw new NotFoundError("Workspace not found.");
    const role = this.grants.get(workspaceId)?.get(a.userId);
    if (!role) throw new NotFoundError("Workspace not found.");
    if (write && role === "viewer") throw new DomainError("Write access required.");
    return { workspace: { id: workspaceId, organizationId }, role } as unknown as Awaited<
      ReturnType<WorkspaceService["get"]>
    >;
  }
}

class FakeDocumentRecordRepository {
  private readonly docs = new Map<string, DocumentRecord>();

  add(id: string, workspaceId: string): void {
    const now = new Date("2026-06-01T00:00:00.000Z");
    this.docs.set(`${workspaceId}:${id}`, {
      id,
      workspaceId,
      organizationId: ORG,
      projectId: null,
      folderId: null,
      name: `${id}.pdf`,
      normalizedName: `${id}.pdf`,
      lifecycleState: "active",
      orderKey: "a0",
      currentVersionId: null,
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

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    return this.docs.get(`${workspaceId}:${documentId}`) ?? null;
  }
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    hasDocument: true,
    hasSelection: true,
    canWrite: true,
    isSplit: true,
    activePane: "left",
    activeDocumentId: "doc-1",
    ...overrides,
  };
}

const SAVE: CommandDescriptor = {
  id: "doc.save",
  label: "Save",
  keywords: ["store"],
  category: "document",
  shortcut: "Ctrl+S",
  requirements: { document: true, write: true },
};

const GOTO: CommandDescriptor = {
  id: "nav.goto",
  label: "Go to page",
  keywords: ["jump"],
  category: "navigation",
};

interface Harness {
  service: CommandPaletteService;
  workspaces: FakeWorkspaceService;
  documents: FakeDocumentRecordRepository;
}

function harness(): Harness {
  const workspaces = new FakeWorkspaceService();
  const documents = new FakeDocumentRecordRepository();

  workspaces.addWorkspace(WS_A, ORG);
  workspaces.addWorkspace(WS_B, ORG_OTHER);
  workspaces.grant(WS_A, "user-owner", "owner");
  workspaces.grant(WS_A, "user-viewer", "viewer");
  workspaces.grant(WS_B, "user-outsider", "owner");
  documents.add("doc-1", WS_A);
  documents.add("doc-b", WS_B);

  const service = new CommandPaletteService(
    new TestLogger(),
    workspaces as unknown as WorkspaceService,
    documents as unknown as DocumentRecordRepository,
  );
  service.registerAll([SAVE, GOTO]);

  return { service, workspaces, documents };
}

describe("CommandPaletteService — registry", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("registers and retrieves a command", () => {
    expect(h.service.get("doc.save")?.label).toBe("Save");
    expect(h.service.list()).toHaveLength(2);
  });

  it("replaces a command registered under the same id", () => {
    h.service.register({ ...SAVE, label: "Save document" });
    expect(h.service.list()).toHaveLength(2);
    expect(h.service.get("doc.save")?.label).toBe("Save document");
  });

  it("refuses an invalid descriptor", () => {
    expect(() => h.service.register({ ...SAVE, id: "" })).toThrow(DomainError);
    expect(() =>
      h.service.register({ ...SAVE, category: "telepathy" as never }),
    ).toThrow(DomainError);
  });

  it("unregisters a command", () => {
    expect(h.service.unregister("doc.save")).toBe(true);
    expect(h.service.get("doc.save")).toBeNull();
    expect(h.service.unregister("doc.save")).toBe(false);
  });

  it("returns null for an unregistered id", () => {
    expect(h.service.get("nope")).toBeNull();
  });
});

describe("CommandPaletteService — search", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("finds a command by label", () => {
    expect(h.service.search("save", context())[0].id).toBe("doc.save");
  });

  it("finds a command by keyword", () => {
    expect(h.service.search("jump", context())[0].id).toBe("nav.goto");
  });

  it("returns the same order for the same query", () => {
    // Deterministic and local: a palette that ranks differently for the same
    // keystrokes is one users stop trusting.
    const first = h.service.search("o", context()).map((r) => r.id);
    const second = h.service.search("o", context()).map((r) => r.id);
    expect(first).toEqual(second);
  });

  it("marks a command disabled with a reason instead of hiding it", () => {
    const results = h.service.search("save", context({ canWrite: false }));
    expect(results[0].enabled).toBe(false);
    expect(results[0].disabledReason).toContain("permission");
  });

  it("evaluates one command against a context", () => {
    expect(h.service.evaluate("doc.save", context())?.enabled).toBe(true);
    expect(h.service.evaluate("doc.save", context({ hasDocument: false }))?.enabled).toBe(false);
    expect(h.service.evaluate("missing", context())).toBeNull();
  });
});

describe("CommandPaletteService — execution authorization", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("executes an authorized command", async () => {
    const result = await h.service.execute(actor("user-owner"), {
      commandId: "doc.save",
      workspaceId: WS_A,
      documentId: "doc-1",
      paneId: "right",
    });

    expect(result.commandId).toBe("doc.save");
    expect(result.documentId).toBe("doc-1");
    expect(result.paneId).toBe("right");
  });

  it("re-authorizes at execution time regardless of what the palette showed", async () => {
    // The palette is a catalogue, not a capability: a viewer who somehow
    // submitted a write command is refused here, not by the UI.
    await expect(
      h.service.execute(actor("user-viewer"), {
        commandId: "doc.save",
        workspaceId: WS_A,
        documentId: "doc-1",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses a command in another organization's Workspace", async () => {
    await expect(
      h.service.execute(actor("user-owner"), { commandId: "nav.goto", workspaceId: WS_B }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not confirm which commands exist to someone guessing", async () => {
    await expect(
      h.service.execute(actor("user-owner"), { commandId: "secret.command", workspaceId: WS_A }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a malformed command id without touching authorization", async () => {
    await expect(
      h.service.execute(actor("user-owner"), { commandId: "", workspaceId: WS_A }),
    ).rejects.toBeInstanceOf(DomainError);
    await expect(
      h.service.execute(actor("user-owner"), {
        commandId: "x".repeat(COMMAND_LIMITS.maxIdLength + 1),
        workspaceId: WS_A,
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("requires a document when the command declares one", async () => {
    await expect(
      h.service.execute(actor("user-owner"), { commandId: "doc.save", workspaceId: WS_A }),
    ).rejects.toThrow(/needs a document/i);
  });

  it("resolves the document within the Workspace", async () => {
    // A document id from another tenant reads as missing rather than forbidden.
    await expect(
      h.service.execute(actor("user-owner"), {
        commandId: "doc.save",
        workspaceId: WS_A,
        documentId: "doc-b",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not require a document for a command that declares none", async () => {
    const result = await h.service.execute(actor("user-owner"), {
      commandId: "nav.goto",
      workspaceId: WS_A,
    });
    expect(result.documentId).toBeNull();
  });

  it("defaults the target pane when none is given", async () => {
    const result = await h.service.execute(actor("user-owner"), {
      commandId: "nav.goto",
      workspaceId: WS_A,
    });
    expect(result.paneId).toBe("left");
  });

  it("allows a viewer to run a read-only command", async () => {
    const result = await h.service.execute(actor("user-viewer"), {
      commandId: "nav.goto",
      workspaceId: WS_A,
    });
    expect(result.role).toBe("viewer");
  });
});
