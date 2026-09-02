import { describe, expect, it } from "vitest";
import {
  ALL_METER_KEYS,
  ENFORCEABLE_METERS,
  METERS,
  isMeterKey,
  meterTableProblems,
} from "./meters";
import { PLAN_ENTITLEMENTS, ALL_PLAN_IDS } from "./plans";

/**
 * The meter vocabulary is only useful if it is the ONLY vocabulary. These tests
 * guard the two ways that stops being true: a key that exists in one table and
 * not the other, and a meter that starts gating work before anything produces it.
 */
describe("meter table", () => {
  it("has no internal disagreements", () => {
    expect(meterTableProblems()).toEqual([]);
  });

  it("declares every key in the union", () => {
    expect(ALL_METER_KEYS.length).toBe(Object.keys(METERS).length);
    for (const key of ALL_METER_KEYS) expect(METERS[key].key).toBe(key);
  });

  it("narrows unknown values", () => {
    expect(isMeterKey("server_operations")).toBe(true);
    expect(isMeterKey("compute_units")).toBe(true);
    expect(isMeterKey("bandwidth")).toBe(false);
    expect(isMeterKey(null)).toBe(false);
    expect(isMeterKey(42)).toBe(false);
  });
});

describe("enforceability", () => {
  it("derives the enforceable set rather than hand-listing it", () => {
    for (const key of ALL_METER_KEYS) {
      expect(ENFORCEABLE_METERS.includes(key)).toBe(METERS[key].enforceable);
    }
  });

  /**
   * compute_units is derived from a formula the user cannot see. Denying work on
   * a number nobody can predict is the behaviour this asserts against.
   */
  it("does not allow a derived cost meter to deny work", () => {
    expect(METERS.compute_units.enforceable).toBe(false);
  });

  /**
   * The phase brief says: prepare for AI usage, do not add AI. A declared meter
   * with no producer is the preparation; an enforced one would be the feature.
   */
  it("declares ai_tokens without letting it gate anything", () => {
    expect(ALL_METER_KEYS).toContain("ai_tokens");
    expect(METERS.ai_tokens.enforceable).toBe(false);
    for (const plan of ALL_PLAN_IDS) {
      expect(PLAN_ENTITLEMENTS[plan].meters.ai_tokens).toBeUndefined();
    }
  });
});

describe("windows", () => {
  it("gives every meter a fixed, UTC-alignable window", () => {
    for (const key of ALL_METER_KEYS) {
      expect(["day", "month"]).toContain(METERS[key].window);
    }
  });
});
