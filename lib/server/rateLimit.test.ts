import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rateLimit";

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
