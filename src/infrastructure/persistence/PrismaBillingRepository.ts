import { Prisma, PrismaClient } from "@prisma/client";
import type {
  BillingSubscriptionRecord,
  IBillingRepository,
  ProviderStateUpdate,
} from "@/src/application/ports/billing/BillingRepository";
import { toSubscriptionStatus, toStoredPlanId } from "@/src/domain/billing/subscription";

type Row = {
  organizationId: string;
  provider: string;
  providerCustomerId: string;
  providerSubscriptionId: string | null;
  providerPriceId: string | null;
  status: string;
  planId: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Coerces on the way *out* of the database, not only on the way in.
 *
 * The columns are free-text for SQLite portability, so a hand-edited row or a
 * status added by a future Stripe version can hold anything. Coercing at the read
 * boundary means every consumer above sees a known status and a known plan, and
 * an unrecognized value degrades to `incomplete`/`free` rather than flowing into
 * an entitlement comparison as an unhandled string.
 */
function toDomain(row: Row): BillingSubscriptionRecord {
  return {
    organizationId: row.organizationId,
    provider: row.provider,
    providerCustomerId: row.providerCustomerId,
    providerSubscriptionId: row.providerSubscriptionId,
    providerPriceId: row.providerPriceId,
    status: toSubscriptionStatus(row.status),
    planId: toStoredPlanId(row.planId),
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Prisma-backed billing state against `billing_subscriptions` + `billing_events`. */
export class PrismaBillingRepository implements IBillingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getByOrganization(organizationId: string): Promise<BillingSubscriptionRecord | null> {
    const row = await this.prisma.billingSubscription.findUnique({ where: { organizationId } });
    return row ? toDomain(row) : null;
  }

  async getByCustomerId(
    providerCustomerId: string,
  ): Promise<BillingSubscriptionRecord | null> {
    const row = await this.prisma.billingSubscription.findUnique({
      where: { providerCustomerId },
    });
    return row ? toDomain(row) : null;
  }

  async getBySubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRecord | null> {
    const row = await this.prisma.billingSubscription.findUnique({
      where: { providerSubscriptionId },
    });
    return row ? toDomain(row) : null;
  }

  /**
   * `upsert` with an empty update, which is the idempotent form: if a row already
   * exists this returns it *unchanged*, so a second concurrent checkout cannot
   * replace a stored customer id with a newly created one and orphan the
   * subscription attached to the first.
   */
  async linkCustomer(input: {
    organizationId: string;
    provider: string;
    providerCustomerId: string;
  }): Promise<BillingSubscriptionRecord> {
    const row = await this.prisma.billingSubscription.upsert({
      where: { organizationId: input.organizationId },
      update: {},
      create: {
        organizationId: input.organizationId,
        provider: input.provider,
        providerCustomerId: input.providerCustomerId,
      },
    });
    return toDomain(row);
  }

  /**
   * Writes subscription state onto an existing row.
   *
   * `update`, not `upsert`: the row is created by `linkCustomer`, and a webhook
   * for a customer we have never stored is an ownership failure the service
   * rejects rather than a row to invent. Creating one here would mean a forged or
   * misrouted event could mint an organization's billing record.
   */
  async saveProviderState(update: ProviderStateUpdate): Promise<BillingSubscriptionRecord> {
    const row = await this.prisma.billingSubscription.update({
      where: { organizationId: update.organizationId },
      data: {
        providerSubscriptionId: update.providerSubscriptionId,
        providerPriceId: update.providerPriceId,
        status: update.status,
        planId: update.planId,
        currentPeriodEnd: update.currentPeriodEnd,
        cancelAtPeriodEnd: update.cancelAtPeriodEnd,
        lastEventAt: update.lastEventAt,
      },
    });
    return toDomain(row);
  }

  /**
   * Insert-wins claim. The unique-constraint violation IS the "already processed"
   * answer — checking first and inserting second would let two concurrent
   * deliveries both see an unclaimed event.
   *
   * Only P2002 means "already claimed". Every other error propagates, because a
   * blanket `catch { return false }` would report a database outage as a duplicate,
   * the route would answer 200, Stripe would never retry, and a paid subscription
   * would be dropped in silence. Same reasoning as
   * `PrismaUsageRepository.claimSettlement`, and the same three outcomes.
   */
  async claimEvent(eventId: string, type: string, at: Date): Promise<boolean> {
    try {
      await this.prisma.billingEvent.create({ data: { id: eventId, type, receivedAt: at } });
      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return false;
      }
      throw err;
    }
  }

  async releaseEvent(eventId: string): Promise<void> {
    try {
      await this.prisma.billingEvent.delete({ where: { id: eventId } });
    } catch (err) {
      // P2025 is "record not found". Releasing a claim that is not held is the
      // desired end state, so that one is success; anything else is a real fault
      // and the caller decides what to do about a claim that could not be
      // released.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return;
      throw err;
    }
  }
}
