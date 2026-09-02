import type {
  CreateCheckoutSessionInput,
  IBillingProvider,
  ProviderEvent,
  ProviderPrice,
  ProviderSubscription,
} from "@/src/application/ports/billing/BillingProvider";
import { BillingError } from "@/src/domain/billing/subscription";
import { verifyStripeSignature } from "./stripeSignature";

/**
 * Stripe adapter over the REST API, using `fetch` and `node:crypto`.
 *
 * No `stripe` SDK. The four calls this slice needs are form-encoded POSTs and one
 * GET, and signature verification is a documented HMAC — so the SDK would buy a
 * dependency, a bundled type surface leaking toward the application layer, and a
 * mock to write, in exchange for nothing this file does not already do in a page.
 *
 * ponytail: hand-rolled request layer with no retry and no pagination. Everything
 * here is a single-object call, so there is nothing to page; if a transient 5xx
 * from Stripe becomes a real problem, wrap `request` in a bounded retry rather
 * than adopting the SDK for it. Webhook delivery is already retried by Stripe.
 *
 * Shapes are read defensively (`asRecord`, `asString`) rather than cast. This is
 * a network boundary: a field that moved between API versions must surface as a
 * null we handle, not as a `TypeError` inside a webhook that Stripe then retries
 * for three days.
 */

const STRIPE_API_BASE = "https://api.stripe.com";

/** Pinned so a Stripe-side default-version change cannot silently reshape payloads. */
const STRIPE_API_VERSION = "2025-04-30.basil";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Stripe sends unix seconds; absent or non-numeric becomes null, never epoch 0. */
function asDate(value: unknown): Date | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1000);
}

/**
 * A Stripe field that is either an id string or an expanded object.
 *
 * Both forms appear depending on the endpoint and on expansion, so every
 * reference is read through this rather than assumed to be one or the other.
 */
function idOf(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct;
  const expanded = asRecord(value);
  return expanded ? asString(expanded.id) : null;
}

/**
 * Flattens a Stripe subscription.
 *
 * `current_period_end` moved from the subscription onto its items in the
 * 2025-03-31 API version. Both locations are read, newest-first, because a
 * deployment pinned to either version must produce a paid-through date — and a
 * null date here means `entitledPlanFor` cannot expire a stale subscription,
 * which is the one guard that survives a lost webhook.
 */
function toProviderSubscription(object: Record<string, unknown>): ProviderSubscription | null {
  const id = asString(object.id);
  const customerId = idOf(object.customer);
  if (!id || !customerId) return null;

  const items = asRecord(object.items);
  const firstItem = Array.isArray(items?.data) ? asRecord(items.data[0]) : null;
  const price = firstItem ? asRecord(firstItem.price) : null;

  return {
    id,
    customerId,
    status: asString(object.status) ?? "",
    priceId: price ? asString(price.id) : null,
    currentPeriodEnd:
      asDate(object.current_period_end) ??
      (firstItem ? asDate(firstItem.current_period_end) : null),
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
  };
}

function metadataOrganizationId(object: Record<string, unknown>): string | null {
  const metadata = asRecord(object.metadata);
  return metadata ? asString(metadata.organizationId) : null;
}

export interface StripeBillingProviderOptions {
  secretKey: string;
  webhookSecret: string;
  /** Overridden only by tests, to avoid reaching the real API. */
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

export class StripeBillingProvider implements IBillingProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(private readonly options: StripeBillingProviderOptions) {
    if (!options.secretKey) {
      throw new BillingError("BILLING_NOT_CONFIGURED", "Stripe secret key is missing.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = options.apiBase ?? STRIPE_API_BASE;
  }

  /**
   * One HTTP path for every call.
   *
   * Stripe's error body is deliberately NOT forwarded to the caller's response —
   * it is logged shape-checked and replaced by a generic message upstream. A
   * provider error string can name a price, a customer or an account, and none of
   * that belongs in a response to a browser.
   */
  private async request(
    path: string,
    init: { method: "GET" | "POST"; form?: URLSearchParams },
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          "Stripe-Version": STRIPE_API_VERSION,
          ...(init.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: init.form ? init.form.toString() : undefined,
      });
    } catch (err) {
      throw new BillingError(
        "PROVIDER_FAILED",
        `Stripe request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = await response.text();
    const parsed = ((): Record<string, unknown> | null => {
      try {
        return asRecord(JSON.parse(text));
      } catch {
        return null;
      }
    })();

    if (!response.ok) {
      const error = parsed ? asRecord(parsed.error) : null;
      const message = error ? asString(error.message) : null;
      throw new BillingError(
        "PROVIDER_FAILED",
        `Stripe returned ${response.status}${message ? `: ${message}` : ""}`,
      );
    }
    if (!parsed) {
      throw new BillingError("PROVIDER_FAILED", "Stripe returned an unreadable response body.");
    }
    return parsed;
  }

  async createCustomer(input: {
    organizationId: string;
    userId: string;
    email: string | null;
  }): Promise<string> {
    const form = new URLSearchParams();
    if (input.email) form.set("email", input.email);
    // Correlation for the Stripe dashboard. Never read back as an authorization
    // fact: ownership is resolved from our own customer-id column.
    form.set("metadata[organizationId]", input.organizationId);
    form.set("metadata[createdByUserId]", input.userId);

    const customer = await this.request("/v1/customers", { method: "POST", form });
    const id = asString(customer.id);
    if (!id) throw new BillingError("PROVIDER_FAILED", "Stripe customer response had no id.");
    return id;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput,
  ): Promise<{ id: string; url: string }> {
    const form = new URLSearchParams();
    form.set("mode", "subscription");
    form.set("customer", input.customerId);
    form.set("line_items[0][price]", input.priceId);
    form.set("line_items[0][quantity]", "1");
    form.set("success_url", input.successUrl);
    form.set("cancel_url", input.cancelUrl);
    form.set("client_reference_id", input.organizationId);
    form.set("metadata[organizationId]", input.organizationId);
    // Stripe copies this onto the subscription it creates, which is what lets a
    // `subscription.created` event be traced back to an org in the dashboard.
    form.set("subscription_data[metadata][organizationId]", input.organizationId);

    const session = await this.request("/v1/checkout/sessions", { method: "POST", form });
    const id = asString(session.id);
    const url = asString(session.url);
    if (!id || !url) {
      throw new BillingError("PROVIDER_FAILED", "Stripe checkout session had no id or url.");
    }
    return { id, url };
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const form = new URLSearchParams();
    form.set("customer", input.customerId);
    form.set("return_url", input.returnUrl);
    const session = await this.request("/v1/billing_portal/sessions", { method: "POST", form });
    const url = asString(session.url);
    if (!url) throw new BillingError("PROVIDER_FAILED", "Stripe portal session had no url.");
    return { url };
  }

  /**
   * Verifies first, parses second.
   *
   * The order is the security property: `verifyStripeSignature` runs against the
   * raw string before `JSON.parse` sees it, so an unauthenticated body is never
   * interpreted at all — not even far enough to read its `type`.
   */
  parseWebhook(rawBody: string, signatureHeader: string | null, now: Date): ProviderEvent {
    verifyStripeSignature({
      rawBody,
      header: signatureHeader,
      secret: this.options.webhookSecret,
      now,
    });

    let payload: Record<string, unknown> | null;
    try {
      payload = asRecord(JSON.parse(rawBody));
    } catch {
      throw new BillingError("PROVIDER_FAILED", "Webhook body is not valid JSON.");
    }
    if (!payload) throw new BillingError("PROVIDER_FAILED", "Webhook body is not an object.");

    const id = asString(payload.id);
    const type = asString(payload.type);
    const createdAt = asDate(payload.created);
    if (!id || !type || !createdAt) {
      // No id means no idempotency key and no `created` means no ordering key.
      // Either absence makes the event unsafe to apply, so it is refused rather
      // than applied with a substituted value.
      throw new BillingError("PROVIDER_FAILED", "Webhook event is missing id, type or created.");
    }

    const data = asRecord(payload.data);
    const object = data ? asRecord(data.object) : null;
    if (!object) return { id, type, createdAt, subscription: null, subscriptionId: null, customerId: null, organizationIdHint: null };

    // A subscription event embeds the subscription; a checkout session references
    // one. Both are reduced to the same three references so the service does not
    // branch on event shape.
    const isSubscriptionObject = asString(object.object) === "subscription";
    const subscription = isSubscriptionObject ? toProviderSubscription(object) : null;

    return {
      id,
      type,
      createdAt,
      subscription,
      subscriptionId: subscription?.id ?? idOf(object.subscription),
      customerId: subscription?.customerId ?? idOf(object.customer),
      organizationIdHint: metadataOrganizationId(object),
    };
  }

  /**
   * Reads a price for display.
   *
   * A 404 (or any provider failure) becomes `null` rather than a throw: the only
   * consumer is a price label, and a pricing page that 500s because Stripe was
   * briefly unreachable is a worse outcome than a card that falls back to its
   * approved copy. `recurring` is read defensively — a one-off price has none, and
   * `unit_amount` is null on tiered prices, which is why the caller must be able
   * to render without an amount.
   */
  async getPrice(priceId: string): Promise<ProviderPrice | null> {
    let object: Record<string, unknown>;
    try {
      object = await this.request(`/v1/prices/${encodeURIComponent(priceId)}`, { method: "GET" });
    } catch {
      return null;
    }
    const id = asString(object.id);
    if (!id) return null;
    const recurring = asRecord(object.recurring);
    const interval = recurring ? asString(recurring.interval) : null;
    const count = recurring?.interval_count;
    return {
      id,
      unitAmount:
        typeof object.unit_amount === "number" && Number.isFinite(object.unit_amount)
          ? object.unit_amount
          : null,
      currency: asString(object.currency) ?? "",
      interval:
        interval === "day" || interval === "week" || interval === "month" || interval === "year"
          ? interval
          : null,
      intervalCount: typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 1,
    };
  }

  async getSubscription(subscriptionId: string): Promise<ProviderSubscription | null> {
    const object = await this.request(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: "GET" },
    );
    return toProviderSubscription(object);
  }
}
