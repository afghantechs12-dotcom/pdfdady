import type { StoredFile } from "@/src/domain/entities/StoredFile";

/**
 * DownloadService port — the application's high-level "produce a download" API.
 *
 * Returns a time-limited signed URL for the file's storage key (the client
 * fetches bytes directly from storage — the app server stays out of the data
 * path), after verifying the caller owns the file. Adapters compose
 * ISignedUrlService + IFileMetadataRepository; the application never knows
 * whether the URL is an R2 presign or a local HMAC route.
 */
export interface DownloadUrlResult {
  file: StoredFile;
  url: string;
  /** Seconds the URL remains valid. */
  ttlSeconds: number;
}

export interface IDownloadService {
  /** Returns a signed download URL for `fileId`, or null if not found. */
  getUrl(fileId: string, ttlSeconds?: number): Promise<DownloadUrlResult | null>;
}
