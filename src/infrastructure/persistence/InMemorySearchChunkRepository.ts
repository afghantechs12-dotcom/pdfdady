import type { SearchChunk } from "@/src/domain/entities/SearchIndex";
import { chunkListLimit } from "@/src/domain/entities/SearchIndex";
import type {
  CreateSearchChunkInput,
  SearchChunkRepository,
} from "@/src/application/ports/workspaces/SearchChunkRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-search-chunk-${counter}`;
}

interface StoredSearchChunk {
  id: string;
  organizationId: string;
  workspaceId: string;
  searchDocumentId: string;
  documentId: string;
  ordinal: number;
  sourceType: SearchChunk["sourceType"];
  pageNumber: number | null;
  text: string;
  normalizedText: string;
  createdAt: Date;
}

/**
 * In-memory SearchChunkRepository, mirroring the Prisma adapter: the
 * (searchDocumentId, ordinal) unique key, Workspace-scoped predicates, and
 * bounded listings. `replaceForDocument` swaps one entry's chunks for the new
 * set so a reindex converges rather than accumulates.
 */
export class InMemorySearchChunkRepository implements SearchChunkRepository {
  private readonly rows = new Map<string, StoredSearchChunk>();

  private toDomain(row: StoredSearchChunk): SearchChunk {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      searchDocumentId: row.searchDocumentId,
      documentId: row.documentId,
      ordinal: row.ordinal,
      sourceType: row.sourceType,
      pageNumber: row.pageNumber,
      text: row.text,
      normalizedText: row.normalizedText,
      createdAt: new Date(row.createdAt),
    };
  }

  async replaceForDocument(
    workspaceId: string,
    searchDocumentId: string,
    chunks: CreateSearchChunkInput[],
  ): Promise<SearchChunk[]> {
    // Remove the entry's current chunks, then insert the new ones. The unique
    // (searchDocumentId, ordinal) key is enforced here the way the database
    // would: a duplicate ordinal in the batch is rejected rather than absorbed.
    for (const [id, row] of this.rows) {
      if (row.workspaceId === workspaceId && row.searchDocumentId === searchDocumentId) {
        this.rows.delete(id);
      }
    }
    const seenOrdinals = new Set<number>();
    const created: SearchChunk[] = [];
    for (const input of chunks) {
      if (seenOrdinals.has(input.ordinal)) {
        throw new Error(
          `Duplicate chunk ordinal ${input.ordinal} for search document ${searchDocumentId}.`,
        );
      }
      seenOrdinals.add(input.ordinal);
      const now = new Date();
      const row: StoredSearchChunk = {
        id: uid(),
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        searchDocumentId: input.searchDocumentId,
        documentId: input.documentId,
        ordinal: input.ordinal,
        sourceType: input.sourceType,
        pageNumber: input.pageNumber,
        text: input.text,
        normalizedText: input.normalizedText,
        createdAt: now,
      };
      this.rows.set(row.id, row);
      created.push(this.toDomain(row));
    }
    return created;
  }

  async listForDocument(
    workspaceId: string,
    documentId: string,
    limit?: number,
  ): Promise<SearchChunk[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.documentId === documentId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .slice(0, chunkListLimit(limit))
      .map((row) => this.toDomain(row));
  }

  async listMatchingTerms(
    workspaceId: string,
    terms: string[],
    limit: number,
  ): Promise<SearchChunk[]> {
    if (terms.length === 0) return [];
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId)
      .filter((row) => terms.every((term) => row.normalizedText.includes(term)))
      .sort((a, b) => a.documentId.localeCompare(b.documentId) || a.ordinal - b.ordinal)
      .slice(0, Math.min(Math.trunc(limit), 1000))
      .map((row) => this.toDomain(row));
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.documentId === documentId,
    ).length;
  }

  async deleteForSearchDocument(
    workspaceId: string,
    searchDocumentId: string,
  ): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.workspaceId === workspaceId && row.searchDocumentId === searchDocumentId) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.workspaceId === workspaceId && row.documentId === documentId) {
        this.rows.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).length;
  }
}
