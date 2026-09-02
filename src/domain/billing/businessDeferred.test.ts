import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PURCHASABLE_PLAN_IDS,
  isPaidPlan,
  isPurchasablePlanId,
  planForPriceId,
  priceIdForPlan,
  type BillingPriceMap,
} from "./subscription";
import { ALL_PLAN_IDS, PLAN_ENTITLEMENTS, isPlanId } from "@/src/domain/metering/plans";
import { _resetConfigForTests, getConfig } from "@/src/infrastructure/config/env";

/**
 * The gate `subscription.ts` and the checkout route both point at.
 *
 * Business billing is DEFERRED, which is two claims at once, and the whole risk
 * lives in the gap between them:
 *
 *  - Business is still a real *plan* — in the vocabulary, in the entitlement
 *    table, in the pricing copy — so an operator-set Business organization keeps
 *    every feature it has.
 *  - Business is not *purchasable* — no price slot, no env var, no checkout path,
 *    no webhook mapping.
 *
 * Deleting the plan would break existing rows; leaving it purchasable would take
 * money for seats and org invoicing that do not exist. So neither half can be
 * asserted alone: a test that only checked "Business is refused" would still pass
 * if someone deleted the plan outright, and a test that only checked "Business is
 * a plan" would pass if a price slot came back.
 *
 * These assertions are deliberately structural rather than behavioural. A comment
 * saying Business is deferred is a convention someone can contradict in one edit;
 * a price map with nowhere to put a Business id cannot be contradicted at all.
 */

function read(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

/** Source with comments stripped, so documentation naming Business is not read as a live path. */
function codeOf(...segments: string[]): string {
  return read(...segments)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("Business remains a real plan", () => {
  it("stays in the plan vocabulary and the entitlement table", () => {
    // If this fails, someone deleted the plan rather than deferring its purchase —
    // and every organization already set to Business silently lost its features.
    expect(isPlanId("business")).toBe(true);
    expect(ALL_PLAN_IDS).toContain("business");
    expect(PLAN_ENTITLEMENTS.business).toBeDefined();
  });

  it("still counts as paid, so an operator-set Business org keeps paid entitlements", () => {
    // isPaidPlan answers "does this stored plan entitle paid features", which is a
    // different question from "may this be bought". Business must answer yes here.
    expect(isPaidPlan("business")).toBe(true);
  });
});

describe("Business is not purchasable", () => {
  it("is absent from the purchasable set", () => {
    expect(PURCHASABLE_PLAN_IDS).toEqual(["pro"]);
    expect(isPurchasablePlanId("business")).toBe(false);
  });

  it("is refused by the domain even when a caller insists", () => {
    // The cast is the point: this is what a crafted request that got past the route
    // guard would reach. The type system refuses it at compile time; this proves the
    // runtime refuses it too, so the deferral does not depend on TypeScript alone.
    const prices: BillingPriceMap = { pro: "price_pro" };
    expect(() =>
      priceIdForPlan(prices, "business" as unknown as (typeof PURCHASABLE_PLAN_IDS)[number]),
    ).toThrow(/not available for purchase/i);
  });

  it("has no price slot for a Business id to be configured into", () => {
    // The structural half. `planForPriceId` iterates PURCHASABLE_PLAN_IDS, so with
    // no `business` key there is no price id — configured, unknown or forged — that
    // can resolve to Business.
    const prices = { pro: "price_pro", business: "price_biz" } as unknown as BillingPriceMap;
    expect(planForPriceId(prices, "price_biz")).toBeNull();
    expect(planForPriceId(prices, "price_pro")).toBe("pro");
  });

  it("builds a price map with a pro key and nothing else", () => {
    const saved = { ...process.env };
    try {
      delete process.env.STRIPE_PRICE_BUSINESS;
      process.env.STRIPE_SECRET_KEY = "sk_test_gate";
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_gate";
      process.env.STRIPE_PRICE_PRO = "price_gate_pro";
      _resetConfigForTests();
      expect(Object.keys(getConfig().billing.prices)).toEqual(["pro"]);
    } finally {
      for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      _resetConfigForTests();
    }
  });

  it("ignores a STRIPE_PRICE_BUSINESS left behind in the environment", () => {
    // The realistic regression: an operator upgrades a deployment that still carries
    // the old variable. It must be inert, not a back door to a purchasable Business.
    const saved = { ...process.env };
    try {
      process.env.STRIPE_SECRET_KEY = "sk_test_gate";
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_gate";
      process.env.STRIPE_PRICE_PRO = "price_gate_pro";
      process.env.STRIPE_PRICE_BUSINESS = "price_gate_biz";
      _resetConfigForTests();
      const prices = getConfig().billing.prices;
      expect(prices).toEqual({ pro: "price_gate_pro" });
      expect(JSON.stringify(prices)).not.toContain("price_gate_biz");
      // And the leftover id maps to no plan at all.
      expect(planForPriceId(prices, "price_gate_biz")).toBeNull();
    } finally {
      for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      _resetConfigForTests();
    }
  });
});

describe("no source path reintroduces a Business purchase", () => {
  it("declares no Business slot on the price map", () => {
    // Read as source rather than exercised, because a `business` slot typed as
    // `string | null` would make every runtime assertion above still pass while
    // handing a future edit somewhere to put a price.
    const source = codeOf("src/domain/billing/subscription.ts");
    const priceMap = source.slice(source.indexOf("interface BillingPriceMap"));
    expect(priceMap.slice(0, priceMap.indexOf("}"))).not.toContain("business");
  });

  it("does not read a Business price variable anywhere in config", () => {
    expect(codeOf("src/infrastructure/config/env.ts")).not.toContain("STRIPE_PRICE_BUSINESS");
  });

  it("does not document a Business price variable to operators", () => {
    // Documenting a variable the schema no longer has would send an operator to
    // configure a purchase path that cannot exist.
    expect(read(".env.example")).not.toMatch(/^\s*#?\s*STRIPE_PRICE_BUSINESS\s*=/m);
    expect(read("SERVER_SETUP.md")).not.toContain("| `STRIPE_PRICE_BUSINESS`");
  });
});
