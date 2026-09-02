import type { StoredFile, StoredFileOwnerType } from "@/src/domain/entities/StoredFile";

/**
 * UploadService port — the application's high-level "ingest a file" API.
 *
 * It composes the lower-level ports: hashes the bytes (sha256, for dedup),
 * stores them via IObjectStorage, and records metadata via
 * IFileMetadataRepository — returning the StoredFile. If a file with the same
 * sha256 already exists for the owner scope, it returns that row (dedup) instead
 * of re-storing. The application calls this; it never touches object storage or
 * the metadata DB directly.
 *
 * `upload` takes a full buffer (dedup-capable, content-addressed key). For large
 * files that arrive as a stream and don't need dedup (tool outputs, job-scoped),
 * use `uploadStream` — it streams through `IObjectStorage.putStream` so the
 * object is never buffered whole, and uses an explicit caller-chosen key.
 */
export interface UploadResult {
  file: StoredFile;
  /** True when the bytes were already present (no new storage write). */
  deduplicated: boolean;
}

export interface UploadInput {
  ownerType: StoredFileOwnerType;
  ownerId: string;
  originalName: string;
  mimeType: string;
  data: Buffer | Uint8Array;
  /** Optional retention expiry; null/undefined = no auto-expiry. */
  expiresAt?: Date | null;
}

export interface UploadInputStream {
  ownerType: StoredFileOwnerType;
  ownerId: string;
  originalName: string;
  mimeType: string;
  /** Streamed bytes; stored via putStream without buffering the whole object. */
  data: ReadableStream<Uint8Array>;
  /**
   * Explicit storage key (job-scoped for tool outputs, e.g.
   * `jobs/<jobId>/output/<name>`). The caller controls it; no content-addressing
   * or dedup is performed on this path.
   */
  key: string;
  /** Optional retention expiry; null/undefined = no auto-expiry. */
  expiresAt?: Date | null;
}

export interface IUploadService {
  /** Buffered upload with per-owner + byte-level dedup (content-addressed key). */
  upload(input: UploadInput): Promise<UploadResult>;
  /**
   * Streaming upload with an explicit key — no dedup. The sha256 + size are
   * computed on the fly by putStream. Use this for large objects (tool outputs)
   * that would be expensive to buffer.
   */
  uploadStream(input: UploadInputStream): Promise<UploadResult>;
}
