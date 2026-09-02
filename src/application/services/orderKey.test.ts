import { describe, expect, it } from "vitest";
import { firstOrderKey, generateOrderKeyBetween } from "./orderKey";

describe("generateOrderKeyBetween", () => {
  it("returns a key that sorts between two known keys", () => {
    const a = "a";
    const b = "z";
    const mid = generateOrderKeyBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  it("returns a key after a lower bound with no upper bound", () => {
    const lo = "m";
    const key = generateOrderKeyBetween(lo, null);
    expect(key > lo).toBe(true);
  });

  it("returns a key before an upper bound with no lower bound", () => {
    const hi = "m";
    const key = generateOrderKeyBetween(null, hi);
    expect(key < hi).toBe(true);
  });

  it("returns a valid first key with no bounds", () => {
    const key = generateOrderKeyBetween(null, null);
    expect(key.length).toBeGreaterThan(0);
  });

  it("generates a sequence that sorts correctly after many insertions at tail", () => {
    const keys: string[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 20; i++) {
      const key = generateOrderKeyBetween(prev, null);
      keys.push(key);
      prev = key;
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i] > keys[i - 1]).toBe(true);
    }
  });

  it("generates a sequence that sorts correctly after many insertions at head", () => {
    const keys: string[] = [];
    let next: string | null = null;
    for (let i = 0; i < 20; i++) {
      const key = generateOrderKeyBetween(null, next);
      keys.unshift(key);
      next = key;
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i] > keys[i - 1]).toBe(true);
    }
  });

  it("generates keys that sort correctly when inserting between adjacent items", () => {
    const first = generateOrderKeyBetween(null, null);
    const last = generateOrderKeyBetween(first, null);
    const mid = generateOrderKeyBetween(first, last);
    expect(first < mid).toBe(true);
    expect(mid < last).toBe(true);
  });

  it("throws when lo >= hi", () => {
    expect(() => generateOrderKeyBetween("z", "a")).toThrow();
    expect(() => generateOrderKeyBetween("m", "m")).toThrow();
  });
});

describe("firstOrderKey", () => {
  it("returns the same as generateOrderKeyBetween(null, null)", () => {
    expect(firstOrderKey()).toBe(generateOrderKeyBetween(null, null));
  });
});
