import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripeSignatureHeader } from "@/src/infrastructure/billing/stripeSignature";
import { BillingError } from "@/src/domain/billing/subscription";

/**
 * Route-level security tests for /api/billing/*.
 *
 * The DI container is mocked so these run without a database or a Stripe account:
 * what is under test is the HTTP contract — who is refused, which status codes
 * Stripe's retry logic will see, and above all *what the response body is allowed
 * to contain*. The entitlement semantics are covered in BillingService.test.ts.
 */

const ORIGIN = "http://localhost:3000";
const WEBHOOK_SECRET = "whsec_test_pdfdadi";

const state = vi.hoisted(() => ({
  getMe: vi.fn(),
  startCheckout: vi.fn(),
  createPortalSession: vi.fn(),
  handleWebhook: vi.fn(),
  logs: [] as { level: string; message: string; fields?: Record<string, unknown> }[],
  resolveBilling: true,
}));

vi.mock("@/src/application/di/container", () => ({
  appContainer: {
    resolve: (token: symbol) => {
      const name = token.description;
      if (name === "AuthService") return { getMe: state.getMe };
      if (name === "BillingService") {
        if (!state.resolveBilling) throw new Error("billing not registered");
        return {
          startCheckout: state.startCheckout,
          createPortalSession: state.createPortalSession,
          handleWebhook: state.handleWebhook,
        };
      }
      if (name === "Logger") {
        const record = (level: string) => (message: string, fields?: Record<string, unknown>) =>
          state.logs.push({ level, message, fields });
        return {
          debug: record("debug"), info: record("info"),
          warn: record("warn"), error: record("error"),
          child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        };
      }
      throw new Error(`unexpected token ${String(name)}`);
    },
  },
}));

import { POST as checkoutPost } from "@/app/api/billing/checkout/route";
import { POST as portalPost } from "@/app/api/billing/portal/route";
import { POST as webhookPost } from "@/app/api/billing/webhook/route";
import * as checkoutRoute from "@/app/api/billing/checkout/route";
import * as portalRoute from "@/app/api/billing/portal/route";
import * as webhookRoute from "@/app/api/billing/webhook/route";
import { billingSessionRateLimiter } from "@/src/application/services/billingHttp";
import { USER_SESSION_COOKIE } from "@/src/application/services/AuthService";

const USER = { id: "user_owner", email: "owner@pdfdadi.test" };
const SESSION = `${USER_SESSION_COOKIE}=session-token`;

interface RequestOptions {
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  cookie?: string;
  headers?: Record<string, string>;
  ip?: string;
}

function makeRequest(url: string, options: RequestOptions = {}) {
  const headers = new Headers({ "Content-Type": "application/json", ...options.headers });
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.cookie) headers.set("cookie", options.cookie);
  headers.set("x-pdfdadi-peer", options.ip ?? `10.1.0.${Math.floor(Math.random() * 250) + 1}`);

  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const request = new Request(url, { method: "POST", headers, body });
  const cookieValue = options.cookie?.split("=").slice(1).join("=");
  Object.defineProperty(request, "cookies", {
    value: {
      get: (name: string) =>
        options.cookie?.startsWith(`${name}=`) ? { name, value: cookieValue } : undefined,
    },
    configurable: true,
  });
  return request as unknown as Parameters<typeof checkoutPost>[0];
}

beforeEach(() => {
  state.getMe.mockReset().mockResolvedValue(USER);
  state.startCheckout.mockReset().mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_1", sessionId: "cs_1" });
  state.createPortalSession.mockReset().mockResolvedValue({ url: "https://billing.stripe.com/p/session/1" });
  state.handleWebhook.mockReset().mockResolvedValue({ applied: true, eventId: "evt_1", eventType: "customer.subscription.updated" });
  state.logs.length = 0;
  state.resolveBilling = true;
  billingSessionRateLimiter.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("route surface", () => {
  it("exposes only POST, on the node runtime, uncached", () => {
    for (const route of [checkoutRoute, portalRoute, webhookRoute]) {
      expect(route.runtime).toBe("nodejs");
      expect(route.dynamic).toBe("force-dynamic");
      const verbs = Object.keys(route).filter((k) => /^(GET|PUT|PATCH|DELETE|HEAD)$/.test(k));
      expect(verbs).toEqual([]);
    }
    expect(typeof checkoutRoute.POST).toBe("function");
    expect(typeof portalRoute.POST).toBe("function");
    expect(typeof webhookRoute.POST).toBe("function");
  });
});

describe("POST /api/billing/checkout", () => {
  it("requires authentication", async () => {
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, { body: { plan: "pro" } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
    expect(state.startCheckout).not.toHaveBeenCalled();
  });

  it("rejects a session cookie the auth service does not recognize", async () => {
    state.getMe.mockResolvedValue(null);
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, { body: { plan: "pro" }, cookie: SESSION }));
    expect(res.status).toBe(401);
    expect(state.startCheckout).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin post before touching the session", async () => {
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, {
      body: { plan: "pro" }, cookie: SESSION, origin: "https://evil.example",
    }));
    expect(res.status).toBe(403);
    expect(state.getMe).not.toHaveBeenCalled();
    expect(state.startCheckout).not.toHaveBeenCalled();
  });

  it("rejects an arbitrary Stripe price id supplied as the plan", async () => {
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, {
      body: { plan: "price_1MoBy5LkdIwHu7ixZhnattbh" }, cookie: SESSION,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_INPUT");
    expect(state.startCheckout).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-purchasable plan", async () => {
    for (const body of [{}, { plan: "free" }, { plan: "guest" }, { plan: 1 }, { plan: null }, { plan: ["pro"] }]) {
      const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, { body, cookie: SESSION }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(state.startCheckout).not.toHaveBeenCalled();
  });

  it("passes only the user id, the plan and an optional org id to the service", async () => {
    // Everything else in the body is dropped on the floor. The assertion is on the
    // *whole* argument object, so a future field silently reaching the service —
    // priceId, amount, successUrl, customerId — fails here.
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, {
      cookie: SESSION,
      body: {
        plan: "pro",
        organizationId: "org_acme",
        priceId: "price_attacker",
        price: "price_attacker",
        amount: 1,
        currency: "usd",
        customerId: "cus_attacker",
        successUrl: "https://evil.example/paid",
        cancelUrl: "https://evil.example/cancel",
        trial_period_days: 3650,
        coupon: "FREEFOREVER",
        status: "active",
        planId: "business",
        userId: "user_someone_else",
      },
    }));
    expect(res.status).toBe(200);
    expect(state.startCheckout).toHaveBeenCalledTimes(1);
    const arg = state.startCheckout.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["ip", "organizationId", "plan", "userId"]);
    expect(arg.userId).toBe(USER.id);
    expect(arg.plan).toBe("pro");
    expect(arg.organizationId).toBe("org_acme");
  });

  it("returns a checkout URL and nothing that resembles an entitlement", async () => {
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, {
      body: { plan: "pro" }, cookie: SESSION,
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["sessionId", "url"]);
    expect(json.url).toBe("https://checkout.stripe.com/c/pay/cs_1");
    // No plan, no status, no subscription: a client has nothing here it could
    // mistake for proof of payment.
    const serialized = JSON.stringify(json);
    expect(serialized).not.toMatch(/\b(plan|planId|status|subscription|entitle)/i);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("maps a forbidden organization to 403 without naming it", async () => {
    state.startCheckout.mockRejectedValue(new BillingError("FORBIDDEN", "Billing is not available for this organization."));
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, {
      body: { plan: "pro", organizationId: "org_rival" }, cookie: SESSION,
    }));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("org_rival");
  });

  it("maps an unconfigured plan to 503 rather than inventing a price", async () => {
    state.startCheckout.mockRejectedValue(new BillingError("PLAN_NOT_PURCHASABLE", "No price is configured for the pro plan."));
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, { body: { plan: "pro" }, cookie: SESSION }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("PLAN_NOT_PURCHASABLE");
  });

  it("does not leak a provider error body", async () => {
    state.startCheckout.mockRejectedValue(new Error("No such price: 'price_internal_test' account acct_123"));
    const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, { body: { plan: "pro" }, cookie: SESSION }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("acct_123");
    expect(text).not.toContain("price_internal_test");
  });

  it("rate limits session creation per IP", async () => {
    const ip = "10.9.9.9";
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await checkoutPost(makeRequest(`${ORIGIN}/api/billing/checkout`, { body: { plan: "pro" }, cookie: SESSION, ip }));
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});

describe("POST /api/billing/portal", () => {
  it("requires authentication", async () => {
    const res = await portalPost(makeRequest(`${ORIGIN}/api/billing/portal`, { body: {} }));
    expect(res.status).toBe(401);
    expect(state.createPortalSession).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin post", async () => {
    const res = await portalPost(makeRequest(`${ORIGIN}/api/billing/portal`, { body: {}, cookie: SESSION, origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(state.createPortalSession).not.toHaveBeenCalled();
  });

  it("never forwards a client-supplied customer id", async () => {
    const res = await portalPost(makeRequest(`${ORIGIN}/api/billing/portal`, {
      cookie: SESSION,
      body: {
        customerId: "cus_victim", customer: "cus_victim",
        organizationId: "org_acme", returnUrl: "https://evil.example",
      },
    }));
    expect(res.status).toBe(200);
    const arg = state.createPortalSession.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(arg).sort()).toEqual(["ip", "organizationId", "userId"]);
    expect(JSON.stringify(arg)).not.toContain("cus_victim");
    expect(JSON.stringify(arg)).not.toContain("evil.example");
    expect(arg.userId).toBe(USER.id);
  });

  it("returns 409 when the organization has no billing customer", async () => {
    state.createPortalSession.mockRejectedValue(new BillingError("NO_BILLING_CUSTOMER", "No billing account yet."));
    const res = await portalPost(makeRequest(`${ORIGIN}/api/billing/portal`, { body: {}, cookie: SESSION }));
    expect(res.status).toBe(409);
  });

  it("returns 403 for an organization the caller may not manage", async () => {
    state.createPortalSession.mockRejectedValue(new BillingError("FORBIDDEN", "Only an organization owner can manage billing."));
    const res = await portalPost(makeRequest(`${ORIGIN}/api/billing/portal`, {
      body: { organizationId: "org_rival" }, cookie: SESSION,
    }));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/billing/webhook", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", created: 1_800_000_000 });

  function signedRequest(rawBody = payload, secret = WEBHOOK_SECRET) {
    return makeRequest(`${ORIGIN}/api/billing/webhook`, {
      rawBody,
      headers: { "stripe-signature": stripeSignatureHeader(rawBody, secret, 1_800_000_000) },
      // Stripe sends neither an Origin header nor a cookie. Both absent here on
      // purpose: if this route ever required them it would reject every real
      // delivery, and the test would be the only place that noticed.
      origin: null,
    });
  }

  it("accepts a signed delivery with no session and no Origin header", async () => {
    const res = await webhookPost(signedRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, applied: true, reason: null });
    expect(state.getMe).not.toHaveBeenCalled();
  });

  it("passes the raw bytes, unparsed, to the service", async () => {
    // Signature is computed over the exact body. A route that parsed and
    // re-serialized would verify a different string and fail on every real event
    // whose key order or number formatting differed.
    const raw = '{"id":"evt_2","created":1800000000,"type":"customer.subscription.updated","data":{"object":{"amount":1.0}}}';
    await webhookPost(signedRequest(raw));
    const arg = state.handleWebhook.mock.calls[0][0] as { rawBody: string; signature: string };
    expect(arg.rawBody).toBe(raw);
    expect(arg.signature).toContain("t=1800000000,v1=");
  });

  it("returns 400 for an invalid signature and does not echo the payload", async () => {
    state.handleWebhook.mockRejectedValue(new BillingError("INVALID_SIGNATURE", "Webhook signature does not match."));
    const res = await webhookPost(makeRequest(`${ORIGIN}/api/billing/webhook`, {
      rawBody: '{"id":"evt_forged","type":"customer.subscription.updated","created":1800000000}',
      headers: { "stripe-signature": "t=1800000000,v1=deadbeef" },
      origin: null,
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SIGNATURE");
    // Nothing from the unverified body reaches the log.
    expect(JSON.stringify(state.logs)).not.toContain("evt_forged");
  });

  it("returns 400 when the signature header is missing entirely", async () => {
    state.handleWebhook.mockRejectedValue(new BillingError("INVALID_SIGNATURE", "Missing signature header."));
    const res = await webhookPost(makeRequest(`${ORIGIN}/api/billing/webhook`, { rawBody: payload, origin: null }));
    expect(res.status).toBe(400);
  });

  it("returns 200 for a duplicate so Stripe stops retrying", async () => {
    state.handleWebhook.mockResolvedValue({ applied: false, reason: "duplicate", eventId: "evt_1", eventType: "customer.subscription.updated" });
    const res = await webhookPost(signedRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, applied: false, reason: "duplicate" });
  });

  it("returns 200 for stale, ignored and unknown-customer outcomes", async () => {
    for (const reason of ["stale", "ignored", "unknown_customer", "ownership_mismatch", "unmapped_price"]) {
      state.handleWebhook.mockResolvedValue({ applied: false, reason, eventId: "evt_1", eventType: "x" });
      const res = await webhookPost(signedRequest());
      expect(res.status, reason).toBe(200);
    }
  });

  it("returns 500 on an unexpected failure so the delivery is retried", async () => {
    state.handleWebhook.mockRejectedValue(new Error("database is locked"));
    const res = await webhookPost(signedRequest());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("WEBHOOK_FAILED");
    expect(state.logs.some((l) => l.level === "error")).toBe(true);
  });

  it("returns 503 when the deployment has no billing configured", async () => {
    state.handleWebhook.mockRejectedValue(new BillingError("BILLING_NOT_CONFIGURED", "Billing is not configured."));
    const res = await webhookPost(signedRequest());
    expect(res.status).toBe(503);
  });

  it("returns 503 when the billing service cannot be resolved at all", async () => {
    state.resolveBilling = false;
    const res = await webhookPost(signedRequest());
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("BILLING_UNAVAILABLE");
  });

  it("refuses an oversized body before reading it", async () => {
    const res = await webhookPost(makeRequest(`${ORIGIN}/api/billing/webhook`, {
      rawBody: payload,
      headers: { "stripe-signature": "t=1,v1=x", "content-length": String(2 * 1024 * 1024) },
      origin: null,
    }));
    expect(res.status).toBe(413);
    expect(state.handleWebhook).not.toHaveBeenCalled();
  });

  it("is not rate limited, because Stripe bursts on retry", async () => {
    const ip = "10.8.8.8";
    for (let i = 0; i < 10; i++) {
      const req = makeRequest(`${ORIGIN}/api/billing/webhook`, {
        rawBody: payload,
        headers: { "stripe-signature": stripeSignatureHeader(payload, WEBHOOK_SECRET, 1_800_000_000) },
        origin: null, ip,
      });
      expect((await webhookPost(req)).status).not.toBe(429);
    }
  });
});
