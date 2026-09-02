import { describe, expect, it } from "vitest";
import {
  evaluateLimits,
  isLimitMode,
  isReportableDenial,
  shouldBlock,
  type EvaluateLimitsInput,
  type LimitMode,
} from "./decision";
import { PLAN_ENTITLEMENTS } from "./plans";

const AT = new Date("2026-08-24T12:00:00.000Z");
const MB = 1024 * 1024;

function evalWith(overrides: Partial<EvaluateLimitsInput>) {
  const base: EvaluateLimitsInput = {
    plan: "free",
    usage: { counters: {} },
    request: { amounts: { server_operations: 1 }, largestInputBytes: 1 * MB, activeOperations: 0 },
    mode: "enforce",
    at: AT,
  };
  return evaluateLimits({ ...base, ...overrides });
}

/**
 * The decision function is the one place allow/deny is decided, so the tests are
 * about the properties that make it trustworthy: the verdict is always truthful,
 * the mode governs only whether it is applied, and the message a stranger sees
 * carries no internal detail.
 */
describe("truthful verdict, independent of mode", () => {
  it("allows an operation within every limit", () => {
    const decision = evalWith({});
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeNull();
    expect(shouldBlock(decision)).toBe(false);
  });

  /**
   * The heart of observe mode: a real over-limit operation is reported as NOT
   * allowed, yet is not blocked. That is the dataset enforcement is calibrated
   * from.
   */
  it("reports a denial truthfully in observe mode but does not block it", () => {
    const decision = evalWith({
      mode: "observe",
      usage: { counters: { server_operations: PLAN_ENTITLEMENTS.free.meters.server_operations } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.enforced).toBe(false);
    expect(shouldBlock(decision)).toBe(false);
    expect(isReportableDenial(decision)).toBe(true);
  });

  it("blocks the same operation in enforce mode", () => {
    const decision = evalWith({
      mode: "enforce",
      usage: { counters: { server_operations: PLAN_ENTITLEMENTS.free.meters.server_operations } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.enforced).toBe(true);
    expect(shouldBlock(decision)).toBe(true);
  });

  it("records nothing and blocks nothing when off", () => {
    const decision = evalWith({
      mode: "off",
      usage: { counters: { server_operations: 9_999_999 } },
    });
    expect(decision.allowed).toBe(false);
    expect(shouldBlock(decision)).toBe(false);
    expect(isReportableDenial(decision)).toBe(false);
  });
});

describe("meter boundaries", () => {
  const limit = PLAN_ENTITLEMENTS.free.meters.server_operations!;

  /**
   * The classic off-by-one. A limit of N must admit the operation that brings
   * the total to exactly N; `>=` would make every allowance one smaller than it
   * claims.
   */
  it("admits the operation that reaches the limit exactly", () => {
    const decision = evalWith({
      usage: { counters: { server_operations: limit - 1 } },
      request: { amounts: { server_operations: 1 }, largestInputBytes: MB, activeOperations: 0 },
    });
    expect(decision.allowed).toBe(true);
  });

  it("denies the operation that would exceed the limit by one", () => {
    const decision = evalWith({
      usage: { counters: { server_operations: limit } },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("meter_exhausted");
    expect(decision.meter).toBe("server_operations");
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("treats an unlimited (absent) meter as never exhausted", () => {
    const decision = evalWith({
      request: { amounts: { ai_tokens: 1_000_000 }, largestInputBytes: MB, activeOperations: 0 },
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("denial ordering", () => {
  /**
   * A guest who is both out of operations AND uploading a 900MB file should be
   * told about the file — the thing they can act on now — not sent away to wait
   * for a daily reset they will hit again.
   */
  it("prefers the actionable file-size message over a meter reset", () => {
    const decision = evaluateLimits({
      plan: "guest",
      usage: { counters: { server_operations: 9_999 } },
      request: {
        amounts: { server_operations: 1 },
        largestInputBytes: 900 * MB,
        activeOperations: 0,
      },
      mode: "enforce",
      at: AT,
    });
    expect(decision.reason).toBe("file_too_large");
    // A larger file will still be too large after the reset; no misleading hint.
    expect(decision.retryAfterSeconds).toBeNull();
  });

  it("denies on concurrency before touching the meters", () => {
    const decision = evaluateLimits({
      plan: "free",
      usage: { counters: {} },
      request: {
        amounts: { server_operations: 1 },
        largestInputBytes: MB,
        activeOperations: PLAN_ENTITLEMENTS.free.maxConcurrentJobs,
      },
      mode: "enforce",
      at: AT,
    });
    expect(decision.reason).toBe("too_many_concurrent");
    expect(decision.retryAfterSeconds).toBe(15);
  });
});

describe("user-facing safety", () => {
  /**
   * Like safeMessageFor, the message must be a fixed sentence with no room for a
   * limit, a plan name or another user's usage to leak through.
   */
  it("never interpolates the numeric limit or usage into the message", () => {
    const decision = evalWith({
      usage: { counters: { server_operations: PLAN_ENTITLEMENTS.free.meters.server_operations } },
    });
    expect(decision.message).toBeTruthy();
    expect(decision.message).not.toContain(String(decision.limit));
    expect(decision.message).not.toContain(String(decision.used));
    expect(decision.message).not.toContain("free");
  });

  it("has no message when allowed", () => {
    expect(evalWith({}).message).toBeNull();
  });
});

describe("snapshot surface", () => {
  it("reports state for every enforceable meter regardless of the request", () => {
    const decision = evalWith({ request: { amounts: {}, largestInputBytes: 0, activeOperations: 0 } });
    const meters = decision.meters.map((m) => m.meter);
    expect(meters).toContain("server_operations");
    expect(meters).toContain("server_input_bytes");
    // Non-enforceable meters never appear as a limit.
    expect(meters).not.toContain("compute_units");
    expect(meters).not.toContain("ai_tokens");
  });

  it("computes remaining as limit minus used, floored at zero", () => {
    const limit = PLAN_ENTITLEMENTS.free.meters.server_operations!;
    const decision = evalWith({ usage: { counters: { server_operations: limit + 50 } } });
    const state = decision.meters.find((m) => m.meter === "server_operations")!;
    expect(state.remaining).toBe(0);
  });
});

describe("mode guard", () => {
  it("narrows valid modes", () => {
    for (const mode of ["off", "observe", "enforce"] as LimitMode[]) {
      expect(isLimitMode(mode)).toBe(true);
    }
    expect(isLimitMode("blocking")).toBe(false);
    expect(isLimitMode(undefined)).toBe(false);
  });
});
