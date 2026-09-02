import type { ILogger } from "@/src/application/ports/Logger";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import type {
  IBillingProvider,
  ProviderEvent,
  ProviderPrice,
  ProviderSubscription,
} from "@/src/application/ports/billing/BillingProvider";
import type {
  BillingSubscriptionRecord,
  IBillingRepository,
} from "@/src/application/ports/billing/BillingRepository";
import {
  BillingError,
  entitledPlanFor,
  isNewerEvent,
  planForPriceId,
  priceIdForPlan,
  toSubscriptionStatus,
  type BillingPriceMap,
  type PurchasablePlanId,
} from "@/src/domain/billing/subscription";
import { proOffer, type DisplayPrice, type ProOffer } from "@/src/domain/billing/proOffer";
import { DEFAULT_PLAN_ID, GUEST_PLAN_ID, type PlanId } from "@/src/domain/metering/plans";
import { roleHasPermission } from "@/src/domain/entities/Role";

/**
 * The one place paid entitlement changes.
 *
 * Everything about this service is arranged around a single rule: **the browser
 * is never a source of billing truth.** Concretely —
 *
 *  - A checkout request names a *plan* (`"pro"`), never a price. The price comes
 *    from server configuration, so a crafted request cannot substitute one.
 *  - The organization is re-resolved from the session's own memberships. An
 *    `organizationId` in the request body is a *filter*, not an assertion: it
 *    selects among the caller's orgs and cannot introduce one.
 *  - Creating a checkout session writes no plan and no status. Returning from
 *    Stripe with `?success=true` therefore changes nothing, because there is no
 *    code path from a redirect to this service.
 *  - The portal is opened with the customer id *we* stored. The request has no
 *    field for one.
 *  - Plan changes happen only in `handleWebhook`, after a signature check, and
 *    only for an organization resolved from a customer id we ourselves recorded.
 */

export interface BillingServiceDeps {
  billing: IBillingRepository;
  /** Null when the deployment has no payment provider configured. */
  provider: IBillingProvider | null;
  organizations: IOrganizationProvider;
  users: IUserProvider;
  audit: IAuditLogRepository;
  logger: ILogger;
  prices: BillingPriceMap;
  /** Absolute origin used to build return URLs. Never taken from the request. */
  siteUrl: string;
  /** Provider name recorded on new rows. */
  providerName?: string;
}

export interface CheckoutResult {
  /** Provider-hosted checkout URL. The only thing the client is given. */
  url: string;
  sessionId: string;
}

/**
 * What a pricing or account surface may know about the caller's Pro standing.
 *
 * Notice what is absent: no price id, no customer id, no subscription id, no
 * organization id. The surfaces need to know *which control to render* and *what
 * the price is*, and every identifier they could be handed is one a later
 * refactor could start sending back — so none is handed out. The `offer` is a
 * decision, not a capability: the endpoints re-authorize on every POST.
 */
export interface ProSummary {
  /** Whether this deployment can take money at all. */
  configured: boolean;
  signedIn: boolean;
  /** The plan currently entitled. `guest` for an anonymous caller. */
  plan: PlanId;
  /** Provider price for Pro, if one could be read. Null is a normal outcome. */
  price: DisplayPrice | null;
  offer: ProOffer;
}

export interface WebhookResult {
  /** True when this delivery changed stored billing state. */
  applied: boolean;
  /** Why nothing was applied — "duplicate", "ignored", "stale", "unmapped_price". */
  reason?: string;
  eventId: string;
  eventType: string;
}

/** The subscription-lifecycle events this slice acts on. Everything else is ignored. */
/**
 * Narrows a provider price to the display shape, dropping anything unusable.
 *
 * A price with no currency is not a price anyone can be shown, so it becomes
 * null here rather than reaching `formatPlanPrice` to be rejected there — one
 * fewer place that has to remember what an empty currency means.
 */
function toDisplayPrice(price: ProviderPrice | null): DisplayPrice | null {
  if (!price || !price.currency) return null;
  return {
    unitAmount: price.unitAmount,
    currency: price.currency,
    interval: price.interval,
    intervalCount: price.intervalCount,
  };
}

const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/**
 * How long a read price label is reused.
 *
 * A price is display data that changes when an operator changes it — minutes of
 * staleness is invisible, and the alternative is a provider round trip on every
 * pricing-page render, which turns a marketing page into an amplifier against
 * Stripe's rate limit. Short enough that fixing a misconfigured price does not
 * need a redeploy.
 */
const PRICE_CACHE_MS = 10 * 60 * 1000;

export class BillingService {
  private readonly providerName: string;
  /** Memoized display price, keyed by the price id it was read for. */
  private priceCache: { priceId: string; at: number; value: DisplayPrice | null } | null = null;

  constructor(private readonly deps: BillingServiceDeps) {
    this.providerName = deps.providerName ?? "stripe";
  }

  /**
   * Whether this deployment can actually sell Pro.
   *
   * Credentials alone are not enough. Without `prices.pro` every checkout POST
   * answers `PLAN_NOT_PURCHASABLE`, so a card that read this as "configured" would
   * render a purchase control the endpoint refuses — and `proOffer`'s own contract
   * for the flag is "key, webhook secret and a Pro price all present".
   */
  isConfigured(): boolean {
    return this.deps.provider !== null && !!this.deps.prices.pro;
  }

  /**
   * Creates a provider-hosted checkout session for a plan the caller may buy.
   *
   * Deliberately returns a URL and nothing else — no subscription, no plan, no
   * "pending Pro" flag. There is no state to write here, because a session that
   * was created is not a payment that was made, and any row written at this point
   * would be a claim about entitlement that the customer has not yet earned.
   */
  async startCheckout(input: {
    userId: string;
    /** Selects among the caller's own organizations. Omitted → their first. */
    organizationId?: string;
    plan: PurchasablePlanId;
    ip?: string | null;
  }): Promise<CheckoutResult> {
    const provider = this.requireProvider();
    // Resolved *before* the price, so an unauthorized caller learns nothing about
    // which plans a deployment sells.
    const organizationId = await this.requireBillingAuthority(input.userId, input.organizationId);
    const priceId = priceIdForPlan(this.deps.prices, input.plan);

    const customerId = await this.ensureCustomer(organizationId, input.userId);

    const session = await provider.createCheckoutSession({
      customerId,
      priceId,
      organizationId,
      // Built from configured origin + fixed paths. No request-supplied URL and no
      // request-supplied path, so there is no redirect for a caller to poison.
      successUrl: this.returnUrl("/pricing?checkout=success"),
      cancelUrl: this.returnUrl("/pricing?checkout=cancelled"),
    });

    await this.tryAudit({
      actorType: "user",
      actorId: input.userId,
      organizationId,
      action: "billing.checkout.created",
      resourceType: "billing_subscription",
      resourceId: customerId,
      // Records the plan requested, NOT a plan granted. The distinction is the
      // point of this whole method.
      metadata: { plan: input.plan, sessionId: session.id, grantedPlan: null },
      ip: input.ip ?? null,
    });

    return { url: session.url, sessionId: session.id };
  }

  /**
   * Opens the provider's billing portal for the caller's own organization.
   *
   * The customer id is read from our row. A caller with no stored customer gets a
   * clear failure rather than a portal for someone else's account — there is no
   * input to this method that could name a customer.
   */
  async createPortalSession(input: {
    userId: string;
    /** Selects among the caller's own organizations. Omitted → their first. */
    organizationId?: string;
    ip?: string | null;
  }): Promise<{ url: string }> {
    const provider = this.requireProvider();
    const organizationId = await this.requireBillingAuthority(input.userId, input.organizationId);

    const record = await this.deps.billing.getByOrganization(organizationId);
    if (!record?.providerCustomerId) {
      throw new BillingError(
        "NO_BILLING_CUSTOMER",
        "This organization has no billing account yet. Start a subscription first.",
      );
    }

    const session = await provider.createPortalSession({
      customerId: record.providerCustomerId,
      returnUrl: this.returnUrl("/pricing"),
    });

    await this.tryAudit({
      actorType: "user",
      actorId: input.userId,
      organizationId,
      action: "billing.portal.created",
      resourceType: "billing_subscription",
      resourceId: record.providerCustomerId,
      ip: input.ip ?? null,
    });

    return session;
  }

  /**
   * The trusted entitlement path.
   *
   * Order of operations is the security design, and each step is a refusal:
   *
   *  1. **Verify the signature** on the raw bytes. An unsigned body is never
   *     parsed, so an attacker cannot get as far as being ignored for the wrong
   *     reason.
   *  2. **Ignore untargeted types** before claiming, so the idempotency table only
   *     holds events that were acted upon.
   *  3. **Claim the event id.** A duplicate delivery stops here, having done
   *     nothing. Released again if step 5 throws, so a failed write does not
   *     strand the event.
   *  4. **Resolve the organization from the customer id we stored.** Not from
   *     `metadata.organizationId` — that is attacker-influencable at checkout and
   *     is only cross-checked, never trusted.
   *  5. **Drop stale events**, then write.
   */
  async handleWebhook(input: {
    rawBody: string;
    signature: string | null;
    now?: Date;
  }): Promise<WebhookResult> {
    const provider = this.requireProvider();
    const now = input.now ?? new Date();

    // Throws BillingError("INVALID_SIGNATURE") — the route maps it to 400 and
    // nothing below has run.
    const event = provider.parseWebhook(input.rawBody, input.signature, now);

    if (!HANDLED_EVENT_TYPES.has(event.type)) {
      return { applied: false, reason: "ignored", eventId: event.id, eventType: event.type };
    }

    const claimed = await this.deps.billing.claimEvent(event.id, event.type, now);
    if (!claimed) {
      this.deps.logger.info("Duplicate billing webhook ignored", {
        eventId: event.id,
        type: event.type,
      });
      return { applied: false, reason: "duplicate", eventId: event.id, eventType: event.type };
    }

    try {
      return await this.applyEvent(event, provider);
    } catch (err) {
      // The claim is released so the provider's retry can try again; without this
      // a transient database failure would permanently skip the event. A release
      // that itself fails must not replace the original error — that one says what
      // actually went wrong, and this one only says the retry will be seen as a
      // duplicate, which is worth a log rather than a substitution.
      try {
        await this.deps.billing.releaseEvent(event.id);
      } catch (releaseErr) {
        this.deps.logger.error("Billing webhook claim could not be released; its retry will be skipped", {
          eventId: event.id,
          error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        });
      }
      throw err;
    }
  }

  /** The plan an organization's billing state currently entitles. */
  async planFor(organizationId: string, now: Date = new Date()): Promise<PlanId> {
    const record = await this.deps.billing.getByOrganization(organizationId);
    return entitledPlanFor(record, now);
  }

  /**
   * What a pricing or account surface should render for this caller.
   *
   * Read-only, and read-only in a way that matters: it resolves the same
   * organization and the same `billing:manage` permission the POST endpoints do,
   * through the same helper, so the control a user is shown and the request the
   * server will accept cannot disagree. What it does NOT do is authorize anything
   * — the endpoints re-check on every POST, because a summary is a hint about the
   * past and a POST is an action in the present.
   *
   * Anonymous callers are answered, not refused. The pricing page is public and a
   * visitor needs to see the price; 401ing here would mean the public page could
   * not render its own product. Nothing in the response is per-account for an
   * anonymous caller — `guest`, and the offer says "sign in".
   *
   * Every failure degrades rather than throws. A pricing page that 500s because an
   * organization lookup timed out is a worse outcome than one that shows the
   * approved "not yet available" copy, and the copy is never wrong — only less
   * useful.
   */
  async proSummary(input: {
    /** From the validated session. Null for an anonymous visitor. */
    userId: string | null;
    /** Selects among the caller's own organizations. Never introduces one. */
    organizationId?: string;
    now?: Date;
  }): Promise<ProSummary> {
    const configured = this.isConfigured();
    const price = configured ? await this.proDisplayPrice() : null;

    if (!input.userId) {
      return {
        configured,
        signedIn: false,
        plan: GUEST_PLAN_ID,
        price,
        offer: proOffer({
          configured,
          signedIn: false,
          canManageBilling: false,
          plan: GUEST_PLAN_ID,
          hasBillingAccount: false,
        }),
      };
    }

    let plan: PlanId = DEFAULT_PLAN_ID;
    let canManageBilling = false;
    let hasBillingAccount = false;
    try {
      const context = await this.resolveBillingContext(input.userId, input.organizationId);
      if (context) {
        const record = await this.deps.billing.getByOrganization(context.organizationId);
        // Committed only after BOTH reads succeed. Assigning the permission first
        // would leave a failed billing read looking like "owner, plan free" — an
        // offered checkout for an organization that may already be paying, which is
        // the one degraded outcome that costs someone money.
        canManageBilling = context.canManageBilling;
        hasBillingAccount = !!record?.providerCustomerId;
        // The same expiry-aware read `/api/usage` resolves through, so a card
        // cannot claim Pro after the paid-through instant has passed.
        plan = entitledPlanFor(record, input.now ?? new Date());
      }
    } catch (err) {
      // Membership or billing read failed. `free` and no permission is the
      // fail-safe direction: the worst outcome is an owner briefly shown "ask your
      // owner", which their next reload corrects.
      this.deps.logger.warn("Billing summary degraded", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      configured,
      signedIn: true,
      plan,
      price,
      offer: proOffer({ configured, signedIn: true, canManageBilling, plan, hasBillingAccount }),
    };
  }

  // ---- internals ------------------------------------------------------------

  private async applyEvent(
    event: ProviderEvent,
    provider: IBillingProvider,
  ): Promise<WebhookResult> {
    const record = await this.resolveOwner(event);
    if (!record) {
      // An event naming a customer we have never stored. Refused rather than
      // reconciled: creating a row here would let a forged (or genuinely
      // misrouted) event mint billing state for a tenant that never opened
      // checkout. Stripe's retries stop mattering because the answer will not
      // change, so this is logged for an operator rather than raised.
      this.deps.logger.warn("Billing webhook for an unknown customer was refused", {
        eventId: event.id,
        type: event.type,
        customerId: event.customerId,
      });
      return { applied: false, reason: "unknown_customer", eventId: event.id, eventType: event.type };
    }

    if (!isNewerEvent(event.createdAt, record.lastEventAt)) {
      // Out-of-order delivery. Applying it would replace newer state with older —
      // a cancellation delayed behind a reactivation is the case that matters.
      this.deps.logger.info("Stale billing webhook dropped", {
        eventId: event.id,
        type: event.type,
        eventAt: event.createdAt.toISOString(),
        storedAt: record.lastEventAt?.toISOString() ?? null,
      });
      return { applied: false, reason: "stale", eventId: event.id, eventType: event.type };
    }

    const subscription = await this.subscriptionFor(event, provider);
    if (!subscription) {
      // `checkout.session.completed` for a non-subscription purchase, or an event
      // whose subscription reference we could not resolve. Nothing to write.
      return {
        applied: false,
        reason: "no_subscription",
        eventId: event.id,
        eventType: event.type,
      };
    }

    // Cross-check, not a source. The hint is only ever used to detect that
    // something is wrong; it never selects the organization.
    if (event.organizationIdHint && event.organizationIdHint !== record.organizationId) {
      this.deps.logger.error("Billing webhook metadata names a different organization than its customer", {
        eventId: event.id,
        hinted: event.organizationIdHint,
        resolved: record.organizationId,
      });
      return {
        applied: false,
        reason: "ownership_mismatch",
        eventId: event.id,
        eventType: event.type,
      };
    }

    const status = toSubscriptionStatus(subscription.status);
    const mappedPlan = planForPriceId(this.deps.prices, subscription.priceId);

    // An unrecognized price stores `free`: the subscription is real and its state
    // is worth recording, but a price this deployment cannot map must not grant a
    // paid plan. The price id is stored alongside, so fixing the configuration
    // later is a resync rather than an archaeology exercise.
    const planId: PlanId = mappedPlan ?? DEFAULT_PLAN_ID;
    if (!mappedPlan && subscription.priceId) {
      this.deps.logger.error("Billing webhook carried an unmapped price; no paid plan granted", {
        eventId: event.id,
        priceId: subscription.priceId,
        organizationId: record.organizationId,
      });
    }

    // `deleted` is authoritative regardless of the status Stripe put on the
    // object: the subscription is gone, so entitlement goes with it.
    const isDeletion = event.type === "customer.subscription.deleted";

    await this.deps.billing.saveProviderState({
      organizationId: record.organizationId,
      providerSubscriptionId: subscription.id,
      providerPriceId: subscription.priceId,
      status: isDeletion ? "canceled" : status,
      planId: isDeletion ? DEFAULT_PLAN_ID : planId,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: isDeletion ? false : subscription.cancelAtPeriodEnd,
      lastEventAt: event.createdAt,
    });

    await this.tryAudit({
      actorType: "system",
      actorId: null,
      organizationId: record.organizationId,
      action: "billing.subscription.synced",
      resourceType: "billing_subscription",
      resourceId: subscription.id,
      metadata: {
        eventId: event.id,
        eventType: event.type,
        status: isDeletion ? "canceled" : status,
        planId: isDeletion ? DEFAULT_PLAN_ID : planId,
        priceId: subscription.priceId,
        unmappedPrice: !mappedPlan && subscription.priceId ? subscription.priceId : null,
      },
    });

    return {
      applied: true,
      reason: !mappedPlan && subscription.priceId ? "unmapped_price" : undefined,
      eventId: event.id,
      eventType: event.type,
    };
  }

  /**
   * Which organization an event belongs to.
   *
   * Customer id first, subscription id second, and nothing else. Both are values
   * *we* wrote — the customer at checkout, the subscription at the first webhook —
   * which is what makes them authorization facts rather than assertions from the
   * request.
   */
  private async resolveOwner(event: ProviderEvent): Promise<BillingSubscriptionRecord | null> {
    if (event.customerId) {
      const byCustomer = await this.deps.billing.getByCustomerId(event.customerId);
      if (byCustomer) return byCustomer;
    }
    if (event.subscriptionId) {
      const bySubscription = await this.deps.billing.getBySubscriptionId(event.subscriptionId);
      if (bySubscription) return bySubscription;
    }
    return null;
  }

  /**
   * The subscription an event is about.
   *
   * Subscription events embed it. `checkout.session.completed` does not, so the
   * provider is asked — which is also a second, independent read of the truth for
   * the one event type that arrives at the same moment as a user's redirect.
   */
  private async subscriptionFor(
    event: ProviderEvent,
    provider: IBillingProvider,
  ): Promise<ProviderSubscription | null> {
    if (event.subscription) return event.subscription;
    if (!event.subscriptionId) return null;
    return provider.getSubscription(event.subscriptionId);
  }

  /**
   * Confirms the caller may manage billing for the organization, and returns the
   * organization id resolved from *their own* membership list.
   *
   * The returned id is used from here on, so even a caller who guessed a valid
   * organization id cannot have it applied — the value that leaves this method
   * came from the database keyed by their user id.
   *
   * `billing:manage` already exists in `ROLE_PERMISSIONS` and is owner-only, so
   * this reuses the product's existing answer to "who may spend money" instead of
   * inventing a second one.
   */
  private async requireBillingAuthority(
    userId: string,
    requestedOrganizationId: string | undefined,
  ): Promise<string> {
    const context = await this.resolveBillingContext(userId, requestedOrganizationId);
    if (!context) {
      throw new BillingError(
        "FORBIDDEN",
        "Billing is not available for this organization.",
      );
    }
    if (!context.canManageBilling) {
      throw new BillingError(
        "FORBIDDEN",
        "Only an organization owner can manage billing.",
      );
    }
    return context.organizationId;
  }

  /**
   * Resolves the caller's organization and whether they may manage its billing.
   *
   * The one place that answers both questions, so the read path (`proSummary`,
   * which decides what button to render) and the write path
   * (`requireBillingAuthority`, which decides what to accept) cannot drift apart.
   * A UI that offered "Upgrade to Pro" to somebody the endpoint then refuses is
   * exactly the drift a second copy of this logic produces.
   *
   * Returns null rather than throwing when there is no organization, because the
   * read path treats that as "nothing to offer" and only the write path treats it
   * as a refusal — the distinction belongs to the caller.
   */
  private async resolveBillingContext(
    userId: string,
    requestedOrganizationId: string | undefined,
  ): Promise<{ organizationId: string; canManageBilling: boolean } | null> {
    const orgs = await this.deps.organizations.listForUser(userId);
    // An absent id defaults to the caller's first organization, matching how the
    // Workspace routes resolve a default tenant. A *present* id is only ever used
    // to `find` within this list — it can narrow the caller's own set and can
    // never add to it, which is why a guessed id from a request body is inert.
    const org = requestedOrganizationId
      ? orgs.find((candidate) => candidate.id === requestedOrganizationId)
      : orgs[0];
    if (!org) return null;

    const membership = await this.deps.organizations.getMembership(org.id, userId);
    return {
      organizationId: org.id,
      // `billing:manage` already exists in `ROLE_PERMISSIONS` and is owner-only, so
      // this reuses the product's existing answer to "who may spend money" instead
      // of inventing a second one.
      canManageBilling: !!membership && roleHasPermission(membership.role, "billing:manage"),
    };
  }

  /**
   * The configured Pro price, for display, memoized.
   *
   * Null on every uncertain path — no provider, no configured price, a provider
   * that could not answer. The consumer renders the approved pricing copy in that
   * case, so a failure here costs a number on a card and never a fabricated one.
   *
   * The cache is keyed by price id so an operator changing `STRIPE_PRICE_PRO` and
   * restarting does not serve the old amount, and negatives are cached too: a
   * misconfigured price id must not mean a Stripe round trip per page view.
   *
   * ponytail: in-process, like the rate limiters. Behind several instances each
   * one reads once per window, which is still a per-deployment constant.
   */
  private async proDisplayPrice(now: number = Date.now()): Promise<DisplayPrice | null> {
    const priceId = this.deps.prices.pro;
    if (!priceId || !this.deps.provider) return null;

    const cached = this.priceCache;
    if (cached && cached.priceId === priceId && now - cached.at < PRICE_CACHE_MS) {
      return cached.value;
    }

    let value: DisplayPrice | null = null;
    try {
      value = toDisplayPrice(await this.deps.provider.getPrice(priceId));
    } catch (err) {
      // `getPrice` is specified to return null rather than throw; this catch is
      // for an adapter that does not honour that, so one bad provider cannot take
      // the pricing page down with it.
      this.deps.logger.warn("Pro price could not be read for display", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.priceCache = { priceId, at: now, value };
    return value;
  }

  /**
   * Returns the stored provider customer, creating one only if there is none.
   *
   * The stored row is checked first so repeated checkout attempts reuse one
   * customer: a second Stripe customer for the same organization would split its
   * payment history and, worse, make the customer id in a later webhook fail to
   * resolve to this org.
   */
  private async ensureCustomer(organizationId: string, userId: string): Promise<string> {
    const existing = await this.deps.billing.getByOrganization(organizationId);
    if (existing?.providerCustomerId) return existing.providerCustomerId;

    const provider = this.requireProvider();
    const user = await this.deps.users.getById(userId);
    const customerId = await provider.createCustomer({
      organizationId,
      userId,
      email: user?.email ?? null,
    });

    // `linkCustomer` is an insert-if-absent, so two concurrent first checkouts
    // converge on whichever customer was stored first. The loser's Stripe customer
    // is orphaned but harmless — it has no subscription, and no webhook can
    // resolve it to an organization.
    const record = await this.deps.billing.linkCustomer({
      organizationId,
      provider: this.providerName,
      providerCustomerId: customerId,
    });
    return record.providerCustomerId;
  }

  private requireProvider(): IBillingProvider {
    if (!this.deps.provider) {
      throw new BillingError(
        "BILLING_NOT_CONFIGURED",
        "Billing is not configured in this deployment.",
      );
    }
    return this.deps.provider;
  }

  /** Absolute return URL from the configured origin. Never from a request. */
  private returnUrl(pathAndQuery: string): string {
    return new URL(pathAndQuery, this.deps.siteUrl).toString();
  }

  /**
   * Audit writes never fail the operation.
   *
   * A checkout that succeeded and an audit row that did not write is a reporting
   * gap; throwing here would instead turn it into a customer who paid and a
   * webhook that 500s. The log line is the fallback record.
   */
  private async tryAudit(entry: Parameters<IAuditLogRepository["record"]>[0]): Promise<void> {
    try {
      await this.deps.audit.record(entry);
    } catch (err) {
      this.deps.logger.warn("Billing audit write failed", {
        action: entry.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
