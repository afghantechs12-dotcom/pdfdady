import { describe, expect, it } from "vitest";
import { OrganizationEntitlementProvider } from "./OrganizationEntitlementProvider";
import { InMemoryBillingRepository } from "@/src/infrastructure/persistence/InMemoryBillingRepository";
import { resolveLimitMode } from "@/src/application/services/UsageMeteringService";
import { PLAN_ENTITLEMENTS } from "@/src/domain/metering/plans";
import type { IBillingRepository } from "@/src/application/ports/billing/BillingRepository";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { Organization } from "@/src/domain/entities/Organization";

/**
 * How billing state and the legacy `Organization.plan` column combine.
 *
 * The rule under test: a billing row *replaces* the column for that org, chosen by
 * existence rather than generosity. Taking the best of the two would let a stale
 * `plan = "pro"` keep entitlement alive for ever after a subscription ended.
 */

const NOW = new Date("2026-08-25T12:00:00.000Z");
const FUTURE = new Date("2026-09-25T12:00:00.000Z");
const PAST = new Date("2026-07-25T12:00:00.000Z");

class Logger implements ILogger {
  readonly warnings: string[] = [];
  debug() {}
  info() {}
  warn(m: string, _f?: LogFields) { this.warnings.push(m); }
  error() {}
  child(): ILogger { return this; }
}

function orgs(list: { id: string; plan: string }[], userId = "user_1"): IOrganizationProvider {
  const orgObjects: Organization[] = list.map((o) => ({
    id: o.id, name: o.id, slug: o.id, plan: o.plan, defaultWorkspaceId: null, createdAt: NOW,
  }));
  return {
    async listForUser(id) { return id === userId ? orgObjects : []; },
    async get(id) { return orgObjects.find((o) => o.id === id) ?? null; },
    async getMembership() { return null; },
    async create() { throw new Error("unused"); },
    async addMember() { throw new Error("unused"); },
    async removeMember() { throw new Error("unused"); },
    async setRole() { throw new Error("unused"); },
  };
}

async function withSubscription(
  repo: InMemoryBillingRepository,
  organizationId: string,
  state: { status: string; planId: string; currentPeriodEnd?: Date | null; cancelAtPeriodEnd?: boolean },
) {
  await repo.linkCustomer({ organizationId, provider: "stripe", providerCustomerId: `cus_${organizationId}` });
  await repo.saveProviderState({
    organizationId,
    providerSubscriptionId: `sub_${organizationId}`,
    providerPriceId: "price_pro_monthly",
    status: state.status as never,
    planId: state.planId as never,
    currentPeriodEnd: state.currentPeriodEnd ?? FUTURE,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd ?? false,
    lastEventAt: NOW,
  });
}

const USER = { ownerType: "user" as const, ownerId: "user_1" };
const GUEST = { ownerType: "anon" as const, ownerId: "sess_abc" };

describe("entitlement from billing state", () => {
  it("grants pro for an active subscription", async () => {
    const repo = new InMemoryBillingRepository();
    await withSubscription(repo, "org_1", { status: "active", planId: "pro" });
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "free" }]), new Logger(), repo);
    expect(await provider.planFor(USER)).toBe("pro");
  });

  it("keeps a guest a guest even when their org would be pro", async () => {
    const repo = new InMemoryBillingRepository();
    await withSubscription(repo, "org_1", { status: "active", planId: "pro" });
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "pro" }]), new Logger(), repo);
    expect(await provider.planFor(GUEST)).toBe("guest");
  });

  it("falls back to Organization.plan when there is no billing row", async () => {
    // Legacy and manually-granted orgs keep working with no backfill.
    const repo = new InMemoryBillingRepository();
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "pro" }]), new Logger(), repo);
    expect(await provider.planFor(USER)).toBe("pro");
  });

  it("lets a cancelled subscription remove entitlement despite a stale plan column", async () => {
    // The expensive-to-get-wrong case: the org row still says "pro" from an earlier
    // manual grant, and the subscription is gone.
    const repo = new InMemoryBillingRepository();
    await withSubscription(repo, "org_1", { status: "canceled", planId: "free" });
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "pro" }]), new Logger(), repo);
    expect(await provider.planFor(USER)).toBe("free");
  });

  it("expires an active subscription whose period has passed, ignoring the plan column", async () => {
    const repo = new InMemoryBillingRepository();
    await withSubscription(repo, "org_1", { status: "active", planId: "pro", currentPeriodEnd: PAST });
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "pro" }]), new Logger(), repo);
    expect(await provider.planFor(USER)).toBe("free");
  });

  it("takes the best plan across several organizations", async () => {
    const repo = new InMemoryBillingRepository();
    await withSubscription(repo, "org_paid", { status: "active", planId: "pro" });
    const provider = new OrganizationEntitlementProvider(
      orgs([{ id: "org_free", plan: "free" }, { id: "org_paid", plan: "free" }]),
      new Logger(),
      repo,
    );
    expect(await provider.planFor(USER)).toBe("pro");
  });

  it("behaves exactly as before billing existed when no repository is wired", async () => {
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "pro" }]), new Logger());
    expect(await provider.planFor(USER)).toBe("pro");
  });
});

describe("entitlement failure containment", () => {
  it("resolves to free — not to the plan column — when the billing lookup throws", async () => {
    // A database hiccup must not resurrect a stale paid grant, and must not lock
    // the user out either.
    const broken: IBillingRepository = {
      async getByOrganization() { throw new Error("database is locked"); },
      async getByCustomerId() { return null; },
      async getBySubscriptionId() { return null; },
      async linkCustomer() { throw new Error("unused"); },
      async saveProviderState() { throw new Error("unused"); },
      async claimEvent() { return true; },
      async releaseEvent() {},
    };
    const logger = new Logger();
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "pro" }]), logger, broken);
    expect(await provider.planFor(USER)).toBe("free");
    expect(logger.warnings.some((w) => w.includes("Entitlement lookup failed"))).toBe(true);
  });

  it("resolves to free when the organization lookup itself fails", async () => {
    const failing = { ...orgs([]), listForUser: async () => { throw new Error("no db"); } } as IOrganizationProvider;
    const provider = new OrganizationEntitlementProvider(failing, new Logger(), new InMemoryBillingRepository());
    expect(await provider.planFor(USER)).toBe("free");
  });

  it("resolves to free for a user with no organizations", async () => {
    const provider = new OrganizationEntitlementProvider(orgs([]), new Logger(), new InMemoryBillingRepository());
    expect(await provider.planFor(USER)).toBe("free");
  });

  it("does not grant a paid plan from an unknown status or plan string", async () => {
    const repo = new InMemoryBillingRepository();
    await withSubscription(repo, "org_1", { status: "renewed", planId: "enterprise" });
    const provider = new OrganizationEntitlementProvider(orgs([{ id: "org_1", plan: "free" }]), new Logger(), repo);
    expect(await provider.planFor(USER)).toBe("free");
  });
});

describe("billing does not change usage enforcement", () => {
  it("leaves the limit mode observe-only by default", async () => {
    // Slice 1 sells a plan; it does not start refusing work. Enforcement stays
    // gated on the readiness verdict, which is a separate decision.
    expect(resolveLimitMode(undefined)).toBe("observe");
    expect(resolveLimitMode(process.env.USAGE_LIMIT_MODE)).toBe("observe");
  });

  it("leaves the calibrated allowances untouched", async () => {
    // Pinned so "Pro exists now" cannot become a reason to re-tune limits that
    // were calibrated against observed traffic.
    expect(PLAN_ENTITLEMENTS.guest.meters.server_operations).toBe(30);
    expect(PLAN_ENTITLEMENTS.free.meters.server_operations).toBe(100);
    expect(PLAN_ENTITLEMENTS.pro.meters.server_operations).toBe(2000);
    expect(PLAN_ENTITLEMENTS.free.maxFileBytes).toBe(100 * 1024 * 1024);
    expect(PLAN_ENTITLEMENTS.pro.maxFileBytes).toBe(500 * 1024 * 1024);
  });
});
