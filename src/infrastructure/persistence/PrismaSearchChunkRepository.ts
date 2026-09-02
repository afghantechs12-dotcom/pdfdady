import type { PrismaClient, SearchChunk as SearchChunkRow } from "@prisma/client";
import type { SearchChunk } from "@/src/domain/entities/SearchIndex";
import {
  SEARCH_LIMITS,
  chunkListLimit,
  isChunkSourceType,
} from "@/src/domain/entities/SearchIndex";
import type {
  CreateSearchChunkInput,
  SearchChunkRepository,
} from "@/src/application/ports/workspaces/SearchChunkRepository";

function toDomain(row: SearchChunkRow): SearchChunk {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    searchDocumentId: row.searchDocumentId,
    documentId: row.documentId,
    ordinal:
      Number.isFinite(row.ordinal) && row.ordinal >= 0 ? Math.trunc(row.ordinal) : 0,
    // An unknown source type degrades to "text" rather than being surfaced: the
    // chunk's content is still valid, only its provenance label is unusable.
    sourceType: isChunkSourceType(row.sourceType) ? row.sourceType : "text",
    pageNumber:
      row.pageNumber === null || !Number.isFinite(row.pageNumber) || row.pageNumber < 1
        ? null
        : Math.trunc(row.pageNumber),
    text: row.text.slice(0, SEARCH_LIMITS.maxChunkTextLength),
    normalizedText: row.normalizedText.slice(0, SEARCH_LIMITS.maxChunkTextLength),
    createdAt: new Date(row.createdAt),
  };
}

/**
 * SQLite-backed SearchChunkRepository.
 *
 * Matching is `contains` on the normalized column — a bounded substring test,
 * never a user-supplied pattern, so no query can describe catastrophic
 * backtracking. Every predicate carries `workspaceId`, so a chunk from another
 * Workspace is unreachable rather than merely unlikely to be returned.
 */
export class PrismaSearchChunkRepository implements SearchChunkRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async replaceForDocument(
    workspaceId: string,
    searchDocumentId: string,
    chunks: CreateSearchChunkInput[],
  ): Promise<SearchChunk[]> {
    const bounded = chunks.slice(0, SEARCH_LIMITS.maxChunksPerDocument);
    // Delete-then-insert inside one transaction: a reindex that failed midway
    // must not leave a document indexed under a mix of two versions' content.
    await this.prisma.$transaction(async (tx) => {
      await tx.searchChunk.deleteMany({ where: { workspaceId, searchDocumentId } });
      if (bounded.length === 0) return;
      for (const input of bounded) {
        await tx.searchChunk.create({
          data: {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            searchDocumentId: input.searchDocumentId,
            documentId: input.documentId,
            ordinal: input.ordinal,
            sourceType: input.sourceType,
            pageNumber: input.pageNumber,
            text: input.text.slice(0, SEARCH_LIMITS.maxChunkTextLength),
            normalizedText: input.normalizedText.slice(0, SEARCH_LIMITS.maxChunkTextLength),
          },
        });
      }
    });

    const rows = await this.prisma.searchChunk.findMany({
      where: { workspaceId, searchDocumentId },
      orderBy: { ordinal: "asc" },
      take: SEARCH_LIMITS.maxChunksPerDocument,
    });
    return rows.map(toDomain);
  }

  async listForDocument(
    workspaceId: string,
    documentId: string,
    limit?: number,
  ): Promise<SearchChunk[]> {
    const rows = await this.prisma.searchChunk.findMany({
      where: { workspaceId, documentId },
      orderBy: { ordinal: "asc" },
      take: chunkListLimit(limit),
    });
    return rows.map(toDomain);
  }

  async listMatchingTerms(
    workspaceId: string,
    terms: string[],
    limit: number,
  ): Promise<SearchChunk[]> {
    if (terms.length === 0) return [];
    const bounded = terms
      .slice(0, SEARCH_LIMITS.maxQueryTerms)
      .map((term) => term.slice(0, SEARCH_LIMITS.maxTermLength));
    const rows = await this.prisma.searchChunk.findMany({
      where: {
        workspaceId,
        // AND of substring tests: a chunk must contain every term. The values
        // are bounded literals, not patterns.
        AND: bounded.map((term) => ({ normalizedText: { contains: term } })),
      },
      orderBy: [{ documentId: "asc" }, { ordinal: "asc" }],
      take: Math.min(Math.trunc(limit), 1000),
    });
    return rows.map(toDomain);
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.searchChunk.count({ where: { workspaceId, documentId } });
  }

  async deleteForSearchDocument(
    workspaceId: string,
    searchDocumentId: string,
  ): Promise<number> {
    const result = await this.prisma.searchChunk.deleteMany({
      where: { workspaceId, searchDocumentId },
    });
    return result.count;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.searchChunk.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.prisma.searchChunk.count({ where: { workspaceId } });
  }
}
