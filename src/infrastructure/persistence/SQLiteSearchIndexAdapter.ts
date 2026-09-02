import type { SearchChunkRepository } from "@/src/application/ports/workspaces/SearchChunkRepository";
import type { SearchIndexPort } from "@/src/application/ports/workspaces/SearchIndexPort";
import type { SearchChunk } from "@/src/domain/entities/SearchIndex";
import { SEARCH_LIMITS, isSearchableTerm } from "@/src/domain/entities/SearchIndex";

/** SQLite-compatible literal substring search adapter. */
export class SQLiteSearchIndexAdapter implements SearchIndexPort {
  constructor(private readonly chunks: SearchChunkRepository) {}

  /** Finds chunks using bounded AND semantics without compiling caller patterns. */
  async searchChunks(
    workspaceId: string,
    terms: string[],
    limit: number,
  ): Promise<SearchChunk[]> {
    const boundedTerms = terms
      .filter(isSearchableTerm)
      .slice(0, SEARCH_LIMITS.maxQueryTerms)
      .map((term) => term.slice(0, SEARCH_LIMITS.maxTermLength));
    if (boundedTerms.length === 0) return [];
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), SEARCH_LIMITS.maxCandidateDocuments))
      : SEARCH_LIMITS.defaultResultLimit;
    return this.chunks.listMatchingTerms(workspaceId, boundedTerms, boundedLimit);
  }
}
