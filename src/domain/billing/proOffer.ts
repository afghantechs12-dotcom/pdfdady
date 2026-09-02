import { isPaidPlan, PURCHASABLE_PLAN_IDS } from "./subscription";
import type { PlanId } from "@/src/domain/metering/plans";

/**
 * What the Pro card offers a given visitor, and how its price reads.
 *
 * Pure, and separate from `BillingService` for the reason `usageViewModel.ts` is
 * separate from `UsageCard.tsx`: this is the layer that decides what a user is
 * *offered*, and "an unconfigured deployment never shows a buy button" is a rule
 * about output that is only real if something asserts it. Vitest runs
 * `environment: "node"`, so a `.tsx` component cannot be rendered against — a
 * pure module can.
 *
 * ── THE PRICE IS NEVER INVENTED HERE ────────────────────────────────────────
 *
 * There is no amount in this file, no default, and no fallback number. A price
 * label exists only when a provider price was actually read
 * (`formatPlanPrice`), and every other path returns `null` so the caller falls
 * back to the *approved* copy in the pricing store — which currently reads "Not
 * yet available". That is the whole defence against a plausible-looking "$9/mo"
 * appearing on a page because a component needed something to render: the
 * number can only come from the price the deployment configured at Stripe, which
 * is also the number that will be charged.
 */

/** A provider price reduced to what a label needs. No provider types cross this. */
export interface DisplayPrice {
  /**
   * Amount in the currency's smallest unit, as providers report it. Null for a
   * price with no simple amount (tiered/metered) — those get no label rather
   * than a guessed one.
   */
  unitAmount: number | null;
  /** ISO 4217, lower or upper case. */
  currency: string;
  /** Recurrence, or null for a one-off price. */
  interval: "day" | "week" | "month" | "year" | null;
  /** Intervals per billing period: 3 with `month` is quarterly. */
  intervalCount: number;
}

/**
 * The action the card's control performs.
 *
 * `unavailable` is first in the decision order and is what an unconfigured
 * deployment always gets, so a build with no Stripe credentials cannot render a
 * control that posts to checkout.
 */
export type ProOfferAction =
  /** The deployment cannot take money. The card keeps its approved "not yet" copy. */
  | "unavailable"
  /** No session. The control is a link to sign in, not a checkout POST. */
  | "sign_in"
  /** An eligible owner. `POST /api/billing/checkout { plan: "pro" }`. */
  | "checkout"
  /** Already paid, with a stored customer. `POST /api/billing/portal`. */
  | "manage"
  /** Already paid with no provider customer (hand-granted): nothing to open. */
  | "current"
  /** Signed in, but billing is owner-only in this organization. */
  | "owner_only";

/** The facts the server knows about one visitor. Every field is server-resolved. */
export interface ProOfferInput {
  /** `cfg.billing.enabled` — key, webhook secret and a Pro price all present. */
  configured: boolean;
  signedIn: boolean;
  /** Owner-only `billing:manage`, resolved from membership. Never from a request. */
  canManageBilling: boolean;
  /** The plan currently *entitled*, not a plan requested at checkout. */
  plan: PlanId;
  /** True when a provider customer is stored, which is what a portal needs. */
  hasBillingAccount: boolean;
}

export interface ProOffer {
  action: ProOfferAction;
  /** Button text. */
  label: string;
  /** One sentence under the control, or null when the label says enough. */
  note: string | null;
}

/**
 * The offer for one visitor.
 *
 * Decision order is the safety property, not a style choice:
 *
 *  1. **Unconfigured wins over everything.** No session, plan or role can
 *     produce a purchase control in a deployment that cannot complete one.
 *  2. **Already-paid is checked before role.** A member of a Pro organization is
 *     told they are on Pro, not that they lack permission to buy what their
 *     organization already has.
 *  3. **A portal is offered only with a stored customer.** Without one the
 *     endpoint answers 409, so offering the button would be a dead control.
 */
export function proOffer(input: ProOfferInput): ProOffer {
  if (!input.configured) {
    return {
      action: "unavailable",
      label: "Contact us",
      note: null,
    };
  }

  if (!input.signedIn) {
    return {
      action: "sign_in",
      label: "Sign in to upgrade",
      note: "Pro applies to your account, so it needs one.",
    };
  }

  if (isPaidPlan(input.plan)) {
    if (input.canManageBilling && input.hasBillingAccount) {
      return {
        action: "manage",
        label: "Manage billing",
        note: "Change your card or cancel in the billing portal.",
      };
    }
    return {
      action: "current",
      label: "Your current plan",
      note: input.canManageBilling
        ? "This plan was applied directly, so there is no subscription to manage."
        : "Billing is managed by your organization's owner.",
    };
  }

  if (!input.canManageBilling) {
    return {
      action: "owner_only",
      label: "Ask your owner to upgrade",
      note: "Only an organization owner can start a subscription.",
    };
  }

  return {
    action: "checkout",
    label: "Upgrade to Pro",
    note: null,
  };
}

/** Whether the control submits a billing request rather than navigating. */
export function offerPosts(action: ProOfferAction): boolean {
  return action === "checkout" || action === "manage";
}

/**
 * A price label, or null.
 *
 * Null on every uncertain input — no amount, a non-finite amount, a negative
 * amount, an unusable currency code. The caller then shows the approved copy from
 * the pricing store, which is the honest answer to "we could not read the price"
 * and is never a number.
 *
 * The minor-unit divisor is derived from `Intl`, not from a hand-kept currency
 * table: `USD` resolves to 2 fraction digits and JPY to 0, so ¥1200 formats as
 * ¥1,200 rather than ¥12. A table would be one more list to get wrong, and
 * getting it wrong misprices the product by 100×.
 *
 * The locale is pinned rather than left to the environment. This label is
 * computed on the server and rendered as a string in the browser, so an
 * environment-dependent locale would produce a server/client mismatch on the one
 * piece of text where disagreement matters.
 */
export function formatPlanPrice(price: DisplayPrice | null): string | null {
  if (!price) return null;
  const { unitAmount, currency } = price;
  if (typeof unitAmount !== "number" || !Number.isFinite(unitAmount) || unitAmount < 0) {
    return null;
  }
  if (!/^[A-Za-z]{3}$/.test(currency)) return null;

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    });
  } catch {
    // An ISO-shaped code Intl does not know. No label beats a wrong one.
    return null;
  }

  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(unitAmount / 10 ** digits);
}

/**
 * The "/month" suffix, or null when there is nothing periodic to say.
 *
 * Kept separate from the amount because the pricing card renders the period in
 * its own smaller type — the same split `PricingPlan.price` / `.period` already
 * uses, so this drops into the existing markup instead of needing new markup.
 */
export function formatPlanPeriod(price: DisplayPrice | null): string | null {
  if (!price?.interval) return null;
  const count = Number.isFinite(price.intervalCount) ? Math.trunc(price.intervalCount) : 1;
  if (count <= 1) return price.interval;
  return `${count} ${price.interval}s`;
}

// ---- public plan availability ----------------------------------------------

/**
 * What a plan's *public* state is, for the pricing page and any other surface
 * that describes a plan without offering it to a specific visitor.
 *
 * Distinct from `proOffer`, which answers "what control does THIS visitor get".
 * This answers "what is true about the plan at all", which is what marketing copy
 * needs and is the question the pricing page was previously answering from a
 * hardcoded `available: boolean` in the pricing store — a value an admin could
 * edit into a claim the deployment cannot honour.
 *
 *  - `free` — no payment involved; always available.
 *  - `purchasable` — the deployment has a configured price and can complete a
 *    checkout.
 *  - `configured-elsewhere` — a real plan this deployment cannot sell, because it
 *    has no price configured. Not "coming later": the product exists.
 *  - `deferred` — not sellable by domain law rather than by configuration. Only
 *    Business, whose absence from `BillingPriceMap` is the enforcement.
 */
export type PublicPlanAvailability =
  | "free"
  | "purchasable"
  | "configured-elsewhere"
  | "deferred";

/**
 * The public state of a plan.
 *
 * `configured` is `cfg.billing.enabled` — derived on the server from the presence
 * of a secret key, a webhook secret and a Pro price. The secret itself never
 * reaches a caller of this function; only the boolean does.
 */
export function publicPlanAvailability(
  planId: string,
  configured: boolean,
): PublicPlanAvailability {
  if (planId === "free") return "free";
  // Business is deferred by domain law: `BillingPriceMap` has no `business` slot,
  // so no configuration can make it purchasable. Checked before `configured` for
  // that reason — a fully configured deployment still cannot sell it.
  if (!PURCHASABLE_PLAN_IDS.includes(planId as never)) return "deferred";
  return configured ? "purchasable" : "configured-elsewhere";
}
