import { type NextRequest } from "next/server";
import {
  billingError,
  billingService,
  optionalBillingUser,
  organizationIdFrom,
} from "@/src/application/services/billingHttp";
import { formatPlanPeriod, formatPlanPrice } from "@/src/domain/billing/proOffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/billing/summary — what the Pro card should render for this caller.
 *
 * ## Why this exists instead of server-rendering the pricing page
 *
 * Baking the price into the page output would show whatever Stripe was configured
 * with at *build* time, and reading the session cookie in the page would make the
 * card's contents part of a cacheable render. So the page ships its approved copy
 * and this endpoint upgrades it per caller — the same split `UsageCard` + `/api/usage`
 * already use, which is why there is no new pattern here.
 *
 * (`/pricing` was prerendered when this was written. Slice 3.2 made it dynamic so it
 * can carry a per-request CSP nonce, which removes the "it would become dynamic"
 * half of the argument but not the build-time-price half — and a client fetch keeps
 * the price out of the HTML that any future cache would hold.)
 *
 * ## Anonymous-safe, not anonymous-blocked
 *
 * A visitor who is not signed in gets `plan: "guest"` and an offer that says
 * "sign in". Refusing them would mean the public pricing page could not show its
 * own price.
 *
 * ## What it will not tell you
 *
 * No price id, no customer id, no subscription id, no organization id — see
 * `ProSummary`. `offer` is a rendering decision and grants nothing: checkout and
 * portal re-authorize on every POST, so a caller who forges a summary response in
 * their own browser has upgraded a button, not an account.
 */
export async function GET(req: NextRequest) {
  const user = await optionalBillingUser(req).catch(() => null);

  let summary;
  try {
    summary = await billingService().proSummary({
      userId: user?.id ?? null,
      // Same filter-not-assertion rule as the POST routes: it selects among the
      // caller's own organizations and cannot introduce one.
      organizationId: organizationIdFrom(queryObject(req)),
    });
  } catch {
    // The container could not resolve billing at all (misconfigured deployment).
    // 503 rather than 500: the page falls back to its approved copy, which is the
    // correct thing to show when this deployment cannot take money.
    return billingError("BILLING_NOT_CONFIGURED", "Billing is unavailable.", 503);
  }

  return Response.json(
    {
      configured: summary.configured,
      signedIn: summary.signedIn,
      plan: summary.plan,
      /**
       * Pre-formatted, and null when no price could be read. The consumer must
       * fall back to the approved pricing copy — it must never substitute a
       * number of its own, which is why no raw amount is sent alongside.
       */
      priceLabel: formatPlanPrice(summary.price),
      pricePeriod: formatPlanPeriod(summary.price),
      action: summary.offer.action,
      actionLabel: summary.offer.label,
      note: summary.offer.note,
    },
    // Per-caller. A shared cache holding one visitor's offer would serve it to the
    // next, and "Manage billing" rendered for an anonymous visitor is a support
    // ticket at best.
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

/** The query string as the record `organizationIdFrom` validates. */
function queryObject(req: NextRequest): Record<string, unknown> {
  const value = req.nextUrl.searchParams.get("organizationId");
  return value === null ? {} : { organizationId: value };
}
