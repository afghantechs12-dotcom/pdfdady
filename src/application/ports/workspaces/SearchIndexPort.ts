import type { SearchChunk } from "@/src/domain/entities/SearchIndex";

/**
 * Backend-neutral query boundary for a bounded search index.
 *
 * Authorization deliberately does not belong here. Callers must authorize and
 * establish their eligible document set before invoking this backend operation.
 */
export interface SearchIndexPort {
  /** Finds bounded chunks containing every supplied normalized literal term. */
  searchChunks(workspaceId: string, terms: string[], limit: number): Promise<SearchChunk[]>;
}
