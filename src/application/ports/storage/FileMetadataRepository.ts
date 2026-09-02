import type { StoredFile, StoredFileOwnerType } from "@/src/domain/entities/StoredFile";

/**
 * FileMetadataRepository port — persistence for StoredFile rows.
 *
 * The bytes are in object storage (IObjectStorage); this is the index that maps
 * a stored-file id to its storage key, owner scope, sha256 (for dedup), size,
 * and retention expiry. Adapters: PrismaStoredFileRepository (and an in-memory
 * one for tests).
 */
export interface StoredFileCreateInput {
  ownerType: StoredFileOwnerType;
  ownerId: string;
  key: string;
  sha256?: string | null;
  size: number;
  mimeType: string;
  originalName?: string | null;
  expiresAt?: Date | null;
}

export interface IFileMetadataRepository {
  create(input: StoredFileCreateInput): Promise<StoredFile>;
  get(id: string): Promise<StoredFile | null>;
  /** Find an existing file by content hash + owner scope (for dedup). */
  findBySha256(ownerType: StoredFileOwnerType, ownerId: string, sha256: string): Promise<StoredFile | null>;
  listByOwner(ownerType: StoredFileOwnerType, ownerId: string, limit?: number): Promise<StoredFile[]>;
  /** Marks (or deletes) files whose expiresAt has passed — used by the retention job. */
  listExpired(now?: Date, limit?: number): Promise<StoredFile[]>;
  delete(id: string): Promise<void>;
}
