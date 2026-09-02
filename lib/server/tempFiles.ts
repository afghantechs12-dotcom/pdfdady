import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates a unique, isolated temp directory for a single processing job.
 * Files live only here and are removed in the route's finally block.
 */
export async function createJobDir(): Promise<string> {
  const base = path.join(tmpdir(), "pdfdadi-");
  return mkdtemp(base);
}

/**
 * Returns a safe absolute path INSIDE jobDir for the given untrusted name.
 * Strips any directory components to prevent path traversal — original
 * filenames are never trusted for filesystem paths.
 */
export function safeJoin(jobDir: string, untrustedName: string): string {
  const base = path.basename(untrustedName).replace(/[^\w.-]+/g, "_");
  const safe = base.length ? base : "file";
  const full = path.resolve(jobDir, safe);
  if (full !== jobDir && !full.startsWith(jobDir + path.sep)) {
    throw new Error("Invalid file path.");
  }
  return full;
}

export async function writeBuffer(
  filePath: string,
  data: Buffer | Uint8Array,
): Promise<void> {
  await writeFile(filePath, data);
}

export async function readBuffer(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}

export async function removeJobDir(jobDir: string): Promise<void> {
  try {
    await rm(jobDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; never throw from cleanup.
  }
}

/**
 * Root for unified-pipeline job directories: `/tmp/pdfdadi/`.
 *
 * A dedicated namespace (rather than `mkdtemp` straight into `/tmp`) so that an
 * operator can see, mount, quota or wipe processing scratch space as one thing,
 * and so the cleanup guard below has an unambiguous boundary to check against.
 */
export function processingTempRoot(): string {
  return path.join(tmpdir(), "pdfdadi");
}

/**
 * Creates this job's private work directory under `/tmp/pdfdadi/`.
 *
 * The name is `{jobId}-{random}`: the job id makes an abandoned directory
 * traceable when debugging, and `mkdtemp`'s random suffix is what makes the path
 * genuinely unpredictable. The job id alone would not be — a cuid embeds a
 * timestamp and a counter, so a co-tenant process could plausibly guess one and
 * pre-create or read the directory.
 *
 * `mkdtemp` also gives atomic creation with 0700 permissions, so there is no
 * window in which the directory exists but is world-readable.
 */
export async function createProcessingWorkDir(jobId: string): Promise<string> {
  const root = processingTempRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  // The job id reaches us from the database, but sanitize anyway: this value is
  // about to become a filesystem path, and "it came from our own table" is the
  // assumption every path-traversal bug is built on.
  const safeId = jobId.replace(/[^\w-]+/g, "_").slice(0, 64) || "job";
  return mkdtemp(path.join(root, `${safeId}-`));
}

/**
 * Removes a processing work directory, refusing anything outside the root.
 *
 * The guard is not paranoia about our own callers so much as about the future: a
 * recursive `rm` whose argument is computed elsewhere is one refactor away from
 * being handed `/` or a storage mount. Refusing rather than throwing keeps this
 * safe to call from a `finally` block, where an exception would mask the real
 * error.
 */
export async function removeProcessingWorkDir(dir: string | null): Promise<void> {
  if (!dir) return;
  const root = processingTempRoot();
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(root + path.sep)) return;
  try {
    await rm(resolved, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; never throw from cleanup.
  }
}
