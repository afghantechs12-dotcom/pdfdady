import type { PrismaClient, SmartCollection as SmartCollectionRow } from "@prisma/client";
import type { SmartCollection } from "@/src/domain/entities/SmartCollection";
import {
  SMART_COLLECTION_LIMITS as L,
  collectionListLimit,
  emptyQuery,
  parseStoredSmartCollectionQuery,
} from "@/src/domain/entities/SmartCollection";
import type {
  CreateSmartCollectionInput,
  SmartCollectionListQuery,
  SmartCollectionRepository,
  UpdateSmartCollectionInput,
} from "@/src/application/ports/workspaces/SmartCollectionRepository";

/**
 * The stored definition is an opaque String (SQLite portability), so it is
 * re-parsed through the allowlisted grammar on the way out. A row that cannot be
 * parsed — corrupt, over-long, or written under a grammar version this build
 * does not know — degrades to a query that matches *nothing* and is flagged.
 * Degrading to "match everything" would turn an unreadable row into a listing of
 * every document in the Workspace.
 */
function toDomain(row: SmartCollectionRow): SmartCollection {
  const query = parseStoredSmartCollectionQuery(row.query);
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    name: row.name,
    normalizedName: row.normalizedName,
    queryVersion: row.queryVersion,
    query: query ?? emptyQuery(),
    queryDegraded: query === null,
    createdById: row.createdById,
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    // Copied, not aliased: a caller mutating these Dates must not reach the row.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed SmartCollectionRepository.
 *
 * Every predicate carries `workspaceId`. There is no persisted membership to
 * maintain here: the collection row holds only its definition, and membership is
 * evaluated against live document and tag data by the service.
 */
export class PrismaSmartCollectionRepository implements SmartCollectionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateSmartCollectionInput): Promise<SmartCollection> {
    const row = await this.prisma.smartCollection.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        name: input.name.slice(0, L.maxNameLength),
        normalizedName: input.normalizedName.slice(0, L.maxNameLength),
        queryVersion: input.queryVersion,
        query: input.queryJson,
        createdById: input.createdById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, collectionId: string): Promise<SmartCollection | null> {
    // Scoped by workspace as well as id, so an id belonging to another tenant
    // reads as missing rather than as forbidden.
    const row = await this.prisma.smartCollection.findFirst({
      where: { id: collectionId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async getByNormalizedName(
    workspaceId: string,
    normalizedName: string,
  ): Promise<SmartCollection | null> {
    const row = await this.prisma.smartCollection.findFirst({
      where: { workspaceId, normalizedName },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: SmartCollectionListQuery): Promise<SmartCollection[]> {
    const rows = await this.prisma.smartCollection.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.afterNormalizedName === undefined
          ? {}
          : { normalizedName: { gt: query.afterNormalizedName } }),
      },
      orderBy: { normalizedName: "asc" },
      take: collectionListLimit(query.limit),
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    collectionId: string,
    expectedRevision: number,
    data: UpdateSmartCollectionInput,
  ): Promise<SmartCollection | null> {
    const result = await this.prisma.smartCollection.updateMany({
      where: { id: collectionId, workspaceId, revision: expectedRevision },
      data: {
        ...(data.name === undefined ? {} : { name: data.name.slice(0, L.maxNameLength) }),
        ...(data.normalizedName === undefined
          ? {}
          : { normalizedName: data.normalizedName.slice(0, L.maxNameLength) }),
        ...(data.queryVersion === undefined ? {} : { queryVersion: data.queryVersion }),
        ...(data.queryJson === undefined ? {} : { query: data.queryJson }),
        revision: { increment: 1 },
      },
    });
    // The revision was part of the match, so a stale one updates nothing and is
    // reported as null — indistinguishable from a missing collection, which is
    // what keeps a probe from confirming existence.
    if (result.count === 0) return null;
    return this.getById(workspaceId, collectionId);
  }

  async delete(workspaceId: string, collectionId: string): Promise<boolean> {
    const result = await this.prisma.smartCollection.deleteMany({
      where: { id: collectionId, workspaceId },
    });
    return result.count > 0;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.prisma.smartCollection.count({ where: { workspaceId } });
  }
}
