import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  IMultipartUpload,
  MultipartSession,
  CompletedPart,
} from "@/src/application/ports/storage/MultipartUpload";
import type { R2Config } from "@/src/infrastructure/config/env";

/**
 * Cloudflare R2 multipart upload adapter (prod). Mirrors the local adapter's
 * interface but the client PUTs parts directly to presigned R2 URLs — bytes
 * never touch the app server, so a 500MB PDF uploads without buffering. Only
 * constructed when R2 is configured.
 */
export class R2MultipartUpload implements IMultipartUpload {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async create(
    key: string,
    contentType: string,
    partCount: number,
    _partSize: number,
  ): Promise<MultipartSession> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    const uploadId = res.UploadId;
    if (!uploadId) throw new Error("R2 did not return an UploadId");

    const parts: { partNumber: number; url: string }[] = [];
    for (let p = 1; p <= partCount; p++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.config.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: p,
        }),
        { expiresIn: 3600 },
      );
      parts.push({ partNumber: p, url });
    }
    return { uploadId, key, parts };
  }

  async complete(
    session: MultipartSession,
    parts: CompletedPart[],
  ): Promise<{ key: string }> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: session.key,
        UploadId: session.uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })),
        },
      }),
    );
    return { key: session.key };
  }

  async abort(session: MultipartSession): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: session.key,
        UploadId: session.uploadId,
      }),
    );
  }
}
