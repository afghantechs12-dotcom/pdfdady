import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public liveness probe — the Node server process is up and answering HTTP.
 * Intentionally cheap (no auth, no I/O) so it is safe for a load balancer and
 * for the Dockerfile HEALTHCHECK. Deeper status (toolchain, data dir) is at
 * /api/health/ready; the per-binary breakdown stays admin-gated at
 * /api/health/dependencies.
 */
export async function GET() {
  return NextResponse.json(
    { ok: true, status: "up" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
