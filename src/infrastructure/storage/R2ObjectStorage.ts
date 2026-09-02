import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import type {
  IObjectStorage,
  ObjectMetadata,
  PutOptions,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";
import type { R2Config } from "@/src/infrastructure/config/env";
import { webStreamToNodeReadable } from "./streamBridge";

/**
 * Cloudflare R2 IObjectStorage adapter (S3-compatible). Only constructed when
 * R2 credentials are present (see container.ts); with no creds the app uses
 * LocalFileStorage and this class is never instantiated, so the build/test path
 * needs no cloud account. Swapping R2 for another S3-compatible store means
 * changing the endpoint here only — the interface is unchanged.
 *
 * `getStream` returns the object body as a Web ReadableStream (the S3 SDK body
 * exposes `transformToWebStream`); `putStream` uploads the stream with chunked
 * transfer-encoding (R2 supports streaming PUTs of unknown length) while teeing
 * every chunk through an in-process sha256 + byte counter.
 */
export class R2ObjectStorage implements IObjectStorage {
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

  async put(
    key: string,
    data: Buffer | Uint8Array,
    options: PutOptions,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: data,
        ContentType: options.contentType,
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty response for key: ${key}`);
    return Buffer.from(bytes);
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`Empty response for key: ${key}`);
    // S3 SDK bodies expose transformToWebStream() → a fresh Web ReadableStream
    // the caller reads directly; the object is never buffered whole.
    return res.Body.transformToWebStream();
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: StreamPutOptions,
  ): Promise<StreamPutResult> {
    const hash = crypto.createHash("sha256");
    let size = 0;
    // Tee chunks through the hash + counter; the SDK reads the Transform as the
    // upload Body (paused-mode consumption with backpressure). pipe() feeds it
    // from the source; when the source ends the upload completes and the hash
    // is final.
    const tee = new Transform({
      transform(chunk, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
        cb(null, chunk);
      },
    });
    const source = webStreamToNodeReadable(stream);
    source.pipe(tee);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
          Body: tee,
          ContentType: options.contentType,
        }),
      );
    } catch (err) {
      // Tear down the in-flight streams so the source isn't left dangling.
      source.destroy();
      tee.destroy();
      throw err;
    }
    return { sha256: options.sha256 ?? hash.digest("hex"), size };
  }

  async head(key: string): Promise<ObjectMetadata> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        key,
        size: res.ContentLength ?? 0,
        contentType: res.ContentType ?? null,
        exists: true,
      };
    } catch {
      return { key, size: 0, contentType: null, exists: false };
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
  }
}
