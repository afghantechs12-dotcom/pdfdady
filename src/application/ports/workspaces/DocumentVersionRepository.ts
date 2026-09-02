import type { DocumentVersion, DocumentVersionOrigin } from "@/src/domain/entities/DocumentVersion";

/**
 * What a caller supplies to create a version. `versionNumber` is deliberately
 * absent: the number is allocated by the adapter inside the same transaction
 * that inserts the row, so no caller can pick one (see `create`).
 */
export interface CreateDocumentVersionInput {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  revision: number;
  origin: DocumentVersionOrigin;
  restoredFromVersionId: string | null;
  label: string | null;
  /** Pre-serialized, pre-validated manifest JSON. */
  manifest: string;
  checksum: string;
  createdById: string;
}

export interface DocumentVersionListQuery {
  workspaceId: string;
  documentId: string;
  limit: number;
  /** Exclusive upper bound: return versions numbered strictly below this. */
  beforeVersionNumber?: number;
}

/**
 * Durable version history.
 *
 * Every method is addressed by `workspaceId` first — never by version id alone —
 * so a caller holding an id from another tenant cannot read or mutate through
 * this port. There is deliberately no `update`: versions are immutable, and the
 * absence of the method is what enforces it.
 */
export interface DocumentVersionRepository {
  /**
   * Inserts a version, allocating the next `versionNumber` for the document
   * inside the same transaction. Implementations must re-read the authoritative
   * maximum within that transaction and retry on a unique conflict — allocating
   * `max+1` outside the transaction would hand the same number to two concurrent
   * saves (docs/milestone-7-plan.md §6.2).
   */
  create(input: CreateDocumentVersionInput): Promise<DocumentVersion>;

  getById(workspaceId: string, versionId: string): Promise<DocumentVersion | null>;

  getByNumber(
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<DocumentVersion | null>;

  /** Newest first, bounded by the domain listing cap. */
  list(query: DocumentVersionListQuery): Promise<DocumentVersion[]>;

  /** The highest-numbered version for a document, or null when it has none. */
  latest(workspaceId: string, documentId: string): Promise<DocumentVersion | null>;

  /** How many versions a document has. Used for retention decisions. */
  countForDocument(workspaceId: string, documentId: string): Promise<number>;

  /**
   * Whether any *other* version still references an object-storage key. Guards
   * artifact deletion: versions share deduplicated source bytes, so deleting one
   * version's artifacts must never orphan another's.
   */
  isArtifactReferenced(
    workspaceId: string,
    key: string,
    excludingVersionId?: string,
  ): Promise<boolean>;

  /**
   * Deletes a version. Reserved for retention pruning of the oldest versions —
   * not exposed as a user-facing edit, which would violate immutability.
   */
  delete(workspaceId: string, versionId: string): Promise<boolean>;
}
