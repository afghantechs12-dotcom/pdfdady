import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportWindowRequest } from "@/src/application/services/UsageAnalyticsReadService";

/**
 * HTTP contract for the admin analytics endpoint.
 *
 * The interesting assertions are not the happy path. They are: that the guard
 * runs before the read (not merely before the response), that the query window
 * reaching the service is bounded whatever the caller asked for, and that no
 * ledger row, subject pseudonym, or owner identity can appear in the body.
 */

const state = vi.hoisted(() => ({
  authorized: false,
  /** Ordered log of what happened, so guard-before-read is checkable. */
  calls: [] as string[],
  lastRequest: null as ReportWindowRequest | null,
  /** The calibration read's own window, kept apart so neither can mask the other. */
  lastCalibrationRequest: null as ReportWindowRequest | null,
  report: {} as Record<string, unknown>,
  calibration: {} as Record<string, unknown>,
}));

vi.mock("@/lib/admin/session", () => ({
  ADMIN_COOKIE: "pdfdadi_admin",
  readAdminCookie: (header: string | null | undefined) =>
    header?.includes("pdfdadi_admin=") ? "token" : undefined,
  verifySessionToken: async (token: string | undefined) => {
    state.calls.push("verify");
    return state.authorized && token === "token";
  },
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      if (token.description !== "UsageAnalyticsReadService") {
        throw new Error(`unexpected token ${String(token.description)}`);
      }
      return {
        report: async (request: { from?: string | null; to?: string | null }) => {
          state.calls.push("read");
          state.lastRequest = request;
          return state.report;
        },
        calibration: async (request: { from?: string | null; to?: string | null }) => {
          state.calls.push("calibrate");
          state.lastCalibrationRequest = request;
          return state.calibration;
        },
      };
    },
  },
}));

import { GET } from "@/app/api/admin/analytics/route";

const ORIGIN = "http://localhost:3000";

function get(query = "", cookie?: string): Request {
  return new Request(`${ORIGIN}/api/admin/analytics${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

beforeEach(() => {
  state.authorized = false;
  state.calls = [];
  state.lastRequest = null;
  state.lastCalibrationRequest = null;
  state.report = { window: { from: "x", to: "y", days: 7, clamped: false }, degraded: false };
  state.calibration = { readiness: { ready_for_enforcement: false } };
});

describe("authorization", () => {
  it("refuses a request with no admin cookie", async () => {
    const res = await GET(get());
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("refuses a request whose cookie does not verify", async () => {
    const res = await GET(get("", "pdfdadi_admin=forged"));
    expect(res.status).toBe(401);
  });

  it("reads nothing when unauthorized", async () => {
    await GET(get("?from=2020-01-01"));
    // Not just "returns 401". A guard placed after the read also returns 401,
    // having already run the query for an anonymous caller. Both reads, so adding
    // the calibration query cannot become a second unguarded path.
    expect(state.calls).toEqual(["verify"]);
  });

  it("verifies before it reads, in that order", async () => {
    state.authorized = true;
    await GET(get("", "pdfdadi_admin=token"));
    expect(state.calls).toEqual(["verify", "read", "calibrate"]);
  });

  it("answers an authorized request", async () => {
    state.authorized = true;
    const res = await GET(get("", "pdfdadi_admin=token"));
    expect(res.status).toBe(200);
    // Per-admin operational data behind a cookie: never a shared cache.
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("window", () => {
  beforeEach(() => {
    state.authorized = true;
  });

  it("passes the requested bounds through to be bounded server-side", async () => {
    await GET(get("?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z", "pdfdadi_admin=token"));
    expect(state.lastRequest).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      funnelToolSlug: null,
    });
    // The SAME bounds, not a second default window: a readiness verdict shown
    // beside a set of numbers has to have been computed over those numbers.
    expect(state.lastCalibrationRequest).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
  });

  it("does not require bounds", async () => {
    const res = await GET(get("", "pdfdadi_admin=token"));
    expect(res.status).toBe(200);
    expect(state.lastRequest).toEqual({ from: null, to: null, funnelToolSlug: null });
    expect(state.lastCalibrationRequest).toEqual({ from: null, to: null });
  });

  it("does not accept an owner or subject parameter", async () => {
    await GET(get("?ownerId=victim&subjectHash=abc&from=2026-01-01", "pdfdadi_admin=token"));
    // The route forwards a fixed set of keys — two dates and which tool's funnel
    // to feature — so there is no owner-scoped report to ask for. The endpoint is
    // un-addressable rather than guarded, which is the stronger property: a guard
    // can be removed by someone who thinks it is redundant.
    expect(Object.keys(state.lastRequest ?? {}).sort()).toEqual([
      "from",
      "funnelToolSlug",
      "to",
    ]);
    expect(Object.keys(state.lastCalibrationRequest ?? {}).sort()).toEqual(["from", "to"]);
  });

  it("names a tool but cannot name a subject through it", async () => {
    // `tool` reaches a WHERE clause, so it is worth pinning that it arrives as an
    // opaque string the service resolves against the registry — not as something
    // that could select a grouping column or a different scope.
    await GET(get("?tool=crop-pdf", "pdfdadi_admin=token"));
    expect(state.lastRequest?.funnelToolSlug).toBe("crop-pdf");
  });
});

describe("response body", () => {
  it("returns exactly what the services produced, with nothing added", async () => {
    state.authorized = true;
    state.report = {
      window: { from: "a", to: "b", days: 7, clamped: false },
      processing: { runs: 3, succeeded: 3 },
      degraded: false,
    };
    state.calibration = { readiness: { ready_for_enforcement: false, reason: "x" } };
    const res = await GET(get("", "pdfdadi_admin=token"));
    // The route composes two service payloads and derives nothing itself. A
    // readiness field computed HERE would be a second answer to a question the
    // domain module already answers, and the two would drift.
    await expect(res.json()).resolves.toEqual({
      ...state.report,
      calibration: state.calibration,
    });
  });
});

describe("source guarantees", () => {
  const src = readFileSync(
    path.join(process.cwd(), "app/api/admin/analytics/route.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");

  it("guards before it resolves the service, in source order", () => {
    const guard = src.indexOf("requireAdmin(req)");
    const resolve = src.indexOf("appContainer.resolve");
    expect(guard).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(guard);
    // The early return, not just the call, has to come first.
    expect(src.indexOf("if (guard) return guard")).toBeLessThan(resolve);
  });

  it("touches no repository or Prisma client directly", () => {
    // The route's only data dependency is the read service, which has no method
    // that returns a row. A direct `prisma.usageEvent.findMany` here would bypass
    // every guarantee the service is carrying.
    expect(src).not.toMatch(/prisma/i);
    expect(src).not.toContain("UsageRepository");
    expect(src).not.toContain("findMany");
  });

  it("never names an identity column", () => {
    expect(src).not.toContain("subjectHash");
    expect(src).not.toContain("ownerId");
  });
});
