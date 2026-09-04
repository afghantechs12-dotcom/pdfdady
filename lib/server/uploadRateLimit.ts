/**
 * Pre-parse abuse control for the multipart upload routes.
 *
 * ONE module, not one counter per route. The three Workspace upload routes all
 * ask the same question — "may this caller ask us to parse another body?" — and
 * they share the buckets, so a caller that exhausts its budget on
 * `documents/upload` is refused on `attachments` too. Per-route counters would
 * multiply every budget by the number of routes and would grow a new hole every
 * time a route is added.
 *
 * IDENTITY, and why it is shaped like this:
 *
 * Next 16 exposes no peer socket address to a route handler, so the only client
 * identity available pre-auth is a header the client itself can write. Reading
 * `X-Forwarded-For` unconditionally would therefore hand every caller a rotating
 * limit key — a limiter you can escape by incrementing a header is not a limiter.
 * So:
 *
 *  - authenticated  -> keyed by user id. Resolved server-side from the session
 *    cookie; a caller cannot forge one, and it survives any topology.
 *  - trusted proxy  -> keyed by the forwarded client address, but ONLY when the
 *    request presents the shared secret in `x-pdfdadi-proxy-secret`. A request
 *    without the secret is keyed as untrusted no matter what forwarding headers
 *    it carries, so spoofing them changes nothing.
 *  - anything else  -> one global bucket. Coarse on purpose: rotation cannot
 *    escape a bucket that has no per-caller key to rotate. Nothing legitimate
 *    reaches a PRIVATE upload route unauthenticated, so this bounds the cost of
 *    refusing traffic rather than the cost of serving it.
 *
 * @see UploadGuardConfig in src/infrastructure/config/env.ts for the defaults and
 * the operational reason for each.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { getConfig } from "@/src/infrastructure/config/env";

import { RateLimiter } from "./rateLimit";

/** Header a trusted reverse proxy must send for its forwarding headers to count. */
export const PROXY_SECRET_HEADER = "x-pdfdadi-proxy-secret";

const WINDOW_MS = 60_000;

/** Which bucket refused. Deliberately carries no key — safe to log. */
export type UploadLimitBucket = "user" | "client" | "global" | "unavailable";

export interface UploadLimitDecision {
  limited: boolean;
  /** Truthful `Retry-After` in seconds; always >= 1. */
  retryAfterSeconds: number;
  bucket: UploadLimitBucket;
}

interface Buckets {
  user: RateLimiter;
  client: RateLimiter;
  global: RateLimiter;
}

let buckets: Buckets | null = null;

function limiters(): Buckets {
  if (buckets) return buckets;
  const { upload } = getConfig();
  buckets = {
    user: new RateLimiter({ windowMs: WINDOW_MS, max: upload.userPerMin }),
    client: new RateLimiter({ windowMs: WINDOW_MS, max: upload.anonPerMin }),
    global: new RateLimiter({ windowMs: WINDOW_MS, max: upload.globalPerMin }),
  };
  return buckets;
}

/** Drops both the cached limiters and their counts. For tests only. */
export function _resetUploadLimitsForTests(): void {
  buckets = null;
}

/**
 * Constant-time secret comparison over digests, so unequal lengths are handled
 * without leaking the expected length through an early return.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The forwarded client address, or null when the forwarding headers are not
 * trustworthy — which is the default, because this repository ships no reverse
 * proxy. Null means "fall back to the global bucket", never "trust the header".
 */
export function trustedClientAddress(request: Request): string | null {
  const expected = getConfig().upload.trustedProxySecret;
  if (!expected) return null;
  const presented = request.headers.get(PROXY_SECRET_HEADER);
  if (!presented || !secretMatches(presented, expected)) return null;
  const fwd = request.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0].trim();
  return first || request.headers.get("x-real-ip")?.trim() || null;
}

/**
 * Records one upload attempt and says whether to refuse it.
 *
 * Call BEFORE reading the body. `userId` is the session user when one has already
 * been resolved, null for an unauthenticated caller — passing it means a flood of
 * anonymous traffic cannot spend a signed-in user's budget, and cannot spend the
 * global budget on their behalf either.
 *
 * FAILS CLOSED. If the limiter cannot answer — an unreadable configuration is the
 * realistic cause — the upload is refused rather than admitted unmetered. An
 * abuse control that quietly disables itself under fault is the one failure mode
 * with no external signal, so this direction is deliberate.
 */
export function checkUploadLimit(input: {
  request: Request;
  userId?: string | null;
  now?: number;
}): UploadLimitDecision {
  const now = input.now ?? Date.now();
  try {
    const b = limiters();

    if (input.userId) {
      const key = `user:${input.userId}`;
      return {
        limited: b.user.hit(key, now),
        retryAfterSeconds: b.user.retryAfterSeconds(key, now),
        bucket: "user",
      };
    }

    // Unauthenticated: the global ceiling is always charged, so it is the bound
    // no key rotation can get past. A trusted per-client bucket refuses earlier
    // when a proxy makes one available, but never instead.
    const globalLimited = b.global.hit("global", now);
    const address = trustedClientAddress(input.request);
    if (address) {
      const key = `client:${address}`;
      const clientLimited = b.client.hit(key, now);
      if (clientLimited) {
        return {
          limited: true,
          retryAfterSeconds: b.client.retryAfterSeconds(key, now),
          bucket: "client",
        };
      }
    }
    return {
      limited: globalLimited,
      retryAfterSeconds: b.global.retryAfterSeconds("global", now),
      bucket: "global",
    };
  } catch {
    return { limited: true, retryAfterSeconds: WINDOW_MS / 1000, bucket: "unavailable" };
  }
}
