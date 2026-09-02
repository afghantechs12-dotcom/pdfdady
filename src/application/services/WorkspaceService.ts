import type { PrismaClient } from "@prisma/client";
import type { Workspace, WorkspaceLifecycleState } from "@/src/domain/entities/Workspace";
import type { WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";
import type { WorkspaceRepository } from "@/src/application/ports/workspaces/WorkspaceRepository";
import type { WorkspaceMembershipRepository } from "@/src/application/ports/workspaces/WorkspaceMembershipRepository";
import { WorkspaceAuthorizationResolver } from "./WorkspaceAuthorizationResolver";
import { normalizeWorkspaceName, normalizeWorkspaceSlug } from "./workspaceNormalization";
import { DomainError, NotFoundError, WorkspaceAccessError, WorkspaceLifecycleError } from "@/src/domain/errors";
import type { Role } from "@/src/domain/entities/Role";
import type { ILogger } from "@/src/application/ports/Logger";

export interface ActorContext {
  userId: string;
  organizationId: string;
  organizationRole: Role;
  organizationDefaultWorkspaceId: string | null;
}

export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workspaces: WorkspaceRepository,
    private readonly memberships: WorkspaceMembershipRepository,
    private readonly resolver = new WorkspaceAuthorizationResolver(),
    private readonly logger?: ILogger,
  ) {}

  /**
   * The Workspaces this actor can open, which is the same set `get` accepts.
   *
   * The picker and the Workspace route consume this one truth. Previously this
   * listed every Workspace in the organization regardless of membership, so the
   * picker advertised Workspaces that `get` refused — the two surfaces
   * disagreed about the same user.
   */
  async list(actor: ActorContext, cursor?: string, limit = 25) {
    return this.workspaces.list({
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      inheritedWorkspaceId: actor.organizationDefaultWorkspaceId,
      lifecycleState: "active",
      cursor,
      limit: Math.min(Math.max(limit, 1), 100),
    });
  }

  /**
   * The canonical Workspace read. Every route and service reaches a Workspace
   * through here, so the identity accepted here is the identity the whole
   * product navigates with: the `Workspace.id` primary key, never a slug, name
   * or list position.
   *
   * A refusal is categorised (`WorkspaceAccessError.code`) for logs and tests
   * but presents identically to the caller — see the class comment for why.
   */
  async get(actor: ActorContext, workspaceId: string, write = false): Promise<{ workspace: Workspace; role: WorkspaceRole }> {
    const id = typeof workspaceId === "string" ? workspaceId.trim() : "";
    if (!id) {
      this.warn("WORKSPACE_ID_INVALID", "input", actor, workspaceId, write, null, null);
      throw new WorkspaceAccessError("WORKSPACE_ID_INVALID");
    }

    const [workspace, explicit] = await Promise.all([
      this.workspaces.getById(actor.organizationId, id),
      this.memberships.get(id, actor.userId),
    ]);
    const result = this.resolver.resolve({ actorId: actor.userId, organizationAvailable: true, organizationId: actor.organizationId, organizationDefaultWorkspaceId: actor.organizationDefaultWorkspaceId, organizationRole: actor.organizationRole, workspace, explicitMembership: explicit, write });
    if (result.allowed && workspace && result.role) return { workspace, role: result.role };

    // A write blocked purely by lifecycle is a different situation from "you
    // cannot see this": the actor already has read access, so telling them the
    // Workspace is archived is both safe and the only actionable answer. The
    // resolver only reports this reason after access has been established.
    if (result.reason === "lifecycle_restricted" && workspace) {
      this.warn("WORKSPACE_ARCHIVED", "lifecycle", actor, id, write, workspace.lifecycleState, explicit);
      throw new WorkspaceLifecycleError(workspace.lifecycleState);
    }
    const code = workspace ? "WORKSPACE_ACCESS_DENIED" : "WORKSPACE_NOT_FOUND";
    this.warn(code, result.reason, actor, id, write, workspace?.lifecycleState ?? null, explicit);
    throw new WorkspaceAccessError(code);
  }

  /**
   * One structured line per refused Workspace lookup.
   *
   * Ids only — no email, no session token, no cookie, no document content. The
   * actor id is the internal cuid the audit log already stores, which is what
   * makes a support report traceable without carrying personal data into logs.
   */
  private warn(
    category: string,
    stage: string,
    actor: ActorContext,
    workspaceId: string,
    write: boolean,
    lifecycleState: string | null,
    membership: { revokedAt: Date | null } | null,
  ): void {
    this.logger?.warn("workspace.access.denied", {
      operation: "WorkspaceService.get",
      category,
      stage,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      workspaceId,
      write,
      workspaceExists: lifecycleState !== null,
      lifecycleState,
      membershipExists: membership !== null,
      membershipRevoked: membership ? membership.revokedAt !== null : false,
    });
  }

  /**
   * Creates a Workspace that is immediately openable by its creator.
   *
   * The returned `Workspace.id` IS the navigation identity — the caller redirects
   * with it and `get` accepts it, with no name lookup or list scan in between.
   * The repository writes the Workspace and the creator's owner membership in one
   * transaction, so success here means `get` already succeeds.
   */
  async create(actor: ActorContext, input: { name: string; slug?: string; description?: string | null }) {
    const name = input.name.trim();
    const normalizedName = normalizeWorkspaceName(name);
    const slug = input.slug?.trim() || name;
    const normalizedSlug = normalizeWorkspaceSlug(slug);
    if (!name || !normalizedName || !normalizedSlug) throw new DomainError("Workspace name and slug are required.");
    if (actor.organizationRole !== "owner" && actor.organizationRole !== "admin") throw new DomainError("Workspace creation is not permitted.");
    return this.workspaces.create({ organizationId: actor.organizationId, name, normalizedName, slug, normalizedSlug, description: input.description ?? null, createdById: actor.userId });
  }

  async update(actor: ActorContext, workspaceId: string, input: { name?: string; slug?: string; description?: string | null; revision: number }) {
    await this.get(actor, workspaceId, true);
    const data: any = { revision: input.revision };
    if (input.name !== undefined) { data.name = input.name.trim(); data.normalizedName = normalizeWorkspaceName(data.name); }
    if (input.slug !== undefined) { data.slug = input.slug.trim(); data.normalizedSlug = normalizeWorkspaceSlug(data.slug); }
    if (input.description !== undefined) data.description = input.description;
    return this.workspaces.update(actor.organizationId, workspaceId, data);
  }

  /**
   * Archives, trashes or restores a Workspace.
   *
   * Authorized as a READ plus the owner/org-admin gate below, deliberately not as
   * a write: a write-intent check refuses any non-active Workspace, which made
   * restore impossible — the one operation that only ever applies to an archived
   * Workspace was the one the lifecycle guard blocked.
   */
  async setLifecycle(actor: ActorContext, workspaceId: string, state: WorkspaceLifecycleState) {
    const access = await this.get(actor, workspaceId, false);
    if (access.role !== "owner" && actor.organizationRole !== "admin") throw new DomainError("Workspace lifecycle changes are not permitted.");
    return this.workspaces.setLifecycle(actor.organizationId, workspaceId, state, actor.userId);
  }

  async provisionDefault(actor: { userId: string; organizationId: string; role: Role }) {
    return this.prisma.$transaction(async (tx) => {
      const organization = await tx.organization.findUnique({ where: { id: actor.organizationId } });
      if (!organization) throw new NotFoundError("Organization not found.");
      if (organization.defaultWorkspaceId) {
        const existing = await tx.workspace.findFirst({ where: { id: organization.defaultWorkspaceId, organizationId: organization.id } });
        if (existing) return existing;
      }
      const base = normalizeWorkspaceName(`${organization.name} Workspace`);
      const slug = normalizeWorkspaceSlug(`${organization.slug}-workspace`);
      const existing = await tx.workspace.findFirst({ where: { organizationId: organization.id, normalizedSlug: slug } });
      const workspace = existing ?? await tx.workspace.create({ data: { organizationId: organization.id, name: `${organization.name} Workspace`, normalizedName: base, slug, normalizedSlug: slug, description: "Default Workspace", lifecycleState: "active", createdById: actor.userId } });
      await tx.workspaceMembership.upsert({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: actor.userId } }, create: { workspaceId: workspace.id, userId: actor.userId, role: "owner", createdById: actor.userId }, update: {} });
      await tx.organization.update({ where: { id: organization.id }, data: { defaultWorkspaceId: workspace.id } });
      return workspace;
    });
  }
}
