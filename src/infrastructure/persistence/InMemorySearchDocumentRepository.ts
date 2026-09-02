import type {
  SearchDocument,
  SearchIndexState,
} from "@/src/domain/entities/SearchIndex";
import type {
  SearchDocumentListQuery,
  SearchDocumentRepository,
  UpsertSearchDocumentInput,
} from "@/src/application/ports/workspaces/SearchDocumentRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-search-doc-${counter}`;
}

interface StoredSearchDocument {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string | null;
  state: SearchIndexState;
  schemaVersion: number;
  checksum: string;
  chunkCount: number;
  error: string | null;
  indexedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory SearchDocumentRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter: the (workspaceId, documentId) unique
 * constraint, Workspace-scoped predicates, compare-and-swap state transitions,
 * and bounded listings. Rows are copied on the way out so a caller mutating a
 * returned entry cannot reach stored state.
 */
export class InMemorySearchDocumentRepository implements SearchDocumentRepository {
  private readonly rows = new Map<string, StoredSearchDocument>();

  private toDomain(row: StoredSearchDocument): SearchDocument {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      versionId: row.versionId,
      state: row.state,
      schemaVersion: row.schemaVersion,
      checksum: row.checksum,
      chunkCount: row.chunkCount,
      error: row.error,
      indexedAt: row.indexedAt === null ? null : new Date(row.indexedAt),
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  async upsert(input: UpsertSearchDocumentInput): Promise<SearchDocument> {
    const existing = [...this.rows.values()].find(
      (row) =>
        row.workspaceId === input.workspaceId && row.documentId === input.documentId,
    );
    if (existing) {
      existing.versionId = input.versionId;
      existing.state = input.state;
      existing.schemaVersion = input.schemaVersion;
      existing.checksum = input.checksum;
      if (input.error !== undefined) existing.error = input.error;
      existing.revision += 1;
      existing.updatedAt = new Date();
      return this.toDomain(existing);
    }

    const now = new Date();
    const row: StoredSearchDocument = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      versionId: input.versionId,
      state: input.state,
      schemaVersion: input.schemaVersion,
      checksum: input.checksum,
      chunkCount: 0,
      error: input.error ?? null,
      indexedAt: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getByDocumentId(
    workspaceId: string,
    documentId: string,
  ): Promise<SearchDocument | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.workspaceId === workspaceId && candidate.documentId === documentId,
    );
    return row ? this.toDomain(row) : null;
  }

  async getById(workspaceId: string, searchDocumentId: string): Promise<SearchDocument | null> {
    const row = this.rows.get(searchDocumentId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async list(query: SearchDocumentListQuery): Promise<SearchDocument[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === query.workspaceId)
      .filter((row) => (query.state === undefined ? true : row.state === query.state))
      .sort((a, b) => a.documentId.localeCompare(b.documentId))
      .slice(0, Math.min(Math.trunc(query.limit), 1000))
      .map((row) => this.toDomain(row));
  }

  async listForDocuments(
    workspaceId: string,
    documentIds: string[],
  ): Promise<SearchDocument[]> {
    const wanted = new Set(documentIds.slice(0, 1000));
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.workspaceId === workspaceId &&
          wanted.has(row.documentId),
      )
      .map((row) => this.toDomain(row));
  }

  async setState(
    workspaceId: string,
    searchDocumentId: string,
    expectedRevision: number,
    state: SearchIndexState,
    error?: string | null,
  ): Promise<SearchDocument | null> {
    const row = this.rows.get(searchDocumentId);
    // Revision is part of the match, not checked after: a stale revision finds
    // no row, which is the same outcome the database's updateMany produces.
    if (!row || row.workspaceId !== workspaceId || row.revision !== expectedRevision) return null;
    row.state = state;
    if (error !== undefined) row.error = error ?? null;
    row.revision += 1;
    row.updatedAt = new Date();
    return this.toDomain(row);
  }

  async markIndexed(
    workspaceId: string,
    searchDocumentId: string,
    chunkCount: number,
    checksum: string,
  ): Promise<SearchDocument | null> {
    const row = this.rows.get(searchDocumentId);
    if (!row || row.workspaceId !== workspaceId) return null;
    row.state = "indexed";
    row.chunkCount = chunkCount;
    row.checksum = checksum;
    row.error = null;
    row.indexedAt = new Date();
    row.revision += 1;
    row.updatedAt = new Date();
    return this.toDomain(row);
  }

  async delete(workspaceId: string, documentId: string): Promise<boolean> {
    const row = [...this.rows.values()].find(
      (candidate) =>
        candidate.workspaceId === workspaceId && candidate.documentId === documentId,
    );
    if (!row) return false;
    this.rows.delete(row.id);
    return true;
  }

  async countForWorkspace(workspaceId: string, state?: SearchIndexState): Promise<number> {
    return [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === workspaceId &&
        (state === undefined || row.state === state),
    ).length;
  }

  async lastIndexedAt(workspaceId: string): Promise<Date | null> {
    let latest: Date | null = null;
    for (const row of this.rows.values()) {
      if (row.workspaceId !== workspaceId) continue;
      if (row.indexedAt !== null && (latest === null || row.indexedAt > latest)) {
        latest = row.indexedAt;
      }
    }
    return latest;
  }
}
