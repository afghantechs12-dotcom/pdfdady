import type { Tag } from "@/src/domain/entities/Tag";
import { tagListLimit } from "@/src/domain/entities/Tag";
import type {
  CreateTagInput,
  TagListQuery,
  TagRepository,
  UpdateTagInput,
} from "@/src/application/ports/workspaces/TagRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-tag-${counter}`;
}

/** Prisma's unique-constraint error, reproduced so both adapters fail alike. */
function uniqueViolation(): Error {
  const error = new Error(
    "Unique constraint failed on the fields: (`workspaceId`,`normalizedName`)",
  );
  (error as Error & { code: string }).code = "P2002";
  return error;
}

interface StoredTag {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  color: string | null;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory TagRepository — for tests and as a zero-dependency fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its unique constraint on
 * (workspaceId, normalizedName), its compare-and-swap update, and its bounded
 * listings. Rows are copied on the way out so a caller mutating a returned tag
 * cannot reach stored state — the database-backed adapter cannot be reached
 * that way either, and a test that passes against one must pass against both.
 */
export class InMemoryTagRepository implements TagRepository {
  private readonly rows = new Map<string, StoredTag>();

  private toDomain(row: StoredTag): Tag {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      name: row.name,
      normalizedName: row.normalizedName,
      color: row.color,
      createdById: row.createdById,
      revision: row.revision,
      // Copied, not aliased: a caller mutating these must not reach stored state.
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private forWorkspace(workspaceId: string): StoredTag[] {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async create(input: CreateTagInput): Promise<Tag> {
    const duplicate = this.forWorkspace(input.workspaceId).some(
      (row) => row.normalizedName === input.normalizedName,
    );
    // The constraint rejects, exactly as the database would; the service does
    // not pre-check, because a check-then-insert races.
    if (duplicate) throw uniqueViolation();

    const now = new Date();
    const row: StoredTag = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      name: input.name,
      normalizedName: input.normalizedName,
      color: input.color,
      createdById: input.createdById,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, tagId: string): Promise<Tag | null> {
    const row = this.rows.get(tagId);
    // Scoped by workspace, not by id alone: an id from another tenant reads as
    // missing rather than as forbidden.
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async getByNormalizedName(workspaceId: string, normalizedName: string): Promise<Tag | null> {
    const row = this.forWorkspace(workspaceId).find(
      (candidate) => candidate.normalizedName === normalizedName,
    );
    return row ? this.toDomain(row) : null;
  }

  async list(query: TagListQuery): Promise<Tag[]> {
    return this.forWorkspace(query.workspaceId)
      .filter((row) =>
        query.afterNormalizedName === undefined
          ? true
          : row.normalizedName > query.afterNormalizedName,
      )
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))
      .slice(0, tagListLimit(query.limit))
      .map((row) => this.toDomain(row));
  }

  async getManyByIds(workspaceId: string, tagIds: string[]): Promise<Tag[]> {
    const wanted = new Set(tagIds);
    return this.forWorkspace(workspaceId)
      .filter((row) => wanted.has(row.id))
      .map((row) => this.toDomain(row));
  }

  async update(
    workspaceId: string,
    tagId: string,
    expectedRevision: number,
    data: UpdateTagInput,
  ): Promise<Tag | null> {
    const row = this.rows.get(tagId);
    // Revision is part of the match, not checked after: a stale revision finds
    // no row, which is the same outcome the database's updateMany produces.
    if (!row || row.workspaceId !== workspaceId || row.revision !== expectedRevision) return null;

    if (data.normalizedName !== undefined && data.normalizedName !== row.normalizedName) {
      const duplicate = this.forWorkspace(workspaceId).some(
        (candidate) => candidate.id !== tagId && candidate.normalizedName === data.normalizedName,
      );
      if (duplicate) throw uniqueViolation();
    }

    if (data.name !== undefined) row.name = data.name;
    if (data.normalizedName !== undefined) row.normalizedName = data.normalizedName;
    if (data.color !== undefined) row.color = data.color;
    row.revision += 1;
    row.updatedAt = new Date();
    return this.toDomain(row);
  }

  async delete(workspaceId: string, tagId: string): Promise<boolean> {
    const row = this.rows.get(tagId);
    if (!row || row.workspaceId !== workspaceId) return false;
    this.rows.delete(tagId);
    return true;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.forWorkspace(workspaceId).length;
  }
}
