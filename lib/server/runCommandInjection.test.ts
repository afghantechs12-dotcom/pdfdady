import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "./runCommand";

/**
 * R14 — a processing argument cannot become shell syntax.
 *
 * `runCommand` is the single seam every external binary goes through, and its
 * whole safety claim is the argument ARRAY: user-controlled text (an uploaded
 * file's name, a page range, a password) is handed to the child as one literal
 * argv entry, never spliced into a command line. Nothing exercised that claim —
 * every handler test injects a fake runner, so the real `execFile` call was
 * unmeasured, and a switch to `exec`/`shell: true` would have stayed green.
 *
 * These run a real child process (`/bin/echo`), because the guarantee is about
 * what the operating system receives, not about how the call is written.
 */
const sentinel = join(tmpdir(), `pdfdadi-injection-${process.pid}.txt`);
const redirected = join(tmpdir(), `pdfdadi-redirect-${process.pid}.txt`);

afterEach(() => {
  // Both are removed because a failing run means the shell DID create them, and
  // a leftover would then fail the reverted run and read as a second defect.
  rmSync(sentinel, { force: true });
  rmSync(redirected, { force: true });
});

describe("runCommand argument safety", () => {
  it("passes shell metacharacters through as one literal argument", async () => {
    const hostile = `report; touch ${sentinel}`;
    const { stdout } = await runCommand("/bin/echo", [hostile]);

    expect(stdout.trim()).toBe(hostile);
    expect(existsSync(sentinel)).toBe(false);
  });

  it("does not expand substitutions, globs or redirections in an argument", async () => {
    const hostile = `$(id) \`id\` $HOME * > ${redirected} && id`;
    const { stdout } = await runCommand("/bin/echo", [hostile]);

    expect(stdout.trim()).toBe(hostile);
    expect(existsSync(redirected)).toBe(false);
  });

  it("keeps a hostile file name intact instead of splitting it into words", async () => {
    const name = "in voice'\";rm -rf ~.pdf";
    const { stdout } = await runCommand("/bin/echo", ["--input", name, "--last"]);

    expect(stdout.trim()).toBe(`--input ${name} --last`);
  });
});
