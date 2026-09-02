import { afterEach, describe, expect, it } from "vitest";
import { createContainer } from "./container";
import { Tokens } from "./tokens";
import { _resetConfigForTests, getConfig, type AppConfig } from "@/src/infrastructure/config/env";
import { PrismaBillingRepository } from "@/src/infrastructure/persistence/PrismaBillingRepository";
import { StripeBillingProvider } from "@/src/infrastructure/billing/StripeBillingProvider";
import { BillingService } from "@/src/application/services/BillingService";
import { OrganizationEntitlementProvider } from "@/src/infrastructure/metering/OrganizationEntitlementProvider";
import type { IEntitlementProvider } from "@/src/application/ports/metering/EntitlementProvider";

/**
 * Billing wiring, against the real container.
 *
 * The policy tests one directory over prove that `entitledPlanFor` and
 * `BillingService` decide correctly *given* their dependencies. This proves the
 * dependencies are actually handed over — which is the half that fails silently:
 * an `OrganizationEntitlementProvider` constructed without the billing repository
 * still passes every entitlement test it has, because its documented fallback for
 * "no billing wired" is to read `Organization.plan`. Every subscription in the
 * database would simply be ignored, and nothing would look broken.
 */

const STRIPE_ENV = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS"] as const;
// STRIPE_PRICE_BUSINESS is in this list to be *cleared*, not set: it no longer
// exists in the schema, and a leftover value in a developer's shell must not be
// able to influence what the container builds.
const saved = Object.fromEntries(STRIPE_ENV.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of STRIPE_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetConfigForTests();
});

function containerWith(env: Partial<Record<(typeof STRIPE_ENV)[number], string>> = {}) {
  for (const key of STRIPE_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  _resetConfigForTests();
  return createContainer();
}

const ENABLED = {
  STRIPE_SECRET_KEY: "sk_test_wiring",
  STRIPE_WEBHOOK_SECRET: "whsec_wiring",
  STRIPE_PRICE_PRO: "price_wiring_pro",
} as const;

describe("billing registrations", () => {
  it("registers the repository, the provider and the service under distinct tokens", () => {
    const tokens = [Tokens.BillingRepository, Tokens.BillingProvider, Tokens.BillingService];
    expect(new Set(tokens).size).toBe(3);
    const c = containerWith();
    expect(c.resolve(Tokens.BillingRepository)).toBeInstanceOf(PrismaBillingRepository);
    expect(c.resolve(Tokens.BillingService)).toBeInstanceOf(BillingService);
  });

  it("caches each as a singleton, matching container policy", () => {
    const c = containerWith(ENABLED);
    expect(c.resolve(Tokens.BillingRepository)).toBe(c.resolve(Tokens.BillingRepository));
    expect(c.resolve(Tokens.BillingService)).toBe(c.resolve(Tokens.BillingService));
    expect(c.resolve(Tokens.BillingProvider)).toBe(c.resolve(Tokens.BillingProvider));
  });

  it("leaves the provider null when Stripe is not configured", () => {
    const c = containerWith();
    expect(c.resolve(Tokens.BillingProvider)).toBeNull();
    expect(c.resolve<BillingService>(Tokens.BillingService).isConfigured()).toBe(false);
  });

  it("builds the Stripe adapter when it is configured", () => {
    const c = containerWith(ENABLED);
    expect(c.resolve(Tokens.BillingProvider)).toBeInstanceOf(StripeBillingProvider);
    expect(c.resolve<BillingService>(Tokens.BillingService).isConfigured()).toBe(true);
  });

  it("takes the price map and the return-URL origin from config, not from a request", () => {
    // STRIPE_PRICE_BUSINESS is set here deliberately: Business billing is deferred,
    // so an environment that still carries the old variable must produce a price map
    // with no Business entry at all. A `business` key appearing here — even null —
    // would mean the deferral is a convention rather than a structure.
    const c = containerWith({ ...ENABLED, STRIPE_PRICE_BUSINESS: "price_wiring_biz" });
    const cfg = c.resolve<AppConfig>(Tokens.Config);
    const deps = (c.resolve<BillingService>(Tokens.BillingService) as unknown as {
      deps: { prices: unknown; siteUrl: string; provider: unknown };
    }).deps;
    expect(deps.prices).toEqual({ pro: "price_wiring_pro" });
    expect(deps.siteUrl).toBe(cfg.siteUrl);
    expect(deps.provider).toBeInstanceOf(StripeBillingProvider);
  });
});

describe("entitlement wiring", () => {
  it("hands the billing repository to the entitlement provider", () => {
    // The assertion that matters. Without it, `planForOrganization` short-circuits
    // to `Organization.plan` for every org and every subscription in the database
    // is silently ignored — with a fully green entitlement suite.
    const c = containerWith(ENABLED);
    const provider = c.resolve<IEntitlementProvider>(Tokens.EntitlementProvider);
    expect(provider).toBeInstanceOf(OrganizationEntitlementProvider);
    const billing = (provider as unknown as { billing: unknown }).billing;
    expect(billing).toBeInstanceOf(PrismaBillingRepository);
    expect(billing).toBe(c.resolve(Tokens.BillingRepository));
  });

  it("wires entitlement to billing even when Stripe is not configured", () => {
    // Entitlement reads rows; it needs no credentials. If this depended on the
    // provider, rotating a key out would silently restore Pro to every cancelled
    // organization by falling back to the legacy plan column.
    const c = containerWith();
    expect(getConfig().billing.enabled).toBe(false);
    const provider = c.resolve<IEntitlementProvider>(Tokens.EntitlementProvider);
    expect((provider as unknown as { billing: unknown }).billing).toBeInstanceOf(PrismaBillingRepository);
  });

  it("does not change the usage metering limit mode", () => {
    // Billing exists now; enforcement is still a separate, deliberate switch.
    const c = containerWith(ENABLED);
    const metering = c.resolve<{ mode?: string }>(Tokens.UsageMeteringService) as unknown as {
      deps?: { mode?: string };
      mode?: string;
    };
    const mode = metering.deps?.mode ?? metering.mode;
    expect(mode).toBe("observe");
  });
});
