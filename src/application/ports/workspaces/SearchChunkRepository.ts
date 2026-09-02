import type { ChunkSourceType, SearchChunk } from "@/src/domain/entities/SearchIndex";

export interface CreateSearchChunkInput {
  organizationId: string;
  workspaceId: string;
  searchDocumentId: string;
  documentId: string;
  ordinal: number;
  sourceType: ChunkSourceType;
  pageNumber: number | null;
  text: string;
  normalizedText: string;
}

/**
 * Chunks beneath an index entry.
 *
 * The (searchDocumentId, ordinal) pair is unique, so a reindex replaces a
 * chunk in place rather than accumulating duplicates. Every read is
 * Workspace-scoped.
 */
export interface SearchChunkRepository {
  /** Bounded bulk replace for one entry: removes its current chunks, then inserts. */
  replaceForDocument(
    workspaceId: string,
    searchDocumentId: string,
    chunks: CreateSearchChunkInput[],
  ): Promise<SearchChunk[]>;
  listForDocument(
    workspaceId: string,
    documentId: string,
    limit?: number,
  ): Promise<SearchChunk[]>;
  /** All chunks across the Workspace whose normalized text matches every term. */
  listMatchingTerms(
    workspaceId: string,
    terms: string[],
    limit: number,
  ): Promise<SearchChunk[]>;
  countForDocument(workspaceId: string, documentId: string): Promise<number>;
  /** Removes the chunks of one entry, returning how many were deleted. */
  deleteForSearchDocument(workspaceId: string, searchDocumentId: string): Promise<number>;
  /** Removes the chunks of one document (all its entries), returning how many. */
  deleteForDocument(workspaceId: string, documentId: string): Promise<number>;
  countForWorkspace(workspaceId: string): Promise<number>;
}
