/**
 * RBAC roles + permissions. Roles map 1:1 to a fixed permission set (M2.4 MVP);
 * a future `role_permissions` table can make them customizable. The mapping
 * lives in the domain so both the Local and Clerk role providers evaluate it
 * identically.
 */
export type Role = "owner" | "admin" | "member" | "viewer";

export type Permission =
  | "tool:run"
  | "file:read"
  | "file:delete"
  | "org:manage"
  | "billing:manage"
  | "apikey:manage"
  | "audit:read";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["tool:run", "file:read", "file:delete", "org:manage", "billing:manage", "apikey:manage", "audit:read"],
  admin: ["tool:run", "file:read", "file:delete", "org:manage", "apikey:manage", "audit:read"],
  member: ["tool:run", "file:read", "file:delete"],
  viewer: ["file:read"],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
