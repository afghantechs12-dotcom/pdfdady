import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { checkAllDependencies } from "@/lib/server/dependencyCheck";
import { STORE_PATH } from "@/data/admin";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IHealthCheck, HealthResult } from "@/src/application/ports/HealthCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `checkAllDependencies` shells out to `which`/`where` for 6 binaries. A load
// balancer may hit readiness every few seconds, so cache the result briefly
// to avoid forking that many processes per probe.
const DEP_CACHE_MS = 30_000;
let depCache: { at: number; value: Record<string, boolean> } | null = null;

async function cachedDeps(): Promise<Record<string, boolean>> {
  const now = Date.now();
  if (depCache && now - depCache.at < DEP_CACHE_MS) return depCache.value;
  const value = await checkAllDependencies();
  depCache = { at: now, value };
  return value;
}

/**
 * Public readiness probe. Aggregates three subsystems:
 *  - data dir: the admin persistence volume is present.
 *  - toolchain: the PDF conversion binaries are installed.
 *  - DI health checks: infrastructure registered in the container (currently
 *    the database ping). Resilient — a wiring/config error is reported as an
 *    unhealthy check, not a 500, so a load balancer drains cleanly.
 *
 * Returns 503 when not ready. Deliberately says WHETHER each subsystem is
 * healthy and never WHY: this endpoint is unauthenticated (a load balancer must
 * reach it), and the underlying `detail` strings are raw driver messages. A
 * Prisma connection failure embeds the DSN host, user and database name, so
 * echoing detail here would publish the database topology to anyone who curls
 * it. The detail is still logged server-side by each check, and the per-binary
 * breakdown stays behind the admin-gated /api/health/dependencies.
 */
export async function GET() {
  let dataDirOk = false;
  try {
    await fs.access(path.dirname(STORE_PATH));
    dataDirOk = true;
  } catch {
    // dataDirOk stays false — the data directory is not accessible.
  }

  let toolchainOk = false;
  try {
    const deps = await cachedDeps();
    toolchainOk = Object.values(deps).every(Boolean);
  } catch {
    // toolchainOk stays false — dependency probing failed.
  }

  const checks: HealthResult[] = [];
  try {
    const healthChecks = appContainer.resolve<IHealthCheck[]>(Tokens.HealthChecks);
    for (const check of healthChecks) {
      try {
        checks.push(await check.check());
      } catch (err) {
        checks.push({
          name: check?.name ?? "unknown",
          healthy: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    // Container/wiring/config error — report as an unhealthy check, not a 500.
    checks.push({
      name: "container",
      healthy: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const dbOk = checks.find((c) => c.name === "database")?.healthy ?? false;

  const ready = dataDirOk && toolchainOk && dbOk;
  return NextResponse.json(
    {
      ok: ready,
      status: ready ? "ready" : "degraded",
      dataDir: dataDirOk,
      toolchain: toolchainOk,
      database: dbOk,
      // Name + healthy only. `detail` is dropped on purpose — see the note
      // above; it carries raw driver text on an unauthenticated endpoint.
      checks: checks.map((c) => ({ name: c.name, healthy: c.healthy })),
    },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
