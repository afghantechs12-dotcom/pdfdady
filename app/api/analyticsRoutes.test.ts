import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP contract for the two endpoints this slice adds.
 *
 * The DI container and the actor resolver are mocked, so these run with no
 * database and no Next request context: the subject is the contract — statuses,
 * what the body may say, what reaches the service, what the service is NEVER
 * asked to trust — not persistence. Ingest semantics are covered against the real
 * repository in `ProductAnalyticsService.test.ts`.
 */

/** The batch shape the route builds. Only what these assertions read. */
type IngestCall = {
  actor: { ownerType: string; ownerId: string };
  events: Array<{ name: string; properties?: Record<string, unknown>; at?: number }>;
};

const state = vi.hoisted(() => ({
  ingest: vi.fn(async (_input: IngestCall) => ({
    accepted: 1,
    dropped: 0,
    degraded: false,
  })),
  snapshot: vi.fn(),
  actor: { ownerType: "anon", ownerId: "anon-1", workspaceId: null } as {
    ownerType: string;
    ownerId: string;
    workspaceId: string | null;
  },
  resolveThrows: false as boolean,
  missingService: null as string | null,
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const name = token.description;
      if (name === state.missingService) throw new Error("not registered");
      if (name === "ProductAnalyticsService") return { ingest: state.ingest };
      if (name === "UsageMeteringService") return { snapshot: state.snapshot };
      throw new Error(`unexpected token ${String(name)}`);
    },
  },
}));

vi.mock("@/lib/server/jobActor", () => ({
  resolveJobActor: async () => {
    if (state.resolveThrows) throw new Error("cookie store unavailable");
    return state.actor;
  },
}));

import { POST as ingestPost } from "@/app/api/analytics/events/route";
import { GET as usageGet } from "@/app/api/usage/route";
import * as ingestRoute from "@/app/api/analytics/events/route";
import * as usageRoute from "@/app/api/usage/route";
import { MAX_EVENTS_PER_BATCH } from "@/src/application/services/ProductAnalyticsService";

const ORIGIN = "http://localhost:3000";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}/api/analytics/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
}

/**
 * A fresh IP per test. The limiter is module-level and shared across this file,
 * so reusing one address would make an unrelated test the reason a later one is
 * rate-limited.
 */
/** The batch the route handed the service, asserting one was sent at all. */
function ingestArg(): IngestCall {
  const call = state.ingest.mock.calls[0];
  expect(call, "expected the route to call ingest").toBeDefined();
  return call![0];
}

let ipCounter = 0;
function freshIp(): Record<string, string> {
  ipCounter += 1;
  return { "x-forwarded-for": `10.0.0.${ipCounter % 250}` };
}

beforeEach(() => {
  state.ingest.mockClear();
  state.ingest.mockResolvedValue({ accepted: 1, dropped: 0, degraded: false });
  state.snapshot.mockReset();
  state.resolveThrows = false;
  state.missingService = null;
  state.actor = { ownerType: "anon", ownerId: "anon-1", workspaceId: null };
});

describe("POST /api/analytics/events", () => {
  it("accepts a batch and answers 204 with an empty body", async () => {
    const res = await ingestPost(post({ events: [{ name: "tool_view" }] }, freshIp()));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts a bare array as well as { events }", async () => {
    await ingestPost(post([{ name: "tool_view" }], freshIp()));
    expect(ingestArg().events).toEqual([
      { name: "tool_view", properties: undefined, at: undefined },
    ]);
  });

  /**
   * Not a 400, on purpose. A beacon's caller is a PDF tool in the user's tab; an
   * endpoint that errors invites a client that retries, which turns a deploy that
   * renamed an event into a retry storm from every stale tab. A 400 is also an
   * oracle for which names the taxonomy admits.
   */
  it("answers 204 to malformed JSON rather than an error a client would retry", async () => {
    const res = await ingestPost(post("{not json", freshIp()));
    expect(res.status).toBe(204);
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it("answers 204 to a body that is not a batch at all", async () => {
    for (const body of ["null", '"tool_view"', "42", "{}", '{"events":"tool_view"}']) {
      const res = await ingestPost(post(body, freshIp()));
      expect(res.status).toBe(204);
    }
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it("skips entries with no usable name instead of rejecting the batch", async () => {
    await ingestPost(
      post({ events: [null, 7, { properties: {} }, { name: 5 }, { name: "download" }] }, freshIp()),
    );
    expect(ingestArg().events).toHaveLength(1);
  });

  it("passes only object properties through, never an array", async () => {
    await ingestPost(
      post({ events: [{ name: "download", properties: ["format", "pdf"] }] }, freshIp()),
    );
    expect(ingestArg().events[0].properties).toBeUndefined();
  });

  /** The two protections that must be able to say no, or they are advisory. */
  it("rejects an over-large declared body with 413", async () => {
    const res = await ingestPost(
      post({ events: [{ name: "tool_view" }] }, { ...freshIp(), "content-length": "999999" }),
    );
    expect(res.status).toBe(413);
    expect(state.ingest).not.toHaveBeenCalled();
  });

  /**
   * `content-length` is client-supplied and a chunked request may omit it, so a
   * cap enforced only on the header is unenforced on exactly the requests that
   * would abuse it.
   */
  it("rejects an over-large actual body even with no content-length header", async () => {
    const events = [{ name: "tool_view", properties: { toolSlug: "x".repeat(40_000) } }];
    const res = await ingestPost(post({ events }, freshIp()));
    expect(res.status).toBe(413);
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it("rate-limits a flood from one address with 429 and Retry-After", async () => {
    const ip = { "x-forwarded-for": "203.0.113.9" };
    let limited: Response | null = null;
    for (let i = 0; i < 200; i += 1) {
      const res = await ingestPost(post({ events: [{ name: "tool_view" }] }, ip));
      if (res.status === 429) {
        limited = res;
        break;
      }
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get("retry-after")).toBe("10");
  });

  it("truncates an oversized batch before it reaches the service", async () => {
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 50 }, () => ({
      name: "tool_view",
    }));
    await ingestPost(post({ events }, freshIp()));
    expect(ingestArg().events.length).toBeLessThanOrEqual(
      MAX_EVENTS_PER_BATCH,
    );
  });

  /**
   * The identity boundary at the HTTP layer: the route hands the service the
   * actor IT resolved, and nothing from the body. A client-sent owner has no
   * parameter to arrive through.
   */
  it("passes the server-resolved actor and never a client-sent identity", async () => {
    state.actor = { ownerType: "user", ownerId: "real-user", workspaceId: null };
    await ingestPost(
      post(
        { events: [{ name: "tool_view" }], ownerId: "attacker", actor: { ownerId: "attacker" } },
        freshIp(),
      ),
    );
    const arg = ingestArg();
    expect(arg.actor).toMatchObject({ ownerType: "user", ownerId: "real-user" });
    expect(JSON.stringify(arg)).not.toContain("attacker");
  });

  /** Analytics failing must be invisible to the tool that sent the beacon. */
  it("answers 204 when the service throws", async () => {
    state.ingest.mockRejectedValueOnce(new Error("boom"));
    const res = await ingestPost(post({ events: [{ name: "tool_view" }] }, freshIp()));
    expect(res.status).toBe(204);
  });

  it("answers 204 when the actor cannot be resolved", async () => {
    state.resolveThrows = true;
    const res = await ingestPost(post({ events: [{ name: "tool_view" }] }, freshIp()));
    expect(res.status).toBe(204);
    expect(state.ingest).not.toHaveBeenCalled();
  });

  it("answers 204 when the service is not registered at all", async () => {
    state.missingService = "ProductAnalyticsService";
    const res = await ingestPost(post({ events: [{ name: "tool_view" }] }, freshIp()));
    expect(res.status).toBe(204);
  });

  it("exposes no GET handler — a beacon is not a readable resource", () => {
    expect("GET" in ingestRoute).toBe(false);
    expect("DELETE" in ingestRoute).toBe(false);
  });
});

describe("GET /api/usage", () => {
  const snapshot = {
    plan: "guest",
    planLabel: "Guest",
    mode: "observe",
    maxFileBytes: 104857600,
    maxConcurrentJobs: 2,
    activeOperations: 1,
    meters: [
      {
        meter: "server_operations",
        unit: "operations",
        used: 4,
        limit: 30,
        remaining: 26,
        resetAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ],
    degraded: false,
  };

  it("answers an anonymous caller with their own guest allowance", async () => {
    state.snapshot.mockResolvedValue(snapshot);
    const res = await usageGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBe("guest");
    expect(body.mode).toBe("observe");
    expect(body.meters[0]).toMatchObject({
      meter: "server_operations",
      used: 4,
      limit: 30,
      remaining: 26,
      window: "day",
      resetAt: "2026-08-25T00:00:00.000Z",
    });
  });

  it("asks for the caller's own usage, resolved server-side", async () => {
    state.actor = { ownerType: "user", ownerId: "user-9", workspaceId: null };
    state.snapshot.mockResolvedValue(snapshot);
    await usageGet();
    expect(state.snapshot).toHaveBeenCalledWith({ ownerType: "user", ownerId: "user-9" });
  });

  /** A per-visitor response a shared cache stored would be served to the next visitor. */
  it("is never cached, including by a shared cache", async () => {
    state.snapshot.mockResolvedValue(snapshot);
    const res = await usageGet();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  /** A UI that cannot tell "0 used" from "unreadable" shows a confident wrong number. */
  it("reports degraded honestly", async () => {
    state.snapshot.mockResolvedValue({ ...snapshot, degraded: true });
    expect((await (await usageGet()).json()).degraded).toBe(true);
  });

  /**
   * The response is mapped field by field, so a field added to the internal
   * snapshot type for the admin surface cannot appear here by inheritance.
   */
  it("does not echo fields added to the internal snapshot type", async () => {
    state.snapshot.mockResolvedValue({
      ...snapshot,
      ownerId: "user-9",
      internalPerToolBreakdown: [{ toolSlug: "merge-pdf", total: 3 }],
      meters: [{ ...snapshot.meters[0], rawCounterRowId: "row-1" }],
    });
    const text = await (await usageGet()).text();
    expect(text).not.toContain("user-9");
    expect(text).not.toContain("internalPerToolBreakdown");
    expect(text).not.toContain("rawCounterRowId");
  });

  it("answers 503 rather than throwing when metering is not registered", async () => {
    state.missingService = "UsageMeteringService";
    const res = await usageGet();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Usage is unavailable." });
  });

  it("exposes no mutating handler — usage is read-only here", () => {
    expect("POST" in usageRoute).toBe(false);
    expect("PATCH" in usageRoute).toBe(false);
    expect("DELETE" in usageRoute).toBe(false);
  });
});
