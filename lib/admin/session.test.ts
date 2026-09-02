import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

// `process.env` types some well-known keys (NODE_ENV) as readonly, but the
// runtime object is fully mutable. Cast to a writable record for the tests so
// we can set/delete without tripping the readonly-property type errors.
const env = process.env as unknown as Record<string, string | undefined>;
const ORIG_SECRET = env.ADMIN_SECRET;
const ORIG_NODE_ENV = env.NODE_ENV;
const ORIG_OPTIN = env.PDFDADI_ALLOW_INSECURE_DEV_SECRET;

describe("admin session tokens", () => {
  beforeEach(() => {
    env.ADMIN_SECRET = "test-secret-at-least-8-chars";
    delete env.PDFDADI_ALLOW_INSECURE_DEV_SECRET;
  });

  afterEach(() => {
    if (ORIG_SECRET === undefined) delete env.ADMIN_SECRET;
    else env.ADMIN_SECRET = ORIG_SECRET;
    if (ORIG_NODE_ENV === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = ORIG_NODE_ENV;
    if (ORIG_OPTIN === undefined) delete env.PDFDADI_ALLOW_INSECURE_DEV_SECRET;
    else env.PDFDADI_ALLOW_INSECURE_DEV_SECRET = ORIG_OPTIN;
  });

  it("verifies a freshly issued token", async () => {
    const token = await createSessionToken(1_000_000);
    await expect(verifySessionToken(token, 1_000_000)).resolves.toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const token = await createSessionToken(1_000_000);
    const last = token.endsWith("0") ? "1" : "0";
    const tampered = token.slice(0, -1) + last;
    await expect(verifySessionToken(tampered, 1_000_000)).resolves.toBe(false);
  });

  it("rejects an expired token (older than 7 days)", async () => {
    const now = 5_000_000;
    const issued = now - 1000 * 60 * 60 * 24 * 8; // 8 days ago > 7-day max age
    const token = await createSessionToken(issued);
    await expect(verifySessionToken(token, now)).resolves.toBe(false);
  });

  it("rejects an implausible future token (more than 60s ahead)", async () => {
    const now = 1_000_000;
    const token = await createSessionToken(now + 120_000);
    await expect(verifySessionToken(token, now)).resolves.toBe(false);
  });

  it("rejects malformed/missing tokens", async () => {
    await expect(verifySessionToken("not-a-token", 1_000_000)).resolves.toBe(false);
    await expect(verifySessionToken(undefined, 1_000_000)).resolves.toBe(false);
    await expect(verifySessionToken("abcdef.no-hex-dot", 1_000_000)).resolves.toBe(false);
  });

  it("throws when ADMIN_SECRET is unset in production with no dev opt-in", async () => {
    delete env.ADMIN_SECRET;
    env.NODE_ENV = "production";
    await expect(createSessionToken(1_000_000)).rejects.toThrow(/ADMIN_SECRET/);
  });

  it("allows the insecure fallback only with the explicit dev opt-in", async () => {
    delete env.ADMIN_SECRET;
    env.NODE_ENV = "development";
    env.PDFDADI_ALLOW_INSECURE_DEV_SECRET = "1";
    const token = await createSessionToken(1_000_000);
    await expect(verifySessionToken(token, 1_000_000)).resolves.toBe(true);
  });
});
