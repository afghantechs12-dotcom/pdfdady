import { describe, expect, it, vi } from "vitest";
import { BillingService, type BillingServiceDeps } from "./BillingService";
import { InMemoryBillingRepository } from "@/src/infrastructure/persistence/InMemoryBillingRepository";
import { StripeBillingProvider } from "@/src/infrastructure/billing/StripeBillingProvider";
import { stripeSignatureHeader } from "@/src/infrastructure/billing/stripeSignature";
import { BillingError, type BillingPriceMap } from "@/src/domain/billing/subscription";
import type { ILogger, LogFields } from "@/src/application/ports/Logger";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { AuditEventInput, IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import type { Organization } from "@/src/domain/entities/Organization";
import type { OrganizationMembership } from "@/src/domain/entities/Membership";
import type { Role } from "@/src/domain/entities/Role";

/**
 * Billing security tests.
 *
 * These run the *real* Stripe adapter — the webhook path in particular is never
 * faked, because a fake `parseWebhook` would make "the signature is verified" a
 * property of the test double rather than of the product. Only `fetch` is
 * stubbed, so no test reaches the network or needs an account.
 */

const SECRET_KEY = "sk_test_pdfdadi";
const WEBHOOK_SECRET = "whsec_test_pdfdadi";
const PRICES: BillingPriceMap = { pro: "price_pro_monthly" };
/** A price this deployment cannot map. Business has no configurable price at all. */
const UNMAPPED_PRICE = "price_biz_monthly";
const SITE = "https://pdfdadi.test";

const OWNER = "user_owner";
const MEMBER = "user_member";
const OUTSIDER = "user_outsider";
const ORG = "org_acme";
const OTHER_ORG = "org_rival";
const CUSTOMER = "cus_acme";
const SUB = "sub_acme";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const PERIOD_END = Math.floor(new Date("2026-09-25T12:00:00.000Z").getTime() / 1000);

// ---- doubles ---------------------------------------------------------------

class SilentLogger implements ILogger {
  readonly lines: { level: string; message: string; fields?: LogFields }[] = [];
  debug(m: string, f?: LogFields) { this.lines.push({ level: "debug", message: m, fields: f }); }
  info(m: string, f?: LogFields) { this.lines.push({ level: "info", message: m, fields: f }); }
  warn(m: string, f?: LogFields) { this.lines.push({ level: "warn", message: m, fields: f }); }
  error(m: string, f?: LogFields) { this.lines.push({ level: "error", message: m, fields: f }); }
  child(): ILogger { return this; }
}

class FakeOrganizations implements IOrganizationProvider {
  /** orgId → userId → role */
  readonly roles = new Map<string, Map<string, Role>>();
  readonly orgs = new Map<string, Organization>();

  add(orgId: string, plan: string, members: Record<string, Role>) {
    this.orgs.set(orgId, {
      id: orgId, name: orgId, slug: orgId, plan, defaultWorkspaceId: null, createdAt: NOW,
    });
    this.roles.set(orgId, new Map(Object.entries(members) as [string, Role][]));
  }

  async get(id: string) { return this.orgs.get(id) ?? null; }
  async listForUser(userId: string) {
    return [...this.orgs.values()].filter((o) => this.roles.get(o.id)?.has(userId));
  }
  async getMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null> {
    const role = this.roles.get(organizationId)?.get(userId);
    if (!role) return null;
    return { id: `mem_${organizationId}_${userId}`, organizationId, userId, role, createdAt: NOW };
  }
  async create(): Promise<Organization> { throw new Error("unused"); }
  async addMember(): Promise<OrganizationMembership> { throw new Error("unused"); }
  async removeMember(): Promise<void> { throw new Error("unused"); }
  async setRole(): Promise<void> { throw new Error("unused"); }
}

const users: IUserProvider = {
  async getById(id) {
    return { id, email: `${id}@pdfdadi.test`, name: null, passwordHash: null, provider: "local", externalId: null, createdAt: NOW } as never;
  },
  async getByEmail() { return null; },
  async createLocal() { throw new Error("unused"); },
  async createExternal() { throw new Error("unused"); },
  async verifyCredentials() { return null; },
};

class RecordingAudit implements IAuditLogRepository {
  readonly entries: AuditEventInput[] = [];
  async record(input: AuditEventInput) {
    this.entries.push(input);
    return { id: `audit_${this.entries.length}`, ...input, createdAt: NOW } as never;
  }
  async listByOrg() { return []; }
}

// ---- Stripe payload builders ----------------------------------------------

function subscriptionObject(over: Record<string, unknown> = {}) {
  return {
    id: SUB,
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    cancel_at_period_end: false,
    items: {
      object: "list",
      data: [{ id: "si_1", current_period_end: PERIOD_END, price: { id: PRICES.pro, object: "price" } }],
    },
    metadata: { organizationId: ORG },
    ...over,
  };
}

/** The configured Pro price, as Stripe reports it. $9.00/month. */
function priceObject(over: Record<string, unknown> = {}) {
  return {
    id: PRICES.pro,
    object: "price",
    active: true,
    currency: "usd",
    unit_amount: 900,
    recurring: { interval: "month", interval_count: 1 },
    ...over,
  };
}

function event(over: Record<string, unknown> = {}, object: Record<string, unknown> = subscriptionObject()) {
  return {
    id: "evt_1",
    object: "event",
    type: "customer.subscription.updated",
    created: Math.floor(NOW.getTime() / 1000),
    data: { object },
    ...over,
  };
}

function signed(payload: unknown, at: Date = NOW): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: stripeSignatureHeader(rawBody, WEBHOOK_SECRET, Math.floor(at.getTime() / 1000)) };
}

// ---- harness ---------------------------------------------------------------

interface Harness {
  service: BillingService;
  repo: InMemoryBillingRepository;
  orgs: FakeOrganizations;
  audit: RecordingAudit;
  logger: SilentLogger;
  calls: { path: string; form: URLSearchParams }[];
  deps: BillingServiceDeps;
}

function harness(opts: { prices?: BillingPriceMap; configured?: boolean; subscriptionBody?: Record<string, unknown>; priceBody?: Record<string, unknown> | null; priceStatus?: number } = {}): Harness {
  const repo = new InMemoryBillingRepository();
  const orgs = new FakeOrganizations();
  orgs.add(ORG, "free", { [OWNER]: "owner", [MEMBER]: "member" });
  orgs.add(OTHER_ORG, "free", { [OUTSIDER]: "owner" });
  const audit = new RecordingAudit();
  const logger = new SilentLogger();
  const calls: { path: string; form: URLSearchParams }[] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://stripe.invalid", "");
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    calls.push({ path, form });
    const body = ((): unknown => {
      if (path.startsWith("/v1/customers")) return { id: CUSTOMER, object: "customer" };
      if (path.startsWith("/v1/checkout/sessions")) {
        return { id: "cs_test_1", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_1" };
      }
      if (path.startsWith("/v1/billing_portal/sessions")) {
        return { object: "billing_portal.session", url: "https://billing.stripe.com/p/session/live_1" };
      }
      if (path.startsWith("/v1/prices/")) return opts.priceBody ?? priceObject();
      if (path.startsWith("/v1/subscriptions/")) return opts.subscriptionBody ?? subscriptionObject();
      return {};
    })();
    const status = path.startsWith("/v1/prices/") ? (opts.priceStatus ?? 200) : 200;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const provider = opts.configured === false
    ? null
    : new StripeBillingProvider({
        secretKey: SECRET_KEY,
        webhookSecret: WEBHOOK_SECRET,
        fetchImpl,
        apiBase: "https://stripe.invalid",
      });

  const deps: BillingServiceDeps = {
    billing: repo,
    provider,
    organizations: orgs,
    users,
    audit,
    logger,
    prices: opts.prices ?? PRICES,
    siteUrl: SITE,
  };
  return { service: new BillingService(deps), repo, orgs, audit, logger, calls, deps };
}

async function billingErrorFrom(fn: () => Promise<unknown>): Promise<BillingError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BillingError);
    return err as BillingError;
  }
  throw new Error("expected a BillingError but the call succeeded");
}

// ===========================================================================
// 1. Checkout requires an authenticated, authorized caller
// ===========================================================================

describe("checkout authorization", () => {
  it("refuses a caller with no organizations (the unauthenticated shape)", async () => {
    // The routes reject an absent session before this point; this is the
    // service-level equivalent — an identity with no membership buys nothing, so a
    // forged or stale user id is inert even if it reaches here.
    const { service, calls } = harness();
    const err = await billingErrorFrom(() => service.startCheckout({ userId: "user_ghost", plan: "pro" }));
    expect(err.code).toBe("FORBIDDEN");
    expect(calls).toHaveLength(0);
  });

  it("refuses to purchase for an organization the caller does not belong to", async () => {
    const { service, repo, calls } = harness();
    const err = await billingErrorFrom(() =>
      service.startCheckout({ userId: OWNER, organizationId: OTHER_ORG, plan: "pro" }),
    );
    expect(err.code).toBe("FORBIDDEN");
    // Nothing was created for either org — no Stripe customer, no row.
    expect(calls).toHaveLength(0);
    expect(await repo.getByOrganization(OTHER_ORG)).toBeNull();
    expect(await repo.getByOrganization(ORG)).toBeNull();
  });

  it("refuses a member without billing:manage in their own organization", async () => {
    const { service, calls } = harness();
    const err = await billingErrorFrom(() => service.startCheckout({ userId: MEMBER, organizationId: ORG, plan: "pro" }));
    expect(err.code).toBe("FORBIDDEN");
    expect(calls).toHaveLength(0);
  });

  it("checks authorization before revealing whether a plan is sold here", async () => {
    // Ordering matters: an unauthorized caller asking for an unconfigured plan must
    // get FORBIDDEN, not PLAN_NOT_PURCHASABLE, or the error is a catalogue oracle.
    const { service } = harness({ prices: { pro: null } });
    const err = await billingErrorFrom(() =>
      service.startCheckout({ userId: OUTSIDER, organizationId: ORG, plan: "pro" }),
    );
    expect(err.code).toBe("FORBIDDEN");
  });

  it("fails clearly when no price is configured instead of inventing one", async () => {
    const { service, calls } = harness({ prices: { pro: null } });
    const err = await billingErrorFrom(() => service.startCheckout({ userId: OWNER, plan: "pro" }));
    expect(err.code).toBe("PLAN_NOT_PURCHASABLE");
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when the deployment has no provider at all", async () => {
    const { service } = harness({ configured: false });
    expect(service.isConfigured()).toBe(false);
    const err = await billingErrorFrom(() => service.startCheckout({ userId: OWNER, plan: "pro" }));
    expect(err.code).toBe("BILLING_NOT_CONFIGURED");
  });
});

// ===========================================================================
// 2/3. Only configured prices; the client never names one
// ===========================================================================

describe("checkout price selection", () => {
  it("sends the server-configured price for the requested plan", async () => {
    const { service, calls } = harness();
    const result = await service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    expect(result.url).toBe("https://checkout.stripe.com/c/pay/cs_test_1");

    const session = calls.find((c) => c.path.startsWith("/v1/checkout/sessions"))!;
    expect(session.form.get("line_items[0][price]")).toBe(PRICES.pro);
    expect(session.form.get("mode")).toBe("subscription");
    // Return URLs come from configured origin + fixed paths.
    expect(session.form.get("success_url")).toBe(`${SITE}/pricing?checkout=success`);
    expect(session.form.get("cancel_url")).toBe(`${SITE}/pricing?checkout=cancelled`);
    // And the org is the one resolved from membership, not one supplied to Stripe
    // by the browser.
    expect(session.form.get("client_reference_id")).toBe(ORG);
  });

  it("has no parameter through which a caller could pass a price id", async () => {
    // Structural, not behavioural: `startCheckout` takes a plan. A price id can
    // only arrive as a plan, and `priceIdForPlan` refuses anything that is not
    // "pro" — see subscription.test.ts. This asserts the crafted value is rejected
    // at the type-guard boundary the routes use.
    const { service, calls } = harness();
    const err = await billingErrorFrom(() =>
      service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "price_1MoBy5LkdIwHu7ix" as any }),
    );
    expect(err.code).toBe("PLAN_NOT_PURCHASABLE");
    expect(calls.some((c) => c.form.toString().includes("price_1MoBy5LkdIwHu7ix"))).toBe(false);
  });

  it("reuses one Stripe customer across repeated checkouts", async () => {
    const { service, calls, repo } = harness();
    await service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    await service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    expect(calls.filter((c) => c.path === "/v1/customers")).toHaveLength(1);
    expect((await repo.getByOrganization(ORG))?.providerCustomerId).toBe(CUSTOMER);
  });
});

// ===========================================================================
// 4. A checkout (and its redirect) grants nothing
// ===========================================================================

describe("checkout grants no entitlement", () => {
  it("leaves the organization on free after a session is created", async () => {
    const { service, repo, audit } = harness();
    const result = await service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });

    const record = await repo.getByOrganization(ORG);
    expect(record?.planId).toBe("free");
    expect(record?.status).toBe("incomplete");
    expect(record?.providerSubscriptionId).toBeNull();
    expect(record?.currentPeriodEnd).toBeNull();
    expect(await service.planFor(ORG, NOW)).toBe("free");

    // Nothing in the response is an entitlement claim, and nothing a browser could
    // replay from the success redirect exists as an input.
    expect(Object.keys(result).sort()).toEqual(["sessionId", "url"]);
    const entry = audit.entries.find((e) => e.action === "billing.checkout.created")!;
    expect((entry.metadata as { grantedPlan: unknown }).grantedPlan).toBeNull();
  });

  it("has no method that turns a success redirect into a plan", async () => {
    // The `?checkout=success` return is a page render, not an API call: the only
    // entitlement writer on BillingService is handleWebhook, which needs a signed
    // body. Naming a "confirm the checkout" helper has to break this test to land,
    // which is the point — the pressure to add one arrives with the pricing UI.
    const names = Object.getOwnPropertyNames(BillingService.prototype);
    const redirectish = names.filter((n) => /confirm|success|redirect|activate|grant|fulfil/i.test(n));
    expect(redirectish).toEqual([]);
  });

  it("writes billing state from nowhere except the webhook path", async () => {
    // Any state change must pass through saveProviderState, and startCheckout must
    // never reach it. linkCustomer is allowed — it writes a customer, not a plan.
    const h = harness();
    const save = vi.spyOn(h.repo, "saveProviderState");
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    await h.service.createPortalSession({ userId: OWNER, organizationId: ORG });
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
  });
});

// ===========================================================================
// 5/6. Webhook signature is the gate
// ===========================================================================

describe("webhook signature", () => {
  async function withCustomer(h: Harness) {
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    return h;
  }

  it("applies a validly signed subscription event", async () => {
    const h = await withCustomer(harness());
    const { rawBody, signature } = signed(event());
    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });

    expect(result).toMatchObject({ applied: true, eventId: "evt_1", eventType: "customer.subscription.updated" });
    const record = await h.repo.getByOrganization(ORG);
    expect(record).toMatchObject({
      status: "active",
      planId: "pro",
      providerSubscriptionId: SUB,
      providerPriceId: PRICES.pro,
      cancelAtPeriodEnd: false,
    });
    expect(record?.currentPeriodEnd?.toISOString()).toBe("2026-09-25T12:00:00.000Z");
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
  });

  it("rejects an unsigned body and writes nothing", async () => {
    const h = await withCustomer(harness());
    const { rawBody } = signed(event());
    const err = await billingErrorFrom(() => h.service.handleWebhook({ rawBody, signature: null, now: NOW }));
    expect(err.code).toBe("INVALID_SIGNATURE");
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
  });

  it("rejects a body signed with the wrong secret", async () => {
    const h = await withCustomer(harness());
    const rawBody = JSON.stringify(event());
    const signature = stripeSignatureHeader(rawBody, "whsec_attacker", Math.floor(NOW.getTime() / 1000));
    const err = await billingErrorFrom(() => h.service.handleWebhook({ rawBody, signature, now: NOW }));
    expect(err.code).toBe("INVALID_SIGNATURE");
    expect((await h.repo.getByOrganization(ORG))?.planId).toBe("free");
  });

  it("rejects a body altered after signing", async () => {
    const h = await withCustomer(harness());
    const { signature } = signed(event());
    const tampered = JSON.stringify(event({}, subscriptionObject({ status: "active" })));
    const upgraded = tampered.replace(PRICES.pro!, UNMAPPED_PRICE);
    const err = await billingErrorFrom(() => h.service.handleWebhook({ rawBody: upgraded, signature, now: NOW }));
    expect(err.code).toBe("INVALID_SIGNATURE");
    expect((await h.repo.getByOrganization(ORG))?.planId).toBe("free");
  });

  it("does not claim an event id it refused to verify", async () => {
    // Otherwise a forged delivery could burn the id of a genuine event and make
    // the real one look like a duplicate.
    const h = await withCustomer(harness());
    const { rawBody } = signed(event());
    await billingErrorFrom(() => h.service.handleWebhook({ rawBody, signature: "t=1,v1=deadbeef", now: NOW }));
    expect(await h.repo.claimEvent("evt_1", "customer.subscription.updated", NOW)).toBe(true);
  });
});

// ===========================================================================
// 7. Duplicate delivery is idempotent
// ===========================================================================

describe("webhook idempotency", () => {
  it("applies once and reports the redelivery as a duplicate", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event());

    const first = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    const second = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    const third = await h.service.handleWebhook({ rawBody, signature, now: NOW });

    expect(first.applied).toBe(true);
    expect(second).toMatchObject({ applied: false, reason: "duplicate" });
    expect(third).toMatchObject({ applied: false, reason: "duplicate" });

    // No duplicate side effects: exactly one sync audit row for three deliveries.
    expect(h.audit.entries.filter((e) => e.action === "billing.subscription.synced")).toHaveLength(1);
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
  });

  it("releases the claim when applying throws, so a retry can still land", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event());

    const save = vi.spyOn(h.repo, "saveProviderState");
    save.mockRejectedValueOnce(new Error("database is locked"));
    await expect(h.service.handleWebhook({ rawBody, signature, now: NOW })).rejects.toThrow("database is locked");
    expect(await h.service.planFor(ORG, NOW)).toBe("free");

    save.mockRestore();
    const retry = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(retry.applied).toBe(true);
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
  });

  it("does not record an idempotency claim for an event type it ignores", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event({ id: "evt_invoice", type: "invoice.paid" }));
    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(result).toMatchObject({ applied: false, reason: "ignored" });
    expect(await h.repo.claimEvent("evt_invoice", "invoice.paid", NOW)).toBe(true);
  });
});

// ===========================================================================
// 8. Out-of-order events cannot rewind state
// ===========================================================================

describe("event ordering", () => {
  it("drops a cancellation that arrives after a newer reactivation", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });

    const later = Math.floor(new Date("2026-08-25T12:10:00.000Z").getTime() / 1000);
    const earlier = Math.floor(new Date("2026-08-25T12:00:00.000Z").getTime() / 1000);

    const newest = signed(event({ id: "evt_new", created: later }));
    await h.service.handleWebhook({ rawBody: newest.rawBody, signature: newest.signature, now: NOW });
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");

    // A genuinely signed, genuinely Stripe-sent, genuinely older cancellation.
    const stale = signed(event(
      { id: "evt_old", created: earlier, type: "customer.subscription.deleted" },
      subscriptionObject({ status: "canceled" }),
    ));
    const result = await h.service.handleWebhook({ rawBody: stale.rawBody, signature: stale.signature, now: NOW });

    expect(result).toMatchObject({ applied: false, reason: "stale" });
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
    expect((await h.repo.getByOrganization(ORG))?.status).toBe("active");
  });

  it("applies a newer event over an older stored one", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const first = signed(event({ id: "evt_a", created: Math.floor(NOW.getTime() / 1000) }));
    await h.service.handleWebhook({ rawBody: first.rawBody, signature: first.signature, now: NOW });

    const second = signed(event(
      { id: "evt_b", created: Math.floor(NOW.getTime() / 1000) + 60, type: "customer.subscription.updated" },
      subscriptionObject({ status: "past_due" }),
    ));
    const result = await h.service.handleWebhook({ rawBody: second.rawBody, signature: second.signature, now: NOW });
    expect(result.applied).toBe(true);
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
  });
});

// ===========================================================================
// 9. Unknown price grants nothing
// ===========================================================================

describe("price mapping on the webhook path", () => {
  it("records the subscription but grants no paid plan for an unmapped price", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event(
      {},
      subscriptionObject({ items: { object: "list", data: [{ id: "si_1", current_period_end: PERIOD_END, price: { id: "price_created_in_dashboard" } }] } }),
    ));

    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(result).toMatchObject({ applied: true, reason: "unmapped_price" });

    const record = await h.repo.getByOrganization(ORG);
    expect(record?.planId).toBe("free");
    expect(record?.status).toBe("active");
    // Kept, so fixing STRIPE_PRICE_PRO later is a resync rather than an audit.
    expect(record?.providerPriceId).toBe("price_created_in_dashboard");
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
    // Loud, because an unmapped price is a paying customer who is not getting Pro.
    expect(h.logger.lines.some((l) => l.level === "error" && l.message.includes("unmapped price"))).toBe(true);
  });

  it("grants nothing when a subscription carries no price at all", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event({}, subscriptionObject({ items: { object: "list", data: [] } })));
    await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
  });
});

// ===========================================================================
// 10. Cancellation removes entitlement
// ===========================================================================

describe("cancellation", () => {
  async function subscribed() {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const active = signed(event({ id: "evt_active", created: Math.floor(NOW.getTime() / 1000) }));
    await h.service.handleWebhook({ rawBody: active.rawBody, signature: active.signature, now: NOW });
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
    return h;
  }

  it("removes the paid plan on subscription.deleted", async () => {
    const h = await subscribed();
    const del = signed(event(
      { id: "evt_del", created: Math.floor(NOW.getTime() / 1000) + 10, type: "customer.subscription.deleted" },
      // Deliberately still says "active": deletion is authoritative over the
      // status Stripe happened to serialize on the object.
      subscriptionObject({ status: "active" }),
    ));
    const result = await h.service.handleWebhook({ rawBody: del.rawBody, signature: del.signature, now: NOW });

    expect(result.applied).toBe(true);
    const record = await h.repo.getByOrganization(ORG);
    expect(record).toMatchObject({ status: "canceled", planId: "free", cancelAtPeriodEnd: false });
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
  });

  it("keeps the plan until period end when cancellation is scheduled", async () => {
    const h = await subscribed();
    const scheduled = signed(event(
      { id: "evt_sched", created: Math.floor(NOW.getTime() / 1000) + 10 },
      subscriptionObject({ cancel_at_period_end: true }),
    ));
    await h.service.handleWebhook({ rawBody: scheduled.rawBody, signature: scheduled.signature, now: NOW });

    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
    // …and expires on its own once the paid period elapses, even if the final
    // webhook never arrives.
    expect(await h.service.planFor(ORG, new Date("2026-09-26T00:00:00.000Z"))).toBe("free");
  });

  it("drops entitlement when the subscription lapses unpaid", async () => {
    const h = await subscribed();
    const unpaid = signed(event(
      { id: "evt_unpaid", created: Math.floor(NOW.getTime() / 1000) + 10 },
      subscriptionObject({ status: "unpaid" }),
    ));
    await h.service.handleWebhook({ rawBody: unpaid.rawBody, signature: unpaid.signature, now: NOW });
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
  });
});

// ===========================================================================
// 11. Portal uses the server-resolved customer
// ===========================================================================

describe("billing portal", () => {
  it("opens the portal with the stored customer id", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    h.calls.length = 0;

    const result = await h.service.createPortalSession({ userId: OWNER, organizationId: ORG });
    expect(result.url).toBe("https://billing.stripe.com/p/session/live_1");
    const call = h.calls.find((c) => c.path.startsWith("/v1/billing_portal/sessions"))!;
    expect(call.form.get("customer")).toBe(CUSTOMER);
    expect(call.form.get("return_url")).toBe(`${SITE}/pricing`);
  });

  it("refuses when the organization has no billing customer", async () => {
    const { service } = harness();
    const err = await billingErrorFrom(() => service.createPortalSession({ userId: OWNER, organizationId: ORG }));
    expect(err.code).toBe("NO_BILLING_CUSTOMER");
  });

  it("refuses to open another organization's portal", async () => {
    const h = harness();
    // The rival org really does have a customer, so this is a live target.
    await h.repo.linkCustomer({ organizationId: OTHER_ORG, provider: "stripe", providerCustomerId: "cus_rival" });
    const err = await billingErrorFrom(() =>
      h.service.createPortalSession({ userId: OWNER, organizationId: OTHER_ORG }),
    );
    expect(err.code).toBe("FORBIDDEN");
    expect(h.calls.some((c) => c.form.get("customer") === "cus_rival")).toBe(false);
  });

  it("refuses a non-owner member", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const err = await billingErrorFrom(() => h.service.createPortalSession({ userId: MEMBER, organizationId: ORG }));
    expect(err.code).toBe("FORBIDDEN");
  });
});

// ===========================================================================
// 12. A client cannot spoof a subscription, a plan, a customer or an owner
// ===========================================================================

describe("spoofing", () => {
  it("ignores metadata that names an organization other than the customer's owner", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    // A checkout whose metadata was tampered with (or a genuinely misrouted event):
    // customer resolves to ORG, metadata claims OTHER_ORG.
    const { rawBody, signature } = signed(event({}, subscriptionObject({ metadata: { organizationId: OTHER_ORG } })));

    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(result).toMatchObject({ applied: false, reason: "ownership_mismatch" });
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
    expect(await h.service.planFor(OTHER_ORG, NOW)).toBe("free");
  });

  it("cannot move a subscription onto another organization that also has billing", async () => {
    // The case the other two spoofing tests miss: both organizations have a billing
    // row. A resolver that looked the metadata id up first would *find* OTHER_ORG,
    // then agree with its own hint — the cross-check below cannot catch a resolver
    // that resolved from the same field it is checking. Ownership therefore comes
    // from the customer id we issued, and metadata never selects a row.
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    await h.repo.linkCustomer({ organizationId: OTHER_ORG, provider: "stripe", providerCustomerId: "cus_rival" });
    const { rawBody, signature } = signed(event({}, subscriptionObject({ metadata: { organizationId: OTHER_ORG } })));

    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(result).toMatchObject({ applied: false, reason: "ownership_mismatch" });
    // The named tenant gains nothing: no plan, and no subscription grafted onto its row.
    expect(await h.service.planFor(OTHER_ORG, NOW)).toBe("free");
    expect((await h.repo.getByOrganization(OTHER_ORG))?.providerSubscriptionId).toBeNull();
    expect((await h.repo.getByOrganization(OTHER_ORG))?.providerCustomerId).toBe("cus_rival");
    // And the real owner is not upgraded either — a mismatch is refused, not repaired.
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
  });  it("refuses an event for a customer it never issued", async () => {
    const h = harness();
    // No checkout has happened; the event is perfectly signed.
    const { rawBody, signature } = signed(event({}, subscriptionObject({ customer: "cus_forged" })));
    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(result).toMatchObject({ applied: false, reason: "unknown_customer" });
    expect(await h.repo.getByOrganization(ORG)).toBeNull();
    expect(await h.repo.getByCustomerId("cus_forged")).toBeNull();
  });

  it("resolves ownership from the customer id, never from metadata", async () => {
    const h = harness();
    await h.repo.linkCustomer({ organizationId: OTHER_ORG, provider: "stripe", providerCustomerId: CUSTOMER });
    // Metadata says ORG; the customer belongs to OTHER_ORG. Neither gets Pro,
    // because the mismatch is refused rather than resolved in metadata's favour.
    const { rawBody, signature } = signed(event({}, subscriptionObject({ metadata: { organizationId: ORG } })));
    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect(result.reason).toBe("ownership_mismatch");
    expect(await h.service.planFor(ORG, NOW)).toBe("free");
    expect(await h.service.planFor(OTHER_ORG, NOW)).toBe("free");
  });

  it("cannot be made to write a plan the price map does not name", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    // A subscription object carrying an explicit plan claim. There is no reader for
    // it: the plan comes from the price map alone.
    const { rawBody, signature } = signed(event({}, subscriptionObject({
      plan: "business", planId: "business", metadata: { organizationId: ORG, plan: "business" },
    })));
    await h.service.handleWebhook({ rawBody, signature, now: NOW });
    expect((await h.repo.getByOrganization(ORG))?.planId).toBe("pro");
  });
});

// ===========================================================================
// 13. Failure never corrupts existing state
// ===========================================================================

describe("failure containment", () => {
  it("leaves a free organization free when the provider errors", async () => {
    const h = harness();
    const failing = { ...h.deps, provider: {
      ...h.deps.provider!,
      createCustomer: async () => { throw new BillingError("PROVIDER_FAILED", "Stripe returned 503"); },
    } };
    const service = new BillingService(failing as BillingServiceDeps);
    const err = await billingErrorFrom(() => service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" }));
    expect(err.code).toBe("PROVIDER_FAILED");
    expect(await h.repo.getByOrganization(ORG)).toBeNull();
    expect(await service.planFor(ORG, NOW)).toBe("free");
  });

  it("leaves an existing subscription untouched when a later checkout fails", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const active = signed(event());
    await h.service.handleWebhook({ rawBody: active.rawBody, signature: active.signature, now: NOW });
    const before = await h.repo.getByOrganization(ORG);

    const failing = new BillingService({ ...h.deps, provider: {
      ...h.deps.provider!,
      createCheckoutSession: async () => { throw new BillingError("PROVIDER_FAILED", "Stripe returned 500"); },
    } } as BillingServiceDeps);
    await billingErrorFrom(() => failing.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" }));

    expect(await h.repo.getByOrganization(ORG)).toEqual(before);
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
  });

  it("does not fail a webhook because its audit row could not be written", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    vi.spyOn(h.audit, "record").mockRejectedValue(new Error("audit table is gone"));
    const { rawBody, signature } = signed(event());
    const result = await h.service.handleWebhook({ rawBody, signature, now: NOW });
    // A customer who paid must not be denied their plan by a reporting failure.
    expect(result.applied).toBe(true);
    expect(await h.service.planFor(ORG, NOW)).toBe("pro");
    vi.restoreAllMocks();
  });

  it("returns free rather than throwing for an organization with no billing state", async () => {
    const { service } = harness();
    expect(await service.planFor("org_never_seen", NOW)).toBe("free");
  });
});

// ===========================================================================
// 11. The pricing card's summary — the read path that decides what is offered
// ===========================================================================

describe("proSummary", () => {
  it("offers checkout to an owner on free, at the price the deployment configured", async () => {
    const { service } = harness();
    const summary = await service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    expect(summary.offer.action).toBe("checkout");
    expect(summary.plan).toBe("free");
    // The amount comes from Stripe's answer for the configured price id — the same
    // price the checkout will charge. Nothing in this app holds a Pro amount.
    expect(summary.price).toEqual({ unitAmount: 900, currency: "usd", interval: "month", intervalCount: 1 });
  });

  it("reads the price from the configured id, and asks Stripe once per window", async () => {
    const h = harness();
    await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    await h.service.proSummary({ userId: MEMBER, organizationId: ORG, now: NOW });
    await h.service.proSummary({ userId: null, now: NOW });
    const priceCalls = h.calls.filter((c) => c.path.startsWith("/v1/prices/"));
    // One provider round trip for three page views: this endpoint is public, so a
    // call per view would make the pricing page an amplifier into Stripe.
    expect(priceCalls).toHaveLength(1);
    expect(priceCalls[0].path).toBe(`/v1/prices/${encodeURIComponent(PRICES.pro as string)}`);
  });

  it("answers an anonymous visitor with a sign-in offer and the price", async () => {
    const { service } = harness();
    const summary = await service.proSummary({ userId: null, now: NOW });
    expect(summary.signedIn).toBe(false);
    expect(summary.plan).toBe("guest");
    expect(summary.offer.action).toBe("sign_in");
    // The public pricing page must be able to show the price.
    expect(summary.price?.unitAmount).toBe(900);
  });

  it("offers no purchase control in a deployment with no provider", async () => {
    const { service, calls } = harness({ configured: false });
    const summary = await service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    expect(summary.configured).toBe(false);
    expect(summary.offer.action).toBe("unavailable");
    expect(summary.price).toBeNull();
    expect(calls).toEqual([]);
  });

  it("offers no purchase control when no Pro price is configured", async () => {
    // `startCheckout` would throw PLAN_NOT_PURCHASABLE here, so offering the
    // button would be a control that cannot work.
    const { service } = harness({ prices: { pro: null } });
    const summary = await service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    expect(summary.configured).toBe(false);
    expect(summary.offer.action).toBe("unavailable");
    expect(summary.price).toBeNull();
  });

  it("offers no price rather than a fabricated one when Stripe cannot answer", async () => {
    const { service } = harness({ priceStatus: 404, priceBody: { error: { message: "No such price" } } });
    const summary = await service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    // Still purchasable — the price id is configured and checkout resolves it
    // server-side — but the card has no number to show and falls back to copy.
    expect(summary.offer.action).toBe("checkout");
    expect(summary.price).toBeNull();
  });

  it("tells a member to ask their owner, matching the 403 the endpoint would give", async () => {
    const { service } = harness();
    const summary = await service.proSummary({ userId: MEMBER, organizationId: ORG, now: NOW });
    expect(summary.offer.action).toBe("owner_only");
    const err = await billingErrorFrom(() => service.startCheckout({ userId: MEMBER, organizationId: ORG, plan: "pro" }));
    expect(err.code).toBe("FORBIDDEN");
  });

  it("offers nothing purchasable for an identity with no organization", async () => {
    const { service } = harness();
    const summary = await service.proSummary({ userId: "user_ghost", now: NOW });
    expect(summary.offer.action).toBe("owner_only");
    expect(summary.plan).toBe("free");
  });

  it("ignores an organization the caller is not a member of", async () => {
    // Same filter-not-assertion rule as the write path: naming someone else's org
    // narrows nothing into existence.
    const { service } = harness();
    const summary = await service.proSummary({ userId: OWNER, organizationId: OTHER_ORG, now: NOW });
    expect(summary.offer.action).toBe("owner_only");
    expect(summary.plan).toBe("free");
  });

  it("offers the portal once a webhook has granted Pro", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event());
    await h.service.handleWebhook({ rawBody, signature, now: NOW });

    const summary = await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    expect(summary.plan).toBe("pro");
    expect(summary.offer.action).toBe("manage");
  });

  it("does not offer the portal to a paying member", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event());
    await h.service.handleWebhook({ rawBody, signature, now: NOW });

    const summary = await h.service.proSummary({ userId: MEMBER, organizationId: ORG, now: NOW });
    expect(summary.plan).toBe("pro");
    expect(summary.offer.action).toBe("current");
  });

  it("stops offering the portal once the paid period has passed", async () => {
    // The same expiry guard `/api/usage` reads through. A card that still said
    // "Manage billing" past the paid-through instant would be claiming an
    // entitlement `entitledPlanFor` has already withdrawn.
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event());
    await h.service.handleWebhook({ rawBody, signature, now: NOW });

    const afterExpiry = new Date(PERIOD_END * 1000 + 60_000);
    const summary = await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: afterExpiry });
    expect(summary.plan).toBe("free");
    expect(summary.offer.action).toBe("checkout");
  });

  it("returns no price id, customer id, subscription id or organization id", async () => {
    const h = harness();
    await h.service.startCheckout({ userId: OWNER, organizationId: ORG, plan: "pro" });
    const { rawBody, signature } = signed(event());
    await h.service.handleWebhook({ rawBody, signature, now: NOW });

    const summary = await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(CUSTOMER);
    expect(serialized).not.toContain(SUB);
    expect(serialized).not.toContain(ORG);
    expect(serialized).not.toContain(PRICES.pro as string);
  });

  it("degrades to no offer rather than throwing when membership cannot be read", async () => {
    const h = harness();
    vi.spyOn(h.orgs, "listForUser").mockRejectedValue(new Error("organizations table is gone"));
    const summary = await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    // Fail-safe direction: an owner briefly told to ask their owner, not a
    // stranger told they may buy.
    expect(summary.plan).toBe("free");
    expect(summary.offer.action).toBe("owner_only");
    expect(h.logger.lines.some((l) => l.level === "warn")).toBe(true);
    vi.restoreAllMocks();
  });

  it("degrades to no offer when the billing row cannot be read", async () => {
    const h = harness();
    vi.spyOn(h.repo, "getByOrganization").mockRejectedValue(new Error("database is locked"));
    const summary = await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    expect(summary.plan).toBe("free");
    expect(summary.offer.action).toBe("owner_only");
    vi.restoreAllMocks();
  });

  it("writes nothing", async () => {
    // A read path that touched billing state would be a second writer of
    // entitlement, and the webhook is the only one.
    const h = harness();
    const before = await h.repo.getByOrganization(ORG);
    await h.service.proSummary({ userId: OWNER, organizationId: ORG, now: NOW });
    expect(await h.repo.getByOrganization(ORG)).toEqual(before);
    expect(h.audit.entries).toEqual([]);
    expect(h.calls.every((c) => c.path.startsWith("/v1/prices/"))).toBe(true);
  });

  it("never offers Business, whatever the caller's state", async () => {
    const h = harness();
    for (const userId of [OWNER, MEMBER, OUTSIDER, null]) {
      const summary = await h.service.proSummary({ userId, now: NOW });
      expect(JSON.stringify(summary.offer).toLowerCase()).not.toContain("business");
    }
  });
});
