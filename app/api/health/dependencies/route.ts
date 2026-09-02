import { NextResponse } from "next/server";
import { checkAllDependencies } from "@/lib/server/dependencyCheck";
import { requireAdmin } from "@/app/api/admin/_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Toolchain status as JSON. Gated behind an admin session — the list of which
 * binaries are (not) installed is operational detail we don't expose to anon
 * callers. The public /server-status page reads the same data server-side.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  const deps = await checkAllDependencies();
  return NextResponse.json(
    { dependencies: deps },
    { headers: { "Cache-Control": "no-store" } },
  );
}
