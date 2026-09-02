import { DomainError } from "@/src/domain/errors";
import { DEFAULT_PLAN_ID, isPlanId, type PlanId } from "@/src/domain/metering/plans";

/**
 * The billing domain: what a subscription *is*, and the one question the rest of
 * the app asks it — "does this entitle a paid plan right now?".
 *
 * Everything here is pure. The provider adapter, the repository and the HTTP
 * routes all depend on these functions; none of them re-decides entitlement on
 * its own, because two places deciding "is this Pro?" is how a cancelled
 * subscription keeps its features on one code path and loses them on another.
 */

/**
 * Subscription lifecycle vocabulary.
 *
 * These are Stripe's status strings, kept verbatim rather than mapped into an
 * invented vocabulary. A second vocabulary would need a translation table that
 * silently defaults an unrecognized Stripe status to *something*, and the safe
 * something is what `toSubscriptionStatus` already does — one step, not two.
 */
export const SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * The status an unrecognized or absent provider status resolves to.
 *
 * `incomplete` — not `active`. A status string this build has never heard of
 * (a new Stripe state, a typo in a hand-edited row) must not entitle anything.
 */
export const DEFAULT_SUBSCRIPTION_STATUS: SubscriptionStatus = "incomplete";

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export function toSubscriptionStatus(value: unknown): SubscriptionStatus {
  return isSubscriptionStatus(value) ? value : DEFAULT_SUBSCRIPTION_STATUS;
}

/**
 * Statuses that entitle the paid plan.
 *
 * `past_due` is deliberately NOT here. A card that failed its first retry loses
 * Pro allowances at once, which is stricter than most products and is the safe
 * direction for a first billing slice: granting paid features on an unpaid
 * invoice is the failure that costs money, being briefly strict is the failure
 * that costs a support email.
 *
 * ponytail: no grace period. If churn data later says one is wanted, add
 * `past_due` here plus a `graceUntil` column — do not widen it by reading
 * `currentPeriodEnd`, which is not a grace window and does not move when an
 * invoice fails.
 */
const ENTITLING_STATUSES: readonly SubscriptionStatus[] = ["active", "trialing"];

/** The provider-independent subscription state the app stores and reasons about. */
export interface BillingSubscriptionState {
  /** Provider status, already coerced through `toSubscriptionStatus`. */
  status: SubscriptionStatus;
  /** The internal plan this subscription's price maps to. */
  planId: PlanId;
  /** End of the paid-through window; null before a subscription exists. */
  currentPeriodEnd: Date | null;
  /** True when the customer has asked it to stop at `currentPeriodEnd`. */
  cancelAtPeriodEnd: boolean;
}

/**
 * The plan a subscription entitles, as of `now`.
 *
 * Three ways to get `free` out of this, and all three matter:
 *
 *  - the status does not entitle (cancelled, unpaid, never completed)
 *  - the stored plan is not a paid plan (an unknown price mapped to nothing)
 *  - the paid-through instant has passed
 *
 * That last one is the guard against a *missed* webhook. Stripe sends
 * `customer.subscription.deleted`, but a webhook endpoint that was down for the
 * one delivery window that mattered would otherwise leave `status: "active"` in
 * the database for ever. Expiry makes silence downgrade rather than extend, so
 * the worst outcome of a lost event is a customer who has to be resynced, not a
 * plan nobody is paying for.
 */
export function entitledPlanFor(
  state: BillingSubscriptionState | null,
  now: Date,
): PlanId {
  if (!state) return DEFAULT_PLAN_ID;
  if (!ENTITLING_STATUSES.includes(state.status)) return DEFAULT_PLAN_ID;
  if (!isPaidPlan(state.planId)) return DEFAULT_PLAN_ID;
  if (state.currentPeriodEnd && state.currentPeriodEnd.getTime() <= now.getTime()) {
    return DEFAULT_PLAN_ID;
  }
  return state.planId;
}

/**
 * Plans that cost money. `guest` and `free` do not.
 *
 * `business` is still here even though it cannot be bought: this answers "does
 * this stored plan entitle paid features", and an operator-set Business row must
 * keep working. Purchasability is a separate question, asked by
 * `PURCHASABLE_PLAN_IDS`.
 */
export function isPaidPlan(plan: PlanId): boolean {
  return plan === "pro" || plan === "business";
}

/**
 * Whether an incoming provider event is newer than what is already stored.
 *
 * Stripe does not guarantee delivery order: a `subscription.updated` that
 * cancels and a later `subscription.updated` that reactivates can arrive
 * backwards, and applying them in arrival order would leave the account in the
 * *older* state permanently. The event's own `created` timestamp is the order,
 * so a strictly older event is dropped.
 *
 * Equal timestamps are accepted rather than dropped. Two distinct events can
 * share a second, and the duplicate case — the same event delivered twice — is
 * already stopped by the event-id claim, which is a stronger guard than a
 * timestamp comparison could be.
 */
export function isNewerEvent(eventAt: Date, storedLastEventAt: Date | null): boolean {
  if (!storedLastEventAt) return true;
  return eventAt.getTime() >= storedLastEventAt.getTime();
}

/** Machine-readable billing failures. The HTTP layer maps these to statuses. */
export type BillingErrorCode =
  | "BILLING_NOT_CONFIGURED"
  | "PLAN_NOT_PURCHASABLE"
  | "FORBIDDEN"
  | "NO_BILLING_CUSTOMER"
  | "PROVIDER_FAILED"
  | "INVALID_SIGNATURE";

export class BillingError extends DomainError {
  constructor(
    readonly code: BillingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

/**
 * Server-configured price → plan mapping.
 *
 * This exists so the *browser* never names a price. A checkout request says
 * "pro"; the price id it resolves to is whatever this deployment configured, and
 * a request naming a price directly has nowhere to put it. That is the whole
 * defence against a crafted request buying a $0 price and getting Pro.
 *
 * One slot, because Pro is the only plan this milestone sells. The absence of a
 * `business` slot is the enforcement, not a default that could be filled in: with
 * nowhere to configure a Business price, `planForPriceId` cannot return
 * `"business"` for any price id, so no Stripe payload — configured, unknown or
 * forged — can grant Business. See BUSINESS BILLING IS DEFERRED below.
 */
export interface BillingPriceMap {
  /** Plan → provider price id. A plan with no configured price is not purchasable. */
  readonly pro: string | null;
}

/**
 * The plans this slice can sell.
 *
 * ── BUSINESS BILLING IS DEFERRED ────────────────────────────────────────────
 *
 * `business` stays in the *plan* vocabulary — `PlanId`, `ALL_PLAN_IDS`,
 * `PLAN_ENTITLEMENTS`, `isPaidPlan` and the pricing copy all keep it, because a
 * Business tier still exists as a product concept and an operator can still set
 * an organization to it by hand. What it is not is *purchasable*: there is no
 * Business price to configure, no checkout path that accepts it, and no price id
 * a webhook can map to it.
 *
 * Deferred rather than deleted because a half-built purchase path is worse than
 * none — seats, per-seat pricing and org invoicing are the actual Business
 * feature set, and none of that is in this slice. Selling the plan before it
 * exists would take money for it.
 *
 * To launch Business later: add its slot to `BillingPriceMap`, add it back to
 * this tuple, restore a `STRIPE_PRICE_BUSINESS` env var, and expect
 * `businessDeferred.test.ts` to go red — that file is the deliberate gate.
 */
export const PURCHASABLE_PLAN_IDS = ["pro"] as const;
export type PurchasablePlanId = (typeof PURCHASABLE_PLAN_IDS)[number];

export function isPurchasablePlanId(value: unknown): value is PurchasablePlanId {
  return (
    typeof value === "string" && (PURCHASABLE_PLAN_IDS as readonly string[]).includes(value)
  );
}

/**
 * The configured price id for a plan, or a `BillingError` if there is none.
 *
 * Throwing beats returning a fallback. "If no real Pro price is configured, fail
 * clearly rather than inventing one" — an invented price id would either 400 at
 * Stripe with an opaque message or, worse, match some other product.
 */
export function priceIdForPlan(prices: BillingPriceMap, plan: PurchasablePlanId): string {
  const priceId = prices[plan];
  if (!priceId) {
    throw new BillingError(
      "PLAN_NOT_PURCHASABLE",
      `The ${plan} plan is not available for purchase in this deployment.`,
    );
  }
  return priceId;
}

/**
 * The internal plan a provider price id grants, or `null` when unrecognized.
 *
 * `null`, not `free`, so callers must decide what an unknown price means in
 * their context — the webhook writes `free` and warns, which is a different
 * thing from an unmapped price being *equal* to free.
 *
 * Iterating `PURCHASABLE_PLAN_IDS` rather than every `PlanId` is what keeps a
 * deferred plan unreachable: `"pro"` is the only member, so the only price id
 * this can resolve is the configured Pro one.
 */
export function planForPriceId(
  prices: BillingPriceMap,
  priceId: string | null | undefined,
): PlanId | null {
  if (!priceId) return null;
  for (const plan of PURCHASABLE_PLAN_IDS) {
    if (prices[plan] === priceId) return plan;
  }
  return null;
}

/** Coerces a stored plan column, keeping an unknown value away from paid tiers. */
export function toStoredPlanId(value: unknown): PlanId {
  return isPlanId(value) ? value : DEFAULT_PLAN_ID;
}
