import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { isAdminPasswordSet } from "@/lib/admin/passwords";

/**
 * R1 — the tree ships no admin password, and nothing under `data/admin` carries a
 * credential.
 *
 * `data/admin/store.json` is source: it is tracked, it is copied into the Docker
 * image, and the image seeds it into the `pdfdadi-data` volume on first attach. So
 * whatever `settings.adminPasswordHash` holds in this repository is the password
 * of every deployment built from it.
 *
 * It held a real scrypt hash. Milestone 1 had already removed a default password
 * and recorded `data/admin/store.json — adminPasswordHash → ""` as done; a later
 * admin save on a developer machine wrote a live hash back into the tracked file,
 * and nothing noticed, because the only thing asserting the field was empty was a
 * line in a completion document. The consequence is not merely a leaked hash:
 * `/api/admin/setup` answers **409 "An admin password is already configured"** when
 * one is set, so a fresh production deployment could not perform its own
 * documented first-run step, and `/admin` opened for exactly one password — the
 * one in Git.
 *
 * Asserted through `isAdminPasswordSet`, the predicate the setup and login routes
 * actually branch on, rather than against a string shape: the guarantee is "this
 * deployment starts with no admin password", and that predicate IS that sentence.
 *
 * The second half scans every JSON file in the directory, not just the store. The
 * atomic `writeStore` keeps a `.bak` copy of the previous good file, and that file
 * was tracked too — holding a credential in a path no reader of `store.json` would
 * think to check. It is now gitignored; this test is what makes its return loud.
 */
const ADMIN_DIR = path.join(process.cwd(), "data", "admin");

/** `salt:hash` as `hashPassword` writes it — 32 hex, colon, 64 hex. */
const SCRYPT_SHAPE = /"adminPasswordHash"\s*:\s*"[0-9a-f]{16,}:[0-9a-f]{32,}"/;

describe("R1 the shipped admin store carries no credential", () => {
  it("store.json ships with no admin password set", () => {
    const store = JSON.parse(readFileSync(path.join(ADMIN_DIR, "store.json"), "utf-8"));
    expect(store.settings.adminPasswordHash).toBe("");
    expect(isAdminPasswordSet(store.settings.adminPasswordHash)).toBe(false);
  });

  it("no JSON file under data/admin holds a scrypt password hash", () => {
    const offenders = readdirSync(ADMIN_DIR)
      .filter((name) => name.includes(".json"))
      .filter((name) => SCRYPT_SHAPE.test(readFileSync(path.join(ADMIN_DIR, name), "utf-8")));
    expect(offenders).toEqual([]);
  });
});
