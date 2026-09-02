import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AuthService, USER_SESSION_COOKIE } from "./AuthService";
import { BillingService } from "./BillingService";
import { BillingError, type BillingErrorCode } from "@/src/domain/billing/subscription";
import { RateLimiter, clientIp } from "@/lib/server/rateLimit";
import type { User } from "@/src/domain/entities/User";

/**
 * Shared plumbing for `/api/billing/*`: session resolution, error shaping and
 * rate limits.
 *
 * Centralized for the same reason `authHttp.ts` is — so the rule that a billing
 * endpoint resolves its user from the HttpOnly session cookie and from nothing
 * else cannot be written three slightly different ways in three routes.
 *
 * The webhook route deliberately does NOT use `requireBillingUser`: Stripe has no
 * session and no Origin header, and its authentication is the payload signature.
 * That is why signature verification lives in the provider and is unconditional
 * there rather than being an optional middleware here.
 */

export function billingError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Maps a `BillingError` to a status.
 *
 * Two things it deliberately does not do: it never echoes a provider error body
 * (which can name prices, customers and account ids), and it never distinguishes
 * "you are not a member of that org" from "that org does not exist" — both are
 * one 403, so the endpoint is not an organization-id oracle.
 */
export function mapBillingError(err: unknown): NextResponse {
  if (err instanceof BillingError) {
    const status: Record<BillingErrorCode, number> = {
      // The deployment cannot take money. Not the caller's fault, and retrying
      // will not help until an operator configures it.
      BILLING_NOT_CONFIGURED: 503,
      PLAN_NOT_PURCHASABLE: 503,
      FORBIDDEN: 403,
      NO_BILLING_CUSTOMER: 409,
      // Upstream failed. 502 rather than 500 so an operator can tell a Stripe
      // outage from a bug in this app.
      PROVIDER_FAILED: 502,
      INVALID_SIGNATURE: 400,
    };
    return billingError(err.code, err.message, status[err.code] ?? 400);
  }
  return billingError("INTERNAL_ERROR", "Billing request failed.", 500);
}

/**
 * Resolves the caller, or returns the 401 response to send.
 *
 * Returns the whole `User` rather than an id because `startCheckout` needs the
 * email for the provider customer, and reading it here — from the session — is
 * what stops a request body from supplying one.
 */
export async function requireBillingUser(
  req: NextRequest,
): Promise<{ user: User } | { response: NextResponse }> {
  const user = await optionalBillingUser(req);
  if (!user) {
    return { response: billingError("UNAUTHORIZED", "Authentication is required.", 401) };
  }
  return { user };
}

/**
 * Resolves the caller, or null when there is no live session.
 *
 * For `GET /api/billing/summary`, which is anonymous-safe: the pricing page is
 * public and a visitor must be able to see the price. It is deliberately the same
 * resolution `requireBillingUser` performs — one lookup, so "a cookie is not
 * proof of a session, only a database lookup is" cannot hold on one billing
 * endpoint and not another.
 */
export async function optionalBillingUser(req: NextRequest): Promise<User | null> {
  const token = req.cookies.get(USER_SESSION_COOKIE)?.value;
  if (!token) return null;
  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);
  return auth.getMe(token);
}

export function billingService(): BillingService {
  return appContainer.resolve<BillingService>(Tokens.BillingService);
}

/**
 * Per-IP limit on session creation.
 *
 * Both endpoints create objects at Stripe, so an unbounded loop here is an
 * unbounded write to someone else's rate-limited API — and, for checkout, a
 * source of orphan customers. Tighter than the tool limits because no legitimate
 * user opens ten checkouts a minute.
 *
 * ponytail: in-process, like the auth limiters. Behind several instances the
 * effective limit multiplies; a shared limiter at the edge is still wanted.
 */
export const billingSessionRateLimiter = new RateLimiter({ windowMs: 60_000, max: 6 });

export function enforceBillingRateLimit(req: NextRequest): NextResponse | null {
  if (!billingSessionRateLimiter.hit(clientIp(req))) return null;
  return NextResponse.json(
    { error: { code: "RATE_LIMITED", message: "Too many billing requests. Try again shortly." } },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

/** Reads a small JSON body, tolerating an empty one. Both routes' bodies are optional. */
export async function readOptionalJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
  // Bounded before parsing: these bodies carry at most a plan name and an
  // organization id, so anything large is either a mistake or an attempt.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > 4096) return {};
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** A request-supplied organization id, or undefined. Validated by the service, not here. */
export function organizationIdFrom(body: Record<string, unknown>): string | undefined {
  const value = body.organizationId;
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}
