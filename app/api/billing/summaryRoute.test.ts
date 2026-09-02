import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests for GET /api/billing/summary.
 *
 * The endpoint is anonymous-safe, which is exactly why it needs its own file: an
 * endpoint that answers without a session is one that must be checked for what it
 * answers *with*. What is asserted here is the response contract — no price id, no
 * customer id, no organization id, never a shared cache, and a body no client could
 * mistake for a grant.
 */

const state = vi.hoisted(() => ({
  getMe: vi.fn(),
  proSummary: vi.fn(),
  resolveBilling: true,
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const name = token.description;
      if (name === "AuthService") return { getMe: state.getMe };
      if (name === "BillingService") {
        if (!state.resolveBilling) throw new Error("billing not registered");
        return { proSummary: state.proSummary };
      }
      throw new Error(`unexpected token ${String(name)}`);
    },
  },
}));

import * as summaryRoute from "@/app/api/billing/summary/route";
import { GET } from "@/app/api/billing/summary/route";
import { USER_SESSION_COOKIE } from "@/src/application/services/AuthService";

const ORIGIN = "http://localhost:3000";
const USER = { id: "user_owner", email: "owner@pdfdadi.test" };
const SESSION = `${USER_SESSION_COOKIE}=session-token`;

const OFFER = {
  configured: true,
  signedIn: true,
  plan: "free" as const,
  price: { unitAmount: 900, currency: "usd", interval: "month" as const, intervalCount: 1 },
  offer: { action: "checkout" as const, label: "Upgrade to Pro", note: null },
};

function makeRequest(query = "", cookie?: string) {
  const url = `${ORIGIN}/api/billing/summary${query}`;
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  const request = new Request(url, { method: "GET", headers });
  const cookieValue = cookie?.split("=").slice(1).join("=");
  Object.defineProperty(request, "cookies", {
    value: {
      get: (name: string) =>
        cookie?.startsWith(`${name}=`) ? { name, value: cookieValue } : undefined,
    },
    configurable: true,
  });
  Object.defineProperty(request, "nextUrl", { value: new URL(url), configurable: true });
  return request as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  state.getMe.mockReset().mockResolvedValue(USER);
  state.proSummary.mockReset().mockResolvedValue(OFFER);
  state.resolveBilling = true;
});

describe("route surface", () => {
  it("exposes only GET, on the node runtime, uncached", () => {
    expect(summaryRoute.runtime).toBe("nodejs");
    expect(summaryRoute.dynamic).toBe("force-dynamic");
    // A POST here would be a second way to reach billing state, and this endpoint
    // is deliberately a read.
    const verbs = Object.keys(summaryRoute).filter((k) => /^(POST|PUT|PATCH|DELETE)$/.test(k));
    expect(verbs).toEqual([]);
    expect(typeof summaryRoute.GET).toBe("function");
  });
});

describe("GET /api/billing/summary", () => {
  it("answers an anonymous visitor rather than refusing them", async () => {
    // The pricing page is public. A 401 here would mean the page could not show
    // its own price.
    state.proSummary.mockResolvedValue({
      ...OFFER,
      signedIn: false,
      plan: "guest",
      offer: { action: "sign_in", label: "Sign in to upgrade", note: "..." },
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(state.proSummary).toHaveBeenCalledWith({ userId: null, organizationId: undefined });
  });

  it("passes the session user id, never one from the query string", async () => {
    await GET(makeRequest("?userId=user_someone_else&organizationId=org_acme", SESSION));
    expect(state.proSummary).toHaveBeenCalledWith({
      userId: USER.id,
      organizationId: "org_acme",
    });
  });

  it("treats an unrecognized session cookie as anonymous", async () => {
    state.getMe.mockResolvedValue(null);
    const res = await GET(makeRequest("", SESSION));
    expect(res.status).toBe(200);
    expect(state.proSummary).toHaveBeenCalledWith({ userId: null, organizationId: undefined });
  });

  it("does not fail the request when session resolution throws", async () => {
    state.getMe.mockRejectedValue(new Error("database is locked"));
    const res = await GET(makeRequest("", SESSION));
    expect(res.status).toBe(200);
    expect((await res.json()).signedIn).toBe(true); // whatever the service said
    expect(state.proSummary).toHaveBeenCalledWith({ userId: null, organizationId: undefined });
  });

  it("drops an unusable organization id instead of forwarding it", async () => {
    await GET(makeRequest(`?organizationId=${"x".repeat(200)}`, SESSION));
    expect(state.proSummary.mock.calls[0][0].organizationId).toBeUndefined();
    state.proSummary.mockClear();
    await GET(makeRequest("?organizationId=", SESSION));
    expect(state.proSummary.mock.calls[0][0].organizationId).toBeUndefined();
  });

  it("returns a pre-formatted price and no raw amount, id or currency", async () => {
    const res = await GET(makeRequest("", SESSION));
    const json = await res.json();
    expect(json.priceLabel).toBe("$9.00");
    expect(json.pricePeriod).toBe("month");
    // The card must not be able to compute its own number: an amount in the body is
    // an invitation to format it a second, different way.
    expect(Object.keys(json).sort()).toEqual([
      "action",
      "actionLabel",
      "configured",
      "note",
      "plan",
      "priceLabel",
      "pricePeriod",
      "signedIn",
    ]);
  });

  it("sends no price id, customer id, subscription id or organization id", async () => {
    state.proSummary.mockResolvedValue({
      ...OFFER,
      // Shapes a future refactor might hand back. None may reach the wire.
      priceId: "price_live_1",
      customerId: "cus_live_1",
      subscriptionId: "sub_live_1",
      organizationId: "org_acme",
    });
    const text = await (await GET(makeRequest("", SESSION))).text();
    expect(text).not.toMatch(/price_live_1|cus_live_1|sub_live_1|org_acme/);
  });

  it("omits a price label entirely when no price could be read", async () => {
    state.proSummary.mockResolvedValue({ ...OFFER, price: null });
    const json = await (await GET(makeRequest("", SESSION))).json();
    // Null, not a placeholder and not a guess: the card then renders the approved
    // pricing copy.
    expect(json.priceLabel).toBeNull();
    expect(json.pricePeriod).toBeNull();
  });

  it("marks the response private and uncacheable", async () => {
    // A shared cache would serve one visitor's offer — "Manage billing" — to the
    // next visitor.
    const res = await GET(makeRequest("", SESSION));
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers 503, not 500, when billing cannot be resolved at all", async () => {
    state.resolveBilling = false;
    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("BILLING_NOT_CONFIGURED");
  });

  it("answers 503 when the service itself throws", async () => {
    state.proSummary.mockRejectedValue(new Error("organizations table is gone"));
    const res = await GET(makeRequest("", SESSION));
    expect(res.status).toBe(503);
    // No provider or database text on the wire.
    expect(await res.text()).not.toMatch(/organizations table/);
  });

  it("returns nothing a client could treat as proof of payment", async () => {
    state.proSummary.mockResolvedValue({
      ...OFFER,
      plan: "pro",
      offer: { action: "manage", label: "Manage billing", note: "Change your card." },
    });
    const json = await (await GET(makeRequest("", SESSION))).json();
    // `plan` is here because the card renders it and analytics reports it — but
    // there is no token, no signature and no expiry, so it is a label. Every
    // privileged action re-checks entitlement server-side.
    expect(json.plan).toBe("pro");
    expect(Object.keys(json)).not.toContain("token");
    expect(Object.keys(json)).not.toContain("entitlement");
  });
});
