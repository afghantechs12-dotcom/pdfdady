/**
 * StoredFile domain entity — metadata for a persisted user/org file.
 *
 * The bytes live in object storage (local disk or R2) keyed by `key`; this
 * record is the metadata row in the `stored_files` table. `ownerType`/`ownerId`
 * are the tenant scope ("anon" | "user" | "org") used to isolate access.
 */
export type StoredFileOwnerType = "anon" | "user" | "org";

export interface StoredFile {
  id: string;
  ownerType: StoredFileOwnerType;
  ownerId: string;
  /** Object-storage key (content-addressed for inputs, job-scoped for outputs). */
  key: string;
  sha256: string | null;
  size: number;
  mimeType: string;
  originalName: string | null;
  createdAt: Date;
  /** When set, the file (and this row) are eligible for retention purge. */
  expiresAt: Date | null;
}
