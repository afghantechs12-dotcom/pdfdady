/**
 * The payment-provider port.
 *
 * Narrow on purpose: five methods, exactly what this slice needs. Every type
 * crossing this boundary is provider-neutral — no Stripe SDK type appears in the
 * application or domain layers, so the adapter can be replaced (or faked in a
 * test) without a single import changing upstream.
 *
 * Note what is absent: nothing here decides entitlement, maps a price to a plan,
 * or authorizes anybody. The adapter's whole job is to talk to the provider and
 * hand back plain data; `BillingService` and `src/domain/billing` own every
 * decision made about that data.
 */

/** A subscription as the provider reports it, flattened to what we store. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  /** Raw provider status string; the domain coerces it. Never trusted verbatim. */
  status: string;
  /** The price the subscription is billed on; mapped to a plan by server config. */
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * A price as the provider reports it, reduced to what a label needs.
 *
 * Read for DISPLAY only. Checkout still resolves its price id from server
 * configuration (`priceIdForPlan`), so nothing here participates in what is
 * charged — this exists so a page can show the amount Stripe will actually bill
 * instead of a number typed into the repo.
 */
export interface ProviderPrice {
  id: string;
  /** Smallest currency unit. Null for a price with no simple unit amount. */
  unitAmount: number | null;
  currency: string;
  interval: "day" | "week" | "month" | "year" | null;
  intervalCount: number;
}

/** A signature-verified provider event, reduced to the fields we act on. */
export interface ProviderEvent {
  /** Provider event id — the idempotency key. */
  id: string;
  type: string;
  /** The provider's own creation instant. The ordering key for stale-event drops. */
  createdAt: Date;
  /** Present when the event payload carried a full subscription object. */
  subscription: ProviderSubscription | null;
  /** Present when the event names a subscription but did not embed it. */
  subscriptionId: string | null;
  /** Present when the event names a customer (checkout completion, for example). */
  customerId: string | null;
  /** `metadata.organizationId` if the payload carried one. Never trusted alone. */
  organizationIdHint: string | null;
}

export interface CreateCheckoutSessionInput {
  customerId: string;
  /** Resolved server-side from the plan. Never supplied by a client. */
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  /** Correlation only — ownership is re-resolved from the customer on webhook. */
  organizationId: string;
}

export interface IBillingProvider {
  /**
   * Creates a provider customer. Reuse is the caller's job: `BillingService`
   * checks for a stored customer id first, so this is only reached once per org.
   */
  createCustomer(input: {
    organizationId: string;
    userId: string;
    email: string | null;
  }): Promise<string>;

  createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<{ id: string; url: string }>;

  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;

  /**
   * Verifies the signature and parses the payload. MUST throw when the signature
   * is absent, malformed, mismatched, or outside the replay tolerance — the
   * caller treats a throw as "reject the request" and never inspects the body
   * first.
   */
  parseWebhook(rawBody: string, signatureHeader: string | null, now: Date): ProviderEvent;

  /** Fetches current state, for events that name a subscription without embedding it. */
  getSubscription(subscriptionId: string): Promise<ProviderSubscription | null>;

  /**
   * Fetches a price, for display. Returns null when the provider does not
   * recognize it — a missing price must degrade a label, never fail a page.
   */
  getPrice(priceId: string): Promise<ProviderPrice | null>;
}
