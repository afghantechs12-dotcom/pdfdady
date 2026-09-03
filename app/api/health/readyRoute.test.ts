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
  /** What `which` finds. A false entry is a binary this host does not have. */
  deps: {} as Record<string, boolean>,
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
  checkAllDependencies: async () => state.deps,
}));

vi.mock("@/data/admin", () => ({ STORE_PATH: process.cwd() + "/package.json" }));

import { GET } from "@/app/api/health/ready/route";

/**
 * A fresh copy of the route, so its dependency cache is empty.
 *
 * `DEP_CACHE_MS` is module state: the route forks `which` once and reuses the
 * answer for 30 seconds, because a load balancer polls this endpoint every few
 * seconds and six forks per poll is not free. A test that changes what `which`
 * finds therefore has to be a new module, not a new call — and the cache's own
 * consequence is asserted separately below.
 */
async function freshGET(): Promise<() => Promise<Response>> {
  vi.resetModules();
  const mod = await import("@/app/api/health/ready/route");
  return mod.GET as () => Promise<Response>;
}

const LEAKY_DETAIL =
  'Can\'t reach database server at `db.internal:5432` (user=pdfdadi_app password=s3cr3t)';

beforeEach(() => {
  state.checks = [];
  state.containerThrows = false;
  state.deps = { qpdf: true, ghostscript: true, libreoffice: true };
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

  /**
   * The readiness half of "no false green".
   *
   * Every other test in this file kept the toolchain healthy, so nothing asserted
   * that a missing binary is even consulted — and a probe that reports ready on a
   * host with no `soffice` is worse than no probe: the load balancer sends traffic
   * to a container where every conversion answers "temporarily unavailable". The
   * audit host IS that host, which is what makes this the live case rather than a
   * hypothetical.
   */
  it("refuses to report ready when one toolchain binary is missing", async () => {
    state.checks = [{ name: "database", healthy: true }];
    state.deps = { qpdf: true, ghostscript: true, libreoffice: false };
    const res = await (await freshGET())();

    expect(res.status).toBe(503);
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({ ok: false, status: "degraded", toolchain: false });
    // The database is still healthy, so this is the toolchain gating readiness and
    // not some other subsystem answering for it.
    expect(JSON.parse(raw).database).toBe(true);
    // And an unauthenticated caller does not learn WHICH binary is absent: that is
    // an inventory of what this server can be attacked for not having.
    expect(raw).not.toContain("libreoffice");
  });

  it("reports ready only when EVERY binary resolves", async () => {
    // Anti-vacuity for the row above: with the same shape and all-true deps the
    // response is 200, so it is the false entry doing the work.
    state.checks = [{ name: "database", healthy: true }];
    const res = await (await freshGET())();
    expect(res.status).toBe(200);
    expect((await res.json()).toolchain).toBe(true);
  });

  it("answers from the dependency cache, so readiness can lag a toolchain that just broke", async () => {
    // Not a defect — it is the reason the cache exists — but it is a property an
    // operator has to know: after a binary disappears, this endpoint keeps saying
    // ready for up to DEP_CACHE_MS. Asserted rather than described, so nobody
    // reads the 30s window as "immediately".
    state.checks = [{ name: "database", healthy: true }];
    const get = await freshGET();
    expect((await get()).status).toBe(200);

    state.deps = { qpdf: true, ghostscript: true, libreoffice: false };
    expect((await get()).status).toBe(200);
  });

  it("is never cached", async () => {
    state.checks = [{ name: "database", healthy: true }];
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
