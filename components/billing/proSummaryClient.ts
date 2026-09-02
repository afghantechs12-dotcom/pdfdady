import type { PlanId } from "@/src/domain/metering/plans";
import type { ProOfferAction } from "@/src/domain/billing/proOffer";

/**
 * The browser half of the Pro upgrade control: reading `/api/billing/summary`,
 * and starting a billing session.
 *
 * Split out of the component for the same reason `usageViewModel.ts` is split out
 * of `UsageCard.tsx` — vitest runs `environment: "node"`, so anything that must be
 * asserted has to live outside the `.tsx`. What is asserted here is not cosmetic:
 * that a malformed summary produces no offer at all rather than a default one,
 * that one page view makes one request, and that a failed checkout POST turns into
 * a sentence a user can act on instead of a status code.
 *
 * Nothing here grants anything. `action` decides which button is drawn; both
 * buttons re-authorize server-side on every POST, so a caller who edits this
 * response in their own devtools has changed a label.
 */

export const SUMMARY_ENDPOINT = "/api/billing/summary";

export interface ProSummaryView {
  configured: boolean;
  signedIn: boolean;
  plan: PlanId;
  /** Already formatted, or null when no price could be read. Never a raw amount. */
  priceLabel: string | null;
  pricePeriod: string | null;
  action: ProOfferAction;
  actionLabel: string;
  note: string | null;
}

const ACTIONS: readonly ProOfferAction[] = [
  "unavailable",
  "sign_in",
  "checkout",
  "manage",
  "current",
  "owner_only",
];

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads a summary response, or returns null.
 *
 * Total, like `parseUsage`: an HTML error page from a proxy, a truncated body, or
 * a future response missing a field all become null, and the card then keeps the
 * server-rendered approved copy. There is deliberately no partial parse — an
 * offer assembled from half a response is how a "Manage billing" button appears
 * for someone who has no subscription.
 */
export function parseProSummary(value: unknown): ProSummaryView | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const action = str(raw.action);
  const actionLabel = str(raw.actionLabel);
  const plan = str(raw.plan);
  if (!action || !actionLabel || !plan) return null;
  if (!ACTIONS.includes(action as ProOfferAction)) return null;
  if (typeof raw.configured !== "boolean" || typeof raw.signedIn !== "boolean") return null;

  return {
    configured: raw.configured,
    signedIn: raw.signedIn,
    plan: plan as PlanId,
    priceLabel: str(raw.priceLabel),
    pricePeriod: str(raw.pricePeriod),
    action: action as ProOfferAction,
    actionLabel,
    note: str(raw.note),
  };
}

/**
 * In-flight and settled summaries, keyed by organization id.
 *
 * The pricing card renders the price and the button as two separate client
 * components, and without this they would be two requests — each of which can
 * reach Stripe. One entry per key, so a page view is one request however many
 * controls read it.
 *
 * A null result is NOT retained: a summary that failed because the network
 * blinked must be retryable by the next mount. Only a real answer is cached, and
 * only for the life of the page.
 *
 * ponytail: per-tab, no TTL — the whole cache dies with the page, and
 * `refreshProSummary` covers the one case (returning from checkout) where a
 * stale answer is visible.
 */
const inFlight = new Map<string, Promise<ProSummaryView | null>>();

function cacheKey(organizationId?: string): string {
  return organizationId ?? "";
}

export function loadProSummary(
  organizationId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProSummaryView | null> {
  const key = cacheKey(organizationId);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const url = organizationId
    ? `${SUMMARY_ENDPOINT}?organizationId=${encodeURIComponent(organizationId)}`
    : SUMMARY_ENDPOINT;

  const promise = (async () => {
    try {
      // `no-store`: the response is per-caller and marked private, and a cached
      // offer from a previous session is the one thing this must not render.
      const res = await fetchImpl(url, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return null;
      return parseProSummary(await res.json());
    } catch {
      return null;
    }
  })().then((value) => {
    if (value === null) inFlight.delete(key);
    return value;
  });

  inFlight.set(key, promise);
  return promise;
}

/** Drops the cached answer and reads again. Used after returning from checkout. */
export function refreshProSummary(
  organizationId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProSummaryView | null> {
  inFlight.delete(cacheKey(organizationId));
  return loadProSummary(organizationId, fetchImpl);
}

/**
 * Whether the account still has no Pro entitlement.
 *
 * Used only after returning from Stripe. `checkout` means the purchase control is
 * still being offered, i.e. the webhook has not landed yet — and null means we
 * could not read the summary at all, which is also not proof of an upgrade. Note
 * what this is *not*: a client-side grant. It decides whether to poll the server
 * again, never what the user may do.
 */
export function awaitingEntitlement(summary: ProSummaryView | null): boolean {
  return summary === null || summary.action === "checkout";
}

// ---------------------------------------------------------------------------

/**
 * What to tell the user when a billing POST fails.
 *
 * Keyed by our own error codes rather than by the server's message text: the
 * status line is stable API, the sentence is not, and a provider message that
 * ever did leak upstream must not become UI copy here.
 */
const SESSION_ERRORS: Record<string, string> = {
  UNAUTHORIZED: "Your session has expired. Sign in again to continue.",
  FORBIDDEN: "Only an organization owner can manage billing.",
  NO_BILLING_CUSTOMER: "There is no subscription on this account yet.",
  BILLING_NOT_CONFIGURED: "Payments are not available right now.",
  PLAN_NOT_PURCHASABLE: "Payments are not available right now.",
  PROVIDER_FAILED: "Our payment provider did not respond. Try again in a moment.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  INVALID_INPUT: "That plan cannot be purchased.",
};

export const GENERIC_SESSION_ERROR = "Could not start checkout. Try again in a moment.";

export function billingSessionError(code: string | null): string {
  return (code && SESSION_ERRORS[code]) || GENERIC_SESSION_ERROR;
}

export type BillingSessionResult = { url: string } | { error: string };

/**
 * Starts checkout or opens the portal, and returns the URL to navigate to.
 *
 * The URL is used verbatim by the caller and is not validated here — it comes
 * from our own same-origin endpoint, which builds it from the provider response
 * and never from anything a client sent. Validating it in the browser would
 * suggest the browser is the authority on where checkout lives; it is not.
 */
export async function startBillingSession(
  action: "checkout" | "manage",
  organizationId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BillingSessionResult> {
  const endpoint = action === "checkout" ? "/api/billing/checkout" : "/api/billing/portal";
  // `plan` is the only thing sent, and only for checkout. No price, no amount, no
  // return URL: the endpoint refuses those, and sending them would imply a client
  // could choose them.
  const body = action === "checkout" ? { plan: "pro", organizationId } : { organizationId };

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }

  const payload: unknown = await res.json().catch(() => null);
  const record =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};

  if (!res.ok) {
    const error =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {};
    return { error: billingSessionError(str(error.code)) };
  }

  const url = str(record.url);
  return url ? { url } : { error: GENERIC_SESSION_ERROR };
}

/** Test seam. Not exported to the component — the page cache is per-tab. */
export function __resetProSummaryCache(): void {
  inFlight.clear();
}
