import { describe, expect, it } from "vitest";
import { resolveReturnTo } from "./returnTo";
import { safeRedirectPath } from "@/src/application/services/authValidation";

describe("resolveReturnTo", () => {
  it("reads returnTo", () => {
    expect(resolveReturnTo({ returnTo: "/workspaces" })).toBe("/workspaces");
  });

  it("reads next", () => {
    expect(resolveReturnTo({ next: "/workspaces" })).toBe("/workspaces");
  });

  it("prefers returnTo when both are present", () => {
    // returnTo is the documented public contract, so it expresses the more
    // deliberate intent.
    expect(resolveReturnTo({ returnTo: "/a", next: "/b" })).toBe("/a");
  });

  it("returns null when neither is present", () => {
    expect(resolveReturnTo({})).toBeNull();
  });

  it("takes the first value of a repeated parameter", () => {
    expect(resolveReturnTo({ next: ["/first", "/second"] })).toBe("/first");
  });

  it("returns null for an empty repeated parameter", () => {
    expect(resolveReturnTo({ next: [] })).toBeNull();
  });
});

describe("returnTo composed with the redirect-safety boundary", () => {
  it("passes a safe internal path through unchanged", () => {
    const resolved = resolveReturnTo({ returnTo: "/workspaces/abc" });
    expect(safeRedirectPath(resolved)).toBe("/workspaces/abc");
  });

  it.each([
    ["https://evil.test", "absolute URL"],
    ["//evil.test", "scheme-relative URL"],
    ["/\\evil.test", "backslash variant"],
    ["javascript:alert(1)", "scheme"],
    ["%2f%2fevil.test", "percent-encoded scheme-relative"],
  ])("neutralises a hostile returnTo (%s — %s)", (hostile) => {
    // The alias must not become a way to smuggle a value past the check that
    // the `next` parameter has always been subject to.
    const resolved = resolveReturnTo({ returnTo: hostile });
    expect(safeRedirectPath(resolved)).toBe("/workspaces");
  });

  it("refuses an auth page as a destination, avoiding a redirect loop", () => {
    expect(safeRedirectPath(resolveReturnTo({ returnTo: "/login" }))).toBe("/workspaces");
    expect(safeRedirectPath(resolveReturnTo({ returnTo: "/register" }))).toBe("/workspaces");
  });
});
