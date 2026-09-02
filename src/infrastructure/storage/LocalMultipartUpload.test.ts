import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMultipartUpload } from "./LocalMultipartUpload";
import { LocalFileStorage } from "./LocalFileStorage";

let root: string;
let multipartRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pdfdadi-multipart-"));
  multipartRoot = path.join(root, ".multipart");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("LocalMultipartUpload", () => {
  it("creates a session, receives parts, and completes to the final object", async () => {
    const storage = new LocalFileStorage(root);
    const mp = new LocalMultipartUpload(storage, multipartRoot, "http://localhost:3000");
    const session = await mp.create("outputs/final.bin", "application/octet-stream", 3, 4);
    expect(session.parts).toHaveLength(3);
    expect(session.parts[0].url).toContain("/api/storage/multipart/");

    await mp.receivePart(session.uploadId, 1, Buffer.from("aa"));
    await mp.receivePart(session.uploadId, 2, Buffer.from("bb"));
    await mp.receivePart(session.uploadId, 3, Buffer.from("cc"));

    const { key } = await mp.complete(session, [
      { partNumber: 3, etag: "z" },
      { partNumber: 1, etag: "x" },
      { partNumber: 2, etag: "y" },
    ]);
    expect(key).toBe("outputs/final.bin");
    expect((await storage.get("outputs/final.bin")).toString()).toBe("aabbcc");
  });

  it("abort removes the multipart directory", async () => {
    const storage = new LocalFileStorage(root);
    const mp = new LocalMultipartUpload(storage, multipartRoot, "http://localhost:3000");
    const session = await mp.create("outputs/x.bin", "application/octet-stream", 2, 4);
    await mp.receivePart(session.uploadId, 1, Buffer.from("aa"));
    await mp.abort(session);
    await expect(fs.stat(path.join(multipartRoot, session.uploadId))).rejects.toThrow();
  });
});
