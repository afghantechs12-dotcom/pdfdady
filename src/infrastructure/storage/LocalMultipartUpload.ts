import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type {
  IMultipartUpload,
  MultipartSession,
  CompletedPart,
} from "@/src/application/ports/storage/MultipartUpload";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";

/**
 * Local-filesystem multipart upload adapter (dev).
 *
 * `create` reserves an upload dir + returns app-internal part URLs; the part
 * route calls `receivePart` to write each chunk; `complete` concatenates the
 * parts (in part-number order) and stores the final object via IObjectStorage;
 * `abort` discards them. The final concat buffers in memory — acceptable for
 * dev; production uses R2MultipartUpload, which streams parts straight to R2.
 *
 * `receivePart` is not on the IMultipartUpload interface (R2 clients PUT parts
 * directly to presigned URLs, bypassing the app); the local part route detects
 * it via a structural check.
 */
export class LocalMultipartUpload implements IMultipartUpload {
  constructor(
    private readonly storage: IObjectStorage,
    private readonly multipartRoot: string,
    private readonly baseUrl: string,
  ) {}

  private partDir(uploadId: string): string {
    return path.join(this.multipartRoot, uploadId);
  }
  private partPath(uploadId: string, partNumber: number): string {
    return path.join(this.partDir(uploadId), String(partNumber));
  }

  async create(
    key: string,
    _contentType: string,
    partCount: number,
    _partSize: number,
  ): Promise<MultipartSession> {
    const uploadId = crypto.randomBytes(16).toString("hex");
    await fs.mkdir(this.partDir(uploadId), { recursive: true });
    const base = this.baseUrl.replace(/\/$/, "");
    const parts = Array.from({ length: partCount }, (_, i) => {
      const partNumber = i + 1;
      return { partNumber, url: `${base}/api/storage/multipart/${uploadId}/${partNumber}` };
    });
    return { uploadId, key, parts };
  }

  async receivePart(
    uploadId: string,
    partNumber: number,
    data: Buffer,
  ): Promise<{ etag: string }> {
    await fs.mkdir(this.partDir(uploadId), { recursive: true });
    await fs.writeFile(this.partPath(uploadId, partNumber), data);
    return { etag: crypto.createHash("sha256").update(data).digest("hex") };
  }

  async complete(
    session: MultipartSession,
    parts: CompletedPart[],
  ): Promise<{ key: string }> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Buffer[] = [];
    for (const p of ordered) {
      chunks.push(await fs.readFile(this.partPath(session.uploadId, p.partNumber)));
    }
    const buf = Buffer.concat(chunks);
    await this.storage.put(session.key, buf, {
      contentType: "application/octet-stream",
    });
    await fs.rm(this.partDir(session.uploadId), { recursive: true, force: true });
    return { key: session.key };
  }

  async abort(session: MultipartSession): Promise<void> {
    await fs.rm(this.partDir(session.uploadId), { recursive: true, force: true });
  }
}
