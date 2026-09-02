import { describe, expect, it } from "vitest";
import {
  BillingError,
  DEFAULT_SUBSCRIPTION_STATUS,
  SUBSCRIPTION_STATUSES,
  entitledPlanFor,
  isNewerEvent,
  isPaidPlan,
  isPurchasablePlanId,
  isSubscriptionStatus,
  planForPriceId,
  priceIdForPlan,
  toStoredPlanId,
  toSubscriptionStatus,
  type BillingPriceMap,
  type BillingSubscriptionState,
} from "./subscription";

const PRICES: BillingPriceMap = { pro: "price_pro" };
const NOW = new Date("2026-08-25T00:00:00.000Z");
const FUTURE = new Date("2026-09-25T00:00:00.000Z");
const PAST = new Date("2026-07-25T00:00:00.000Z");

function state(over: Partial<BillingSubscriptionState> = {}): BillingSubscriptionState {
  return {
    status: "active",
    planId: "pro",
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    ...over,
  };
}

describe("subscription status vocabulary", () => {
  it("recognizes every documented status", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      expect(isSubscriptionStatus(status)).toBe(true);
      expect(toSubscriptionStatus(status)).toBe(status);
    }
  });

  it("resolves an unknown status to a non-entitling default, never to active", () => {
    // The direction is the whole point: a status this build has never heard of
    // must not be the one that grants Pro.
    for (const junk of ["ACTIVE", "renewed", "", null, undefined, 42, {}]) {
      expect(toSubscriptionStatus(junk)).toBe(DEFAULT_SUBSCRIPTION_STATUS);
    }
    expect(DEFAULT_SUBSCRIPTION_STATUS).not.toBe("active");
    expect(entitledPlanFor(state({ status: toSubscriptionStatus("renewed") }), NOW)).toBe("free");
  });
});

describe("entitledPlanFor", () => {
  it("grants the plan for an active subscription inside its period", () => {
    expect(entitledPlanFor(state(), NOW)).toBe("pro");
    expect(entitledPlanFor(state({ planId: "business" }), NOW)).toBe("business");
  });

  it("grants during a trial", () => {
    expect(entitledPlanFor(state({ status: "trialing" }), NOW)).toBe("pro");
  });

  it("still grants while a cancellation is pending at period end", () => {
    // cancel_at_period_end means "paid through the period" — taking features away
    // the moment someone clicks cancel would be charging for a month not served.
    expect(entitledPlanFor(state({ cancelAtPeriodEnd: true }), NOW)).toBe("pro");
  });

  it("grants nothing for a null record", () => {
    expect(entitledPlanFor(null, NOW)).toBe("free");
  });

  it("grants nothing for any non-entitling status", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      if (status === "active" || status === "trialing") continue;
      expect(entitledPlanFor(state({ status }), NOW)).toBe("free");
    }
  });

  it("does not entitle on past_due", () => {
    // Explicit rather than implied by the loop above: this is a deliberate product
    // decision (no grace period in slice 1) and it should fail loudly if changed.
    expect(entitledPlanFor(state({ status: "past_due" }), NOW)).toBe("free");
  });

  it("expires an active subscription whose period has passed", () => {
    // The missed-webhook guard: silence must downgrade, not extend for ever.
    expect(entitledPlanFor(state({ currentPeriodEnd: PAST }), NOW)).toBe("free");
    expect(entitledPlanFor(state({ currentPeriodEnd: NOW }), NOW)).toBe("free");
  });

  it("does not grant a paid plan for a free-mapped record even when active", () => {
    // This is what an unmapped Stripe price stores, and it must not be Pro.
    expect(entitledPlanFor(state({ planId: "free" }), NOW)).toBe("free");
    expect(entitledPlanFor(state({ planId: "guest" }), NOW)).toBe("free");
  });

  it("treats only pro and business as paid", () => {
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("business")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan("guest")).toBe(false);
  });
});

describe("isNewerEvent", () => {
  it("accepts anything when nothing has been applied", () => {
    expect(isNewerEvent(PAST, null)).toBe(true);
  });

  it("accepts a newer event and a same-second event", () => {
    expect(isNewerEvent(FUTURE, NOW)).toBe(true);
    expect(isNewerEvent(NOW, NOW)).toBe(true);
  });

  it("rejects a strictly older event", () => {
    expect(isNewerEvent(PAST, NOW)).toBe(false);
  });
});

describe("price mapping", () => {
  it("resolves a configured plan to its price", () => {
    expect(priceIdForPlan(PRICES, "pro")).toBe("price_pro");
  });

  it("throws rather than inventing a price when none is configured", () => {
    const partial: BillingPriceMap = { pro: null };
    expect(() => priceIdForPlan(partial, "pro")).toThrow(BillingError);
    try {
      priceIdForPlan(partial, "pro");
    } catch (err) {
      expect((err as BillingError).code).toBe("PLAN_NOT_PURCHASABLE");
    }
  });

  it("maps a known price back to its plan", () => {
    expect(planForPriceId(PRICES, "price_pro")).toBe("pro");
  });

  it("maps an unknown price to null, not to a plan", () => {
    // null rather than "free" so a caller has to decide what unknown means; the
    // webhook stores free and logs, which is a different fact from equality.
    expect(planForPriceId(PRICES, "price_attacker")).toBeNull();
    expect(planForPriceId(PRICES, null)).toBeNull();
    expect(planForPriceId(PRICES, "")).toBeNull();
  });

  it("does not match an unconfigured plan against a null price", () => {
    const partial: BillingPriceMap = { pro: null };
    expect(planForPriceId(partial, null)).toBeNull();
    expect(planForPriceId(partial, "price_biz")).toBeNull();
  });

  it("accepts only pro as purchasable", () => {
    // Business billing is deferred: it is a real plan with real entitlements and no
    // purchase path. See businessDeferred.test.ts for the whole-slice assertion.
    expect(isPurchasablePlanId("pro")).toBe(true);
    expect(isPurchasablePlanId("business")).toBe(false);
    expect(isPurchasablePlanId("free")).toBe(false);
    expect(isPurchasablePlanId("guest")).toBe(false);
    // The shape a crafted request would use.
    expect(isPurchasablePlanId("price_1MoBy5LkdIwHu7ixZhnattbh")).toBe(false);
  });
});

describe("toStoredPlanId", () => {
  it("keeps known plans and floors unknown ones at free", () => {
    expect(toStoredPlanId("pro")).toBe("pro");
    expect(toStoredPlanId("enterprise")).toBe("free");
    expect(toStoredPlanId(undefined)).toBe("free");
  });
});
