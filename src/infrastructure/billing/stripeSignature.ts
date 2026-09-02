import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingError } from "@/src/domain/billing/subscription";

/**
 * Stripe webhook signature verification.
 *
 * Kept as a standalone pure function, separate from the HTTP adapter, for one
 * reason: this is the single check standing between an anonymous internet request
 * and a plan upgrade, and it has to be testable directly — signature present but
 * wrong, timestamp outside tolerance, header malformed, body altered by a byte —
 * without a network, a server or a Stripe account.
 *
 * The scheme (documented by Stripe): the `Stripe-Signature` header carries
 * `t=<unix seconds>` and one or more `v1=<hex hmac>` values. The signed payload is
 * `${t}.${rawBody}` and the MAC is HMAC-SHA256 under the endpoint secret. The
 * timestamp is inside the MAC, which is what makes the tolerance check meaningful:
 * an attacker cannot move `t` without invalidating the signature, so a captured
 * request cannot be replayed past the window.
 *
 * Implemented against the documented scheme rather than the `stripe` SDK because
 * that is ~40 lines of `node:crypto` versus a dependency, and because a fake in a
 * test only has to sign a string.
 */

/** Stripe's own default replay window. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === "t") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) timestamp = seconds;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Constant-time comparison that also survives a length mismatch.
 *
 * `timingSafeEqual` throws when the buffers differ in length, and letting that
 * throw would turn "wrong length" into a distinguishable failure — a weak but
 * real oracle. Length is checked first and returns the same `false` as a content
 * mismatch.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function signStripePayload(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  return createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

/** Builds a header in Stripe's format. Used by the adapter's tests and fakes. */
export function stripeSignatureHeader(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  return `t=${timestampSeconds},v1=${signStripePayload(rawBody, secret, timestampSeconds)}`;
}

/**
 * Throws `BillingError("INVALID_SIGNATURE")` unless the body is authentic and
 * within tolerance. Returns nothing on success — there is no partial result and
 * no "probably fine" path, because a caller that received a value could be
 * tempted to use it after a soft failure.
 */
export function verifyStripeSignature(input: {
  rawBody: string;
  header: string | null | undefined;
  secret: string | null;
  now: Date;
  toleranceSeconds?: number;
}): void {
  const { rawBody, header, secret, now } = input;
  const tolerance = input.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;

  if (!secret) {
    // A missing secret must not degrade into "accept everything". It is a
    // configuration failure, and the endpoint has to refuse until it is fixed.
    throw new BillingError("INVALID_SIGNATURE", "Webhook signing secret is not configured.");
  }
  if (!header) {
    throw new BillingError("INVALID_SIGNATURE", "Missing webhook signature.");
  }

  const parsed = parseHeader(header);
  if (!parsed) {
    throw new BillingError("INVALID_SIGNATURE", "Malformed webhook signature header.");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  // Absolute difference, so a far-future timestamp is rejected too. A one-sided
  // check would accept a signature dated next year, which never expires.
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    throw new BillingError("INVALID_SIGNATURE", "Webhook signature timestamp is outside the tolerance window.");
  }

  const expected = signStripePayload(rawBody, secret, parsed.timestamp);
  for (const candidate of parsed.signatures) {
    if (safeEqualHex(candidate, expected)) return;
  }
  throw new BillingError("INVALID_SIGNATURE", "Webhook signature verification failed.");
}
