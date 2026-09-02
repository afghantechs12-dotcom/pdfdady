import type {
  SearchDocument,
  SearchIndexState,
} from "@/src/domain/entities/SearchIndex";

export interface UpsertSearchDocumentInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string | null;
  state: SearchIndexState;
  schemaVersion: number;
  checksum: string;
  error?: string | null;
}

export interface SearchDocumentListQuery {
  workspaceId: string;
  state?: SearchIndexState;
  limit: number;
}

/**
 * Index entries, one per document.
 *
 * Every method is Workspace-scoped: an entry addressed from another Workspace
 * must read as missing, so that no index row can confirm a document exists to
 * someone who cannot see the document itself.
 */
export interface SearchDocumentRepository {
  /**
   * Creates or replaces the entry for a document. Upsert rather than
   * create-then-update because indexing is retried and redelivered, and a
   * second attempt must converge on the same row rather than collide.
   */
  upsert(input: UpsertSearchDocumentInput): Promise<SearchDocument>;
  getByDocumentId(workspaceId: string, documentId: string): Promise<SearchDocument | null>;
  getById(workspaceId: string, searchDocumentId: string): Promise<SearchDocument | null>;
  list(query: SearchDocumentListQuery): Promise<SearchDocument[]>;
  /** Loads entries for a set of documents in one read, for result assembly. */
  listForDocuments(workspaceId: string, documentIds: string[]): Promise<SearchDocument[]>;
  /**
   * Moves an entry to a new state, compare-and-swapping on revision. Returns
   * null for both a stale revision and a missing row, so neither discloses the
   * other.
   */
  setState(
    workspaceId: string,
    searchDocumentId: string,
    expectedRevision: number,
    state: SearchIndexState,
    error?: string | null,
  ): Promise<SearchDocument | null>;
  /** Records a completed indexing pass: chunk count, checksum and timestamp. */
  markIndexed(
    workspaceId: string,
    searchDocumentId: string,
    chunkCount: number,
    checksum: string,
  ): Promise<SearchDocument | null>;
  delete(workspaceId: string, documentId: string): Promise<boolean>;
  countForWorkspace(workspaceId: string, state?: SearchIndexState): Promise<number>;
  /** Most recent successful index time in the Workspace, or null. */
  lastIndexedAt(workspaceId: string): Promise<Date | null>;
}
