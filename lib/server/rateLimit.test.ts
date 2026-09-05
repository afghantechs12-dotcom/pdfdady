import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetConfigForTests } from "@/src/infrastructure/config/env";

import {
  PEER_ADDR_HEADER,
  PROXY_SECRET_HEADER,
  RateLimiter,
  _resetForwardingWarningForTests,
  clientIp,
} from "./rateLimit";

describe("RateLimiter", () => {
  it("allows up to max hits in a window, then rejects further hits", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 3 });
    expect(limiter.hit("ip1", 0)).toBe(false); // 1st
    expect(limiter.hit("ip1", 10)).toBe(false); // 2nd
    expect(limiter.hit("ip1", 20)).toBe(false); // 3rd
    expect(limiter.hit("ip1", 30)).toBe(true); // 4th → over
    expect(limiter.hit("ip1", 40)).toBe(true); // still over
  });

  it("resets after the window elapses", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
    expect(limiter.hit("ip1", 0)).toBe(false);
    expect(limiter.hit("ip1", 500)).toBe(false);
    expect(limiter.hit("ip1", 999)).toBe(true); // 3rd in window → over
    expect(limiter.hit("ip1", 1001)).toBe(false); // new window starts
  });

  it("tracks keys independently", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.hit("ip1", 0)).toBe(false);
    expect(limiter.hit("ip2", 0)).toBe(false);
    expect(limiter.hit("ip1", 10)).toBe(true); // ip1 over
    expect(limiter.hit("ip2", 10)).toBe(true); // ip2 over
  });

  it("isLimited peeks without consuming a hit", () => {
    const limiter = new RateLimiter({ windowMs: 1000, max: 1 });
    expect(limiter.isLimited("ip1", 0)).toBe(false);
    limiter.hit("ip1", 0); // allowed
    limiter.hit("ip1", 10); // over now
    expect(limiter.isLimited("ip1", 20)).toBe(true);
    // Peeking did not advance the window or the count.
    expect(limiter.isLimited("ip1", 25)).toBe(true);
  });
});

/**
 * `clientIp` is the key every limiter above is keyed on, so a caller who can choose
 * it has no limit. Until Stage 5 of production acceptance a caller could: the
 * function read `X-Forwarded-For` from anyone. These are the three sources it may
 * use, in the order that makes the key unchoosable.
 */
describe("clientIp — the key a caller must not be able to choose", () => {
  const env = process.env as Record<string, string | undefined>;
  const SECRET = "proxy-secret-0123456789";
  let orig: string | undefined;

  const req = (headers: Record<string, string> = {}) =>
    new Request("https://example.test/api/admin/login", { method: "POST", headers });

  beforeEach(() => {
    orig = env.TRUSTED_PROXY_SECRET;
    delete env.TRUSTED_PROXY_SECRET;
    _resetConfigForTests();
  });

  afterEach(() => {
    if (orig === undefined) delete env.TRUSTED_PROXY_SECRET;
    else env.TRUSTED_PROXY_SECRET = orig;
    _resetConfigForTests();
  });

  it("ignores forwarding headers no proxy vouched for", () => {
    // The bypass, as it was: five of these rotated the admin login limiter's key.
    const spoofs: Record<string, string>[] = [
      { "x-forwarded-for": "1.1.1.1" },
      { "x-forwarded-for": "2.2.2.2, 3.3.3.3" },
      { "x-real-ip": "4.4.4.4" },
      { "x-forwarded-for": "5.5.5.5", [PROXY_SECRET_HEADER]: "wrong-but-long-enough" },
    ];
    for (const headers of spoofs) {
      expect(clientIp(req({ ...headers, [PEER_ADDR_HEADER]: "10.0.0.9" }))).toBe("10.0.0.9");
    }
  });

  it("cannot be rotated: N spoofed addresses spend one bucket", () => {
    const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });
    const spend = (n: number) =>
      limiter.hit(clientIp(req({ "x-forwarded-for": `9.9.9.${n}`, [PEER_ADDR_HEADER]: "10.0.0.9" })));
    expect([spend(1), spend(2), spend(3), spend(4)]).toEqual([false, false, true, true]);
  });

  it("uses a verified proxy's forwarded address ahead of the peer, which is the proxy", () => {
    env.TRUSTED_PROXY_SECRET = SECRET;
    _resetConfigForTests();
    expect(
      clientIp(
        req({
          [PROXY_SECRET_HEADER]: SECRET,
          "x-forwarded-for": "203.0.113.7, 70.41.3.18",
          [PEER_ADDR_HEADER]: "10.0.0.9",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  it("says once, not per request, that a proxy deployment is missing its secret", () => {
    /*
     * The one case this change makes coarser rather than finer: behind a proxy with
     * no secret configured, every caller connects from the proxy's address and so
     * shares one key. That is safe (a caller cannot rotate it) but it is not what
     * the operator wanted, and nothing else in the process would ever say so.
     */
    _resetForwardingWarningForTests();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      clientIp(req({ "x-forwarded-for": "1.1.1.1" }));
      clientIp(req({ "x-forwarded-for": "2.2.2.2" }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/TRUSTED_PROXY_SECRET/);
      // Never the address itself: this line is written on an attacker's schedule.
      expect(warn.mock.calls[0][0]).not.toMatch(/1\.1\.1\.1/);
    } finally {
      warn.mockRestore();
    }
  });

  it("shares one bucket when nothing identifies the caller", () => {
    // `next dev`, which installs no ingress and so stamps nothing.
    expect(clientIp(req())).toBe("unknown");
    expect(clientIp(req({ [PEER_ADDR_HEADER]: "  " }))).toBe("unknown");
  });
});
