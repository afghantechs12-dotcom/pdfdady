/**
 * ObjectStorage port — the lowest-level byte-store abstraction.
 *
 * Adapters: `LocalFileStorage` (node:fs, dev/standalone) and `R2ObjectStorage`
 * (Cloudflare R2 / any S3-compatible store, prod). The application layer never
 * knows which one is behind it. Multipart upload is a separate port
 * (IMultipartUpload) for large files.
 */
export interface PutOptions {
  contentType: string;
  /** Optional sha256 for content-addressing / dedup; adapters may skip if absent. */
  sha256?: string;
}

export interface ObjectMetadata {
  key: string;
  size: number;
  contentType: string | null;
  exists: boolean;
}

export interface StreamPutOptions {
  contentType: string;
  /**
   * If supplied, the adapter returns it in the result without recomputing.
   * When absent the adapter computes the sha256 on the fly as bytes flow.
   */
  sha256?: string;
}

/**
 * Result of a streaming put: the sha256 and total byte count, computed as the
 * stream flowed so the caller never holds the whole object in memory. Used to
 * record file metadata (key, sha256, size) without buffering the output.
 */
export interface StreamPutResult {
  sha256: string;
  size: number;
}

export interface IObjectStorage {
  /** Stores `data` under `key`. Overwrites if the key already exists. */
  put(key: string, data: Buffer | Uint8Array, options: PutOptions): Promise<void>;

  /** Streams/loads the bytes for `key`. Throws if the key does not exist. */
  get(key: string): Promise<Buffer>;

  /**
   * Streams the bytes for `key` as a Web ReadableStream — the object is never
   * fully materialized in memory. Use this for large files (serving a download,
   * materializing an input to disk). Throws if the key does not exist. The
   * returned stream is a fresh, unconsumed stream each call.
   */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;

  /**
   * Streams `stream` into `key`, computing the sha256 and total size on the fly
   * and returning them — the object is never fully buffered. The caller chooses
   * the key (content-addressed for inputs, job-scoped for outputs). Use this for
   * large files (storing a processor's output) instead of `put`.
   */
  putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: StreamPutOptions,
  ): Promise<StreamPutResult>;

  /** Lightweight existence + size check without loading the bytes. */
  head(key: string): Promise<ObjectMetadata>;

  /** Removes `key`. Idempotent (no error if the key is missing). */
  delete(key: string): Promise<void>;
}
