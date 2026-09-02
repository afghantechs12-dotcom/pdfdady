import type { PrismaClient, SearchDocument as SearchDocumentRow } from "@prisma/client";
import type { SearchDocument, SearchIndexState } from "@/src/domain/entities/SearchIndex";
import {
  SEARCH_LIMITS,
  isSearchIndexState,
  isBoundedSearchId,
} from "@/src/domain/entities/SearchIndex";
import type {
  SearchDocumentListQuery,
  SearchDocumentRepository,
  UpsertSearchDocumentInput,
} from "@/src/application/ports/workspaces/SearchDocumentRepository";

function toDomain(row: SearchDocumentRow): SearchDocument {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    versionId: row.versionId,
    // A row written by a newer build cannot widen the state contract; an
    // unknown state is unusable and degrades to "stale", which fails closed by
    // refusing to present the entry as current.
    state: isSearchIndexState(row.state) ? row.state : "stale",
    schemaVersion: row.schemaVersion,
    checksum: row.checksum.slice(0, SEARCH_LIMITS.maxChecksumLength),
    chunkCount:
      Number.isFinite(row.chunkCount) && row.chunkCount >= 0
        ? Math.trunc(row.chunkCount)
        : 0,
    error: row.error === null ? null : row.error.slice(0, SEARCH_LIMITS.maxErrorLength),
    indexedAt: row.indexedAt === null ? null : new Date(row.indexedAt),
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    // Copied, not aliased: a caller mutating these Dates must not reach the row.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed SearchDocumentRepository.
 *
 * Every predicate carries `workspaceId`, so an entry from another Workspace
 * reads as missing rather than as forbidden — an index row must never confirm a
 * document's existence to someone who cannot see the document. The
 * (workspaceId, documentId) unique index is what makes `upsert` converge under
 * duplicate delivery instead of colliding.
 */
export class PrismaSearchDocumentRepository implements SearchDocumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertSearchDocumentInput): Promise<SearchDocument> {
    const row = await this.prisma.searchDocument.upsert({
      where: {
        workspaceId_documentId: {
          workspaceId: input.workspaceId,
          documentId: input.documentId,
        },
      },
      create: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        versionId: input.versionId,
        state: input.state,
        schemaVersion: input.schemaVersion,
        checksum: input.checksum.slice(0, SEARCH_LIMITS.maxChecksumLength),
        error: input.error ?? null,
      },
      update: {
        versionId: input.versionId,
        state: input.state,
        schemaVersion: input.schemaVersion,
        checksum: input.checksum.slice(0, SEARCH_LIMITS.maxChecksumLength),
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    });
    return toDomain(row);
  }

  async getByDocumentId(
    workspaceId: string,
    documentId: string,
  ): Promise<SearchDocument | null> {
    const row = await this.prisma.searchDocument.findUnique({
      where: { workspaceId_documentId: { workspaceId, documentId } },
    });
    return row ? toDomain(row) : null;
  }

  async getById(workspaceId: string, searchDocumentId: string): Promise<SearchDocument | null> {
    // Scoped by Workspace as well as id, so an entry belonging to another
    // tenant reads as missing.
    const row = await this.prisma.searchDocument.findFirst({
      where: { id: searchDocumentId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: SearchDocumentListQuery): Promise<SearchDocument[]> {
    const rows = await this.prisma.searchDocument.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.state === undefined ? {} : { state: query.state }),
      },
      orderBy: { documentId: "asc" },
      take: Math.min(Math.trunc(query.limit), 1000),
    });
    return rows.map(toDomain);
  }

  async listForDocuments(
    workspaceId: string,
    documentIds: string[],
  ): Promise<SearchDocument[]> {
    if (documentIds.length === 0) return [];
    const rows = await this.prisma.searchDocument.findMany({
      where: {
        workspaceId,
        documentId: { in: documentIds.slice(0, 1000) },
      },
    });
    return rows.map(toDomain);
  }

  async setState(
    workspaceId: string,
    searchDocumentId: string,
    expectedRevision: number,
    state: SearchIndexState,
    error?: string | null,
  ): Promise<SearchDocument | null> {
    const result = await this.prisma.searchDocument.updateMany({
      where: { id: searchDocumentId, workspaceId, revision: expectedRevision },
      data: {
        state,
        ...(error === undefined ? {} : { error }),
        revision: { increment: 1 },
      },
    });
    // updateMany returns a count, not the row: the mutation is compare-and-swap
    // and the fresh row is re-read so the caller gets its current state.
    if (result.count === 0) return null;
    return this.getById(workspaceId, searchDocumentId);
  }

  async markIndexed(
    workspaceId: string,
    searchDocumentId: string,
    chunkCount: number,
    checksum: string,
  ): Promise<SearchDocument | null> {
    const result = await this.prisma.searchDocument.updateMany({
      where: { id: searchDocumentId, workspaceId },
      data: {
        state: "indexed",
        chunkCount: Math.max(0, Math.trunc(chunkCount)),
        checksum: checksum.slice(0, SEARCH_LIMITS.maxChecksumLength),
        error: null,
        indexedAt: new Date(),
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, searchDocumentId);
  }

  async delete(workspaceId: string, documentId: string): Promise<boolean> {
    const result = await this.prisma.searchDocument.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count > 0;
  }

  async countForWorkspace(workspaceId: string, state?: SearchIndexState): Promise<number> {
    return this.prisma.searchDocument.count({
      where: {
        workspaceId,
        ...(state === undefined ? {} : { state }),
      },
    });
  }

  async lastIndexedAt(workspaceId: string): Promise<Date | null> {
    const rows = await this.prisma.searchDocument.findMany({
      where: { workspaceId, indexedAt: { not: null } },
      orderBy: { indexedAt: "desc" },
      take: 1,
    });
    const latest = rows[0]?.indexedAt ?? null;
    return latest === null ? null : new Date(latest);
  }
}

/** Bounds a document id before it reaches a predicate. */
export function boundedSearchDocumentId(value: unknown): string | null {
  if (!isBoundedSearchId(value)) return null;
  return value.trim();
}
