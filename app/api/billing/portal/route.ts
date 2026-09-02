import { type NextRequest } from "next/server";
import {
  billingService,
  enforceBillingRateLimit,
  mapBillingError,
  organizationIdFrom,
  readOptionalJsonBody,
  requireBillingUser,
} from "@/src/application/services/billingHttp";
import { requireSameOrigin } from "@/src/application/services/workspaceCsrf";
import { clientIp } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/billing/portal — open the provider's billing portal.
 *
 * Body: `{ organizationId?: string }` and nothing else. There is deliberately no
 * customer-id field: the portal is opened with the customer stored against the
 * caller's own organization, so a request cannot ask for someone else's billing
 * history, invoices or payment methods. An organization with no stored customer
 * gets a 409, not a portal.
 */
export async function POST(req: NextRequest) {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const limited = enforceBillingRateLimit(req);
  if (limited) return limited;

  const auth = await requireBillingUser(req);
  if ("response" in auth) return auth.response;

  const body = await readOptionalJsonBody(req);

  try {
    const result = await billingService().createPortalSession({
      userId: auth.user.id,
      organizationId: organizationIdFrom(body),
      ip: clientIp(req),
    });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return mapBillingError(err);
  }
}
