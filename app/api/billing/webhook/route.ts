import { type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { BillingService } from "@/src/application/services/BillingService";
import type { ILogger } from "@/src/application/ports/Logger";
import { BillingError } from "@/src/domain/billing/subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stripe events are small; anything larger is not one. */
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/**
 * POST /api/billing/webhook — the only route that can change paid entitlement.
 *
 * Unauthenticated by design and authenticated in fact: there is no session and no
 * CSRF check, because the request comes from Stripe, and its credential is the
 * HMAC signature over the exact bytes of the body. That is why this handler reads
 * `req.text()` and never `req.json()` — parsing first would compute the signature
 * over a re-serialized body, and a re-serialized body is a different body.
 *
 * ## Status codes are a retry protocol, not decoration
 *
 * Stripe retries any non-2xx for about three days, so what this returns decides
 * whether a failure heals itself:
 *
 *  - **400** for an invalid signature. Not retryable: the bytes will never verify,
 *    and a retry storm on a forged request is pure load.
 *  - **200** for accepted, duplicate, stale, ignored and unknown-customer. All are
 *    final answers. A duplicate has already been applied; a stale event must not
 *    be applied; an event for a customer we never stored will not become ours on
 *    the fourth attempt.
 *  - **500** only for an unexpected failure — a database that was briefly down.
 *    That IS retryable, and the event's claim has already been released, so the
 *    retry applies it for real.
 */
export async function POST(req: NextRequest) {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, { status: 413 });
  }

  let service: BillingService;
  let logger: ILogger;
  try {
    service = appContainer.resolve<BillingService>(Tokens.BillingService);
    logger = appContainer.resolve<ILogger>(Tokens.Logger);
  } catch {
    return Response.json({ error: { code: "BILLING_UNAVAILABLE" } }, { status: 503 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: { code: "INVALID_BODY" } }, { status: 400 });
  }
  if (new TextEncoder().encode(rawBody).length > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: { code: "PAYLOAD_TOO_LARGE" } }, { status: 413 });
  }

  try {
    const result = await service.handleWebhook({
      rawBody,
      signature: req.headers.get("stripe-signature"),
    });
    // `received: true` is what Stripe wants; `applied`/`reason` are for our own
    // logs and for the operator reading a delivery in the Stripe dashboard.
    return Response.json({ received: true, applied: result.applied, reason: result.reason ?? null });
  } catch (err) {
    if (err instanceof BillingError && err.code === "INVALID_SIGNATURE") {
      // No body detail in the response and no body content in the log: an
      // unverified payload is attacker-controlled, and logging it verbatim moves
      // the injection into whatever reads the logs.
      logger.warn("Rejected billing webhook with an invalid signature", {
        reason: err.message,
      });
      return Response.json({ error: { code: "INVALID_SIGNATURE" } }, { status: 400 });
    }
    if (err instanceof BillingError && err.code === "BILLING_NOT_CONFIGURED") {
      return Response.json({ error: { code: "BILLING_NOT_CONFIGURED" } }, { status: 503 });
    }
    logger.error("Billing webhook processing failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // 500 so Stripe retries. The event claim was released, so the retry will do
    // the work rather than skip it as a duplicate.
    return Response.json({ error: { code: "WEBHOOK_FAILED" } }, { status: 500 });
  }
}
