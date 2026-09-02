import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import type {
  ISignedUrlService,
  SignedUrlVerb,
} from "@/src/application/ports/storage/SignedUrlService";
import type { R2Config } from "@/src/infrastructure/config/env";

/**
 * R2/S3 ISignedUrlService adapter (prod). Presigns GET/PUT URLs with a TTL so
 * the client fetches/puts bytes directly to R2 — the app server never buffers
 * file bodies. Only constructed when R2 is configured.
 */
export class R2SignedUrlService implements ISignedUrlService {
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

  async signedUrl(
    key: string,
    verb: SignedUrlVerb,
    ttlSeconds = 900,
  ): Promise<string> {
    const command =
      verb === "get"
        ? new GetObjectCommand({ Bucket: this.config.bucket, Key: key })
        : new PutObjectCommand({ Bucket: this.config.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: ttlSeconds });
  }
}
