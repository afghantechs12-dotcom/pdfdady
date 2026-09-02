import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { UsageMeteringService } from "@/src/application/services/UsageMeteringService";
import { resolveJobActor } from "@/lib/server/jobActor";
import { METERS } from "@/src/domain/metering/meters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/usage — the caller's own allowance, and only ever their own.
 *
 * ## Anonymous-safe, not anonymous-blocked
 *
 * A guest is a real actor with a real allowance (see the `guest` plan in
 * `src/domain/metering/plans.ts`), so 401'ing them here would make the endpoint
 * unusable by the visitors the product is mostly serving. The actor comes from
 * `resolveJobActor` — a validated session for a signed-in user, the HttpOnly
 * anonymous cookie otherwise — which is the same resolution job ownership uses.
 *
 * That also makes the endpoint un-addressable: there is no owner parameter to
 * accept and therefore none to authorize. Someone else's usage is not something
 * this route can be asked for, rather than something it declines to answer.
 *
 * ## Why the numbers are re-shaped rather than passed through
 *
 * `UsageSnapshot` is an internal type and internal types grow fields. Mapping
 * explicitly means a field added for the admin surface — an owner id, a per-tool
 * breakdown, a raw counter row — does not appear in a public response because
 * someone widened a shared type. `degraded` is reported honestly: a UI that
 * cannot tell "0 used" from "we could not read it" will confidently show the
 * wrong number.
 *
 * `mode` is included so a client can tell that a limit is being observed rather
 * than enforced. In observe mode `remaining: 0` does not mean the next
 * submission will be refused, and a UI that assumed otherwise would invent a
 * paywall this phase does not have.
 */
export async function GET() {
  let service: UsageMeteringService;
  try {
    service = appContainer.resolve<UsageMeteringService>(Tokens.UsageMeteringService);
  } catch {
    return NextResponse.json({ error: "Usage is unavailable." }, { status: 503 });
  }

  const actor = await resolveJobActor();
  // `snapshot` never throws: it reports `degraded: true` and zeroes instead, so
  // this route has no read failure to handle.
  const snapshot = await service.snapshot({
    ownerType: actor.ownerType,
    ownerId: actor.ownerId,
  });

  return NextResponse.json(
    {
      plan: snapshot.plan,
      planLabel: snapshot.planLabel,
      /** "off" | "observe" | "enforce". See the note above on reading `remaining`. */
      mode: snapshot.mode,
      maxFileBytes: snapshot.maxFileBytes,
      maxConcurrentJobs: snapshot.maxConcurrentJobs,
      activeOperations: snapshot.activeOperations,
      meters: snapshot.meters.map((meter) => ({
        meter: meter.meter,
        unit: meter.unit,
        window: METERS[meter.meter].window,
        used: meter.used,
        limit: meter.limit,
        remaining: meter.remaining,
        resetAt: meter.resetAt.toISOString(),
      })),
      /** True when counters could not be read; the numbers above are then floors. */
      degraded: snapshot.degraded,
    },
    // Never cached, and never by a shared cache: the response is per-visitor, and
    // a proxy that stored one visitor's allowance would serve it to the next.
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
