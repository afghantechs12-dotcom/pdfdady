/**
 * M7.4 document ingestion domain types.
 *
 * An ingestion record is the durable link between a DocumentRecord and the
 * StoredFile holding its bytes, plus the state of the post-upload processing
 * pipeline. It exists so an upload is recoverable and observable: a crashed or
 * failed ingestion leaves a row in a known state rather than an orphaned
 * document with no bytes behind it.
 */

/**
 * Ingestion lifecycle.
 *
 * `pending` — row created, bytes stored, processing not started.
 * `processing` — a worker is deriving page count, thumbnails, and text.
 * `complete` — derived data is available; the document is fully usable.
 * `failed` — processing failed; `failureReason` explains why. The document and
 *   its bytes are retained so the caller can retry or discard deliberately.
 */
export type DocumentIngestionStatus = "pending" | "processing" | "complete" | "failed";

/** Terminal states — an ingestion in one of these will not advance on its own. */
export const TERMINAL_INGESTION_STATUSES: readonly DocumentIngestionStatus[] = ["complete", "failed"];

/**
 * Bounds shared by the service (rejects on write) and the adapters (clamp on
 * read), so a row written by an older client cannot return unbounded values.
 */
export const DOCUMENT_INGESTION_LIMITS = {
  /** Hard cap on an uploaded document, in bytes. */
  maxUploadBytes: 100 * 1024 * 1024,
  /** Longest accepted original filename. */
  maxFilenameLength: 255,
  /** Longest accepted document display name. */
  maxNameLength: 255,
  /** Longest stored failure reason. */
  maxFailureReasonLength: 500,
  /** Upper bound on derived page count, guarding against absurd values. */
  maxPageCount: 100_000,
} as const;

export interface DocumentIngestion {
  id: string;
  workspaceId: string;
  organizationId: string;
  documentId: string;
  /** StoredFile holding the uploaded bytes. */
  storedFileId: string;
  status: DocumentIngestionStatus;
  /** sha256 of the uploaded bytes — the dedup and integrity key. */
  checksum: string;
  byteSize: number;
  mimeType: string;
  originalName: string;
  /** Derived during processing; null until known. */
  pageCount: number | null;
  /** Set only when `status` is "failed". */
  failureReason: string | null;
  uploadedById: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/**
 * Result of a workspace upload.
 *
 * `deduplicated` reports only whether *this owner* already had a document for
 * these bytes. It is deliberately never set from a cross-owner byte match: that
 * would disclose that another tenant holds the same file.
 */
export interface WorkspaceUploadResult {
  document: {
    id: string;
    name: string;
    workspaceId: string;
    folderId: string | null;
    projectId: string | null;
  };
  file: {
    id: string;
    key: string;
    size: number;
    mimeType: string;
    originalName: string | null;
  };
  ingestion: {
    id: string;
    status: DocumentIngestionStatus;
    checksum: string;
    pageCount: number | null;
  };
  /** True when this workspace already held a document for these exact bytes. */
  deduplicated: boolean;
}
