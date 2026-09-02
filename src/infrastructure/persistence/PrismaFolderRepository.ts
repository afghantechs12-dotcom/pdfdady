import { PrismaClient } from "@prisma/client";
import type { Folder, FolderLifecycleState } from "@/src/domain/entities/Folder";
import type { CreateFolderInput, FolderListQuery, FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";

function toDomain(row: any): Folder {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    parentId: row.parentId,
    name: row.name,
    normalizedName: row.normalizedName,
    orderKey: row.orderKey,
    lifecycleState: row.lifecycleState,
    createdById: row.createdById,
    revision: row.revision,
    depth: row.depth,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    trashedAt: row.trashedAt,
    archivedById: row.archivedById,
    trashedById: row.trashedById,
  };
}

export class PrismaFolderRepository implements FolderRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: FolderListQuery): Promise<{ items: Folder[]; nextCursor: string | null }> {
    const where: any = { workspaceId: query.workspaceId };
    if (query.lifecycleState) where.lifecycleState = query.lifecycleState;
    if ("parentId" in query) where.parentId = query.parentId ?? null;
    if ("projectId" in query && query.projectId !== undefined) where.projectId = query.projectId;

    const rows = await this.prisma.folder.findMany({
      where,
      orderBy: [{ orderKey: "asc" }, { id: "asc" }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toDomain);
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async getById(workspaceId: string, folderId: string): Promise<Folder | null> {
    const row = await this.prisma.folder.findFirst({ where: { id: folderId, workspaceId } });
    return row ? toDomain(row) : null;
  }

  async create(input: CreateFolderInput): Promise<Folder> {
    return toDomain(
      await this.prisma.folder.create({
        data: {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          projectId: input.projectId ?? null,
          parentId: input.parentId ?? null,
          name: input.name,
          normalizedName: input.normalizedName,
          orderKey: input.orderKey,
          depth: input.depth,
          createdById: input.createdById,
        },
      }),
    );
  }

  async update(
    workspaceId: string,
    folderId: string,
    data: Partial<Pick<Folder, "name" | "normalizedName" | "orderKey" | "projectId" | "parentId" | "depth" | "revision">>,
  ): Promise<Folder> {
    const result = await this.prisma.folder.updateMany({
      where: { id: folderId, workspaceId, ...(data.revision ? { revision: data.revision } : {}) },
      data: { ...data, revision: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error("Folder update conflict.");
    return toDomain(await this.prisma.folder.findFirstOrThrow({ where: { id: folderId, workspaceId } }));
  }

  async setLifecycle(workspaceId: string, folderId: string, state: FolderLifecycleState, actorId: string): Promise<Folder> {
    const data =
      state === "archived"
        ? { lifecycleState: state, archivedAt: new Date(), archivedById: actorId, revision: { increment: 1 } }
        : state === "active"
          ? { lifecycleState: state, archivedAt: null, archivedById: null, revision: { increment: 1 } }
          : { lifecycleState: state, trashedAt: new Date(), trashedById: actorId, revision: { increment: 1 } };
    await this.prisma.folder.updateMany({ where: { id: folderId, workspaceId }, data });
    return toDomain(await this.prisma.folder.findFirstOrThrow({ where: { id: folderId, workspaceId } }));
  }

  async getAncestorIds(workspaceId: string, folderId: string): Promise<string[]> {
    const ancestors: string[] = [];
    let current = await this.prisma.folder.findFirst({ where: { id: folderId, workspaceId }, select: { parentId: true } });
    while (current?.parentId) {
      ancestors.unshift(current.parentId);
      current = await this.prisma.folder.findFirst({ where: { id: current.parentId, workspaceId }, select: { parentId: true } });
    }
    return ancestors;
  }

  async getDescendantIds(workspaceId: string, folderId: string): Promise<string[]> {
    const result: string[] = [];
    const queue = [folderId];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const children = await this.prisma.folder.findMany({
        where: { workspaceId, parentId, lifecycleState: "active" },
        select: { id: true },
      });
      for (const child of children) {
        result.push(child.id);
        queue.push(child.id);
      }
    }
    return result;
  }

  async maxOrderKey(workspaceId: string, parentId: string | null): Promise<string | null> {
    const row = await this.prisma.folder.findFirst({
      where: { workspaceId, parentId, lifecycleState: "active" },
      orderBy: [{ orderKey: "desc" }, { id: "desc" }],
      select: { orderKey: true },
    });
    return row?.orderKey ?? null;
  }
}
