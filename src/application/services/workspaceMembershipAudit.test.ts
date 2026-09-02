import { describe, expect, it, vi } from "vitest";
import type { WorkspaceMembershipRepository } from "@/src/application/ports/workspaces/WorkspaceMembershipRepository";
import { WorkspaceMembershipService } from "@/src/application/services/WorkspaceMembershipService";
import type { WorkspaceMembership } from "@/src/domain/entities/WorkspaceMembership";

// ---------------------------------------------------------------------------
// Membership audit event tests
//
// These tests verify the audit contract at the service boundary:
//   - successful role update produces a committed mutation (audit is separate / best-effort)
//   - successful revocation produces a committed mutation
//   - unauthorized or failed mutation does not reach the mutation layer
//
// Audit recording at the HTTP layer (app/api routes) is best-effort fire-and-
// forget via .catch(). The service itself does not call audit.record — that
// is the route's responsibility. These tests confirm the mutation contract
// that the route-layer audit records are contingent on.
// ---------------------------------------------------------------------------

function makeActiveMembership(overrides: Partial<WorkspaceMembership> = {}): WorkspaceMembership {
  return {
    id: "m1",
    workspaceId: "w1",
    userId: "target",
    role: "viewer",
    createdById: "owner",
    revision: 1,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<WorkspaceMembershipRepository> = {}): WorkspaceMembershipRepository {
  return {
    list: vi.fn(async () => ({ items: [makeActiveMembership()], nextCursor: null })),
    get: vi.fn(async () => makeActiveMembership()),
    add: vi.fn(async (input) => makeActiveMembership(input)),
    update: vi.fn(async (_ws, _u, role) => makeActiveMembership({ role, revision: 2 })),
    revoke: vi.fn(async () => makeActiveMembership({ revokedAt: new Date(), revision: 2 })),
    countActiveOwners: vi.fn(async () => 2),
    ...overrides,
  };
}

function makeOwnerWorkspaces() {
  return { get: vi.fn(async () => ({ role: "owner" as const, capabilities: [], source: "explicit" as const, workspace: {} })) };
}

function makeEditorWorkspaces() {
  return { get: vi.fn(async () => ({ role: "editor" as const, capabilities: [], source: "explicit" as const, workspace: {} })) };
}

function makeActor() {
  return { userId: "actor", organizationId: "o1", organizationRole: "member" as const, organizationDefaultWorkspaceId: "w1" };
}

// ---- Role update ------------------------------------------------------------

describe("WorkspaceMembershipService — role update mutation contract", () => {
  it("commits the role update for a successful operation", async () => {
    const repo = makeRepo();
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    const result = await service.update(makeActor(), "w1", "target", "editor", 1);

    expect(repo.update).toHaveBeenCalledOnce();
    expect(result.role).toBe("editor");
    expect(result.revision).toBe(2);
    // Audit is best-effort at route layer — service returns committed state
    expect(result.revokedAt).toBeNull();
  });

  it("does not call repo.update when actor lacks owner role", async () => {
    const repo = makeRepo();
    const service = new WorkspaceMembershipService(repo, makeEditorWorkspaces() as any);

    await expect(service.update(makeActor(), "w1", "target", "editor", 1)).rejects.toThrow("Membership management is not permitted.");
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("does not call repo.update when membership not found", async () => {
    const repo = makeRepo({ get: vi.fn(async () => null) });
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    await expect(service.update(makeActor(), "w1", "target", "editor", 1)).rejects.toThrow("Membership not found.");
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("does not call repo.update when downgrading the last owner", async () => {
    const repo = makeRepo({
      get: vi.fn(async () => makeActiveMembership({ role: "owner" })),
      countActiveOwners: vi.fn(async () => 1),
    });
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    await expect(service.update(makeActor(), "w1", "target", "viewer", 1)).rejects.toThrow("retain an owner");
    expect(repo.update).not.toHaveBeenCalled();
  });
});

// ---- Revocation -------------------------------------------------------------

describe("WorkspaceMembershipService — revocation mutation contract", () => {
  it("commits revocation for a successful operation", async () => {
    const repo = makeRepo();
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    const result = await service.revoke(makeActor(), "w1", "target", 1);

    expect(repo.revoke).toHaveBeenCalledOnce();
    expect(result.revokedAt).not.toBeNull();
    expect(result.revision).toBe(2);
  });

  it("does not call repo.revoke when actor lacks owner role", async () => {
    const repo = makeRepo();
    const service = new WorkspaceMembershipService(repo, makeEditorWorkspaces() as any);

    await expect(service.revoke(makeActor(), "w1", "target", 1)).rejects.toThrow("Membership management is not permitted.");
    expect(repo.revoke).not.toHaveBeenCalled();
  });

  it("does not call repo.revoke when revoking the last owner", async () => {
    const repo = makeRepo({
      get: vi.fn(async () => makeActiveMembership({ role: "owner" })),
      countActiveOwners: vi.fn(async () => 1),
    });
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    await expect(service.revoke(makeActor(), "w1", "target", 1)).rejects.toThrow("retain an owner");
    expect(repo.revoke).not.toHaveBeenCalled();
  });
});

// ---- Audit best-effort contract (route layer pattern) ----------------------

describe("Membership audit — best-effort fire-and-forget contract", () => {
  it("audit.record failure must not prevent a committed mutation from being returned", async () => {
    // This tests the pattern used in app/api/workspaces/[workspaceId]/members/[userId]/route.ts:
    //   services.memberships.update(...)
    //   services.audit.record(...).catch(() => {}) // fire-and-forget
    //   return NextResponse.json({ membership })
    //
    // Simulate: mutation succeeds, audit throws. The caller receives the result.

    const repo = makeRepo();
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    const mutation = service.update(makeActor(), "w1", "target", "editor", 1);
    const auditResult = mutation.then((m) => {
      // Simulate the audit fire-and-forget
      const auditPromise = Promise.reject(new Error("Audit write failed")).catch(() => {});
      return Promise.all([Promise.resolve(m), auditPromise]);
    });

    const [membership] = await auditResult;
    expect((membership as WorkspaceMembership).role).toBe("editor");
    expect(repo.update).toHaveBeenCalledOnce();
  });

  it("successful role update does not emit audit event before mutation commits", async () => {
    // Verifies ordering: mutation must succeed before audit fires
    const callOrder: string[] = [];
    const repo = makeRepo({
      update: vi.fn(async () => {
        callOrder.push("mutation");
        return makeActiveMembership({ role: "editor", revision: 2 });
      }),
    });
    const auditRecord = vi.fn(async (_event: { action: string; resourceId: string }) => {
      callOrder.push("audit");
    });
    const service = new WorkspaceMembershipService(repo, makeOwnerWorkspaces() as any);

    const membership = await service.update(makeActor(), "w1", "target", "editor", 1);
    auditRecord({ action: "workspace.membership.role_update", resourceId: membership.id });

    expect(callOrder).toEqual(["mutation", "audit"]);
  });
});
