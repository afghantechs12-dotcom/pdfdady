import { describe, expect, it } from "vitest";
import { roleHasPermission, ROLE_PERMISSIONS, type Permission } from "./Role";

const ALL: Permission[] = [
  "tool:run",
  "file:read",
  "file:delete",
  "org:manage",
  "billing:manage",
  "apikey:manage",
  "audit:read",
];

describe("RBAC roles + permissions", () => {
  it("owner has every permission", () => {
    for (const p of ALL) expect(roleHasPermission("owner", p)).toBe(true);
  });

  it("admin has everything except billing", () => {
    expect(roleHasPermission("admin", "billing:manage")).toBe(false);
    expect(ROLE_PERMISSIONS.admin).not.toContain("billing:manage");
    expect(roleHasPermission("admin", "org:manage")).toBe(true);
    expect(roleHasPermission("admin", "audit:read")).toBe(true);
  });

  it("member can run tools + read/delete files but not manage the org", () => {
    expect(roleHasPermission("member", "tool:run")).toBe(true);
    expect(roleHasPermission("member", "file:read")).toBe(true);
    expect(roleHasPermission("member", "file:delete")).toBe(true);
    expect(roleHasPermission("member", "org:manage")).toBe(false);
    expect(roleHasPermission("member", "apikey:manage")).toBe(false);
  });

  it("viewer can only read files", () => {
    expect(roleHasPermission("viewer", "file:read")).toBe(true);
    expect(roleHasPermission("viewer", "tool:run")).toBe(false);
    expect(roleHasPermission("viewer", "file:delete")).toBe(false);
  });
});
