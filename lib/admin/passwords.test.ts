import { describe, expect, it } from "vitest";
import { hashPassword, isAdminPasswordSet, verifyPassword } from "./passwords";

describe("admin password helpers", () => {
  it("hashes and verifies a round-trip", () => {
    const hash = hashPassword("correct horse battery");
    expect(hash.includes(":")).toBe(true);
    expect(verifyPassword("correct horse battery", hash)).toBe(true);
  });

  it("rejects the wrong password", () => {
    const hash = hashPassword("correct horse battery");
    expect(verifyPassword("wrong", hash)).toBe(false);
  });

  it("never verifies against an empty or malformed stored hash", () => {
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", undefined)).toBe(false);
    expect(verifyPassword("anything", null)).toBe(false);
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
    expect(verifyPassword("anything", "onlysalt:")).toBe(false);
  });

  it("detects whether a password is configured (first-run gate)", () => {
    expect(isAdminPasswordSet("")).toBe(false);
    expect(isAdminPasswordSet(undefined)).toBe(false);
    expect(isAdminPasswordSet(null)).toBe(false);
    expect(isAdminPasswordSet("malformed-no-colon")).toBe(false);
    expect(isAdminPasswordSet("285ce572413c55b2:b84b66029b05086f")).toBe(true);
  });

  it("produces unique salts for the same password", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });
});
