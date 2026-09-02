import { describe, expect, it, vi } from "vitest";
import { DocumentRecordService } from "./DocumentRecordService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { Folder } from "@/src/domain/entities/Folder";

function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "d1",
    workspaceId: "w1",
    organizationId: "o1",
    projectId: null,
    folderId: null,
    name: "My Document",
    normalizedName: "my document",
    lifecycleState: "active",
    orderKey: "m",
    currentVersionId: null,
    favorite: false,
    lastAccessedAt: null,
    createdById: "u1",
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    trashedAt: null,
    archivedById: null,
    trashedById: null,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "f1", workspaceId: "w1", organizationId: "o1", projectId: null, parentId: null,
    name: "Folder", normalizedName: "folder", orderKey: "m", lifecycleState: "active",
    createdById: "u1", revision: 1, depth: 0,
    createdAt: new Date(), updatedAt: new Date(),
    archivedAt: null, trashedAt: null, archivedById: null, trashedById: null,
    ...overrides,
  };
}

function makeDocRepo(overrides: Partial<DocumentRecordRepository> = {}): DocumentRecordRepository {
  return {
    list: vi.fn(async () => ({ items: [makeDocument()], nextCursor: null })),
    getById: vi.fn(async () => makeDocument()),
    create: vi.fn(async (input) => makeDocument(input as any)),
    update: vi.fn(async () => makeDocument({ revision: 2 })),
    setCurrentVersionIfUnset: vi.fn(async () => true),
    setLifecycle: vi.fn(async () => makeDocument({ lifecycleState: "archived" })),
    touchLastAccessed: vi.fn(async () => {}),
    bulkSetLifecycle: vi.fn(async (_ws: string, ids: string[], _state: any) => ({
      operationId: "op1",
      itemResults: ids.map((id: string) => ({ documentId: id, success: true })),
    })),
    bulkMove: vi.fn(async (_ws: string, ids: string[]) => ({
      operationId: "op2",
      itemResults: ids.map((id: string) => ({ documentId: id, success: true })),
    })),
    maxOrderKey: vi.fn(async () => null),
    ...overrides,
  };
}

function makeFolderRepo(overrides: Partial<FolderRepository> = {}): FolderRepository {
  return {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    getById: vi.fn(async () => makeFolder()),
    create: vi.fn(async () => makeFolder()),
    update: vi.fn(async () => makeFolder()),
    setLifecycle: vi.fn(async () => makeFolder()),
    getAncestorIds: vi.fn(async () => []),
    getDescendantIds: vi.fn(async () => []),
    maxOrderKey: vi.fn(async () => null),
    ...overrides,
  };
}

function makeProjectRepo(): ProjectRepository {
  return {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    getById: vi.fn(async () => null),
    create: vi.fn(async () => { throw new Error("not used"); }),
    update: vi.fn(async () => { throw new Error("not used"); }),
    setLifecycle: vi.fn(async () => { throw new Error("not used"); }),
    maxOrderKey: vi.fn(async () => null),
  };
}

function makeWorkspacesSvc(orgId = "o1") {
  const workspace = { id: "w1", organizationId: orgId, lifecycleState: "active" };
  return { get: vi.fn(async () => ({ workspace, role: "editor" as const, capabilities: [], source: "explicit" as const })) };
}

function makeActor() {
  return { userId: "u1", organizationId: "o1", organizationRole: "owner" as const, organizationDefaultWorkspaceId: "w1" };
}

describe("DocumentRecordService — create", () => {
  it("creates a document at workspace root", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.create(makeActor(), "w1", { name: "Report.pdf" });
    expect(docRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Report.pdf",
      normalizedName: "report.pdf",
      folderId: null,
    }));
  });

  it("rejects cross-organization creation", async () => {
    const docRepo = makeDocRepo();
    const workspacesSvc = { get: vi.fn(async () => ({ workspace: { id: "w1", organizationId: "other" }, role: "editor" as const, capabilities: [], source: "explicit" as const })) };
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), workspacesSvc as any);
    await expect(svc.create(makeActor(), "w1", { name: "Bad" })).rejects.toThrow("Cross-organization");
    expect(docRepo.create).not.toHaveBeenCalled();
  });

  it("rejects empty name", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "   " })).rejects.toThrow("required");
  });

  it("rejects creation inside an archived folder", async () => {
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => makeFolder({ lifecycleState: "archived" })) });
    const svc = new DocumentRecordService(makeDocRepo(), folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "Doc", folderId: "f1" })).rejects.toThrow("archived or trashed");
  });

  it("rejects creation in folder from different workspace", async () => {
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => makeFolder({ workspaceId: "other-ws" })) });
    const svc = new DocumentRecordService(makeDocRepo(), folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "Doc", folderId: "foreign" })).rejects.toThrow("not found");
  });
});

describe("DocumentRecordService — rename", () => {
  it("renames a document", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.rename(makeActor(), "w1", "d1", "Renamed.pdf", 1);
    expect(docRepo.update).toHaveBeenCalledWith("w1", "d1", expect.objectContaining({ name: "Renamed.pdf" }));
  });
});

describe("DocumentRecordService — move", () => {
  it("moves a document into a target folder", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.move(makeActor(), "w1", "d1", { targetFolderId: "f1", revision: 1 });
    expect(docRepo.update).toHaveBeenCalledWith("w1", "d1", expect.objectContaining({ folderId: "f1" }));
  });

  it("rejects moving into an archived folder", async () => {
    const docRepo = makeDocRepo();
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => makeFolder({ lifecycleState: "archived" })) });
    const svc = new DocumentRecordService(docRepo, folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.move(makeActor(), "w1", "d1", { targetFolderId: "f1", revision: 1 })).rejects.toThrow("archived or trashed");
  });

  it("rejects move referencing document in different workspace", async () => {
    const foreignDoc = makeDocument({ id: "ref", workspaceId: "other-ws" });
    const docRepo = makeDocRepo({
      getById: vi.fn(async (_ws, id) => {
        if (id === "ref") return foreignDoc;
        return makeDocument();
      }),
    });
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.move(makeActor(), "w1", "d1", { afterId: "ref", revision: 1 })).rejects.toThrow("Reference document not found");
  });
});

describe("DocumentRecordService — lifecycle", () => {
  it("archives a document", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    const result = await svc.setLifecycle(makeActor(), "w1", "d1", "archived");
    expect(docRepo.setLifecycle).toHaveBeenCalledWith("w1", "d1", "archived", "u1");
    expect(result.lifecycleState).toBe("archived");
  });

  it("throws when document does not exist", async () => {
    const docRepo = makeDocRepo({ getById: vi.fn(async () => null) });
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.setLifecycle(makeActor(), "w1", "missing", "archived")).rejects.toThrow("not found");
  });
});

describe("DocumentRecordService — favorites", () => {
  it("toggles favorite from false to true", async () => {
    const docRepo = makeDocRepo({ getById: vi.fn(async () => makeDocument({ favorite: false })) });
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.toggleFavorite(makeActor(), "w1", "d1", 1);
    expect(docRepo.update).toHaveBeenCalledWith("w1", "d1", expect.objectContaining({ favorite: true }));
  });

  it("toggles favorite from true to false", async () => {
    const docRepo = makeDocRepo({ getById: vi.fn(async () => makeDocument({ favorite: true })) });
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.toggleFavorite(makeActor(), "w1", "d1", 1);
    expect(docRepo.update).toHaveBeenCalledWith("w1", "d1", expect.objectContaining({ favorite: false }));
  });
});

describe("DocumentRecordService — bulk operations", () => {
  it("bulk archives up to 50 documents", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    const ids = Array.from({ length: 10 }, (_, i) => `d${i}`);
    const result = await svc.bulkSetLifecycle(makeActor(), "w1", ids, "archived");
    expect(result.itemResults).toHaveLength(10);
    expect(result.itemResults.every((r) => r.success)).toBe(true);
  });

  it("rejects bulk operation exceeding 50 items", async () => {
    const svc = new DocumentRecordService(makeDocRepo(), makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    const ids = Array.from({ length: 51 }, (_, i) => `d${i}`);
    await expect(svc.bulkSetLifecycle(makeActor(), "w1", ids, "archived")).rejects.toThrow("limited to 50");
  });

  it("bulk move rejects archived target folder", async () => {
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => makeFolder({ lifecycleState: "trashed" })) });
    const svc = new DocumentRecordService(makeDocRepo(), folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.bulkMove(makeActor(), "w1", ["d1"], "f1")).rejects.toThrow("archived or trashed");
  });
});

describe("T13/T14 — what an open records, and what \"Recent\" means", () => {
  it("records an open as a timestamp only: no version, no revision bump", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.touchAccessed(makeActor(), "w1", "d1");
    expect(docRepo.touchLastAccessed).toHaveBeenCalledWith("w1", "d1");
    /*
     * The two calls that must NOT happen. `update` is the compare-and-swap write:
     * it advances `revision`, which is the token an open editor's autosave fences
     * against — so recording an open through it would make the next save of a
     * document opened in a second tab a conflict nobody caused. And an open is not
     * a version: nothing about the document changed by looking at it.
     */
    expect(docRepo.update).not.toHaveBeenCalled();
    expect(docRepo.setCurrentVersionIfUnset).not.toHaveBeenCalled();
  });

  it("refuses to record an open for a document that is not in this Workspace", async () => {
    const docRepo = makeDocRepo({ getById: vi.fn(async () => null) });
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.touchAccessed(makeActor(), "w1", "nope")).rejects.toThrow("Document not found.");
    expect(docRepo.touchLastAccessed).not.toHaveBeenCalled();
  });

  it("orders Recent by when it was OPENED, and lists only documents that were", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    // The caller's own sort is what every caller sends — the page defaults to
    // name — and Recent is an ordering, so the view overrides it.
    await svc.list(makeActor(), "w1", { view: "recent", sortBy: "name", sortOrder: "asc" });
    expect(docRepo.list).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycleState: "active",
        openedOnly: true,
        sortBy: "lastAccessedAt",
        sortOrder: "desc",
      }),
    );
  });

  it("leaves every other view sorting by what the caller asked for", async () => {
    const docRepo = makeDocRepo();
    const svc = new DocumentRecordService(docRepo, makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.list(makeActor(), "w1", { view: "all", sortBy: "name", sortOrder: "asc" });
    expect(docRepo.list).toHaveBeenCalledWith(
      expect.objectContaining({ openedOnly: false, sortBy: "name", sortOrder: "asc" }),
    );
    await svc.list(makeActor(), "w1", { view: "favorites", sortBy: "updatedAt", sortOrder: "desc" });
    expect(docRepo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ favorite: true, openedOnly: false, sortBy: "updatedAt" }),
    );
  });
});
