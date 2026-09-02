/**
 * The client half of save identity: one key per intention, and the two ways an
 * intention is allowed to be repeated.
 *
 * These are the properties the server's guards assume. If a key the client mints
 * were refused by `normalizeSaveIntentKey`, every save would fail with "Save
 * reference is not valid"; if a key were NOT stable across a remount, a lost
 * response would produce a second document. Both are checked here against the real
 * server-side validator rather than against a copy of its rules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  newSaveIntentKey,
  saveIntentKeyForJob,
  saveIntentKeyForTarget,
} from "./saveIntent";
import {
  SAVE_INTENT_LIMITS,
  normalizeSaveIntentKey,
} from "@/src/domain/entities/WorkspaceSaveIntent";

/** A per-tab store, as `sessionStorage` behaves. */
function fakeStorage() {
  const values = new Map<string, string>();
  return {
    store: values,
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
}

const originalStorage = Reflect.get(globalThis, "sessionStorage");

afterEach(() => {
  if (originalStorage === undefined) Reflect.deleteProperty(globalThis, "sessionStorage");
  else Reflect.set(globalThis, "sessionStorage", originalStorage);
  vi.resetModules();
});

describe("a fresh intention", () => {
  it("is unguessable, unique, and accepted by the server that validates it", () => {
    const keys = Array.from({ length: 200 }, () => newSaveIntentKey());
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.length).toBeGreaterThanOrEqual(SAVE_INTENT_LIMITS.minKeyLength);
      // The contract that matters: the server accepts it unchanged.
      expect(normalizeSaveIntentKey(key)).toBe(key);
    }
  });

  it("still mints an acceptable key where randomUUID is unavailable", () => {
    // A non-secure context has no `crypto.randomUUID`. A key is not a secret, so
    // the fallback only has to stay unique and valid — and it must produce one,
    // because a save that cannot mint a key cannot happen at all.
    const withoutRandomUuid = { ...globalThis.crypto, randomUUID: undefined } as unknown as Crypto;
    const restore = vi.spyOn(globalThis, "crypto", "get").mockReturnValue(withoutRandomUuid);
    try {
      const keys = Array.from({ length: 50 }, () => newSaveIntentKey());
      expect(new Set(keys).size).toBe(50);
      for (const key of keys) expect(normalizeSaveIntentKey(key)).toBe(key);
    } finally {
      restore.mockRestore();
    }
  });
});

describe("a job's intention outlives the page", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "sessionStorage", fakeStorage());
  });

  it("is the same key every time the same job is saved", () => {
    const first = saveIntentKeyForJob("job_alpha");
    expect(saveIntentKeyForJob("job_alpha")).toBe(first);
    expect(saveIntentKeyForJob("job_beta")).not.toBe(first);
    expect(normalizeSaveIntentKey(first)).toBe(first);
  });

  it("survives a reload, because the result it belongs to does", async () => {
    const storage = fakeStorage();
    Reflect.set(globalThis, "sessionStorage", storage);
    const before = saveIntentKeyForJob("job_reload");
    expect([...storage.store.keys()]).toEqual(["pdfdadi.saveIntent.job.job_reload"]);

    // A reload: the module's own map is gone, the tab's storage is not. Pressing
    // Save again is the same intention, so it must not mint a second key.
    vi.resetModules();
    const reloaded = await import("./saveIntent");
    expect(reloaded.saveIntentKeyForJob("job_reload")).toBe(before);
  });

  it("still works, per page, when storage is blocked entirely", async () => {
    Reflect.set(globalThis, "sessionStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const fresh = await import("./saveIntent");
    const key = fresh.saveIntentKeyForJob("job_blocked");
    // A remount is still free; only a reload costs a new intention, which is a
    // duplicate document at worst and never a refused save.
    expect(fresh.saveIntentKeyForJob("job_blocked")).toBe(key);
    expect(normalizeSaveIntentKey(key)).toBe(key);
  });
});

describe("one intention per destination", () => {
  it("keeps a retry of the same destination identical, and separates two", () => {
    const base = newSaveIntentKey();
    const home = saveIntentKeyForTarget(base, "wks_home_0000000000000");
    expect(saveIntentKeyForTarget(base, "wks_home_0000000000000")).toBe(home);
    expect(saveIntentKeyForTarget(base, "wks_team_0000000000000")).not.toBe(home);
    // Both halves are still there: two saves of one result are visibly related,
    // which is what makes a conflict report legible in a log.
    expect(home.startsWith(base)).toBe(true);
    expect(normalizeSaveIntentKey(home)).toBe(home);
  });

  it("stays a valid key even for a destination id full of unusable characters", () => {
    // A Workspace id is a cuid, so this never happens; if it did, the request must
    // still be a save the server accepts rather than a validation error the user
    // cannot act on.
    const key = saveIntentKeyForTarget(newSaveIntentKey(), "wks/../../%20 weird");
    expect(normalizeSaveIntentKey(key)).toBe(key);
    expect(key).not.toContain("/");
    expect(key.length).toBeLessThanOrEqual(SAVE_INTENT_LIMITS.maxKeyLength);
  });
});
