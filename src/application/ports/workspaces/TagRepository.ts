import type { Tag } from "@/src/domain/entities/Tag";

export interface CreateTagInput {
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  color: string | null;
  createdById: string;
}

export interface TagListQuery {
  workspaceId: string;
  limit: number;
  /** Exclusive cursor: return tags ordered after this normalized name. */
  afterNormalizedName?: string;
}

export interface UpdateTagInput {
  name?: string;
  normalizedName?: string;
  color?: string | null;
}

/**
 * Workspace-scoped tag persistence.
 *
 * Every method takes `workspaceId` first and never addresses a tag by id alone,
 * so a caller holding an id from another tenant reads and writes nothing. There
 * is no "find by id across workspaces" method: its absence is what enforces the
 * scoping, rather than a check each call site has to remember.
 */
export interface TagRepository {
  /**
   * Inserts a tag. Implementations must let the Workspace-scoped uniqueness
   * constraint on `normalizedName` reject a duplicate rather than checking first
   * and inserting after — a check-then-insert races and admits two tags that
   * normalize alike.
   */
  create(input: CreateTagInput): Promise<Tag>;

  getById(workspaceId: string, tagId: string): Promise<Tag | null>;

  /** Resolves a tag by its normalized form within one Workspace. */
  getByNormalizedName(workspaceId: string, normalizedName: string): Promise<Tag | null>;

  /** Ordered by normalized name, bounded by the domain listing cap. */
  list(query: TagListQuery): Promise<Tag[]>;

  /** Resolves several tags at once, dropping any that are not in this Workspace. */
  getManyByIds(workspaceId: string, tagIds: string[]): Promise<Tag[]>;

  /**
   * Compare-and-swap on `revision`. Returns null when no row matched, which is
   * how a stale revision and a missing tag are reported without distinguishing
   * them to the caller.
   */
  update(
    workspaceId: string,
    tagId: string,
    expectedRevision: number,
    data: UpdateTagInput,
  ): Promise<Tag | null>;

  /** Deletes a tag. Returns false when nothing matched in this Workspace. */
  delete(workspaceId: string, tagId: string): Promise<boolean>;

  /** How many tags a Workspace holds. Used for bounds and for empty-state UI. */
  countForWorkspace(workspaceId: string): Promise<number>;
}
