import { describe, expect, it, vi } from "vitest";
import { WorkspaceMembershipService } from "./WorkspaceMembershipService";
import type { WorkspaceMembershipRepository } from "@/src/application/ports/workspaces/WorkspaceMembershipRepository";

const membership = {
  id: "m1",
  workspaceId: "w1",
  userId: "target",
  role: "viewer" as const,
  createdById: "owner",
  revision: 1,
  revokedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setup(role: "owner" | "editor" | "viewer", organizationRole: "owner" | "admin" | "member" = "member") {
  const repository: WorkspaceMembershipRepository = {
    list: vi.fn(async () => ({ items: [membership], nextCursor: null })),
    get: vi.fn(async () => membership),
    add: vi.fn(async (input) => ({ ...membership, ...input })),
    update: vi.fn(async (_workspaceId, _userId, nextRole) => ({ ...membership, role: nextRole, revision: 2 })),
    revoke: vi.fn(async () => ({ ...membership, revokedAt: new Date(), revision: 2 })),
    countActiveOwners: vi.fn(async () => 2),
  };
  const workspaces = {
    get: vi.fn(async () => ({ role, capabilities: [], source: "explicit", workspace: {} })),
  };
  const service = new WorkspaceMembershipService(repository, workspaces as never);
  const actor = { userId: "actor", organizationId: "o1", organizationRole, organizationDefaultWorkspaceId: "w1" };
  return { service, repository, actor };
}

describe("WorkspaceMembershipService", () => {
  it("allows only a Workspace owner to add membership", async () => {
    const owner = setup("owner");
    await expect(owner.service.add(owner.actor, "w1", "target", "viewer")).resolves.toMatchObject({ userId: "target" });

    const admin = setup("editor", "admin");
    await expect(admin.service.add(admin.actor, "w1", "target", "viewer")).rejects.toThrow("Membership management is not permitted.");
  });

  it("rejects cross-scope operations before repository mutation", async () => {
    const denied = setup("viewer");
    await expect(denied.service.update(denied.actor, "w1", "target", "editor", 1)).rejects.toThrow();
    expect(denied.repository.update).not.toHaveBeenCalled();
  });

  it("keeps the last active owner", async () => {
    const owner = setup("owner");
    (owner.repository.get as ReturnType<typeof vi.fn>).mockResolvedValue({ ...membership, role: "owner" });
    (owner.repository.countActiveOwners as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    await expect(owner.service.revoke(owner.actor, "w1", "target", 1)).rejects.toThrow("retain an owner");
    expect(owner.repository.revoke).not.toHaveBeenCalled();
  });
});
