import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { safeJoin } from "./tempFiles";

export interface ZipEntry {
  /** Absolute path of the file to add to the archive. */
  filePath: string;
  /** Name inside the zip (defaults to the file's basename). */
  name?: string;
}

/**
 * Streams a zip of the given files to `<jobDir>/<zipName>` using archiver.
 *
 * Unlike JSZip's `generateAsync({ type: "nodebuffer" })` — which builds the
 * entire archive in memory before yielding a single byte — archiver (a
 * Transform stream) writes the zip to disk incrementally as each entry is read.
 * For a multi-page pdf-to-images run (or a batch of N outputs) the zip is never
 * held whole in memory; it lands on disk and is then streamed to object storage
 * by the job handler via uploadStream. Returns the absolute path to the zip.
 */
export async function streamZipFiles(
  jobDir: string,
  entries: ZipEntry[],
  zipName: string,
): Promise<string> {
  const outPath = safeJoin(jobDir, zipName);
  const out = createWriteStream(outPath);
  // zlib level 6 balances size and CPU; image/PDF payloads are already
  // compressed so this mostly affects the archive container overhead.
  const zip = new ZipArchive({ zlib: { level: 6 } });

  // pipeline propagates archiver/write errors and respects backpressure.
  const done = pipeline(zip, out);

  for (const entry of entries) {
    zip.file(entry.filePath, { name: entry.name ?? path.basename(entry.filePath) });
  }
  await zip.finalize();
  await done;
  return outPath;
}
