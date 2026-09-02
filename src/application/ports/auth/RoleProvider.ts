import type { Role, Permission } from "@/src/domain/entities/Role";

/**
 * RoleProvider port — RBAC queries. `getRole` returns the user's role in an
 * organization (or null if not a member); `hasPermission` evaluates the
 * role→permission map from the domain. Both Local and Clerk providers can back
 * this (Clerk maps org roles to these).
 */
export interface IRoleProvider {
  getRole(userId: string, organizationId: string): Promise<Role | null>;
  hasPermission(userId: string, organizationId: string, permission: Permission): Promise<boolean>;
}
