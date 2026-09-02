import { describe, expect, it } from "vitest";
import {
  formatPlanPeriod,
  formatPlanPrice,
  offerPosts,
  proOffer,
  type DisplayPrice,
  type ProOfferInput,
} from "./proOffer";
import { PURCHASABLE_PLAN_IDS } from "./subscription";

/**
 * The Pro card's decision policy.
 *
 * Two properties are worth the file. First: no combination of session, role, plan
 * or stored customer can produce a purchase control in a deployment that cannot
 * complete a purchase — asserted by enumeration, not by example, because "we
 * checked the obvious cases" is how the one unchecked combination ships. Second:
 * a price label exists only for a price that was actually read, so no input
 * produces a plausible number the deployment is not charging.
 */

const BASE: ProOfferInput = {
  configured: true,
  signedIn: true,
  canManageBilling: true,
  plan: "free",
  hasBillingAccount: false,
};

/** Every input combination, so a claim below covers the whole space. */
function everyInput(): ProOfferInput[] {
  const out: ProOfferInput[] = [];
  for (const configured of [true, false]) {
    for (const signedIn of [true, false]) {
      for (const canManageBilling of [true, false]) {
        for (const plan of ["guest", "free", "pro", "business"] as const) {
          for (const hasBillingAccount of [true, false]) {
            out.push({ configured, signedIn, canManageBilling, plan, hasBillingAccount });
          }
        }
      }
    }
  }
  return out;
}

describe("proOffer — unconfigured deployments", () => {
  it("never offers a control that posts, for any other combination of facts", () => {
    const offered = everyInput()
      .filter((input) => !input.configured)
      .filter((input) => offerPosts(proOffer(input).action));
    expect(offered).toEqual([]);
  });

  it("keeps the approved copy's action rather than a disabled buy button", () => {
    const offer = proOffer({ ...BASE, configured: false });
    expect(offer.action).toBe("unavailable");
    // The label is the pricing store's own CTA. A "coming soon" flavoured
    // *purchase* label here would be the card promising a checkout that does not
    // exist in this deployment.
    expect(offer.label).toBe("Contact us");
  });

  it("outranks every other fact, including an already-paid plan", () => {
    for (const plan of ["pro", "business"] as const) {
      const offer = proOffer({ ...BASE, configured: false, plan, hasBillingAccount: true });
      expect(offer.action).toBe("unavailable");
    }
  });
});

describe("proOffer — who is offered a purchase", () => {
  it("offers checkout to a signed-in owner on a free plan", () => {
    const offer = proOffer(BASE);
    expect(offer.action).toBe("checkout");
    expect(offer.label).toMatch(/upgrade/i);
    expect(offerPosts(offer.action)).toBe(true);
  });

  it("sends an anonymous visitor to sign in rather than to checkout", () => {
    const offer = proOffer({ ...BASE, signedIn: false, plan: "guest" });
    expect(offer.action).toBe("sign_in");
    // A link, not a POST: an anonymous checkout is a 401 at the endpoint, so
    // offering the button would be a control that cannot work.
    expect(offerPosts(offer.action)).toBe(false);
  });

  it("tells a non-owner to ask their owner instead of offering a refused button", () => {
    const offer = proOffer({ ...BASE, canManageBilling: false });
    expect(offer.action).toBe("owner_only");
    expect(offerPosts(offer.action)).toBe(false);
    expect(offer.note).toMatch(/owner/i);
  });

  it("never offers checkout to a caller who cannot manage billing", () => {
    // The endpoint answers 403 for these callers. This is the read path agreeing
    // with the write path: every offered checkout must be one the POST accepts.
    const wrong = everyInput()
      .filter((input) => !input.canManageBilling)
      .filter((input) => proOffer(input).action === "checkout");
    expect(wrong).toEqual([]);
  });

  it("never offers checkout to an anonymous visitor", () => {
    const wrong = everyInput()
      .filter((input) => !input.signedIn)
      .filter((input) => offerPosts(proOffer(input).action));
    expect(wrong).toEqual([]);
  });
});

describe("proOffer — callers who already pay", () => {
  it("offers the portal to a paying owner with a stored customer", () => {
    const offer = proOffer({ ...BASE, plan: "pro", hasBillingAccount: true });
    expect(offer.action).toBe("manage");
    expect(offerPosts(offer.action)).toBe(true);
  });

  it("offers no portal without a stored customer, because the endpoint answers 409", () => {
    const offer = proOffer({ ...BASE, plan: "pro", hasBillingAccount: false });
    expect(offer.action).toBe("current");
    expect(offerPosts(offer.action)).toBe(false);
  });

  it("tells a paying member their plan rather than that they lack permission", () => {
    const offer = proOffer({
      ...BASE,
      plan: "pro",
      canManageBilling: false,
      hasBillingAccount: true,
    });
    expect(offer.action).toBe("current");
    expect(offer.label).not.toMatch(/upgrade/i);
  });

  it("never offers to sell Pro to an account that already has a paid plan", () => {
    const wrong = everyInput()
      .filter((input) => input.plan === "pro" || input.plan === "business")
      .filter((input) => proOffer(input).action === "checkout");
    expect(wrong).toEqual([]);
  });
});

describe("proOffer — what the labels never say", () => {
  it("puts no amount, currency or price id in any label or note", () => {
    for (const input of everyInput()) {
      const { label, note } = proOffer(input);
      const text = `${label} ${note ?? ""}`;
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[$€£¥]/);
      expect(text).not.toMatch(/price_/);
    }
  });

  it("produces a non-empty label for every combination", () => {
    // A blank button is a control a user cannot understand, and every branch here
    // renders one.
    for (const input of everyInput()) expect(proOffer(input).label.length).toBeGreaterThan(0);
  });

  it("mentions Business in no offer, because Business is not purchasable", () => {
    expect(PURCHASABLE_PLAN_IDS).toEqual(["pro"]);
    for (const input of everyInput()) {
      const { label, note } = proOffer(input);
      expect(`${label} ${note ?? ""}`.toLowerCase()).not.toContain("business");
    }
  });
});

// ---------------------------------------------------------------------------

const USD: DisplayPrice = { unitAmount: 900, currency: "usd", interval: "month", intervalCount: 1 };

describe("formatPlanPrice", () => {
  it("formats a read price in its own currency's minor units", () => {
    expect(formatPlanPrice(USD)).toBe("$9.00");
  });

  it("does not divide a zero-decimal currency by 100", () => {
    // The failure this pins is a 100× mispricing: ¥1,200 rendered as ¥12.
    expect(formatPlanPrice({ ...USD, unitAmount: 1200, currency: "jpy" })).toBe("¥1,200");
  });

  it("accepts an upper-case currency code", () => {
    expect(formatPlanPrice({ ...USD, currency: "USD" })).toBe("$9.00");
  });

  it("formats a free price as zero rather than as no price", () => {
    expect(formatPlanPrice({ ...USD, unitAmount: 0 })).toBe("$0.00");
  });

  it("returns null for every price it cannot read, rather than a number", () => {
    const unreadable: (DisplayPrice | null)[] = [
      null,
      // Tiered or metered: Stripe reports no unit amount.
      { ...USD, unitAmount: null },
      { ...USD, unitAmount: Number.NaN },
      { ...USD, unitAmount: Number.POSITIVE_INFINITY },
      { ...USD, unitAmount: -900 },
      { ...USD, currency: "" },
      { ...USD, currency: "dollars" },
      { ...USD, currency: "us" },
      { ...USD, currency: "u$d" },
    ];
    for (const price of unreadable) {
      expect(formatPlanPrice(price), JSON.stringify(price)).toBeNull();
    }
  });

  it("is stable regardless of the ambient locale", () => {
    // Computed on the server and rendered in the browser: an environment-derived
    // locale would produce two different strings for the same price.
    const previous = process.env.LANG;
    process.env.LANG = "de_DE.UTF-8";
    try {
      expect(formatPlanPrice(USD)).toBe("$9.00");
    } finally {
      if (previous === undefined) delete process.env.LANG;
      else process.env.LANG = previous;
    }
  });
});

describe("formatPlanPeriod", () => {
  it("names a monthly interval", () => {
    expect(formatPlanPeriod(USD)).toBe("month");
  });

  it("pluralizes a multi-interval period", () => {
    expect(formatPlanPeriod({ ...USD, interval: "month", intervalCount: 3 })).toBe("3 months");
  });

  it("returns null for a one-off price and for no price", () => {
    expect(formatPlanPeriod({ ...USD, interval: null })).toBeNull();
    expect(formatPlanPeriod(null)).toBeNull();
  });

  it("treats a nonsense interval count as one period", () => {
    expect(formatPlanPeriod({ ...USD, intervalCount: Number.NaN })).toBe("month");
    expect(formatPlanPeriod({ ...USD, intervalCount: 0 })).toBe("month");
  });
});
