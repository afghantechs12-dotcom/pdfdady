import { NextResponse } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import {
  ProductAnalyticsService,
  MAX_EVENTS_PER_BATCH,
  type ClientAnalyticsEvent,
} from "@/src/application/services/ProductAnalyticsService";
import { resolveJobActor } from "@/lib/server/jobActor";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per-IP beacon budget.
 *
 * Higher than the tool routes' 20/min because a beacon is cheap and a real
 * session legitimately sends several — a funnel is six events, and a visitor who
 * merges four times in a minute is normal. Low enough that a `fetch` loop from a
 * console cannot fill the ledger. Separate limiter instance, same single-instance
 * caveat as every other one in this repo (see lib/server/rateLimit.ts).
 */
const beaconLimiter = new RateLimiter({ windowMs: 60_000, max: 120 });

/**
 * A batch is at most `MAX_EVENTS_PER_BATCH` events of a handful of short
 * declared dimensions each. 16KB is generous for that and small enough that a
 * body worth parsing can never be large.
 *
 * Enforced on the read bytes, not only on `content-length`: the header is
 * client-supplied and a chunked request may omit it entirely, so trusting it
 * alone leaves the actual cap unenforced on exactly the requests that would
 * abuse it.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST /api/analytics/events — the only way a browser writes to the ledger.
 *
 * ## It answers 204 to almost everything
 *
 * Unknown event name, malformed JSON, undeclared properties, a failed database
 * write: all 204. Two reasons, and both are about the caller.
 *
 * A beacon's caller is a PDF tool running in the user's tab. It must not care
 * whether analytics worked, and an endpoint that returns errors invites a client
 * that retries them — which turns a deploy that renamed an event into a retry
 * storm from every stale tab still open. (The taxonomy's own doc comment makes
 * the same argument for dropping unknown names rather than rejecting them.)
 *
 * The second reason is that a 400 is an oracle. "This event name is valid, that
 * one is not" and "this property was kept, that one was dropped" are answers
 * this endpoint should not hand out to an anonymous prober.
 *
 * The exceptions are the two protections that must be able to say no: a body
 * over the cap (413) and an over-budget IP (429). Silently accepting those would
 * make the limit advisory.
 *
 * ## What the client is trusted with
 *
 * The event name and its declared dimensions. Not identity: the actor is
 * resolved from the session cookie server-side via `resolveJobActor`, exactly as
 * job ownership is, so an `ownerId` in the body has nowhere to land and no
 * effect. Not the plan, which the entitlement provider resolves. And not quota:
 * the service reached here can only append events — it has no path to a counter.
 */
export async function POST(request: Request) {
  if (beaconLimiter.hit(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many requests." },
      { status: 429, headers: { "Retry-After": "10" } },
    );
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const raw = await request.text().catch(() => "");
  // The real cap. `content-length` above is a cheap early exit, not the gate.
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large." }, { status: 413 });
  }

  const events = parseEvents(raw);
  if (events.length === 0) return noContent();

  try {
    const actor = await resolveJobActor();
    await appContainer
      .resolve<ProductAnalyticsService>(Tokens.ProductAnalyticsService)
      .ingest({ actor, events });
  } catch {
    // Includes the container itself failing to resolve — a misconfigured
    // deployment must degrade to "no analytics", never to a broken tool page.
    return noContent();
  }

  return noContent();
}

/**
 * 204 with `no-store`.
 *
 * Empty body on purpose: a count of accepted events would tell a prober which
 * names and properties the taxonomy admits, one request at a time.
 */
function noContent(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Extracts the event array from a body that may be anything at all.
 *
 * Structural only — no name or property checking here. That belongs to the
 * taxonomy, and doing a first pass of it in the route is how the two versions
 * start to disagree about what is valid. `sendBeacon` posts a `Blob`, so the
 * content type is not reliably JSON and is not consulted.
 */
function parseEvents(raw: string): ClientAnalyticsEvent[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { events?: unknown })?.events)
      ? (parsed as { events: unknown[] }).events
      : [];
  const out: ClientAnalyticsEvent[] = [];
  for (const item of list.slice(0, MAX_EVENTS_PER_BATCH)) {
    if (!item || typeof item !== "object") continue;
    const event = item as { name?: unknown; properties?: unknown; at?: unknown };
    if (typeof event.name !== "string") continue;
    out.push({
      name: event.name,
      properties:
        event.properties && typeof event.properties === "object" && !Array.isArray(event.properties)
          ? (event.properties as Record<string, unknown>)
          : undefined,
      at: typeof event.at === "number" ? event.at : undefined,
    });
  }
  return out;
}
