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

/**
 * Best-effort client IP extraction. Trusts the first `X-Forwarded-For` token
 * when present (configure your reverse proxy to OVERWRITE this header rather
 * than append, so clients can't spoof it), else `X-Real-IP`, else "unknown".
 *
 * NOTE: spoofing X-Forwarded-For is possible if the app is exposed without a
 * trusted proxy that overwrites it. A trusted-proxy-aware extractor is future
 * work (Milestone 2 hardening); for now, deploy behind a proxy that sets the
 * header correctly.
 */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
