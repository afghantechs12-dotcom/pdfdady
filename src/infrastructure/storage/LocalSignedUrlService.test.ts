import { describe, expect, it } from "vitest";
import { LocalSignedUrlService } from "./LocalSignedUrlService";
import { verifyLocalUrl } from "./localSignedUrl";

describe("LocalSignedUrlService", () => {
  it("produces a verifiable signed URL with key + verb + expiry bound", async () => {
    const svc = new LocalSignedUrlService("secret", "http://localhost:3000");
    const url = await svc.signedUrl("ca/ab/cd/file", "get", 60);
    const u = new URL(url);
    expect(u.pathname).toBe("/api/storage/file");

    const key = u.searchParams.get("key")!;
    const verb = u.searchParams.get("verb")!;
    const expires = u.searchParams.get("expires")!;
    const sig = u.searchParams.get("sig")!;

    expect(verifyLocalUrl("secret", `${key}|${verb}|${expires}`, sig)).toBe(true);
    // Wrong secret → rejected.
    expect(verifyLocalUrl("wrong", `${key}|${verb}|${expires}`, sig)).toBe(false);
    // Tampered key → rejected.
    expect(verifyLocalUrl("secret", `${key}-tampered|${verb}|${expires}`, sig)).toBe(false);
    // Tampered verb → rejected.
    expect(verifyLocalUrl("secret", `${key}|put|${expires}`, sig)).toBe(false);
  });

  it("the expiry is in the future and increases with ttl", async () => {
    const svc = new LocalSignedUrlService("secret", "http://localhost:3000");
    const before = Math.floor(Date.now() / 1000);
    const url = await svc.signedUrl("k", "get", 120);
    const expires = Number(new URL(url).searchParams.get("expires"));
    expect(expires).toBeGreaterThan(before);
    expect(expires).toBeLessThanOrEqual(before + 120);
  });
});
