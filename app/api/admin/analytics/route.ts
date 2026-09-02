import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { UsageAnalyticsReadService } from "@/src/application/services/UsageAnalyticsReadService";
import { requireAdmin } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The admin analytics read surface.
 *
 * Three properties of this handler matter more than its body:
 *
 *  - **`requireAdmin` runs before anything is read.** Not merely before the
 *    response is written — before the query. An early-return guard placed after
 *    the read still executes the read, so a 401 would already have cost the
 *    database a scan, and any future logging of the result would log it for an
 *    unauthenticated caller. The test for this asserts the ordering in source,
 *    not just the status code, because a passing status code is exactly what a
 *    guard-after-read also produces.
 *
 *  - **The response is aggregates only.** The service it calls has no method that
 *    returns a `UsageEvent`, so this route cannot forward one. That is the design:
 *    the ledger's `subjectHash` exists to be unlinkable, and a JSON array of them
 *    is a visitor list no matter what the field is named.
 *
 *  - **The window is bounded server-side.** `from`/`to` are query parameters, so
 *    an admin cookie is not a licence to ask for the entire ledger; the service
 *    clamps and reports that it clamped.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const url = new URL(req.url);
  const analytics = appContainer.resolve<UsageAnalyticsReadService>(
    Tokens.UsageAnalyticsReadService,
  );
  const window = {
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  };
  // One request, two reads, issued together. Calibration answers a different
  // question from the dashboard — "may we enforce yet" rather than "what
  // happened" — but it answers it over the same window, and splitting it into a
  // second endpoint would mean a second admin guard, a second clamp, and a UI
  // that can show a readiness verdict calibrated from a different range than the
  // numbers next to it.
  const [report, calibration] = await Promise.all([
    analytics.report({
      ...window,
      // Which funnel to feature. Not validated against the tool registry here: the
      // service falls back to the default for an unknown slug, and a 400 would turn
      // a bookmarked dashboard into an error page the day a tool is renamed.
      funnelToolSlug: url.searchParams.get("tool"),
    }),
    analytics.calibration(window),
  ]);

  // `no-store` for the same reason as GET /api/usage: this is per-request
  // operational data behind an auth cookie, and a shared cache holding it would
  // serve one admin's dashboard to the next request that looked similar enough.
  return NextResponse.json({ ...report, calibration }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
