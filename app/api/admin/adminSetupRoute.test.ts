import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, isAdminPasswordSet } from "@/lib/admin/passwords";

/**
 * HTTP contract for the first-run admin bootstrap.
 *
 * The invariant under test is the production one: a deployment that has ALREADY
 * been initialized must not expose a route that can silently recreate or reset
 * administrator access. `isAdminPasswordSet` is already unit-tested as a pure
 * predicate — that is not the risk. The risk is the wiring: a route that checks
 * the predicate and writes anyway, or that a query parameter can talk past it.
 *
 * The fake store below runs the REAL mutator that the route passes to
 * updateStore, so the check-and-set actually executes. A mock that ignored the
 * mutator would make every assertion here pass with the guard deleted.
 */

const state = vi.hoisted(() => ({
  /** The persisted admin password hash; "" means a fresh installation. */
  hash: "",
  /** Ordered log of store operations, so "refused" can be told from "rewrote". */
  writes: [] as string[],
}));

vi.mock("@/data/admin", () => ({
  updateStore: async (mutator: (s: { settings: { adminPasswordHash: string } }) => void) => {
    // Mirror the real updateStore: mutate a draft, then persist it. The route's
    // own check-and-set runs inside the mutator, exactly as in production.
    const draft = { settings: { adminPasswordHash: state.hash } };
    await mutator(draft);
    if (draft.settings.adminPasswordHash !== state.hash) {
      state.writes.push("hash-changed");
      state.hash = draft.settings.adminPasswordHash;
    } else {
      state.writes.push("no-change");
    }
    return draft;
  },
}));

import { POST } from "@/app/api/admin/setup/route";

const ORIGIN = "http://localhost:3000";

function post(body: unknown, query = "", ip = "203.0.113.1"): Request {
  return new Request(`${ORIGIN}/api/admin/setup${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-pdfdadi-peer": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Each test gets a distinct IP so the module-level rate limiter never bleeds. */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

beforeEach(() => {
  state.hash = "";
  state.writes = [];
});

describe("POST /api/admin/setup — first run", () => {
  it("sets the initial password on a fresh installation", async () => {
    const res = await POST(post({ password: "correct-horse-battery" }, "", freshIp()));
    expect(res.status).toBe(200);
    expect(isAdminPasswordSet(state.hash)).toBe(true);
    expect(state.writes).toEqual(["hash-changed"]);
  });

  it("rejects a password below the minimum length without writing", async () => {
    const res = await POST(post({ password: "short" }, "", freshIp()));
    expect(res.status).toBe(400);
    expect(state.hash).toBe("");
    expect(state.writes).toEqual([]);
  });

  it("rejects a malformed body without writing", async () => {
    const res = await POST(post("not json", "", freshIp()));
    expect(res.status).toBe(400);
    expect(state.writes).toEqual([]);
  });
});

describe("POST /api/admin/setup — already initialized", () => {
  const EXISTING = hashPassword("the-real-admin-password");

  beforeEach(() => {
    state.hash = EXISTING;
    state.writes = [];
  });

  it("refuses re-setup with 409 and leaves the existing hash untouched", async () => {
    const res = await POST(post({ password: "attacker-chosen-password" }, "", freshIp()));
    expect(res.status).toBe(409);
    // The invariant: administrator access was not recreated.
    expect(state.hash).toBe(EXISTING);
    expect(state.writes).toEqual(["no-change"]);
  });

  it.each([
    "?force=1",
    "?force=true",
    "?reset=1",
    "?setup=1",
    "?overwrite=yes",
    "?firstRun=true",
    "?admin=1&force=1",
  ])("cannot be bypassed by a query parameter (%s)", async (query) => {
    const res = await POST(post({ password: "attacker-chosen-password" }, query, freshIp()));
    expect(res.status).toBe(409);
    expect(state.hash).toBe(EXISTING);
  });

  it("cannot be bypassed by a body field that looks like a flag", async () => {
    const res = await POST(
      post(
        { password: "attacker-chosen-password", force: true, reset: true, overwrite: true },
        "",
        freshIp(),
      ),
    );
    expect(res.status).toBe(409);
    expect(state.hash).toBe(EXISTING);
  });

  it.each(["production", "development", "test", undefined])(
    "refuses re-setup regardless of NODE_ENV (%s) — no development shortcut",
    async (nodeEnv) => {
      const env = process.env as unknown as Record<string, string | undefined>;
      const orig = env.NODE_ENV;
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      try {
        const res = await POST(post({ password: "attacker-chosen-password" }, "", freshIp()));
        expect(res.status).toBe(409);
        expect(state.hash).toBe(EXISTING);
      } finally {
        if (orig === undefined) delete env.NODE_ENV;
        else env.NODE_ENV = orig;
      }
    },
  );

  it("never returns the password hash or the submitted password", async () => {
    const res = await POST(post({ password: "attacker-chosen-password" }, "", freshIp()));
    const text = await res.text();
    expect(text).not.toContain(EXISTING);
    expect(text).not.toContain(EXISTING.split(":")[0]); // not even the salt
    expect(text).not.toContain("attacker-chosen-password");
  });
});

describe("POST /api/admin/setup — rate limiting", () => {
  it("still rate-limits the open endpoint (429 after the window's allowance)", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    // The limiter allows 10 per minute per IP; the 11th must be refused.
    for (let i = 0; i < 12; i += 1) {
      const res = await POST(post({ password: "short" }, "", ip));
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(statuses[11]).toBe(429);
  });
});
