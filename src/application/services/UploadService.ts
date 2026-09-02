import crypto from "node:crypto";
import type { IUploadService, UploadInput, UploadInputStream, UploadResult } from "@/src/application/ports/storage/UploadService";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { ILogger } from "@/src/application/ports/Logger";

/**
 * Application service that ingests a file through the storage ports.
 *
 *  1. sha256 the bytes.
 *  2. If this owner already has a metadata row for that hash → dedup (return it,
 *     no storage write).
 *  3. Otherwise use a content-addressed key `ca/<sha>/<sha>` so identical bytes
 *     across owners are stored once (byte-level dedup): only `put` if the object
 *     doesn't already exist.
 *  4. Record the metadata row.
 *
 * The application calls this; it never touches object storage or the metadata
 * DB directly — both are injected ports. `uploadStream` is the no-dedup,
 * explicit-key, streaming variant for large objects (tool outputs).
 */
export class UploadService implements IUploadService {
  constructor(
    private readonly storage: IObjectStorage,
    private readonly meta: IFileMetadataRepository,
    private readonly logger: ILogger,
  ) {}

  async upload(input: UploadInput): Promise<UploadResult> {
    const data = Buffer.isBuffer(input.data)
      ? input.data
      : Buffer.from(input.data);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");

    // Per-owner dedup: same owner re-uploading the same file.
    const existing = await this.meta.findBySha256(
      input.ownerType,
      input.ownerId,
      sha256,
    );
    if (existing) {
      this.logger.debug("Upload deduplicated (owner already has file)", {
        fileId: existing.id,
        sha256,
      });
      return { file: existing, deduplicated: true };
    }

    // Content-addressed key → byte-level dedup across owners.
    const key = `ca/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    const head = await this.storage.head(key);
    if (!head.exists) {
      await this.storage.put(key, data, {
        contentType: input.mimeType,
        sha256,
      });
    } else {
      this.logger.debug("Upload byte-deduplicated (object already stored)", {
        key,
        sha256,
      });
    }

    const file = await this.meta.create({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      key,
      sha256,
      size: data.length,
      mimeType: input.mimeType,
      originalName: input.originalName,
      expiresAt: input.expiresAt ?? null,
    });
    return { file, deduplicated: false };
  }

  async uploadStream(input: UploadInputStream): Promise<UploadResult> {
    // Stream straight to storage; putStream computes sha256 + size on the fly
    // so the object is never buffered whole. No dedup on this path (explicit,
    // job-scoped key) — outputs are typically unique per job.
    const { sha256, size } = await this.storage.putStream(
      input.key,
      input.data,
      { contentType: input.mimeType },
    );
    const file = await this.meta.create({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      key: input.key,
      sha256,
      size,
      mimeType: input.mimeType,
      originalName: input.originalName,
      expiresAt: input.expiresAt ?? null,
    });
    return { file, deduplicated: false };
  }
}
