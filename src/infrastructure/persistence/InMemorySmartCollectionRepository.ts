import type { SmartCollection } from "@/src/domain/entities/SmartCollection";
import {
  SMART_COLLECTION_LIMITS,
  collectionListLimit,
  parseStoredSmartCollectionQuery,
} from "@/src/domain/entities/SmartCollection";
import type {
  CreateSmartCollectionInput,
  SmartCollectionListQuery,
  SmartCollectionRepository,
  UpdateSmartCollectionInput,
} from "@/src/application/ports/workspaces/SmartCollectionRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-collection-${counter}`;
}

function uniqueViolation(): Error {
  const error = new Error(
    "Unique constraint failed on the fields: (`workspaceId`,`normalizedName`)",
  );
  (error as Error & { code: string }).code = "P2002";
  return error;
}

interface StoredCollection {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  queryVersion: number;
  query: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory SmartCollectionRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter: Workspace-scoped predicates, the
 * (workspaceId, normalizedName) unique constraint, compare-and-swap updates,
 * and bounded listings. The definition is held serialized and re-parsed on the
 * way out, so an unreadable row degrades exactly as the database-backed
 * adapter degrades it.
 */
export class InMemorySmartCollectionRepository implements SmartCollectionRepository {
  private readonly rows = new Map<string, StoredCollection>();

  private toDomain(row: StoredCollection): SmartCollection {
    const query = parseStoredSmartCollectionQuery(row.query);
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      name: row.name,
      normalizedName: row.normalizedName,
      queryVersion: row.queryVersion,
      query: query ?? {
        version: SMART_COLLECTION_LIMITS.queryVersion,
        root: { mode: "all", conditions: [] },
      },
      queryDegraded: query === null,
      createdById: row.createdById,
      revision: row.revision,
      // Copied, not aliased: a caller mutating these must not reach stored state.
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private forWorkspace(workspaceId: string): StoredCollection[] {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async create(input: CreateSmartCollectionInput): Promise<SmartCollection> {
    const duplicate = this.forWorkspace(input.workspaceId).some(
      (row) => row.normalizedName === input.normalizedName,
    );
    if (duplicate) throw uniqueViolation();

    const now = new Date();
    const row: StoredCollection = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      name: input.name,
      normalizedName: input.normalizedName,
      queryVersion: input.queryVersion,
      query: input.queryJson,
      createdById: input.createdById,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, collectionId: string): Promise<SmartCollection | null> {
    const row = this.rows.get(collectionId);
    // Scoped by workspace, not by id alone: an id from another tenant reads as
    // missing rather than as forbidden.
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async getByNormalizedName(
    workspaceId: string,
    normalizedName: string,
  ): Promise<SmartCollection | null> {
    const row = this.forWorkspace(workspaceId).find(
      (candidate) => candidate.normalizedName === normalizedName,
    );
    return row ? this.toDomain(row) : null;
  }

  async list(query: SmartCollectionListQuery): Promise<SmartCollection[]> {
    return this.forWorkspace(query.workspaceId)
      .filter((row) =>
        query.afterNormalizedName === undefined
          ? true
          : row.normalizedName > query.afterNormalizedName,
      )
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName))
      .slice(0, collectionListLimit(query.limit))
      .map((row) => this.toDomain(row));
  }

  async update(
    workspaceId: string,
    collectionId: string,
    expectedRevision: number,
    data: UpdateSmartCollectionInput,
  ): Promise<SmartCollection | null> {
    const row = this.rows.get(collectionId);
    // Revision is part of the match, not checked after: a stale revision finds
    // no row, which is the same outcome the database's updateMany produces.
    if (!row || row.workspaceId !== workspaceId || row.revision !== expectedRevision) return null;

    if (data.normalizedName !== undefined && data.normalizedName !== row.normalizedName) {
      const duplicate = this.forWorkspace(workspaceId).some(
        (candidate) => candidate.id !== collectionId && candidate.normalizedName === data.normalizedName,
      );
      if (duplicate) throw uniqueViolation();
    }

    if (data.name !== undefined) row.name = data.name;
    if (data.normalizedName !== undefined) row.normalizedName = data.normalizedName;
    if (data.queryVersion !== undefined) row.queryVersion = data.queryVersion;
    if (data.queryJson !== undefined) row.query = data.queryJson;
    row.revision += 1;
    row.updatedAt = new Date();
    return this.toDomain(row);
  }

  async delete(workspaceId: string, collectionId: string): Promise<boolean> {
    const row = this.rows.get(collectionId);
    if (!row || row.workspaceId !== workspaceId) return false;
    this.rows.delete(collectionId);
    return true;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.forWorkspace(workspaceId).length;
  }
}
