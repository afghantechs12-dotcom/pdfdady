import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { streamZipFiles } from "./zip";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfdadi-zip-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(file: string, content: string): Promise<string> {
  const p = path.join(dir, file);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
}

/** Streams a zip then reads it back with JSZip to verify entries + contents. */
async function readZip(zipPath: string): Promise<Map<string, string>> {
  const buf = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, string>();
  await Promise.all(
    Object.keys(zip.files).map(async (name) => {
      const entry = zip.files[name];
      if (!entry.dir) out.set(name, await entry.async("string"));
    }),
  );
  return out;
}

describe("streamZipFiles", () => {
  it("streams a multi-file zip to disk and round-trips through JSZip", async () => {
    const a = await write("a.txt", "alpha");
    const b = await write("nested/b.txt", "beta");
    const zipPath = await streamZipFiles(dir, [
      { filePath: a, name: "a.txt" },
      { filePath: b, name: "nested/b.txt" },
    ], "out.zip");

    expect(path.basename(zipPath)).toBe("out.zip");
    const entries = await readZip(zipPath);
    expect(entries.get("a.txt")).toBe("alpha");
    expect(entries.get("nested/b.txt")).toBe("beta");
  });

  it("defaults the entry name to the file's basename", async () => {
    const f = await write("photo.jpg", "jpg-bytes");
    const zipPath = await streamZipFiles(dir, [{ filePath: f }], "out.zip");
    const entries = await readZip(zipPath);
    expect(entries.get("photo.jpg")).toBe("jpg-bytes");
  });

  it("handles many entries (streaming — never holds the whole archive)", async () => {
    const entries = [];
    for (let i = 0; i < 50; i++) {
      const p = await write(`p-${i}.bin`, `page-${i}-`.repeat(100));
      entries.push({ filePath: p, name: `p-${i}.bin` });
    }
    const zipPath = await streamZipFiles(dir, entries, "many.zip");
    const read = await readZip(zipPath);
    expect(read.size).toBe(50);
    expect(read.get("p-0.bin")).toBe("page-0-".repeat(100));
    expect(read.get("p-49.bin")).toBe("page-49-".repeat(100));
  }, 15_000);

  it("sanitizes a path-traversal zip name (basename keeps it inside jobDir)", async () => {
    const f = await write("a.txt", "x");
    const zipPath = await streamZipFiles(dir, [{ filePath: f }], "../escape.zip");
    // safeJoin strips the "../" via basename → the zip lands inside jobDir.
    expect(path.dirname(zipPath)).toBe(dir);
    expect(path.basename(zipPath)).toBe("escape.zip");
    const entries = await readZip(zipPath);
    expect(entries.get("a.txt")).toBe("x");
  });
});
