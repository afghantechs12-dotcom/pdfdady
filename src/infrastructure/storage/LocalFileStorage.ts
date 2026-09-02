import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  IObjectStorage,
  ObjectMetadata,
  PutOptions,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";
import {
  webStreamToNodeReadable,
  nodeReadableToWebStream,
} from "./streamBridge";

/**
 * Local-filesystem IObjectStorage adapter — the dev/standalone default.
 *
 * Stores bytes under `rootDir/<key>` with path-traversal protection (keys never
 * escape the root). No external services, no credentials. The R2 adapter
 * implements the same interface for production. `getStream`/`putStream` flow
 * bytes through node streams so a large object never sits whole in memory.
 */
export class LocalFileStorage implements IObjectStorage {
  /**
   * The root, resolved to an absolute path once.
   *
   * `path.resolve` always returns an absolute path, so comparing its result
   * against a *relative* root (the `.storage/local` default) never matches and
   * the traversal guard rejects every legitimate key. Normalizing here keeps
   * both sides of that comparison in the same form; the guard itself is
   * unchanged, and a key that really does escape the root still throws.
   */
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Invalid storage key (escapes root): ${key}`);
    }
    return full;
  }

  async put(
    key: string,
    data: Buffer | Uint8Array,
    _options: PutOptions,
  ): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async get(key: string): Promise<Buffer> {
    const full = this.resolve(key);
    return fs.readFile(full); // throws ENOENT if missing — intended.
  }

  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const full = this.resolve(key);
    // Verify existence so missing keys throw synchronously like get(), rather
    // than emitting an 'error' on a stream the caller may not have wired yet.
    await fs.access(full);
    // createReadStream produces Buffer chunks (a Uint8Array subtype); the bridge
    // surfaces them as Uint8Array on the Web ReadableStream.
    return nodeReadableToWebStream(createReadStream(full));
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: StreamPutOptions,
  ): Promise<StreamPutResult> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });

    const hash = crypto.createHash("sha256");
    let size = 0;
    // Tee every chunk through the hash + counter, then to the file. pipeline
    // propagates errors and respects backpressure — the object is never held
    // whole in memory.
    const tally = new Transform({
      transform(chunk, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
        cb(null, chunk);
      },
    });
    await pipeline(webStreamToNodeReadable(stream), tally, createWriteStream(full));
    return { sha256: options.sha256 ?? hash.digest("hex"), size };
  }

  async head(key: string): Promise<ObjectMetadata> {
    const full = this.resolve(key);
    try {
      const stat = await fs.stat(full);
      return { key, size: stat.size, contentType: null, exists: true };
    } catch {
      return { key, size: 0, contentType: null, exists: false };
    }
  }

  async delete(key: string): Promise<void> {
    const full = this.resolve(key);
    await fs.rm(full, { force: true }); // idempotent
  }
}
