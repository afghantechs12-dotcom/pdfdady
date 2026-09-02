import type { PlanId } from "@/src/domain/metering/plans";
import type { SubscriptionStatus } from "@/src/domain/billing/subscription";

/**
 * Persistence port for billing state.
 *
 * One row per organization. It is created when the provider customer is created
 * — before any subscription exists — so the same row is both the customer
 * mapping and the subscription state. A separate customers table would need a
 * join to answer the only question anyone asks ("what is this org entitled
 * to?"), and two tables to keep consistent under out-of-order webhooks.
 */
export interface BillingSubscriptionRecord {
  organizationId: string;
  /** "stripe" today. Stored so a second provider cannot be silently conflated. */
  provider: string;
  providerCustomerId: string;
  providerSubscriptionId: string | null;
  providerPriceId: string | null;
  status: SubscriptionStatus;
  /** The plan the stored price maps to, resolved at write time. */
  planId: PlanId;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** `created` of the newest provider event applied. The stale-event ordering key. */
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The subscription fields a provider event overwrites. */
export interface ProviderStateUpdate {
  organizationId: string;
  providerSubscriptionId: string | null;
  providerPriceId: string | null;
  status: SubscriptionStatus;
  planId: PlanId;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  lastEventAt: Date;
}

export interface IBillingRepository {
  getByOrganization(organizationId: string): Promise<BillingSubscriptionRecord | null>;
  getByCustomerId(providerCustomerId: string): Promise<BillingSubscriptionRecord | null>;
  getBySubscriptionId(
    providerSubscriptionId: string,
  ): Promise<BillingSubscriptionRecord | null>;

  /**
   * Records the provider customer for an organization, idempotently.
   *
   * Called only when no row exists yet. Implementations must not overwrite an
   * existing customer id: two concurrent checkout attempts would otherwise each
   * create a Stripe customer and the second would orphan the first, leaving a
   * paying customer whose subscription maps to a customer id we no longer store.
   */
  linkCustomer(input: {
    organizationId: string;
    provider: string;
    providerCustomerId: string;
  }): Promise<BillingSubscriptionRecord>;

  /** Overwrites subscription state. The caller has already checked event order. */
  saveProviderState(update: ProviderStateUpdate): Promise<BillingSubscriptionRecord>;

  /**
   * Compare-and-set claim on a provider event id.
   *
   * `true` means this caller owns the event and must process it; `false` means it
   * was already processed and this delivery is a duplicate. The same durable
   * insert-wins mechanism as `UsageSettlement`: an in-process set would not hold
   * across restarts or across instances, and a read-then-write lets two
   * deliveries both see "unclaimed".
   */
  claimEvent(eventId: string, type: string, at: Date): Promise<boolean>;

  /**
   * Drops a claim so the provider's retry can apply the event after all.
   *
   * Claiming before processing is what makes a duplicate delivery cause *no*
   * duplicate side effects — but it also means a claim followed by a failed write
   * would strand the event: the retry would see it claimed and skip work that
   * never happened. Releasing on failure is the other half of that guarantee.
   */
  releaseEvent(eventId: string): Promise<void>;
}
