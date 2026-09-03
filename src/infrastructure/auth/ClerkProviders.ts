import type { User } from "@/src/domain/entities/User";
import type { UserSession } from "@/src/domain/entities/UserSession";
import type { Organization } from "@/src/domain/entities/Organization";
import type { OrganizationMembership } from "@/src/domain/entities/Membership";
import type { Role } from "@/src/domain/entities/Role";
import type { IUserProvider } from "@/src/application/ports/auth/UserProvider";
import type { ISessionProvider } from "@/src/application/ports/auth/SessionProvider";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";

/**
 * Clerk adapter SCAFFOLD (M2.4 — not yet wired).
 *
 * These implement the four auth provider interfaces so that switching from
 * Local to Clerk is a single DI change in container.ts (register these for the
 * same tokens). Every method throws until the Clerk integration is built
 * (webhook user-mirroring, Clerk session JWT verification, Clerk Organizations
 * API). The Local providers remain the active implementation.
 */
const NOT_IMPLEMENTED = "Clerk auth adapter is not implemented yet (M2.4 scaffold).";

export class ClerkUserProvider implements IUserProvider {
  async getById(): Promise<User | null> { throw new Error(NOT_IMPLEMENTED); }
  async getByEmail(): Promise<User | null> { throw new Error(NOT_IMPLEMENTED); }
  async createLocal(): Promise<User> { throw new Error(NOT_IMPLEMENTED); }
  async createExternal(): Promise<User> { throw new Error(NOT_IMPLEMENTED); }
  async verifyCredentials(): Promise<User | null> {
    // Clerk verifies credentials externally; the app never sees the password.
    throw new Error(NOT_IMPLEMENTED);
  }
}

export class ClerkSessionProvider implements ISessionProvider {
  async create(): Promise<UserSession> { throw new Error(NOT_IMPLEMENTED); }
  async get(): Promise<UserSession | null> { throw new Error(NOT_IMPLEMENTED); }
  async delete(): Promise<void> { throw new Error(NOT_IMPLEMENTED); }
  /** Clerk owns session expiry; there is no local table to prune. */
  async pruneExpired(): Promise<number> { return 0; }
}

export class ClerkOrganizationProvider implements IOrganizationProvider {
  async create(): Promise<Organization> { throw new Error(NOT_IMPLEMENTED); }
  async get(): Promise<Organization | null> { throw new Error(NOT_IMPLEMENTED); }
  async listForUser(): Promise<Organization[]> { throw new Error(NOT_IMPLEMENTED); }
  async getMembership(): Promise<OrganizationMembership | null> { throw new Error(NOT_IMPLEMENTED); }
  async addMember(): Promise<OrganizationMembership> { throw new Error(NOT_IMPLEMENTED); }
  async removeMember(): Promise<void> { throw new Error(NOT_IMPLEMENTED); }
  async setRole(): Promise<void> { throw new Error(NOT_IMPLEMENTED); }
}

export class ClerkRoleProvider implements IRoleProvider {
  async getRole(): Promise<Role | null> { throw new Error(NOT_IMPLEMENTED); }
  async hasPermission(): Promise<boolean> { throw new Error(NOT_IMPLEMENTED); }
}
