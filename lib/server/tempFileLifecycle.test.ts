/**
 * R17 — the temp-file lifecycle: user bytes leave the disk, and a recursive `rm`
 * whose argument is computed elsewhere cannot be talked into deleting something
 * else.
 *
 * Real filesystem, no mocks. Mocking `fs` here would assert that this code calls
 * `rm` with a string, which is not the property — the property is that the bytes
 * are gone afterwards and that the ones outside the boundary are still there.
 *
 * Nothing asserts on the CONTENTS of the shared `/tmp/pdfdadi` root, only on paths
 * this file created: a parallel worker, another suite, or a previous run's
 * abandoned directory all live in that root too, and a test that counted its
 * entries would fail for reasons that are not bugs.
 */
import { mkdtemp, mkdir, writeFile, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupJob } from "./cleanup";
import {
  createJobDir,
  createProcessingWorkDir,
  processingTempRoot,
  removeProcessingWorkDir,
  safeJoin,
} from "./tempFiles";

const made: string[] = [];
const track = <T extends string>(dir: T): T => (made.push(dir), dir);
const exists = (p: string) => stat(p).then(() => true, () => false);

afterAll(async () => {
  // Only what this file created, and never the shared root itself.
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

describe("cleanupJob — the finally-block contract", () => {
  it("removes the directory and every user file inside it", async () => {
    const jobDir = track(await createJobDir());
    await writeFile(path.join(jobDir, "invoice.pdf"), "%PDF-1.7 private");
    await mkdir(path.join(jobDir, "pages"));
    await writeFile(path.join(jobDir, "pages", "1.png"), "png bytes");
    expect(await exists(path.join(jobDir, "pages", "1.png"))).toBe(true);

    await cleanupJob(jobDir);

    expect(await exists(jobDir)).toBe(false);
  });

  it("does nothing at all when the job never got a directory", async () => {
    const probe = track(await createJobDir());
    // A null jobDir must not resolve to the temp root and take the neighbours
    // with it: `rm(path.join(tmpdir(), String(null)))` is one refactor away.
    await expect(cleanupJob(null)).resolves.toBeUndefined();
    expect(await exists(probe)).toBe(true);
    expect(await exists(tmpdir())).toBe(true);
  });

  it("stays silent when the directory is already gone, twice over", async () => {
    const jobDir = await createJobDir();
    await cleanupJob(jobDir);
    // The route's `finally` runs after a throw. If cleanup threw here it would
    // replace the real error with a misleading one.
    await expect(cleanupJob(jobDir)).resolves.toBeUndefined();
  });
});

describe("safeJoin — an untrusted filename becoming a path", () => {
  it("keeps a traversal attempt inside the job directory", async () => {
    const jobDir = track(await createJobDir());
    const full = safeJoin(jobDir, "../../../../etc/passwd");
    expect(full.startsWith(jobDir + path.sep)).toBe(true);
    expect(path.basename(full)).toBe("passwd");
    // And the boundary holds in practice, not only in the string.
    await writeFile(full, "x");
    expect(await readdir(jobDir)).toEqual(["passwd"]);
  });

  it("neutralizes names with nothing usable left in them", async () => {
    const jobDir = track(await createJobDir());
    for (const [name, expected] of [
      ["", "file"],
      ["   ", "_"],
      ["a b/c;d.pdf", "c_d.pdf"],
      ["\u0000hidden.pdf", "_hidden.pdf"],
    ] as const) {
      expect([name, path.basename(safeJoin(jobDir, name))]).toEqual([name, expected]);
    }
  });

  it("refuses outright the two names the character filter cannot save", () => {
    // `.` and `-` are legal in filenames, so the `[^\w.-]` filter leaves ".."
    // intact and `path.resolve(jobDir, "..")` is the parent directory. The
    // second guard is what stops it, and these are the only inputs that reach
    // it — asserting the throw is asserting that guard is not dead code.
    const jobDir = "/tmp/pdfdadi-fake-job";
    for (const name of ["..", "../"]) {
      expect(() => safeJoin(jobDir, name), name).toThrow("Invalid file path.");
    }
    // Three dots is an ordinary filename; the refusal is narrow, not a ban on dots.
    expect(safeJoin(jobDir, "...")).toBe(`${jobDir}/...`);
    // And a trailing segment saves it: basename splits before the filter runs.
    expect(safeJoin(jobDir, "  ../  ")).toBe(`${jobDir}/_`);
  });
});

describe("the processing work directory and its boundary", () => {
  it("sanitizes a hostile job id and still lands under the root", async () => {
    const dir = track(await createProcessingWorkDir("../../etc/evil-job"));
    expect(dir.startsWith(processingTempRoot() + path.sep)).toBe(true);
    expect(path.basename(dir)).toMatch(/^_etc_evil-job-[\w]+$/);
    // 0700: the scratch space holds a user's document while it is being processed.
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("gives two jobs sharing an id two different directories", async () => {
    const [a, b] = [
      track(await createProcessingWorkDir("same-id")),
      track(await createProcessingWorkDir("same-id")),
    ];
    expect(a).not.toBe(b);
    expect([await exists(a), await exists(b)]).toEqual([true, true]);
  });

  it("removes its own directory, contents and all", async () => {
    const dir = await createProcessingWorkDir("cleanup-me");
    await writeFile(path.join(dir, "in.pdf"), "%PDF");
    await removeProcessingWorkDir(dir);
    expect(await exists(dir)).toBe(false);
  });

  it("refuses a path outside the root instead of deleting it", async () => {
    // A directory that genuinely exists, with a file in it, so the guard is what
    // spares it rather than the absence of anything to delete.
    const outside = track(await mkdtemp(path.join(tmpdir(), "not-pdfdadi-")));
    const keep = path.join(outside, "someone-elses.pdf");
    await writeFile(keep, "%PDF");

    await expect(removeProcessingWorkDir(outside)).resolves.toBeUndefined();
    await expect(removeProcessingWorkDir(path.join(outside, ".."))).resolves.toBeUndefined();

    expect(await exists(keep)).toBe(true);
  });

  it("refuses the shared root itself, which would wipe every concurrent job", async () => {
    const root = processingTempRoot();
    const mine = track(await createProcessingWorkDir("co-tenant"));

    await removeProcessingWorkDir(root);
    await removeProcessingWorkDir(`${root}/`);
    await removeProcessingWorkDir(null);

    expect(await exists(mine)).toBe(true);
    expect(await exists(root)).toBe(true);
  });
});
