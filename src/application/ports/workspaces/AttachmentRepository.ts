import type { AttachmentRecord, MetadataOrigin } from "@/src/domain/entities/DocumentMetadata";

export interface CreateAttachmentInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** Null for an embedded attachment that was catalogued but not extracted. */
  storedFileId: string | null;
  origin: MetadataOrigin;
  name: string;
  normalizedName: string;
  description: string | null;
  mimeType: string;
  byteSize: number;
  checksum: string;
  createdById: string;
}

export interface UpdateAttachmentInput {
  name?: string;
  normalizedName?: string;
  description?: string | null;
}

export interface AttachmentListQuery {
  workspaceId: string;
  documentId: string;
  origin?: MetadataOrigin;
  limit: number;
}

/**
 * Attachment records for a document.
 *
 * The row is the catalogue entry; the bytes live in object storage behind a
 * StoredFile. Separating them is what lets an embedded attachment be *listed*
 * without being extracted — `storedFileId` is null in that case, and the record
 * is honestly not downloadable rather than pointing at bytes that do not exist.
 *
 * `byteSize` is stored so a quota can be enforced without a storage round-trip
 * per attachment, and `checksum` so a download can be verified against what was
 * recorded at upload.
 *
 * Every predicate carries `workspaceId`.
 */
export interface AttachmentRepository {
  create(input: CreateAttachmentInput): Promise<AttachmentRecord>;
  getById(workspaceId: string, attachmentId: string): Promise<AttachmentRecord | null>;
  /** Resolves by name within a document, for duplicate detection. */
  getByNormalizedName(
    workspaceId: string,
    documentId: string,
    normalizedName: string,
  ): Promise<AttachmentRecord | null>;
  list(query: AttachmentListQuery): Promise<AttachmentRecord[]>;
  /** Compare-and-swap update; null for both a stale revision and a missing row. */
  update(
    workspaceId: string,
    attachmentId: string,
    expectedRevision: number,
    input: UpdateAttachmentInput,
  ): Promise<AttachmentRecord | null>;
  delete(workspaceId: string, attachmentId: string): Promise<boolean>;
  deleteForDocument(workspaceId: string, documentId: string): Promise<number>;
  countForDocument(workspaceId: string, documentId: string): Promise<number>;
  /** Total stored bytes for one document, for the per-document quota. */
  totalBytesForDocument(workspaceId: string, documentId: string): Promise<number>;
}
