import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { UploadService } from "./UploadService";
import { InMemoryStoredFileRepository } from "@/src/infrastructure/persistence/InMemoryStoredFileRepository";
import { ConsoleLogger } from "@/src/infrastructure/logging/ConsoleLogger";
import type {
  IObjectStorage,
  ObjectMetadata,
  PutOptions,
  StreamPutOptions,
  StreamPutResult,
} from "@/src/application/ports/storage/ObjectStorage";

/** Fake storage that counts puts so we can assert dedup behavior. */
class FakeStorage implements IObjectStorage {
  puts = 0;
  putStreams = 0;
  private readonly store = new Map<string, Buffer>();
  async put(key: string, data: Buffer | Uint8Array, _options: PutOptions): Promise<void> {
    this.puts += 1;
    this.store.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const b = this.store.get(key);
    if (!b) throw new Error(`missing: ${key}`);
    return b;
  }
  async getStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const b = this.store.get(key);
    if (!b) throw new Error(`missing: ${key}`);
    return new Response(b).body as ReadableStream<Uint8Array>;
  }
  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: StreamPutOptions,
  ): Promise<StreamPutResult> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    const data = Buffer.concat(chunks);
    this.putStreams += 1;
    this.store.set(key, data);
    const sha256 =
      options.sha256 ?? crypto.createHash("sha256").update(data).digest("hex");
    return { sha256, size };
  }
  async head(key: string): Promise<ObjectMetadata> {
    return {
      key,
      size: this.store.get(key)?.length ?? 0,
      contentType: null,
      exists: this.store.has(key),
    };
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const logger = () => new ConsoleLogger("error");
const input = (ownerId: string, data: Buffer) => ({
  ownerType: "anon" as const,
  ownerId,
  originalName: "f.pdf",
  mimeType: "application/pdf",
  data,
});

const webStream = (data: Buffer): ReadableStream<Uint8Array> =>
  Readable.toWeb(Readable.from([data])) as ReadableStream<Uint8Array>;

describe("UploadService", () => {
  it("stores a new file and records metadata", async () => {
    const storage = new FakeStorage();
    const meta = new InMemoryStoredFileRepository();
    const svc = new UploadService(storage, meta, logger());
    const { file, deduplicated } = await svc.upload(input("a", Buffer.from("content")));
    expect(deduplicated).toBe(false);
    expect(file.size).toBe(7);
    expect(storage.puts).toBe(1);
  });

  it("deduplicates when the same owner re-uploads the same bytes", async () => {
    const storage = new FakeStorage();
    const meta = new InMemoryStoredFileRepository();
    const svc = new UploadService(storage, meta, logger());
    await svc.upload(input("a", Buffer.from("content")));
    const second = await svc.upload(input("a", Buffer.from("content")));
    expect(second.deduplicated).toBe(true);
    expect(storage.puts).toBe(1); // no second storage write
  });

  it("byte-deduplicates across owners (new metadata row, no second put)", async () => {
    const storage = new FakeStorage();
    const meta = new InMemoryStoredFileRepository();
    const svc = new UploadService(storage, meta, logger());
    await svc.upload(input("a", Buffer.from("shared")));
    const second = await svc.upload(input("b", Buffer.from("shared")));
    expect(second.deduplicated).toBe(false); // different owner → new row
    expect(storage.puts).toBe(1); // bytes already stored → no second put
  });

  it("uploadStream stores via putStream with the explicit key and records sha256 + size", async () => {
    const storage = new FakeStorage();
    const meta = new InMemoryStoredFileRepository();
    const svc = new UploadService(storage, meta, logger());
    const data = Buffer.from("streamed-output");
    const { file, deduplicated } = await svc.uploadStream({
      ownerType: "anon",
      ownerId: "job-1",
      originalName: "out.pdf",
      mimeType: "application/pdf",
      data: webStream(data),
      key: "jobs/job-1/output/out.pdf",
      expiresAt: null,
    });
    expect(deduplicated).toBe(false); // explicit-key path never dedups
    expect(storage.putStreams).toBe(1);
    expect(file.key).toBe("jobs/job-1/output/out.pdf");
    expect(file.size).toBe(data.length);
    expect(file.sha256).toBe(
      crypto.createHash("sha256").update(data).digest("hex"),
    );
    expect(file.originalName).toBe("out.pdf");
  });

  it("uploadStream records the retention expiry on the metadata row", async () => {
    const storage = new FakeStorage();
    const meta = new InMemoryStoredFileRepository();
    const svc = new UploadService(storage, meta, logger());
    const expiresAt = new Date(Date.now() + 60_000);
    const { file } = await svc.uploadStream({
      ownerType: "anon",
      ownerId: "job-2",
      originalName: "out.pdf",
      mimeType: "application/pdf",
      data: webStream(Buffer.from("x")),
      key: "jobs/job-2/output/out.pdf",
      expiresAt,
    });
    expect(file.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });
});
