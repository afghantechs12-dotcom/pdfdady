import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { LocalFileStorage } from "./LocalFileStorage";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pdfdadi-storage-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Drains a Web ReadableStream into a Buffer. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A Web ReadableStream of `data`, chunked to exercise the streaming path. */
function toWebStream(data: Buffer): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from([data.subarray(0, 3), data.subarray(3)])) as ReadableStream<Uint8Array>;
}

describe("LocalFileStorage", () => {
  it("puts, gets, heads, and deletes an object", async () => {
    const s = new LocalFileStorage(root);
    await s.put("a/b/file.pdf", Buffer.from("hello"), {
      contentType: "application/pdf",
    });
    expect((await s.get("a/b/file.pdf")).toString()).toBe("hello");
    const h = await s.head("a/b/file.pdf");
    expect(h.exists).toBe(true);
    expect(h.size).toBe(5);
    await s.delete("a/b/file.pdf");
    expect((await s.head("a/b/file.pdf")).exists).toBe(false);
  });

  it("get throws on a missing key", async () => {
    const s = new LocalFileStorage(root);
    await expect(s.get("nope")).rejects.toThrow();
  });

  it("delete is idempotent on a missing key", async () => {
    const s = new LocalFileStorage(root);
    await expect(s.delete("nope")).resolves.toBeUndefined();
  });

  it("rejects path-traversal keys that escape the root", async () => {
    const s = new LocalFileStorage(root);
    await expect(
      s.put("../escape", Buffer.from("x"), { contentType: "application/octet-stream" }),
    ).rejects.toThrow(/escapes root/);
  });

  /**
   * The configured default root is RELATIVE (`.storage/local`). `path.resolve`
   * returns an absolute path, so comparing it against a relative root rejected
   * every legitimate key and made all uploads fail in the default configuration.
   */
  it("accepts ordinary keys when constructed with a relative root", async () => {
    const relative = path.relative(process.cwd(), root);
    // Guard the premise: a root that is not relative would not exercise this.
    expect(path.isAbsolute(relative)).toBe(false);

    const s = new LocalFileStorage(relative);
    await s.put("org/ws/doc.pdf", Buffer.from("bytes"), { contentType: "application/pdf" });
    expect((await s.get("org/ws/doc.pdf")).toString()).toBe("bytes");
  });

  it("still blocks traversal when constructed with a relative root", async () => {
    const s = new LocalFileStorage(path.relative(process.cwd(), root));
    await expect(
      s.put("../escape", Buffer.from("x"), { contentType: "application/octet-stream" }),
    ).rejects.toThrow(/escapes root/);
  });

  it("blocks an absolute key that would escape the root", async () => {
    const s = new LocalFileStorage(root);
    await expect(
      s.put(path.join(root, "..", "escape"), Buffer.from("x"), {
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow(/escapes root/);
  });

  it("does not treat a sibling directory sharing the root's prefix as inside it", async () => {
    // `<root>-sibling` starts with the root string but is not under the root.
    const s = new LocalFileStorage(root);
    await expect(
      s.put(`../${path.basename(root)}-sibling/file.bin`, Buffer.from("x"), {
        contentType: "application/octet-stream",
      }),
    ).rejects.toThrow(/escapes root/);
  });

  it("putStream stores bytes and returns the computed sha256 + size", async () => {
    const s = new LocalFileStorage(root);
    const data = Buffer.from("streamed-body-content");
    const { sha256, size } = await s.putStream("out/file.bin", toWebStream(data), {
      contentType: "application/octet-stream",
    });
    expect(size).toBe(data.length);
    expect(sha256).toBe(crypto.createHash("sha256").update(data).digest("hex"));
    // Object landed on disk and round-trips through get().
    expect((await s.get("out/file.bin")).toString()).toBe(data.toString());
  });

  it("putStream returns a caller-supplied sha256 without recomputing", async () => {
    const s = new LocalFileStorage(root);
    const data = Buffer.from("abc");
    const { sha256 } = await s.putStream("o/f", toWebStream(data), {
      contentType: "application/octet-stream",
      sha256: "deadbeef",
    });
    expect(sha256).toBe("deadbeef");
  });

  it("getStream streams the bytes without buffering the whole object", async () => {
    const s = new LocalFileStorage(root);
    const data = Buffer.from("round-trip-stream");
    await s.put("o/f.bin", data, { contentType: "application/octet-stream" });
    const stream = await s.getStream("o/f.bin");
    expect(await drain(stream)).toEqual(data);
  });

  it("getStream throws on a missing key", async () => {
    const s = new LocalFileStorage(root);
    await expect(s.getStream("nope")).rejects.toThrow();
  });

  it("putStream then getStream round-trips a large-ish payload", async () => {
    const s = new LocalFileStorage(root);
    const data = crypto.randomBytes(64 * 1024); // 64 KiB, multiple chunks
    // Stream the payload in uneven chunks to exercise the tallying transform.
    const stream = Readable.toWeb(
      Readable.from([data.subarray(0, 1024), data.subarray(1024, 33000), data.subarray(33000)]),
    ) as ReadableStream<Uint8Array>;
    const { size, sha256 } = await s.putStream("o/big.bin", stream, {
      contentType: "application/octet-stream",
    });
    expect(size).toBe(data.length);
    expect(sha256).toBe(crypto.createHash("sha256").update(data).digest("hex"));
    expect(await drain(await s.getStream("o/big.bin"))).toEqual(data);
  });
});
