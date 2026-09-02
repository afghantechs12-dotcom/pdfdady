import type { WorkspaceMembershipRepository } from "@/src/application/ports/workspaces/WorkspaceMembershipRepository";
import type { WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import { DomainError } from "@/src/domain/errors";

export class WorkspaceMembershipService {
  constructor(private readonly memberships: WorkspaceMembershipRepository, private readonly workspaces: WorkspaceService) {}

  async list(actor: ActorContext, workspaceId: string, cursor?: string, limit = 25) {
    const access = await this.workspaces.get(actor, workspaceId);
    if (!["owner", "editor"].includes(access.role) && actor.organizationRole !== "admin") throw new DomainError("Membership access is not permitted.");
    return this.memberships.list(workspaceId, Math.min(Math.max(limit, 1), 100), cursor);
  }

  async add(actor: ActorContext, workspaceId: string, userId: string, role: WorkspaceRole) {
    const access = await this.workspaces.get(actor, workspaceId, true);
    if (access.role !== "owner") throw new DomainError("Membership management is not permitted.");
    return this.memberships.add({ workspaceId, userId, role, createdById: actor.userId });
  }

  async update(actor: ActorContext, workspaceId: string, userId: string, role: WorkspaceRole, revision: number) {
    const access = await this.workspaces.get(actor, workspaceId, true);
    if (access.role !== "owner") throw new DomainError("Membership management is not permitted.");
    const existing = await this.memberships.get(workspaceId, userId);
    if (!existing) throw new DomainError("Membership not found.");
    if (existing.role === "owner" && role !== "owner" && await this.memberships.countActiveOwners(workspaceId) <= 1) throw new DomainError("A Workspace must retain an owner.");
    return this.memberships.update(workspaceId, userId, role, revision);
  }

  async revoke(actor: ActorContext, workspaceId: string, userId: string, revision: number) {
    const access = await this.workspaces.get(actor, workspaceId, true);
    if (access.role !== "owner") throw new DomainError("Membership management is not permitted.");
    const existing = await this.memberships.get(workspaceId, userId);
    if (existing?.role === "owner" && await this.memberships.countActiveOwners(workspaceId) <= 1) throw new DomainError("A Workspace must retain an owner.");
    return this.memberships.revoke(workspaceId, userId, revision);
  }
}
