import { Prisma, PrismaClient } from "@prisma/client";
import type { Workspace, WorkspaceLifecycleState } from "@/src/domain/entities/Workspace";
import type { CreateWorkspaceInput, WorkspaceListQuery, WorkspaceRepository } from "@/src/application/ports/workspaces/WorkspaceRepository";
import { DomainError } from "@/src/domain/errors";

function toDomain(row: any): Workspace {
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    normalizedName: row.normalizedName,
    slug: row.slug,
    normalizedSlug: row.normalizedSlug,
    description: row.description,
    lifecycleState: row.lifecycleState as WorkspaceLifecycleState,
    createdById: row.createdById,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    trashedAt: row.trashedAt,
    archivedById: row.archivedById,
    trashedById: row.trashedById,
  };
}

export class PrismaWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Lists only the Workspaces this actor can actually open.
   *
   * Two queries, never N+1: one for the actor's active memberships, one for the
   * Workspaces. `Workspace` declares no Prisma relation to
   * `WorkspaceMembership` (the model is relation-free by design, so every
   * predicate can be Workspace-scoped without a join), so an `id in (...)`
   * filter is the join. Memberships are not organization-scoped — that table has
   * no organizationId — but the Workspace query is, so a membership pointing at
   * another tenant's Workspace cannot widen this result.
   *
   * ponytail: the id set is materialized in memory; if an organization ever
   * holds enough Workspaces per user for that to matter, this becomes a raw
   * join.
   */
  async list(query: WorkspaceListQuery): Promise<{ items: Workspace[]; nextCursor: string | null }> {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { userId: query.actorUserId, revokedAt: null },
      select: { workspaceId: true },
    });
    const accessible = new Set(memberships.map((row) => row.workspaceId));
    if (query.inheritedWorkspaceId) accessible.add(query.inheritedWorkspaceId);
    if (accessible.size === 0) return { items: [], nextCursor: null };

    const rows = await this.prisma.workspace.findMany({
      where: {
        organizationId: query.organizationId,
        id: { in: [...accessible] },
        ...(query.lifecycleState ? { lifecycleState: query.lifecycleState } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toDomain);
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async getById(organizationId: string, workspaceId: string): Promise<Workspace | null> {
    const row = await this.prisma.workspace.findFirst({ where: { id: workspaceId, organizationId } });
    return row ? toDomain(row) : null;
  }

  /**
   * Workspace row + creator's owner membership, in one transaction.
   *
   * This is THE fix for the launch-blocking defect: `create` used to write the
   * Workspace row alone, so the creator had no membership and
   * `WorkspaceService.get` — which requires an explicit membership or the
   * organization's default Workspace — refused the Workspace one redirect later
   * with "Workspace not found.". The two writes are one operation now, so a
   * returned Workspace is always already openable by `createdById`, and a
   * failed membership insert rolls the Workspace back rather than leaving a
   * half-usable row behind.
   */
  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({ data: { ...input, description: input.description ?? null } });
        await tx.workspaceMembership.create({
          data: { workspaceId: workspace.id, userId: input.createdById, role: "owner", createdById: input.createdById },
        });
        return workspace;
      });
      return toDomain(row);
    } catch (error) {
      // A duplicate name/slug is a user mistake, not a server fault: the
      // organization-scoped unique indexes used to surface as a raw Prisma
      // failure and a 500 error page.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new DomainError("A Workspace with this name already exists in this organization.");
      }
      throw error;
    }
  }

  async update(organizationId: string, workspaceId: string, data: Partial<Pick<Workspace, "name" | "normalizedName" | "slug" | "normalizedSlug" | "description" | "revision">>): Promise<Workspace> {
    const row = await this.prisma.workspace.updateMany({
      where: { id: workspaceId, organizationId, ...(data.revision ? { revision: data.revision } : {}) },
      data: { ...data, revision: { increment: 1 } },
    });
    if (row.count !== 1) throw new Error("Workspace update conflict.");
    return toDomain(await this.prisma.workspace.findFirstOrThrow({ where: { id: workspaceId, organizationId } }));
  }

  async setLifecycle(organizationId: string, workspaceId: string, state: WorkspaceLifecycleState, actorId: string): Promise<Workspace> {
    const data = state === "archived" ? { lifecycleState: state, archivedAt: new Date(), archivedById: actorId, revision: { increment: 1 } } : state === "active" ? { lifecycleState: state, archivedAt: null, archivedById: null, revision: { increment: 1 } } : { lifecycleState: state, trashedAt: new Date(), trashedById: actorId, revision: { increment: 1 } };
    await this.prisma.workspace.updateMany({ where: { id: workspaceId, organizationId }, data });
    return toDomain(await this.prisma.workspace.findFirstOrThrow({ where: { id: workspaceId, organizationId } }));
  }
}
