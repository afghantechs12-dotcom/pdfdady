import { type NextRequest } from "next/server";
import {
  billingError,
  billingService,
  enforceBillingRateLimit,
  mapBillingError,
  organizationIdFrom,
  readOptionalJsonBody,
  requireBillingUser,
} from "@/src/application/services/billingHttp";
import { requireSameOrigin } from "@/src/application/services/workspaceCsrf";
import { isPurchasablePlanId } from "@/src/domain/billing/subscription";
import { clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/checkout — start a subscription purchase.
 *
 * Body: `{ plan: "pro", organizationId?: string }`.
 *
 * `"pro"` is the only accepted value. Business billing is deferred, so `"business"`
 * is refused here exactly like `"enterprise"` or `"price_free"` would be — one 400,
 * before any Stripe call. (`src/domain/billing/subscription.ts` explains why, and
 * `businessDeferred.test.ts` holds the line.)
 *
 * What the body notably cannot contain: a price id, a customer id, a success URL,
 * an amount, or a plan to *grant*. `plan` names the one server-configured price
 * and nothing else; anything unrecognized is a 400 before a single Stripe call
 * happens.
 *
 * The response is `{ url }` — a Stripe-hosted checkout URL. It is not a
 * subscription and not an entitlement: no plan is written here, so returning from
 * Stripe with `?checkout=success` changes nothing about what this account may do.
 * Entitlement moves only in `/api/billing/webhook`, after a signature check.
 */
export async function POST(req: NextRequest) {
  // Same-origin evidence first: this is a state-changing POST behind a cookie, so
  // it needs the same CSRF guard as every other one in the app.
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const limited = enforceBillingRateLimit(req);
  if (limited) return limited;

  const auth = await requireBillingUser(req);
  if ("response" in auth) return auth.response;

  const body = await readOptionalJsonBody(req);
  const plan = body.plan;
  if (!isPurchasablePlanId(plan)) {
    return billingError("INVALID_INPUT", "A supported plan must be specified.", 400);
  }

  try {
    const result = await billingService().startCheckout({
      userId: auth.user.id,
      organizationId: organizationIdFrom(body),
      plan,
      ip: clientIp(req),
    });
    // `url` and a correlation id. Deliberately no plan field: a client that saw
    // `plan: "pro"` in a checkout response would be one refactor away from
    // treating it as an entitlement.
    return Response.json(
      { url: result.url, sessionId: result.sessionId },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return mapBillingError(err);
  }
}
