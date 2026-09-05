/**
 * In-process fixed-window rate limiter, keyed by an arbitrary string (usually
 * a client IP). Used to protect the public tool API and the admin auth routes
 * from abuse.
 *
 * Single-instance guard, like lib/server/concurrency.ts. Behind multiple
 * instances the per-key state lives only in this process, so the effective
 * limit becomes N×(instances). Enforce at a shared layer (Redis / the load
 * balancer) as well in Milestone 2.
 *
 * Usage:
 *   const limiter = new RateLimiter({ windowMs: 60_000, max: 20 });
 *   if (limiter.hit(clientIp(req))) return new NextResponse(..., { status: 429 });
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { getConfig } from "@/src/infrastructure/config/env";

export interface RateLimiterOptions {
  /** Length of the fixed window in milliseconds. */
  windowMs: number;
  /** Maximum hits allowed within one window (the (max+1)th is rejected). */
  max: number;
  /** Cap on the underlying Map size to bound memory; pruned when exceeded. */
  maxEntries?: number;
}

interface Entry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly maxEntries: number;

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.max = opts.max;
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  /**
   * Records a hit for `key` and returns `true` if the key is OVER the limit
   * (the caller should reject with 429). The first hit in a window is always
   * allowed; the (max+1)th hit in the same window returns true.
   */
  hit(key: string, now: number = Date.now()): boolean {
    if (this.entries.size > this.maxEntries) this.prune(now);
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart > this.windowMs) {
      this.entries.set(key, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > this.max;
  }

  /**
   * Seconds until `key`'s current window ends — the truthful `Retry-After`.
   *
   * A fixed window forgets a key when its window elapses, so this is exactly how
   * long a limited caller must wait, not a constant guess. Never 0: a client told
   * to retry after 0 seconds retries immediately into the same refusal. Unknown
   * keys report the full window, which is the longest a caller could have to wait.
   *
   * The `+ 1` is not padding. `hit` starts a new window only once `now -
   * windowStart` is STRICTLY greater than `windowMs`, so the boundary instant
   * still belongs to the old window; without it a client that obeys this header
   * to the millisecond is refused again, which makes the header a lie.
   */
  retryAfterSeconds(key: string, now: number = Date.now()): number {
    const entry = this.entries.get(key);
    const remaining = entry ? entry.windowStart + this.windowMs + 1 - now : this.windowMs;
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  /** Peeks whether `key` is currently limited without consuming a hit. */
  isLimited(key: string, now: number = Date.now()): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    return now - entry.windowStart <= this.windowMs && entry.count > this.max;
  }


  /** Clears all rate-limit state. Useful in test beforeEach to avoid cross-test leakage. */
  reset(): void {
    this.entries.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.windowStart > this.windowMs) this.entries.delete(key);
    }
  }
}

/** Header a trusted reverse proxy must send for its forwarding headers to count. */
export const PROXY_SECRET_HEADER = "x-pdfdadi-proxy-secret";

/**
 * Header the ingress guard stamps with the connection's peer address, having first
 * deleted any copy the client sent (`ingress/guard.mjs`).
 *
 * It is not a forwarding header and must not be treated as one. It is written at
 * the only point in this deployment that sees a socket, and production refuses to
 * serve when that point is not installed (`assertInstalled`, and
 * `src/infrastructure/config/startupGate.ts`), so a value present here is one no
 * client could have written. Absent under `next dev`, which runs no ingress.
 */
export const PEER_ADDR_HEADER = "x-pdfdadi-peer";

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
 * proxy. Null means "fall back", never "trust the header".
 *
 * Lives here rather than in `uploadRateLimit.ts`, its first caller, because every
 * limiter in the process needs the same answer to the same question — and two
 * implementations of one trust rule is exactly how they came to disagree. See
 * `clientIp` below for what the other one did.
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
 * Once per process, not once per request: the misconfiguration below is a property
 * of the deployment, and a per-request line would be a log flood written by
 * whoever chose to send the header.
 */
let warnedAboutUntrustedForwarding = false;

/** For tests only. */
export function _resetForwardingWarningForTests(): void {
  warnedAboutUntrustedForwarding = false;
}

/**
 * The client identity every limiter in this file is keyed on.
 *
 * Three sources, in this order, and the order is the security property:
 *
 *   1. a verified proxy's forwarded address — `TRUSTED_PROXY_SECRET` is set and the
 *      request presented it, so `X-Forwarded-For` came from our own proxy;
 *   2. the peer address the ingress guard stamped, which no client can write;
 *   3. `"unknown"` — one shared bucket, which is what `next dev` gets.
 *
 * This read `X-Forwarded-For` unconditionally until Stage 5 of production
 * acceptance, and the effect was backwards: a browser sends no such header, so
 * every honest caller shared one bucket while a caller who added
 * `X-Forwarded-For: <counter>` got a fresh one per request. Every limiter keyed
 * here was therefore bypassable by an unauthenticated client — including the 5/min
 * bound on admin password attempts, the only thing between an anonymous caller and
 * unlimited guesses against a 24 ms blocking `scryptSync` (`lib/admin/passwords.ts`,
 * whose own comment justifies the blocking call by citing that rate limit).
 *
 * The upload limiter has had rule 1 since Phase 6 and could not have rule 2, which
 * did not exist; it collapses to one global bucket instead. Nothing needs to change
 * there — a stamped peer address would only make that bucket finer.
 */
export function clientIp(req: Request): string {
  const forwarded = trustedClientAddress(req);
  if (forwarded) return forwarded;
  if (!warnedAboutUntrustedForwarding && req.headers.has("x-forwarded-for")) {
    warnedAboutUntrustedForwarding = true;
    console.warn(
      "[rate-limit] Requests are arriving with X-Forwarded-For but TRUSTED_PROXY_SECRET is " +
        "not configured (or the request did not present it), so callers are keyed by the " +
        "connecting address. Behind a reverse proxy that is ONE key for every caller: set " +
        "TRUSTED_PROXY_SECRET and have the proxy send x-pdfdadi-proxy-secret. " +
        "Directly exposed, no action is needed.",
    );
  }
  return req.headers.get(PEER_ADDR_HEADER)?.trim() || "unknown";
}
