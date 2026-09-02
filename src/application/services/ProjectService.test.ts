import { describe, expect, it, vi } from "vitest";
import { ProjectService } from "./ProjectService";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { Project } from "@/src/domain/entities/Project";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "p1",
    workspaceId: "w1",
    organizationId: "o1",
    name: "Alpha",
    normalizedName: "alpha",
    slug: "alpha",
    normalizedSlug: "alpha",
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

function makeWorkspacesSvc(orgId = "o1") {
  const workspace = { id: "w1", organizationId: orgId, lifecycleState: "active" };
  return { get: vi.fn(async () => ({ workspace, role: "editor" as const, capabilities: [], source: "explicit" as const })) };
}

function makeActor(orgId = "o1") {
  return { userId: "u1", organizationId: orgId, organizationRole: "owner" as const, organizationDefaultWorkspaceId: "w1" };
}

describe("ProjectService — list", () => {
  it("lists projects after verifying workspace access", async () => {
    const repo = makeProjectRepo();
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    const result = await svc.list(makeActor(), "w1");
    expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1" }));
    expect(result.items).toHaveLength(1);
  });
});

describe("ProjectService — create", () => {
  it("creates a project with normalized name and order key", async () => {
    const repo = makeProjectRepo();
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    const project = await svc.create(makeActor(), "w1", { name: "My Project" });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "My Project",
      normalizedName: "my project",
      workspaceId: "w1",
    }));
    expect(project).toBeDefined();
  });

  it("rejects cross-organization creation", async () => {
    const repo = makeProjectRepo();
    // workspaces.get returns a workspace with a different org
    const workspacesSvc = { get: vi.fn(async () => ({ workspace: { id: "w1", organizationId: "other" }, role: "editor" as const, capabilities: [], source: "explicit" as const })) };
    const svc = new ProjectService(repo, workspacesSvc as any);
    await expect(svc.create(makeActor("o1"), "w1", { name: "Bad" })).rejects.toThrow("Cross-organization");
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("rejects empty project name", async () => {
    const repo = makeProjectRepo();
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    await expect(svc.create(makeActor(), "w1", { name: "   " })).rejects.toThrow("required");
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe("ProjectService — update", () => {
  it("updates project fields", async () => {
    const repo = makeProjectRepo();
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    await svc.update(makeActor(), "w1", "p1", { name: "Renamed", revision: 1 });
    expect(repo.update).toHaveBeenCalledWith("w1", "p1", expect.objectContaining({ name: "Renamed" }));
  });

  it("throws NotFoundError when project does not exist", async () => {
    const repo = makeProjectRepo({ getById: vi.fn(async () => null) });
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    await expect(svc.update(makeActor(), "w1", "missing", { revision: 1 })).rejects.toThrow("not found");
  });
});

describe("ProjectService — move", () => {
  it("generates an orderKey after a reference project", async () => {
    const afterProject = makeProject({ id: "p0", orderKey: "a" });
    const repo = makeProjectRepo({
      getById: vi.fn(async (wsId, id) => {
        if (id === "p0") return afterProject;
        return makeProject();
      }),
    });
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    await svc.move(makeActor(), "w1", "p1", { afterId: "p0", revision: 1 });
    expect(repo.update).toHaveBeenCalledWith("w1", "p1", expect.objectContaining({ orderKey: expect.stringMatching(/.+/) }));
  });

  it("rejects move referencing a project in a different workspace", async () => {
    const repo = makeProjectRepo({
      getById: vi.fn(async (_wsId, id) => {
        if (id === "ref") return makeProject({ id: "ref", workspaceId: "other-ws" });
        return makeProject();
      }),
    });
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    await expect(svc.move(makeActor(), "w1", "p1", { afterId: "ref", revision: 1 })).rejects.toThrow("Reference project not found");
  });
});

describe("ProjectService — lifecycle", () => {
  it("archives a project", async () => {
    const repo = makeProjectRepo();
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    const result = await svc.setLifecycle(makeActor(), "w1", "p1", "archived");
    expect(repo.setLifecycle).toHaveBeenCalledWith("w1", "p1", "archived", "u1");
    expect(result.lifecycleState).toBe("archived");
  });

  it("throws NotFoundError when project does not exist", async () => {
    const repo = makeProjectRepo({ getById: vi.fn(async () => null) });
    const svc = new ProjectService(repo, makeWorkspacesSvc() as any);
    await expect(svc.setLifecycle(makeActor(), "w1", "missing", "archived")).rejects.toThrow("not found");
  });
});
