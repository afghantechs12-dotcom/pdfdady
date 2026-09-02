import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { PrismaBillingRepository } from "./PrismaBillingRepository";

/**
 * The billing adapter, against the semantics its callers depend on.
 *
 * Three of them are load-bearing and none is visible from the service:
 *
 *   claimEvent P2002        → false  ("already delivered, do nothing")
 *   claimEvent anything else→ throw  (so the route 500s and Stripe RETRIES)
 *   linkCustomer on a row   → unchanged (never re-points a stored customer)
 *   saveProviderState, no row→ throw  (a webhook cannot mint billing state)
 *
 * The dangerous version of the first pair is a blanket `catch { return false }`:
 * a database outage would answer "duplicate", the webhook would return 200, Stripe
 * would stop retrying, and a customer who paid would never be upgraded — with no
 * error anywhere. Hence a fake that raises real Prisma errors rather than plain
 * objects, because the adapter's guard is `instanceof`.
 */

function knownError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, {
    code,
    clientVersion: "test",
  });
}

const AT = new Date("2026-08-25T12:00:00.000Z");
const PERIOD_END = new Date("2026-09-25T12:00:00.000Z");

type Row = Record<string, unknown>;

/** Minimal delegates that enforce the real unique constraints. */
function fakePrisma() {
  const subs = new Map<string, Row>();
  const events = new Map<string, Row>();
  const findBy = (field: string, value: unknown) =>
    [...subs.values()].find((row) => row[field] === value) ?? null;

  const prisma = {
    billingSubscription: {
      findUnique: async ({ where }: { where: Row }) => {
        const [field, value] = Object.entries(where)[0]!;
        return findBy(field, value);
      },
      upsert: async ({ where, create }: { where: { organizationId: string }; create: Row }) => {
        const existing = subs.get(where.organizationId);
        if (existing) return existing;
        const row = {
          providerSubscriptionId: null, providerPriceId: null,
          status: "incomplete", planId: "free",
          currentPeriodEnd: null, cancelAtPeriodEnd: false, lastEventAt: null,
          createdAt: AT, updatedAt: AT,
          ...create,
        };
        subs.set(where.organizationId, row);
        return row;
      },
      update: async ({ where, data }: { where: { organizationId: string }; data: Row }) => {
        const existing = subs.get(where.organizationId);
        if (!existing) throw knownError("P2025");
        const row = { ...existing, ...data, updatedAt: AT };
        subs.set(where.organizationId, row);
        return row;
      },
    },
    billingEvent: {
      create: async ({ data }: { data: { id: string } }) => {
        if (events.has(data.id)) throw knownError("P2002");
        events.set(data.id, data);
        return data;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        if (!events.has(where.id)) throw knownError("P2025");
        const row = events.get(where.id)!;
        events.delete(where.id);
        return row;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, subs, events };
}

describe("PrismaBillingRepository.claimEvent", () => {
  it("claims an unseen event once and refuses the redelivery", async () => {
    const { prisma, events } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    expect(await repo.claimEvent("evt_1", "customer.subscription.updated", AT)).toBe(true);
    expect(await repo.claimEvent("evt_1", "customer.subscription.updated", AT)).toBe(false);
    // One row, so the constraint answered — not a cache inside the adapter.
    expect([...events.keys()]).toEqual(["evt_1"]);
  });

  it("keys per event, so one delivery does not suppress another", async () => {
    const { prisma } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    expect(await repo.claimEvent("evt_1", "a", AT)).toBe(true);
    expect(await repo.claimEvent("evt_2", "a", AT)).toBe(true);
  });

  it("lets a genuine fault propagate instead of answering 'already delivered'", async () => {
    // P1001 is "cannot reach database". Returning false here is the silent
    // dropped-subscription path: 200 to Stripe, no retry, no upgrade, no error.
    const failing = {
      billingEvent: { create: () => Promise.reject(knownError("P1001")) },
    } as unknown as PrismaClient;
    await expect(new PrismaBillingRepository(failing).claimEvent("evt_1", "a", AT)).rejects.toThrow();
  });

  it("propagates a non-Prisma failure too", async () => {
    const failing = {
      billingEvent: { create: () => Promise.reject(new Error("socket hang up")) },
    } as unknown as PrismaClient;
    await expect(new PrismaBillingRepository(failing).claimEvent("evt_1", "a", AT)).rejects.toThrow("socket hang up");
  });

  it("records the claim time it was given", async () => {
    const { prisma, events } = fakePrisma();
    await new PrismaBillingRepository(prisma).claimEvent("evt_1", "customer.subscription.created", AT);
    expect(events.get("evt_1")).toMatchObject({ type: "customer.subscription.created", receivedAt: AT });
  });
});

describe("PrismaBillingRepository.releaseEvent", () => {
  it("frees a claim so a retry can apply the event for real", async () => {
    const { prisma } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    await repo.claimEvent("evt_1", "a", AT);
    await repo.releaseEvent("evt_1");
    expect(await repo.claimEvent("evt_1", "a", AT)).toBe(true);
  });

  it("treats an absent claim as success", async () => {
    const { prisma } = fakePrisma();
    await expect(new PrismaBillingRepository(prisma).releaseEvent("evt_never")).resolves.toBeUndefined();
  });

  it("propagates a real fault rather than pretending the claim is gone", async () => {
    const failing = {
      billingEvent: { delete: () => Promise.reject(knownError("P1001")) },
    } as unknown as PrismaClient;
    await expect(new PrismaBillingRepository(failing).releaseEvent("evt_1")).rejects.toThrow();
  });
});

describe("PrismaBillingRepository customer linking", () => {
  it("creates a row with no plan and no subscription", async () => {
    const { prisma } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    const record = await repo.linkCustomer({ organizationId: "org_1", provider: "stripe", providerCustomerId: "cus_1" });
    expect(record).toMatchObject({
      organizationId: "org_1", providerCustomerId: "cus_1",
      status: "incomplete", planId: "free", providerSubscriptionId: null,
    });
  });

  it("never re-points an existing customer id", async () => {
    // Two concurrent first checkouts: the loser's Stripe customer is orphaned, but
    // replacing the stored id would orphan the *subscription* instead and make its
    // webhooks unresolvable.
    const { prisma } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    await repo.linkCustomer({ organizationId: "org_1", provider: "stripe", providerCustomerId: "cus_first" });
    const second = await repo.linkCustomer({ organizationId: "org_1", provider: "stripe", providerCustomerId: "cus_second" });
    expect(second.providerCustomerId).toBe("cus_first");
    expect((await repo.getByOrganization("org_1"))?.providerCustomerId).toBe("cus_first");
    expect(await repo.getByCustomerId("cus_second")).toBeNull();
  });
});

describe("PrismaBillingRepository.saveProviderState", () => {
  it("refuses to create a row for an organization that never opened checkout", async () => {
    const { prisma, subs } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    await expect(repo.saveProviderState({
      organizationId: "org_unknown",
      providerSubscriptionId: "sub_1", providerPriceId: "price_pro",
      status: "active", planId: "pro",
      currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, lastEventAt: AT,
    })).rejects.toThrow();
    expect(subs.size).toBe(0);
  });

  it("writes subscription state onto the linked row and reads it back", async () => {
    const { prisma } = fakePrisma();
    const repo = new PrismaBillingRepository(prisma);
    await repo.linkCustomer({ organizationId: "org_1", provider: "stripe", providerCustomerId: "cus_1" });
    await repo.saveProviderState({
      organizationId: "org_1",
      providerSubscriptionId: "sub_1", providerPriceId: "price_pro",
      status: "active", planId: "pro",
      currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, lastEventAt: AT,
    });
    expect(await repo.getBySubscriptionId("sub_1")).toMatchObject({
      organizationId: "org_1", status: "active", planId: "pro", currentPeriodEnd: PERIOD_END, lastEventAt: AT,
    });
    expect(await repo.getByCustomerId("cus_1")).toMatchObject({ planId: "pro" });
  });
});

describe("PrismaBillingRepository read coercion", () => {
  it("floors an unrecognized stored status and plan instead of trusting the column", async () => {
    // The columns are free text for SQLite portability. A row hand-edited to
    // planId = "enterprise", status = "renewed" must not reach an entitlement
    // comparison as an unhandled string.
    const { prisma, subs } = fakePrisma();
    subs.set("org_1", {
      organizationId: "org_1", provider: "stripe", providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1", providerPriceId: "price_x",
      status: "renewed", planId: "enterprise",
      currentPeriodEnd: PERIOD_END, cancelAtPeriodEnd: false, lastEventAt: AT,
      createdAt: AT, updatedAt: AT,
    });
    const record = await new PrismaBillingRepository(prisma).getByOrganization("org_1");
    expect(record).toMatchObject({ status: "incomplete", planId: "free" });
  });
});
