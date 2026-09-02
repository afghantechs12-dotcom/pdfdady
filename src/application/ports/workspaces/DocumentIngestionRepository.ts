import type {
  DocumentIngestion,
  DocumentIngestionStatus,
} from "@/src/domain/entities/DocumentIngestion";

export interface CreateDocumentIngestionInput {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  storedFileId: string;
  status: DocumentIngestionStatus;
  checksum: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
  uploadedById: string;
}

export interface UpdateDocumentIngestionInput {
  status?: DocumentIngestionStatus;
  pageCount?: number | null;
  failureReason?: string | null;
  completedAt?: Date | null;
}

/**
 * Persistence port for M7.4 ingestion records.
 *
 * Every method is Workspace-scoped: a record is addressed by
 * (workspaceId, id) or (workspaceId, documentId), never by id alone, so a
 * cross-Workspace read is unreachable at the adapter boundary.
 */
export interface DocumentIngestionRepository {
  create(input: CreateDocumentIngestionInput): Promise<DocumentIngestion>;

  getById(workspaceId: string, ingestionId: string): Promise<DocumentIngestion | null>;

  /** The ingestion backing a document, or null when the document has no bytes yet. */
  getByDocumentId(workspaceId: string, documentId: string): Promise<DocumentIngestion | null>;

  /**
   * Finds an existing ingestion for these bytes within a Workspace.
   *
   * Scoped to the Workspace on purpose: dedup must never reveal that another
   * tenant holds the same content.
   */
  findByChecksum(workspaceId: string, checksum: string): Promise<DocumentIngestion | null>;

  update(
    workspaceId: string,
    ingestionId: string,
    data: UpdateDocumentIngestionInput,
  ): Promise<DocumentIngestion | null>;

  /**
   * Ingestions stuck in a non-terminal state, oldest first, bounded by `limit`.
   *
   * Deliberately *not* Workspace-scoped: this is the recovery sweep, and the
   * thing it recovers from is an upload whose job was never enqueued (the queue
   * was down, or the process died between the write and the enqueue). No tenant
   * is doing the asking — the worker is — so there is no Workspace to scope to,
   * and the rows it returns are handed straight back to the tenant-scoped
   * promotion path rather than to a caller.
   *
   * Oldest-first and bounded so a large backlog is drained deterministically in
   * batches instead of loaded at once.
   */
  listUnfinished(limit: number, olderThan?: Date): Promise<DocumentIngestion[]>;

  /** Removes a record — used to roll back a partially-failed upload. */
  delete(workspaceId: string, ingestionId: string): Promise<boolean>;
}
