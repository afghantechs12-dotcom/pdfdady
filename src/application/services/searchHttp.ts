import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { SearchService } from "./SearchService";
import type { SearchDocument, SearchHit } from "@/src/domain/entities/SearchIndex";

/** Resolves the singleton search application service. */
export function searchService(): SearchService {
  return appContainer.resolve<SearchService>(Tokens.SearchService);
}

/** Serializes a search hit without exposing tenancy or persistence keys. */
export function toSearchHitResponse(hit: SearchHit): SearchHit {
  return {
    documentId: hit.documentId,
    versionId: hit.versionId,
    score: hit.score,
    snippets: hit.snippets.map((snippet) => ({
      text: snippet.text,
      highlights: snippet.highlights.map((range) => ({ ...range })),
      pageNumber: snippet.pageNumber,
      sourceType: snippet.sourceType,
    })),
    pageNumbers: [...hit.pageNumbers],
    stale: hit.stale,
  };
}

/** Serializes safe search-index status fields for a Workspace member. */
export function toSearchStatusResponse(entry: SearchDocument | null): object | null {
  if (!entry) return null;
  return {
    documentId: entry.documentId,
    versionId: entry.versionId,
    state: entry.state,
    schemaVersion: entry.schemaVersion,
    chunkCount: entry.chunkCount,
    error: entry.error,
    indexedAt: entry.indexedAt?.toISOString() ?? null,
    revision: entry.revision,
    updatedAt: entry.updatedAt.toISOString(),
  };
}
