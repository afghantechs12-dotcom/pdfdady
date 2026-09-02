import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_SESSION_ERROR,
  SUMMARY_ENDPOINT,
  __resetProSummaryCache,
  awaitingEntitlement,
  billingSessionError,
  loadProSummary,
  parseProSummary,
  refreshProSummary,
  startBillingSession,
  type ProSummaryView,
} from "./proSummaryClient";

/**
 * The browser side of the Pro card.
 *
 * What is worth asserting is not the happy path — it is that every malformed,
 * hostile or half-written response ends at "show the approved copy" rather than at
 * a rendered offer, and that a failed POST becomes a sentence instead of a silent
 * no-op. `ProUpgradeAction.tsx` holds only markup on top of this.
 */

const GOOD = {
  configured: true,
  signedIn: true,
  plan: "free",
  priceLabel: "$9.00",
  pricePeriod: "month",
  action: "checkout",
  actionLabel: "Upgrade to Pro",
  note: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  __resetProSummaryCache();
  vi.restoreAllMocks();
});

describe("parseProSummary", () => {
  it("reads a well-formed summary", () => {
    expect(parseProSummary(GOOD)).toEqual({
      configured: true,
      signedIn: true,
      plan: "free",
      priceLabel: "$9.00",
      pricePeriod: "month",
      action: "checkout",
      actionLabel: "Upgrade to Pro",
      note: null,
    });
  });

  it("returns null for anything that is not an object", () => {
    for (const value of [null, undefined, 0, "", "<html>502 Bad Gateway</html>", [GOOD], true]) {
      expect(parseProSummary(value), JSON.stringify(value ?? null)).toBeNull();
    }
  });

  it("returns null rather than assembling an offer from a partial response", () => {
    // The failure this pins: a truncated or renamed response producing a control
    // whose action came from a default. There is no default.
    for (const key of ["action", "actionLabel", "plan", "configured", "signedIn"]) {
      const partial = { ...GOOD } as Record<string, unknown>;
      delete partial[key];
      expect(parseProSummary(partial), key).toBeNull();
    }
  });

  it("returns null for an action it does not know", () => {
    for (const action of ["grant", "activate", "pro", "", "CHECKOUT"]) {
      expect(parseProSummary({ ...GOOD, action }), action).toBeNull();
    }
  });

  it("returns null when a boolean field arrives as a string", () => {
    // `configured: "false"` is truthy. Coercing it would render a buy button in a
    // deployment that cannot sell anything.
    expect(parseProSummary({ ...GOOD, configured: "false" })).toBeNull();
    expect(parseProSummary({ ...GOOD, signedIn: "true" })).toBeNull();
  });

  it("drops a price label that is not a usable string, rather than rendering it", () => {
    expect(parseProSummary({ ...GOOD, priceLabel: 900 })?.priceLabel).toBeNull();
    expect(parseProSummary({ ...GOOD, priceLabel: "" })?.priceLabel).toBeNull();
    expect(parseProSummary({ ...GOOD, pricePeriod: {} })?.pricePeriod).toBeNull();
  });

  it("ignores extra fields instead of passing them on", () => {
    const parsed = parseProSummary({
      ...GOOD,
      priceId: "price_live_secret",
      customerId: "cus_secret",
      organizationId: "org_secret",
      unitAmount: 900,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/price_live_secret|cus_secret|org_secret/);
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "action",
      "actionLabel",
      "configured",
      "plan",
      "priceLabel",
      "pricePeriod",
      "note",
      "signedIn",
    ].sort());
  });
});

describe("loadProSummary", () => {
  it("makes one request for concurrent readers on the same page", async () => {
    // The pricing card reads this from three places (badge, price, button). Three
    // requests per page view would be three chances to hit the provider.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GOOD));
    const [a, b, c] = await Promise.all([
      loadProSummary(undefined, fetchImpl as unknown as typeof fetch),
      loadProSummary(undefined, fetchImpl as unknown as typeof fetch),
      loadProSummary(undefined, fetchImpl as unknown as typeof fetch),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it("requests the endpoint with no store and same-origin credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GOOD));
    await loadProSummary(undefined, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(SUMMARY_ENDPOINT);
    // A cached per-caller offer is the one thing this must not render.
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("same-origin");
  });

  it("keys the cache by organization, and encodes the id", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(GOOD));
    await loadProSummary("org_a", fetchImpl as unknown as typeof fetch);
    await loadProSummary("org b/../org_c", fetchImpl as unknown as typeof fetch);
    await loadProSummary("org_a", fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      `${SUMMARY_ENDPOINT}?organizationId=org%20b%2F..%2Forg_c`,
    );
  });

  it("returns null for a non-OK response and does not cache the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: "BILLING_NOT_CONFIGURED" } }, 503))
      .mockResolvedValueOnce(jsonResponse(GOOD));
    expect(await loadProSummary(undefined, fetchImpl as unknown as typeof fetch)).toBeNull();
    // A summary that failed because the deployment blinked must be retryable; a
    // cached null would leave the card on approved copy for the whole session.
    expect((await loadProSummary(undefined, fetchImpl as unknown as typeof fetch))?.action).toBe(
      "checkout",
    );
  });

  it("returns null when the network throws, and when the body is not JSON", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await loadProSummary(undefined, throwing as unknown as typeof fetch)).toBeNull();
    __resetProSummaryCache();
    const html = vi.fn().mockResolvedValue(new Response("<html>proxy error</html>", { status: 200 }));
    expect(await loadProSummary(undefined, html as unknown as typeof fetch)).toBeNull();
  });
});

describe("awaitingEntitlement", () => {
  it("keeps waiting while checkout is still being offered", () => {
    expect(awaitingEntitlement(parseProSummary(GOOD))).toBe(true);
  });

  it("keeps waiting when the summary could not be read at all", () => {
    // Not proof of an upgrade. The alternative — treating an unreadable summary as
    // success — is a client-side grant.
    expect(awaitingEntitlement(null)).toBe(true);
  });

  it("stops once the server reports a paid plan", () => {
    for (const action of ["manage", "current"] as const) {
      const summary = parseProSummary({ ...GOOD, plan: "pro", action, actionLabel: "x" });
      expect(awaitingEntitlement(summary), action).toBe(false);
    }
  });
});

describe("startBillingSession", () => {
  it("posts only the plan to checkout, and nothing that names a price", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: "https://checkout.stripe.com/c/pay/cs_1" }));
    const result = await startBillingSession("checkout", undefined, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_1" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("/api/billing/checkout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const body = JSON.parse(init.body);
    expect(Object.keys(body)).toEqual(["plan"]);
    expect(body.plan).toBe("pro");
  });

  it("forwards an organization id to checkout as the only extra field", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: "https://checkout.stripe.com/x" }));
    await startBillingSession("checkout", "org_acme", fetchImpl as unknown as typeof fetch);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ plan: "pro", organizationId: "org_acme" });
  });

  it("posts no plan at all to the portal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: "https://billing.stripe.com/p/1" }));
    await startBillingSession("manage", undefined, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl.mock.calls[0][0]).toBe("/api/billing/portal");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({});
  });

  it("never sends a price, an amount, a customer or a return URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: "https://checkout.stripe.com/x" }));
    for (const action of ["checkout", "manage"] as const) {
      await startBillingSession(action, "org_acme", fetchImpl as unknown as typeof fetch);
    }
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].body).not.toMatch(/price|amount|currency|customer|successUrl|returnUrl|coupon|trial/i);
    }
  });

  it("turns a refusal into a sentence chosen from the error code", async () => {
    const cases: [number, string, RegExp][] = [
      [401, "UNAUTHORIZED", /sign in/i],
      [403, "FORBIDDEN", /owner/i],
      [409, "NO_BILLING_CUSTOMER", /no subscription/i],
      [429, "RATE_LIMITED", /too many/i],
      [503, "BILLING_NOT_CONFIGURED", /not available/i],
    ];
    for (const [status, code, expected] of cases) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { code } }, status));
      const result = await startBillingSession("checkout", undefined, fetchImpl as unknown as typeof fetch);
      expect("error" in result && result.error, code).toMatch(expected);
    }
  });

  it("does not put a provider message on screen", async () => {
    // The endpoints do not forward provider text, and this is the second line of
    // that defence: the copy is chosen by code, so a leak upstream still cannot
    // become UI.
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { code: "PROVIDER_FAILED", message: "No such price: price_live_1 on acct_123" } },
        502,
      ),
    );
    const result = await startBillingSession("checkout", undefined, fetchImpl as unknown as typeof fetch);
    expect("error" in result && result.error).not.toMatch(/price_live_1|acct_123/);
  });

  it("reports a generic failure for an unknown code, an unparseable body and no url", async () => {
    const unknown = vi.fn().mockResolvedValue(jsonResponse({ error: { code: "WHAT" } }, 418));
    expect(await startBillingSession("checkout", undefined, unknown as unknown as typeof fetch)).toEqual({
      error: GENERIC_SESSION_ERROR,
    });

    const garbage = vi.fn().mockResolvedValue(new Response("not json", { status: 500 }));
    expect(await startBillingSession("checkout", undefined, garbage as unknown as typeof fetch)).toEqual({
      error: GENERIC_SESSION_ERROR,
    });

    // A 200 with no URL: nothing to navigate to, so it is a failure, not a
    // navigation to "undefined".
    const empty = vi.fn().mockResolvedValue(jsonResponse({ sessionId: "cs_1" }));
    expect(await startBillingSession("checkout", undefined, empty as unknown as typeof fetch)).toEqual({
      error: GENERIC_SESSION_ERROR,
    });
  });

  it("reports a network failure rather than throwing into a click handler", async () => {
    const offline = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const result = await startBillingSession("checkout", undefined, offline as unknown as typeof fetch);
    expect("error" in result && result.error).toMatch(/network/i);
  });

  it("has a non-empty sentence for every code it maps", () => {
    for (const code of [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "NO_BILLING_CUSTOMER",
      "BILLING_NOT_CONFIGURED",
      "PLAN_NOT_PURCHASABLE",
      "PROVIDER_FAILED",
      "RATE_LIMITED",
      "INVALID_INPUT",
      null,
    ]) {
      expect(billingSessionError(code).length, String(code)).toBeGreaterThan(10);
    }
  });
});

describe("what the client half cannot do", () => {
  it("has no endpoint that could grant a plan", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ url: "https://checkout.stripe.com/x" }));
    await startBillingSession("checkout", undefined, fetchImpl as unknown as typeof fetch);
    await loadProSummary(undefined, fetchImpl as unknown as typeof fetch);
    const paths = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(paths).toEqual(["/api/billing/checkout", SUMMARY_ENDPOINT]);
    // Nothing here posts to an "activate", "grant" or webhook-shaped path — the
    // only writer of entitlement is the signed webhook.
    for (const path of paths) expect(path).not.toMatch(/activate|grant|entitle|webhook/i);
  });

  it("treats a summary claiming Pro as a label, since the type carries no entitlement", () => {
    const forged = parseProSummary({
      ...GOOD,
      plan: "pro",
      action: "manage",
      actionLabel: "Manage billing",
    }) as ProSummaryView;
    // The shape a hostile devtools response could produce carries no token, no
    // signature and no capability: it selects a button, and both buttons
    // re-authorize server-side.
    expect(Object.keys(forged)).not.toContain("token");
    expect(awaitingEntitlement(forged)).toBe(false);
  });
});

describe("failure isolation", () => {
  /** Everything a browser can hand back that is not a summary. */
  const FAILURES: Array<[string, () => Promise<Response>]> = [
    ["fetch throws synchronously", () => {
      throw new Error("offline");
    }],
    ["fetch rejects", () => Promise.reject(new Error("dns failure"))],
    ["a proxy returns an HTML error page", async () => new Response("<html>502</html>", { status: 502 })],
    ["a 200 with a body that is not JSON", async () => new Response("not json", { status: 200 })],
    ["a 200 with a JSON body of the wrong shape", async () => jsonResponse({ plan: "pro" })],
    ["the body throws while being read", async () =>
      ({ ok: true, json: () => Promise.reject(new Error("truncated")) }) as unknown as Response],
  ];

  it("resolves for every failure rather than rejecting into the caller", async () => {
    // This is the property that keeps a billing outage out of the workspace: the
    // control's effect awaits these, and a rejection there is an unhandled
    // rejection inside whatever card embedded it. Every path must produce a value
    // the component can render past.
    for (const [name, impl] of FAILURES) {
      await expect(
        loadProSummary(undefined, impl as unknown as typeof fetch),
        name,
      ).resolves.toBeNull();
      __resetProSummaryCache();
      await expect(
        refreshProSummary("org_acme", impl as unknown as typeof fetch),
        name,
      ).resolves.toBeNull();
      __resetProSummaryCache();
    }
  });

  it("turns every session failure into a sentence rather than a rejection", async () => {
    for (const [name, impl] of FAILURES) {
      const result = await startBillingSession(
        "checkout",
        undefined,
        impl as unknown as typeof fetch,
      );
      // A rejection here would escape the click handler as an unhandled rejection;
      // an `{ error }` is something the button can display.
      expect(result, name).not.toHaveProperty("url");
      expect(typeof (result as { error: string }).error, name).toBe("string");
    }
  });

  it("still shows the fallback after a failure, and lets the next mount retry", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("blip"));
    expect(await loadProSummary(undefined, failing as unknown as typeof fetch)).toBeNull();
    // Not cached: a summary that failed because the network blinked must be
    // readable on the next attempt, or one bad moment costs the offer for the life
    // of the page.
    const working = vi.fn().mockResolvedValue(jsonResponse(GOOD));
    expect(await loadProSummary(undefined, working as unknown as typeof fetch)).not.toBeNull();
    expect(working).toHaveBeenCalledTimes(1);
  });
});
