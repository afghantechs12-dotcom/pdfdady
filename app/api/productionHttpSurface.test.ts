import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { globSync } from "node:fs";

/**
 * Repo-wide guard on the production HTTP surface.
 *
 * The invariant, stated as the launch-readiness slice states it:
 *
 *   probe/test helper code may exercise production code,
 *   but production HTTP code must not contain a hidden probe bypass.
 *
 * `scripts/*-probe.mjs` are maintained and deliberately untouched: they drive the
 * real app over real HTTP, which is exactly the right way to probe. What must
 * never appear is the inverse — a route that reads an env var, header or query
 * parameter and skips a guard because something claims to be a test.
 *
 * This scans source text rather than behaviour on purpose: the failure mode it
 * defends against is a NEW route added later with a convenient shortcut in it, so
 * the fixture has to be the whole repo. That makes the scan itself the thing most
 * likely to rot, so it asserts its own coverage below — a glob that matches
 * nothing would otherwise pass silently and prove nothing.
 */

const ROOT = process.cwd();

function routeFiles(): string[] {
  return globSync("app/api/**/route.ts", { cwd: ROOT }).sort();
}

/** Reads a repo-relative file as text. */
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/**
 * Env-var names that would unlock behaviour if a route consulted them. Matched
 * against `process.env.X` reads inside route handlers.
 */
const FORBIDDEN_ENV = /process\.env\.[A-Z0-9_]*(BYPASS|SKIP_AUTH|DISABLE_AUTH|NO_AUTH|TEST_MODE|ALLOW_INSECURE|E2E|PLAYWRIGHT|FIXTURE|SEED_ADMIN)[A-Z0-9_]*/;

/**
 * Request-controlled escape hatches: a caller-supplied header or query parameter
 * whose name announces that it turns a check off.
 */
const FORBIDDEN_REQUEST_KEY =
  /["'`](x-)?(test|debug|bypass|force[-_]?admin|skip[-_]?auth|no[-_]?auth|impersonate|__probe|__test)["'`]/i;

/**
 * `NODE_ENV` has exactly one legitimate use inside a route: relaxing the cookie
 * `secure` flag so sessions work over plain http in local dev. Any OTHER read is
 * a development shortcut in production code and must be justified explicitly.
 */
const NODE_ENV_READ = /process\.env\.NODE_ENV/g;
const LEGITIMATE_NODE_ENV = /secure:\s*process\.env\.NODE_ENV === "production"/;

describe("production HTTP surface", () => {
  const files = routeFiles();

  it("scans the real route tree (guards against a vacuous glob)", () => {
    // ~130 route handlers today. A collapse to zero or a handful means the glob
    // broke, not that the repo shrank — and every assertion below would pass.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("app/api/health/route.ts");
    expect(files).toContain("app/api/admin/setup/route.ts");
  });

  it("has no route that unlocks behaviour from a test/debug env var", () => {
    const offenders = files.filter((f) => FORBIDDEN_ENV.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("has no route that takes a test/debug escape hatch from the request", () => {
    const offenders = files.filter((f) => FORBIDDEN_REQUEST_KEY.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("reads NODE_ENV only to relax the dev cookie flag", () => {
    const offenders = files.filter((f) => {
      const src = read(f);
      const reads = src.match(NODE_ENV_READ)?.length ?? 0;
      if (reads === 0) return false;
      // Every read in the file must be the cookie-flag idiom.
      const legitimate = src.match(
        /secure:\s*process\.env\.NODE_ENV === "production"/g,
      )?.length ?? 0;
      return legitimate !== reads;
    });
    expect(offenders).toEqual([]);
  });

  it("keeps the one legitimate NODE_ENV idiom actually present", () => {
    // Not decoration: if the cookie-flag idiom disappeared, the rule above would
    // become unfalsifiable and quietly stop testing anything.
    const withCookieFlag = files.filter((f) => LEGITIMATE_NODE_ENV.test(read(f)));
    expect(withCookieFlag.length).toBeGreaterThan(0);
  });

  it("exposes the toolchain breakdown only behind the admin guard", () => {
    // The public readiness probe may say WHETHER it is ready; only the
    // admin-gated route may say which binaries are missing. What the readiness
    // probe actually puts in its body is asserted behaviourally in
    // app/api/health/readyRoute.test.ts.
    expect(read("app/api/health/dependencies/route.ts")).toMatch(/requireAdmin/);
  });
});
