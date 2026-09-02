import type { DocumentMetadata, MetadataFields } from "@/src/domain/entities/DocumentMetadata";

export interface UpsertDocumentMetadataInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  fields: MetadataFields;
  schemaVersion: number;
  actorId: string;
}

/**
 * Workspace-owned document metadata.
 *
 * One row per document, which is what makes a save idempotent: a redelivered
 * write converges on the same row rather than inserting a second set of
 * properties. Every predicate carries `workspaceId`, so metadata belonging to
 * another Workspace reads as missing rather than as forbidden — a properties row
 * must never confirm a document the actor cannot see.
 *
 * Embedded /Info values are never written here. They are a projection of the PDF
 * bytes and are reported separately (see `EMBEDDED_WRITE_SUPPORT`).
 */
export interface DocumentMetadataRepository {
  /** Creates or replaces the metadata row for one document. */
  upsert(input: UpsertDocumentMetadataInput): Promise<DocumentMetadata>;
  getByDocumentId(workspaceId: string, documentId: string): Promise<DocumentMetadata | null>;
  /**
   * Compare-and-swap replace. Returns null when the expected revision no longer
   * matches *or* the row is absent: a caller must not be able to tell a lost
   * race from a missing document.
   */
  replaceFields(
    workspaceId: string,
    documentId: string,
    expectedRevision: number,
    fields: MetadataFields,
    actorId: string,
  ): Promise<DocumentMetadata | null>;
  /** Bounded bulk read, for listing properties across a document set. */
  listForDocuments(workspaceId: string, documentIds: string[]): Promise<DocumentMetadata[]>;
  delete(workspaceId: string, documentId: string): Promise<boolean>;
  countForWorkspace(workspaceId: string): Promise<number>;
}
