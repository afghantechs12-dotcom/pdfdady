import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";

export interface DocumentRecordListQuery {
  workspaceId: string;
  folderId?: string | null;
  projectId?: string | null;
  lifecycleState?: DocumentRecordLifecycleState;
  favorite?: boolean;
  /**
   * True to return only documents somebody has actually opened — the `Recent`
   * view. A `lastAccessedAt` sort alone is not the same query: it would list every
   * never-opened document too, with no timestamp, under a heading that promises
   * recently opened ones.
   */
  openedOnly?: boolean;
  cursor?: string;
  limit: number;
  sortBy?: "name" | "createdAt" | "updatedAt" | "lastAccessedAt";
  sortOrder?: "asc" | "desc";
}

export interface CreateDocumentRecordInput {
  workspaceId: string;
  organizationId: string;
  projectId?: string | null;
  folderId?: string | null;
  name: string;
  normalizedName: string;
  orderKey: string;
  createdById: string;
}

export interface BulkOperationResult {
  operationId: string;
  itemResults: Array<{ documentId: string; success: boolean; error?: string }>;
}

export interface DocumentRecordRepository {
  list(query: DocumentRecordListQuery): Promise<{ items: DocumentRecord[]; nextCursor: string | null }>;
  getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null>;
  create(input: CreateDocumentRecordInput): Promise<DocumentRecord>;
  /**
   * Patches a document. `revision`, when present, is the EXPECTED CURRENT
   * revision — a compare-and-swap guard in the WHERE clause — and the column is
   * incremented by the write itself. A caller that passes the revision it wants
   * to end up with matches no row and gets a conflict.
   */
  update(
    workspaceId: string,
    documentId: string,
    data: Partial<Pick<DocumentRecord, "name" | "normalizedName" | "projectId" | "folderId" | "orderKey" | "favorite" | "currentVersionId" | "revision">>,
  ): Promise<DocumentRecord>;
  /**
   * Points a document at a version *only while it still has none*, in a single
   * conditional write. Returns true when this call set the pointer.
   *
   * Ingestion needs this rather than read-then-`update`: between reading
   * `currentVersionId === null` and writing, a concurrent save can advance the
   * document, and an unconditional write would drag it back to its import
   * version. The null check belongs in the WHERE clause, where the database
   * enforces it, not in application memory where it is already stale.
   */
  setCurrentVersionIfUnset(
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<boolean>;
  setLifecycle(workspaceId: string, documentId: string, state: DocumentRecordLifecycleState, actorId: string): Promise<DocumentRecord>;
  touchLastAccessed(workspaceId: string, documentId: string): Promise<void>;
  bulkSetLifecycle(workspaceId: string, documentIds: string[], state: DocumentRecordLifecycleState, actorId: string): Promise<BulkOperationResult>;
  bulkMove(workspaceId: string, documentIds: string[], targetFolderId: string | null, actorId: string): Promise<BulkOperationResult>;
  maxOrderKey(workspaceId: string, folderId: string | null): Promise<string | null>;
}
