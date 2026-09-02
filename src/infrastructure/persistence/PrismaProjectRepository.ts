import { PrismaClient } from "@prisma/client";
import type { Project, ProjectLifecycleState } from "@/src/domain/entities/Project";
import type { CreateProjectInput, ProjectListQuery, ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";

function toDomain(row: any): Project {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    name: row.name,
    normalizedName: row.normalizedName,
    slug: row.slug,
    normalizedSlug: row.normalizedSlug,
    description: row.description,
    status: row.status,
    lifecycleState: row.lifecycleState,
    orderKey: row.orderKey,
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

export class PrismaProjectRepository implements ProjectRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: ProjectListQuery): Promise<{ items: Project[]; nextCursor: string | null }> {
    const rows = await this.prisma.project.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.lifecycleState ? { lifecycleState: query.lifecycleState } : {}),
      },
      orderBy: [{ orderKey: "asc" }, { id: "asc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toDomain);
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async getById(workspaceId: string, projectId: string): Promise<Project | null> {
    const row = await this.prisma.project.findFirst({ where: { id: projectId, workspaceId } });
    return row ? toDomain(row) : null;
  }

  async create(input: CreateProjectInput): Promise<Project> {
    return toDomain(
      await this.prisma.project.create({
        data: {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          name: input.name,
          normalizedName: input.normalizedName,
          slug: input.slug,
          normalizedSlug: input.normalizedSlug,
          description: input.description ?? null,
          orderKey: input.orderKey,
          createdById: input.createdById,
        },
      }),
    );
  }

  async update(
    workspaceId: string,
    projectId: string,
    data: Partial<Pick<Project, "name" | "normalizedName" | "slug" | "normalizedSlug" | "description" | "status" | "orderKey" | "revision">>,
  ): Promise<Project> {
    const result = await this.prisma.project.updateMany({
      where: { id: projectId, workspaceId, ...(data.revision ? { revision: data.revision } : {}) },
      data: { ...data, revision: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error("Project update conflict.");
    return toDomain(await this.prisma.project.findFirstOrThrow({ where: { id: projectId, workspaceId } }));
  }

  async setLifecycle(workspaceId: string, projectId: string, state: ProjectLifecycleState, actorId: string): Promise<Project> {
    const data =
      state === "archived"
        ? { lifecycleState: state, archivedAt: new Date(), archivedById: actorId, revision: { increment: 1 } }
        : state === "active"
          ? { lifecycleState: state, archivedAt: null, archivedById: null, revision: { increment: 1 } }
          : { lifecycleState: state, trashedAt: new Date(), trashedById: actorId, revision: { increment: 1 } };
    await this.prisma.project.updateMany({ where: { id: projectId, workspaceId }, data });
    return toDomain(await this.prisma.project.findFirstOrThrow({ where: { id: projectId, workspaceId } }));
  }

  async maxOrderKey(workspaceId: string): Promise<string | null> {
    const row = await this.prisma.project.findFirst({
      where: { workspaceId, lifecycleState: "active" },
      orderBy: [{ orderKey: "desc" }, { id: "desc" }],
      select: { orderKey: true },
    });
    return row?.orderKey ?? null;
  }
}
