import type {
  BillingSubscriptionRecord,
  IBillingRepository,
  ProviderStateUpdate,
} from "@/src/application/ports/billing/BillingRepository";
import { NotFoundError } from "@/src/domain/errors";

/**
 * In-memory billing state, for tests and for a deployment with no database.
 *
 * Mirrors the Prisma adapter's *observable* behaviour, including the parts that
 * exist for correctness: `linkCustomer` returns an existing row unchanged rather
 * than replacing its customer id, `saveProviderState` throws for an unknown
 * organization rather than creating one, and `claimEvent` is insert-wins. A test
 * that passes here and fails against Prisma would mean this class is lying.
 */
export class InMemoryBillingRepository implements IBillingRepository {
  private readonly byOrg = new Map<string, BillingSubscriptionRecord>();
  private readonly events = new Map<string, Date>();
  /** Monotonic clock stand-in for createdAt/updatedAt; tests never assert on it. */
  private tick = 0;

  private now(): Date {
    return new Date(1_700_000_000_000 + this.tick++);
  }

  async getByOrganization(organizationId: string): Promise<BillingSubscriptionRecord | null> {
    return this.byOrg.get(organizationId) ?? null;
  }

  async getByCustomerId(
    providerCustomerId: string,
  ): Promise<BillingSubscriptionRecord | null> {
    for (const record of this.byOrg.values()) {
      if (record.providerCustomerId === providerCustomerId) return record;
    }
    return null;
  }

  async getBySubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRecord | null> {
    for (const record of this.byOrg.values()) {
      if (record.providerSubscriptionId === providerSubscriptionId) return record;
    }
    return null;
  }

  async linkCustomer(input: {
    organizationId: string;
    provider: string;
    providerCustomerId: string;
  }): Promise<BillingSubscriptionRecord> {
    const existing = this.byOrg.get(input.organizationId);
    if (existing) return existing;
    const created: BillingSubscriptionRecord = {
      organizationId: input.organizationId,
      provider: input.provider,
      providerCustomerId: input.providerCustomerId,
      providerSubscriptionId: null,
      providerPriceId: null,
      status: "incomplete",
      planId: "free",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      lastEventAt: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.byOrg.set(input.organizationId, created);
    return created;
  }

  async saveProviderState(update: ProviderStateUpdate): Promise<BillingSubscriptionRecord> {
    const existing = this.byOrg.get(update.organizationId);
    if (!existing) {
      throw new NotFoundError(`No billing record for organization ${update.organizationId}.`);
    }
    const next: BillingSubscriptionRecord = {
      ...existing,
      providerSubscriptionId: update.providerSubscriptionId,
      providerPriceId: update.providerPriceId,
      status: update.status,
      planId: update.planId,
      currentPeriodEnd: update.currentPeriodEnd,
      cancelAtPeriodEnd: update.cancelAtPeriodEnd,
      lastEventAt: update.lastEventAt,
      updatedAt: this.now(),
    };
    this.byOrg.set(update.organizationId, next);
    return next;
  }

  async claimEvent(eventId: string, _type: string, at: Date): Promise<boolean> {
    if (this.events.has(eventId)) return false;
    this.events.set(eventId, at);
    return true;
  }

  async releaseEvent(eventId: string): Promise<void> {
    this.events.delete(eventId);
  }
}
