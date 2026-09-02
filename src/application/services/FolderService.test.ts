import { describe, expect, it, vi } from "vitest";
import { FolderService } from "./FolderService";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { Folder } from "@/src/domain/entities/Folder";
import type { Project } from "@/src/domain/entities/Project";

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: "f1",
    workspaceId: "w1",
    organizationId: "o1",
    projectId: null,
    parentId: null,
    name: "Folder A",
    normalizedName: "folder a",
    orderKey: "m",
    lifecycleState: "active",
    createdById: "u1",
    revision: 1,
    depth: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    trashedAt: null,
    archivedById: null,
    trashedById: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj1",
    workspaceId: "w1",
    organizationId: "o1",
    name: "Project",
    normalizedName: "project",
    slug: "project",
    normalizedSlug: "project",
    description: null,
    status: "active",
    lifecycleState: "active",
    orderKey: "m",
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

function makeFolderRepo(overrides: Partial<FolderRepository> = {}): FolderRepository {
  return {
    list: vi.fn(async () => ({ items: [makeFolder()], nextCursor: null })),
    getById: vi.fn(async () => makeFolder()),
    create: vi.fn(async (input) => makeFolder(input as Partial<Folder>)),
    update: vi.fn(async () => makeFolder({ revision: 2 })),
    setLifecycle: vi.fn(async () => makeFolder({ lifecycleState: "archived" })),
    getAncestorIds: vi.fn(async () => []),
    getDescendantIds: vi.fn(async () => []),
    maxOrderKey: vi.fn(async () => null),
    ...overrides,
  };
}

function makeProjectRepo(overrides: Partial<ProjectRepository> = {}): ProjectRepository {
  return {
    list: vi.fn(async () => ({ items: [makeProject()], nextCursor: null })),
    getById: vi.fn(async () => makeProject()),
    create: vi.fn(async (input) => makeProject(input as Partial<Project>)),
    update: vi.fn(async () => makeProject({ revision: 2 })),
    setLifecycle: vi.fn(async () => makeProject({ lifecycleState: "archived" })),
    maxOrderKey: vi.fn(async () => null),
    ...overrides,
  };
}

function makeWorkspacesSvc() {
  const workspace = { id: "w1", organizationId: "o1", lifecycleState: "active" };
  return { get: vi.fn(async () => ({ workspace, role: "editor" as const, capabilities: [], source: "explicit" as const })) };
}

function makeActor() {
  return { userId: "u1", organizationId: "o1", organizationRole: "owner" as const, organizationDefaultWorkspaceId: "w1" };
}

describe("FolderService — create", () => {
  it("creates a root folder", async () => {
    const folderRepo = makeFolderRepo();
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.create(makeActor(), "w1", { name: "Docs" });
    expect(folderRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Docs",
      normalizedName: "docs",
      parentId: null,
      depth: 0,
    }));
  });

  it("creates a nested folder with correct depth", async () => {
    const parent = makeFolder({ id: "parent", depth: 1 });
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => parent) });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.create(makeActor(), "w1", { name: "Sub", parentId: "parent" });
    expect(folderRepo.create).toHaveBeenCalledWith(expect.objectContaining({ depth: 2, parentId: "parent" }));
  });

  it("rejects nesting beyond MAX_FOLDER_DEPTH", async () => {
    const deepParent = makeFolder({ id: "deep", depth: 10 });
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => deepParent) });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "TooDeep", parentId: "deep" })).rejects.toThrow("nesting limit");
    expect(folderRepo.create).not.toHaveBeenCalled();
  });

  it("rejects creating inside an archived folder", async () => {
    const archivedParent = makeFolder({ id: "archived", lifecycleState: "archived" });
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => archivedParent) });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "Bad", parentId: "archived" })).rejects.toThrow("archived or trashed");
  });

  it("rejects parent folder from a different workspace", async () => {
    const foreignParent = makeFolder({ id: "foreign", workspaceId: "other-ws" });
    const folderRepo = makeFolderRepo({ getById: vi.fn(async () => foreignParent) });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "Bad", parentId: "foreign" })).rejects.toThrow("not found");
  });

  it("rejects empty folder name", async () => {
    const svc = new FolderService(makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "   " })).rejects.toThrow("required");
  });
});

describe("FolderService — move / cycle prevention", () => {
  it("prevents moving a folder into itself", async () => {
    const svc = new FolderService(makeFolderRepo(), makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.move(makeActor(), "w1", "f1", { newParentId: "f1", revision: 1 })).rejects.toThrow("own parent");
  });

  it("prevents moving a folder into one of its descendants", async () => {
    const folderRepo = makeFolderRepo({
      getDescendantIds: vi.fn(async () => ["child1", "child2"]),
      getById: vi.fn(async (wsId, id) => {
        if (id === "f1") return makeFolder({ id: "f1" });
        if (id === "child1") return makeFolder({ id: "child1", parentId: "f1" });
        return null;
      }),
    });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.move(makeActor(), "w1", "f1", { newParentId: "child1", revision: 1 })).rejects.toThrow("cycle");
  });

  it("rejects moving into an archived folder", async () => {
    const archivedTarget = makeFolder({ id: "archived", lifecycleState: "archived" });
    const folderRepo = makeFolderRepo({
      getById: vi.fn(async (wsId, id) => {
        if (id === "archived") return archivedTarget;
        return makeFolder({ id });
      }),
      getDescendantIds: vi.fn(async () => []),
    });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await expect(svc.move(makeActor(), "w1", "f1", { newParentId: "archived", revision: 1 })).rejects.toThrow("archived or trashed");
  });
});

describe("FolderService — rename", () => {
  it("renames a folder", async () => {
    const folderRepo = makeFolderRepo();
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    await svc.rename(makeActor(), "w1", "f1", "Renamed", 1);
    expect(folderRepo.update).toHaveBeenCalledWith("w1", "f1", expect.objectContaining({ name: "Renamed", normalizedName: "renamed" }));
  });
});

describe("FolderService — lifecycle", () => {
  it("archives a folder", async () => {
    const folderRepo = makeFolderRepo();
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    const result = await svc.setLifecycle(makeActor(), "w1", "f1", "archived");
    expect(folderRepo.setLifecycle).toHaveBeenCalledWith("w1", "f1", "archived", "u1");
    expect(result.lifecycleState).toBe("archived");
  });
});

describe("FolderService — breadcrumbs", () => {
  it("returns breadcrumbs from root to the target folder", async () => {
    const root = makeFolder({ id: "root", parentId: null, name: "Root" });
    const child = makeFolder({ id: "child", parentId: "root", name: "Child" });
    const target = makeFolder({ id: "target", parentId: "child", name: "Target" });
    const folderRepo = makeFolderRepo({
      getById: vi.fn(async (_wsId, id) => {
        if (id === "root") return root;
        if (id === "child") return child;
        if (id === "target") return target;
        return null;
      }),
      getAncestorIds: vi.fn(async () => ["root", "child"]),
    });
    const svc = new FolderService(folderRepo, makeProjectRepo(), makeWorkspacesSvc() as any);
    const crumbs = await svc.breadcrumbs(makeActor(), "w1", "target");
    expect(crumbs.map((f) => f.name)).toEqual(["Root", "Child", "Target"]);
  });
});
