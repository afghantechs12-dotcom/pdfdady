import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Body contract for the PUBLIC readiness probe.
 *
 * A load balancer has to reach this endpoint unauthenticated, so whatever it
 * returns is world-readable. The health checks it aggregates carry raw driver
 * text in `detail` — a Prisma connection failure embeds the DSN host, user and
 * database name — so the probe must report WHETHER each subsystem is healthy and
 * never WHY. This test drives an unhealthy check whose detail contains a
 * recognizable DSN and asserts none of it reaches the response.
 */

const state = vi.hoisted(() => ({
  checks: [] as Array<{ name: string; healthy: boolean; detail?: string }>,
  /** Set to throw from resolve() to simulate a container/wiring failure. */
  containerThrows: false,
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: () => {
      if (state.containerThrows) throw new Error("wiring exploded: postgres://u:pw@host/db");
      return state.checks.map((c) => ({ name: c.name, check: async () => c }));
    },
  },
}));

vi.mock("@/lib/server/dependencyCheck", () => ({
  checkAllDependencies: async () => ({ qpdf: true, ghostscript: true }),
}));

vi.mock("@/data/admin", () => ({ STORE_PATH: process.cwd() + "/package.json" }));

import { GET } from "@/app/api/health/ready/route";

const LEAKY_DETAIL =
  'Can\'t reach database server at `db.internal:5432` (user=pdfdadi_app password=s3cr3t)';

beforeEach(() => {
  state.checks = [];
  state.containerThrows = false;
});

describe("GET /api/health/ready", () => {
  it("reports ready when every subsystem is healthy", async () => {
    state.checks = [{ name: "database", healthy: true }];
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("ready");
    expect(body.database).toBe(true);
    expect(body.checks).toEqual([{ name: "database", healthy: true }]);
  });

  it("returns 503 and names the failing subsystem without explaining why", async () => {
    state.checks = [{ name: "database", healthy: false, detail: LEAKY_DETAIL }];
    const res = await GET();
    expect(res.status).toBe(503);
    const raw = await res.text();
    // The operator learns the database is down...
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      status: "degraded",
      database: false,
      checks: [{ name: "database", healthy: false }],
    });
    // ...but the world does not learn the database topology.
    for (const secret of ["db.internal", "pdfdadi_app", "s3cr3t", "password"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).not.toContain("detail");
  });

  it("does not leak a container/wiring error message either", async () => {
    state.containerThrows = true;
    const res = await GET();
    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(JSON.parse(raw).checks).toEqual([{ name: "container", healthy: false }]);
    expect(raw).not.toContain("postgres://");
    expect(raw).not.toContain("wiring exploded");
  });

  it("is never cached", async () => {
    state.checks = [{ name: "database", healthy: true }];
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
