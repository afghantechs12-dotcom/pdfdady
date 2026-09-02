import type { PrismaClient, Tag as TagRow } from "@prisma/client";
import type { Tag } from "@/src/domain/entities/Tag";
import { TAG_LIMITS as L, tagListLimit } from "@/src/domain/entities/Tag";
import type {
  CreateTagInput,
  TagListQuery,
  TagRepository,
  UpdateTagInput,
} from "@/src/application/ports/workspaces/TagRepository";

function toDomain(row: TagRow): Tag {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    name: row.name,
    normalizedName: row.normalizedName,
    color: row.color === null ? null : row.color.slice(0, L.maxColorLength),
    createdById: row.createdById,
    // A row written by a newer build cannot widen the counter contract; a
    // non-finite or negative revision is unusable and degrades to 1.
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    // Copied, not aliased: a caller mutating these Dates must not reach the row.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed TagRepository.
 *
 * Every predicate carries `workspaceId`, so a cross-Workspace read or write is
 * unreachable rather than merely unlikely. Duplicates are rejected by the
 * (workspaceId, normalizedName) unique index rather than by a check-then-insert,
 * which is what keeps creation safe under concurrency.
 */
export class PrismaTagRepository implements TagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateTagInput): Promise<Tag> {
    const row = await this.prisma.tag.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        name: input.name.slice(0, L.maxNameLength),
        normalizedName: input.normalizedName.slice(0, L.maxNameLength),
        color: input.color === null ? null : input.color.slice(0, L.maxColorLength),
        createdById: input.createdById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, tagId: string): Promise<Tag | null> {
    // Scoped by workspace as well as id, so an id belonging to another tenant
    // reads as missing rather than as forbidden.
    const row = await this.prisma.tag.findFirst({ where: { id: tagId, workspaceId } });
    return row ? toDomain(row) : null;
  }

  async getByNormalizedName(workspaceId: string, normalizedName: string): Promise<Tag | null> {
    const row = await this.prisma.tag.findFirst({ where: { workspaceId, normalizedName } });
    return row ? toDomain(row) : null;
  }

  async list(query: TagListQuery): Promise<Tag[]> {
    const rows = await this.prisma.tag.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.afterNormalizedName === undefined
          ? {}
          : { normalizedName: { gt: query.afterNormalizedName } }),
      },
      orderBy: { normalizedName: "asc" },
      take: tagListLimit(query.limit),
    });
    return rows.map(toDomain);
  }

  async getManyByIds(workspaceId: string, tagIds: string[]): Promise<Tag[]> {
    if (tagIds.length === 0) return [];
    const rows = await this.prisma.tag.findMany({
      where: { workspaceId, id: { in: tagIds.slice(0, 1000) } },
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    tagId: string,
    expectedRevision: number,
    data: UpdateTagInput,
  ): Promise<Tag | null> {
    const row = await this.prisma.tag.updateMany({
      where: { id: tagId, workspaceId, revision: expectedRevision },
      data: {
        ...(data.name === undefined ? {} : { name: data.name.slice(0, L.maxNameLength) }),
        ...(data.normalizedName === undefined
          ? {}
          : { normalizedName: data.normalizedName.slice(0, L.maxNameLength) }),
        ...(data.color === undefined ? {} : { color: data.color }),
        revision: { increment: 1 },
      },
    });
    // updateMany returns a count, not the row: the mutation is compare-and-swap
    // (the revision was part of the match) and the updated row is re-read so the
    // caller gets its fresh state.
    if (row.count === 0) return null;
    return this.getById(workspaceId, tagId);
  }

  async delete(workspaceId: string, tagId: string): Promise<boolean> {
    const result = await this.prisma.tag.deleteMany({ where: { id: tagId, workspaceId } });
    return result.count > 0;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.prisma.tag.count({ where: { workspaceId } });
  }
}
