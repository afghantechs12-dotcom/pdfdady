import { afterEach, describe, expect, it, vi } from "vitest";
import path from "path";

/**
 * R1 — the admin store is written where the operator said, not where the process
 * happens to be standing.
 *
 * This is the reader half of a two-part guard. `productionProblems` refuses a
 * deployment whose `ADMIN_STORE_DIR` would land inside a build output; that refusal
 * is worth nothing if this module ignores the variable, and the failure would be
 * invisible — the gate would name a variable that does nothing while the admin
 * password hash kept landing in `.next/standalone/data/admin/`, where the next
 * `npm run build` deletes it and `/admin/setup` re-opens to an unauthenticated
 * visitor.
 *
 * `resetModules` because the path is resolved once at module load, which is the
 * behaviour under test: the server reads `process.env` at boot, not per request.
 */
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("admin store location", () => {
  it("puts the store under ADMIN_STORE_DIR when it is set", async () => {
    vi.resetModules();
    vi.stubEnv("ADMIN_STORE_DIR", "/srv/pdfdadi/admin");
    const { STORE_PATH, ADMIN_STORE_DIR } = await import("./index");
    expect(ADMIN_STORE_DIR).toBe("/srv/pdfdadi/admin");
    expect(STORE_PATH).toBe("/srv/pdfdadi/admin/store.json");
  });

  it("falls back to <working directory>/data/admin when it is unset", async () => {
    // The dev default, and the one the production gate exists to refuse: in
    // production the working directory is the build output.
    vi.resetModules();
    vi.stubEnv("ADMIN_STORE_DIR", "");
    const { STORE_PATH } = await import("./index");
    expect(STORE_PATH).toBe(path.join(process.cwd(), "data", "admin", "store.json"));
  });
});
