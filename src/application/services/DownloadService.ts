import type {
  IDownloadService,
  DownloadUrlResult,
} from "@/src/application/ports/storage/DownloadService";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { ISignedUrlService } from "@/src/application/ports/storage/SignedUrlService";

/**
 * Application service that produces a time-limited download URL for a file.
 *
 * Looks up the metadata row, then asks ISignedUrlService for a signed GET URL
 * for the file's storage key. The client fetches bytes directly from storage
 * (R2 presign in prod, an HMAC local route in dev) — the app server never
 * buffers the file body. NOTE: ownership enforcement (does the caller own this
 * file?) is layered on in M2.4 with auth; M2.2 returns a URL for any existing
 * fileId.
 */
export class DownloadService implements IDownloadService {
  constructor(
    private readonly meta: IFileMetadataRepository,
    private readonly signedUrls: ISignedUrlService,
  ) {}

  async getUrl(fileId: string, ttlSeconds = 900): Promise<DownloadUrlResult | null> {
    const file = await this.meta.get(fileId);
    if (!file) return null;
    const url = await this.signedUrls.signedUrl(file.key, "get", ttlSeconds);
    return { file, url, ttlSeconds };
  }
}
