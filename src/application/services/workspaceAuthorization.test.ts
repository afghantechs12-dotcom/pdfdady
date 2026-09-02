import { describe, expect, it, vi } from "vitest";
import { WorkspaceAuthorizationResolver } from "./WorkspaceAuthorizationResolver";
import { WorkspaceService } from "./WorkspaceService";
import { WorkspaceMembershipService } from "./WorkspaceMembershipService";
import type { Workspace } from "@/src/domain/entities/Workspace";
import type { WorkspaceMembership } from "@/src/domain/entities/WorkspaceMembership";
import type { WorkspaceRepository } from "@/src/application/ports/workspaces/WorkspaceRepository";
import type { WorkspaceMembershipRepository } from "@/src/application/ports/workspaces/WorkspaceMembershipRepository";
import { WorkspaceLifecycleError } from "@/src/domain/errors";

// ---- shared fixtures -------------------------------------------------------

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    organizationId: "o1",
    name: "Main",
    normalizedName: "main",
    slug: "main",
    normalizedSlug: "main",
    description: null,
    lifecycleState: "active",
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

function makeMembership(overrides: Partial<WorkspaceMembership> = {}): WorkspaceMembership {
  return {
    id: "m1",
    workspaceId: "w1",
    userId: "u1",
    role: "owner",
    createdById: "u1",
    revision: 1,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const resolver = new WorkspaceAuthorizationResolver();

/** The error a call threw. Fails loudly if the call resolved instead. */
async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected this call to be refused, but it resolved.");
}

// ---- WorkspaceAuthorizationResolver ----------------------------------------

describe("WorkspaceAuthorizationResolver — cross-organization IDOR", () => {
  it("denies access when workspace.organizationId differs from actor organizationId", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace({ organizationId: "other-org" }),
      explicitMembership: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("workspace_unavailable");
    // The response must not reveal whether the workspace exists in another org
  });

  it("denies access when workspace is null — no existence disclosure", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: null,
      explicitMembership: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("workspace_unavailable");
  });

  it("does not disclose inaccessible non-default workspace existence", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w-default",
      organizationRole: "member",
      workspace: makeWorkspace({ id: "w-other" }),
      explicitMembership: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("denied");
    expect(result.role).toBeNull();
    expect(result.capabilities).toHaveLength(0);
  });
});

describe("WorkspaceAuthorizationResolver — explicit membership resolution", () => {
  it("grants access via explicit active membership", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: null,
      organizationRole: "member",
      workspace: makeWorkspace(),
      explicitMembership: makeMembership({ role: "editor" }),
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("editor");
    expect(result.source).toBe("explicit");
  });

  it("respects explicit viewer role even when org role would give editor", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "member",
      workspace: makeWorkspace(),
      explicitMembership: makeMembership({ role: "viewer" }),
    });
    expect(result.role).toBe("viewer");
    expect(result.source).toBe("explicit");
  });
});

describe("WorkspaceAuthorizationResolver — inherited default-workspace access", () => {
  it("grants inherited editor role to org member on default workspace", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "member",
      workspace: makeWorkspace(),
      explicitMembership: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("editor");
    expect(result.source).toBe("organization");
  });

  it("grants inherited owner role to org owner on default workspace", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace(),
      explicitMembership: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("owner");
  });

  it("grants inherited viewer role to org viewer on default workspace", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "viewer",
      workspace: makeWorkspace(),
      explicitMembership: null,
    });
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("viewer");
  });
});

describe("WorkspaceAuthorizationResolver — revocation precedence", () => {
  it("explicit revocation beats inherited default-workspace access", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "admin",
      workspace: makeWorkspace(),
      explicitMembership: makeMembership({ revokedAt: new Date(), role: "owner" }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("explicit_revocation");
  });

  it("explicit revocation wins even when actor is org owner", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace(),
      explicitMembership: makeMembership({ revokedAt: new Date() }),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("explicit_revocation");
  });
});

describe("WorkspaceAuthorizationResolver — org admin capability restrictions", () => {
  it("org admin via inheritance does not gain workspace:transfer-owner", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "admin",
      workspace: makeWorkspace(),
      explicitMembership: null,
    });
    expect(result.capabilities).toContain("org:admin");
    expect(result.capabilities).not.toContain("workspace:transfer-owner");
    expect(result.capabilities).not.toContain("workspace:delete");
  });
});

describe("WorkspaceAuthorizationResolver — archived/trashed lifecycle write restriction", () => {
  it("denies write to archived workspace", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace({ lifecycleState: "archived" }),
      explicitMembership: null,
      write: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("lifecycle_restricted");
  });

  it("denies write to trashed workspace", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace({ lifecycleState: "trashed" }),
      explicitMembership: null,
      write: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("lifecycle_restricted");
  });

  it("allows read on archived workspace", () => {
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace({ lifecycleState: "archived" }),
      explicitMembership: null,
      write: false,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("WorkspaceAuthorizationResolver — resource ID never authorizes", () => {
  it("knowing a workspace ID in the wrong org does not grant access", () => {
    // Actor belongs to org o1, workspace belongs to o2
    // Even with an explicit active membership (cross-org injection attempt)
    const result = resolver.resolve({
      actorId: "u1",
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace({ organizationId: "o2" }),
      explicitMembership: makeMembership({ workspaceId: "w1", userId: "u1", revokedAt: null }),
    });
    // workspace_unavailable fires before explicit membership check
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("workspace_unavailable");
  });

  it("unauthenticated actor never gains access regardless of workspace state", () => {
    const result = resolver.resolve({
      actorId: null,
      organizationAvailable: true,
      organizationId: "o1",
      organizationDefaultWorkspaceId: "w1",
      organizationRole: "owner",
      workspace: makeWorkspace(),
      explicitMembership: null,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("unauthenticated");
  });
});

// ---- WorkspaceService — owner-only membership management -------------------

function makeWorkspaceService(actorRole: "owner" | "editor" | "viewer", orgRole: "owner" | "admin" | "member" | "viewer" = "member") {
  const workspace = makeWorkspace();
  const workspaceRepo: WorkspaceRepository = {
    list: vi.fn(async () => ({ items: [workspace], nextCursor: null })),
    getById: vi.fn(async () => workspace),
    create: vi.fn(async (input) => ({ ...workspace, ...input })),
    update: vi.fn(async () => workspace),
    setLifecycle: vi.fn(async () => workspace),
  };
  const membershipRepo: WorkspaceMembershipRepository = {
    list: vi.fn(async () => ({ items: [], nextCursor: null })),
    get: vi.fn(async () => null),
    add: vi.fn(async (input) => makeMembership(input)),
    update: vi.fn(async () => makeMembership()),
    revoke: vi.fn(async () => makeMembership({ revokedAt: new Date() })),
    countActiveOwners: vi.fn(async () => 2),
  };
  const mockPrisma = {} as any;
  const mockResolver = {
    resolve: vi.fn(() => ({
      allowed: true,
      role: actorRole,
      capabilities: [],
      source: "explicit" as const,
      reason: "allowed" as const,
    })),
  };

  const svc = new WorkspaceService(mockPrisma, workspaceRepo, membershipRepo, mockResolver as any);
  const actor = { userId: "u1", organizationId: "o1", organizationRole: orgRole, organizationDefaultWorkspaceId: "w1" };
  return { svc, workspaceRepo, membershipRepo, actor };
}

describe("WorkspaceService — owner-only membership management access gate", () => {
  it("owner can get workspace for write", async () => {
    const { svc, actor } = makeWorkspaceService("owner");
    await expect(svc.get(actor, "w1", true)).resolves.toMatchObject({ role: "owner" });
  });

  it("editor write refused for lifecycle gets the lifecycle answer, not a collapsed not-found", async () => {
    const { svc, actor } = makeWorkspaceService("editor");
    // Simulate the resolver refusing a write purely because of lifecycle.
    (svc as any).resolver.resolve.mockReturnValueOnce({ allowed: false, role: null, capabilities: [], source: "none", reason: "lifecycle_restricted" });

    // This used to assert `rejects.toThrow("not found")`, which pinned the very
    // behaviour that made restore impossible and left an owner with no way to
    // tell "archived" from "you have no access". The actor already has read
    // access here, so naming the state is safe and is the only actionable answer.
    const error = await refusal(svc.get(actor, "w1", true));
    expect(error).toBeInstanceOf(WorkspaceLifecycleError);
    expect(error.message).not.toContain("not found");
    expect(error.message).toContain("Restore it before making changes.");
    expect((error as WorkspaceLifecycleError).code).toBe("WORKSPACE_ARCHIVED");
  });

  it("a refusal that is not about lifecycle stays the uniform not-found", async () => {
    const { svc, actor } = makeWorkspaceService("editor");
    (svc as any).resolver.resolve.mockReturnValueOnce({ allowed: false, role: null, capabilities: [], source: "none", reason: "denied" });
    await expect(svc.get(actor, "w1", true)).rejects.toThrow("Workspace not found.");
  });
});

describe("WorkspaceMembershipService — owner-only guard", () => {
  function setupMembershipSvc(actorRole: "owner" | "editor" | "viewer") {
    const membershipRepo: WorkspaceMembershipRepository = {
      list: vi.fn(async () => ({ items: [makeMembership()], nextCursor: null })),
      get: vi.fn(async () => makeMembership()),
      add: vi.fn(async (input) => makeMembership(input)),
      update: vi.fn(async () => makeMembership()),
      revoke: vi.fn(async () => makeMembership({ revokedAt: new Date() })),
      countActiveOwners: vi.fn(async () => 2),
    };
    const workspacesSvc = {
      get: vi.fn(async () => ({ role: actorRole, capabilities: [], source: "explicit", workspace: makeWorkspace() })),
    };
    const service = new WorkspaceMembershipService(membershipRepo, workspacesSvc as any);
    const actor = { userId: "actor", organizationId: "o1", organizationRole: "member" as const, organizationDefaultWorkspaceId: "w1" };
    return { service, membershipRepo, actor };
  }

  it("allows workspace owner to add a member", async () => {
    const { service, actor } = setupMembershipSvc("owner");
    await expect(service.add(actor, "w1", "target", "viewer")).resolves.toMatchObject({ userId: "target" });
  });

  it("rejects editor adding a member — owner-only", async () => {
    const { service, actor, membershipRepo } = setupMembershipSvc("editor");
    await expect(service.add(actor, "w1", "target", "viewer")).rejects.toThrow("Membership management is not permitted.");
    expect(membershipRepo.add).not.toHaveBeenCalled();
  });

  it("rejects viewer adding a member — owner-only", async () => {
    const { service, actor, membershipRepo } = setupMembershipSvc("viewer");
    await expect(service.add(actor, "w1", "target", "owner")).rejects.toThrow();
    expect(membershipRepo.add).not.toHaveBeenCalled();
  });

  it("rejects cross-organization membership creation attempt", async () => {
    const membershipRepo: WorkspaceMembershipRepository = {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      get: vi.fn(async () => null),
      add: vi.fn(async (input) => makeMembership(input)),
      update: vi.fn(async () => makeMembership()),
      revoke: vi.fn(async () => makeMembership()),
      countActiveOwners: vi.fn(async () => 1),
    };
    // Simulate workspaces.get throwing NotFoundError for cross-org workspace
    const { NotFoundError } = await import("@/src/domain/errors");
    const workspacesSvc = {
      get: vi.fn(async () => { throw new NotFoundError("Workspace not found."); }),
    };
    const service = new WorkspaceMembershipService(membershipRepo, workspacesSvc as any);
    const actor = { userId: "actor", organizationId: "o1", organizationRole: "owner" as const, organizationDefaultWorkspaceId: "w1" };
    await expect(service.add(actor, "w-other-org", "target", "viewer")).rejects.toThrow("Workspace not found.");
    expect(membershipRepo.add).not.toHaveBeenCalled();
  });

  it("protects last owner on role downgrade", async () => {
    const { service, membershipRepo, actor } = setupMembershipSvc("owner");
    (membershipRepo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeMembership({ role: "owner" }));
    (membershipRepo.countActiveOwners as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    await expect(service.update(actor, "w1", "target", "editor", 1)).rejects.toThrow("retain an owner");
    expect(membershipRepo.update).not.toHaveBeenCalled();
  });

  it("protects last owner on revoke", async () => {
    const { service, membershipRepo, actor } = setupMembershipSvc("owner");
    (membershipRepo.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(makeMembership({ role: "owner" }));
    (membershipRepo.countActiveOwners as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    await expect(service.revoke(actor, "w1", "target", 1)).rejects.toThrow("retain an owner");
    expect(membershipRepo.revoke).not.toHaveBeenCalled();
  });
});
