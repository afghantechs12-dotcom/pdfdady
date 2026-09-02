import { describe, expect, it } from "vitest";
import { pricingPlans } from "@/data/pricing";
import { serverToolConfig } from "@/data/serverToolConfig";
import { ALL_METER_KEYS, METERS, isMeterKey } from "./meters";
import {
  ALL_PLAN_IDS,
  DEFAULT_PLAN_ID,
  GUEST_PLAN_ID,
  PLAN_ENTITLEMENTS,
  entitlementPricingGaps,
  isPlanId,
  largestConfiguredToolSizeBytes,
  meterLimitFor,
  planLimitsFor,
  toPlanId,
} from "./plans";

/**
 * The entitlement table decides what a limit *is*. The tests that matter are not
 * the ones checking a number is 100 — they are the ones checking the numbers
 * cannot silently become a product regression or contradict the pricing page.
 */
describe("entitlement table", () => {
  it("has no gaps against pricing or the meter vocabulary", () => {
    expect(entitlementPricingGaps()).toEqual([]);
  });

  it("covers every plan on the pricing page", () => {
    for (const plan of pricingPlans) {
      expect(isPlanId(plan.id)).toBe(true);
      expect(PLAN_ENTITLEMENTS[plan.id as never]).toBeDefined();
    }
  });

  /**
   * An anonymous visitor is a real actor with a real allowance. Modelling them as
   * a plan is what keeps the decision one shape for everyone instead of a
   * "no plan" branch nobody enforces.
   */
  it("models guests as a plan without listing them on the pricing page", () => {
    expect(PLAN_ENTITLEMENTS[GUEST_PLAN_ID]).toBeDefined();
    expect(pricingPlans.some((p) => p.id === GUEST_PLAN_ID)).toBe(false);
  });

  it("files every plan under its own id", () => {
    for (const id of ALL_PLAN_IDS) expect(PLAN_ENTITLEMENTS[id].id).toBe(id);
  });

  it("only ever caps meters that are allowed to deny work", () => {
    for (const id of ALL_PLAN_IDS) {
      for (const meter of Object.keys(PLAN_ENTITLEMENTS[id].meters)) {
        expect(ALL_METER_KEYS).toContain(meter);
        // The guard both narrows the key and asserts it: a plan naming a meter
        // that METERS does not define must fail here, not index into undefined.
        expect(isMeterKey(meter)).toBe(true);
        if (!isMeterKey(meter)) continue;
        expect(METERS[meter].enforceable).toBe(true);
      }
    }
  });
});

/**
 * The single most important test in this file.
 *
 * data/pricing.ts promises the free plan "Every PDF tool that is available
 * today". A plan ceiling below the largest per-tool limit would make that
 * sentence false — a regression shipped inside a metering phase, with a green
 * suite, which is exactly the failure mode this guard exists to prevent.
 */
describe("no product regression", () => {
  it("lets guests and free users upload anything the tools already accept", () => {
    const largest = largestConfiguredToolSizeBytes();
    expect(largest).toBeGreaterThan(0);
    expect(PLAN_ENTITLEMENTS.guest.maxFileBytes).toBeGreaterThanOrEqual(largest);
    expect(PLAN_ENTITLEMENTS.free.maxFileBytes).toBeGreaterThanOrEqual(largest);
  });

  it("derives the largest tool limit from the config rather than a copied constant", () => {
    const expected = Math.max(
      ...Object.values(serverToolConfig).map((c) => c.maxSizeBytes),
    );
    expect(largestConfiguredToolSizeBytes()).toBe(expected);
  });

  it("keeps the free tier's allowance at least as generous as a guest's", () => {
    expect(PLAN_ENTITLEMENTS.free.maxFileBytes).toBeGreaterThanOrEqual(
      PLAN_ENTITLEMENTS.guest.maxFileBytes,
    );
    expect(PLAN_ENTITLEMENTS.free.maxConcurrentJobs).toBeGreaterThanOrEqual(
      PLAN_ENTITLEMENTS.guest.maxConcurrentJobs,
    );
    for (const meter of ALL_METER_KEYS) {
      const guest = meterLimitFor("guest", meter);
      const free = meterLimitFor("free", meter);
      if (guest !== null && free !== null) expect(free).toBeGreaterThanOrEqual(guest);
    }
  });

  /**
   * data/pricing.ts advertises "Larger file size limits" on the Pro card. The
   * entitlement table has to be able to honour that copy the day billing
   * arrives, or the copy becomes the fiction.
   */
  it("makes paid plans strictly more generous, as the pricing copy claims", () => {
    expect(PLAN_ENTITLEMENTS.pro.maxFileBytes).toBeGreaterThan(
      PLAN_ENTITLEMENTS.free.maxFileBytes,
    );
    expect(PLAN_ENTITLEMENTS.business.maxFileBytes).toBeGreaterThanOrEqual(
      PLAN_ENTITLEMENTS.pro.maxFileBytes,
    );
    for (const meter of ALL_METER_KEYS) {
      const free = meterLimitFor("free", meter);
      const pro = meterLimitFor("pro", meter);
      if (free !== null && pro !== null) expect(pro).toBeGreaterThan(free);
    }
  });
});

describe("plan coercion", () => {
  it("narrows known ids", () => {
    for (const id of ALL_PLAN_IDS) expect(isPlanId(id)).toBe(true);
    expect(isPlanId("enterprise")).toBe(false);
    expect(isPlanId(undefined)).toBe(false);
  });

  /**
   * Organization.plan is a free-text column, so it can hold anything a past
   * migration or an admin wrote. A typo must not break someone's tools, and must
   * not silently grant Business either.
   */
  it("resolves an unrecognized stored plan to free, never to the most generous", () => {
    expect(toPlanId("enterprise")).toBe("free");
    expect(toPlanId("")).toBe("free");
    expect(toPlanId(null)).toBe("free");
    expect(toPlanId(undefined)).toBe("free");
    expect(toPlanId(7)).toBe("free");
    expect(DEFAULT_PLAN_ID).toBe("free");
    expect(toPlanId("business")).toBe("business");
  });

  it("falls back to the default plan's limits for an unknown id", () => {
    expect(planLimitsFor("nope" as never)).toEqual(PLAN_ENTITLEMENTS.free);
  });

  it("reports an unlisted meter as unlimited rather than as zero", () => {
    expect(meterLimitFor("free", "ai_tokens")).toBeNull();
    expect(meterLimitFor("free", "server_operations")).toBeGreaterThan(0);
  });
});
