import type { Organization } from "@/src/domain/entities/Organization";
import type { OrganizationMembership } from "@/src/domain/entities/Membership";
import type { Role } from "@/src/domain/entities/Role";

/**
 * OrganizationProvider port — tenant (organization) + membership management.
 * `create` also seeds the owner membership. The Local implementation uses the
 * `organizations` + `organization_memberships` tables; the Clerk adapter
 * defers to Clerk Organizations.
 */
export interface IOrganizationProvider {
  create(name: string, slug: string, ownerId: string, plan?: string): Promise<Organization>;
  get(id: string): Promise<Organization | null>;
  listForUser(userId: string): Promise<Organization[]>;
  getMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null>;
  addMember(organizationId: string, userId: string, role: Role): Promise<OrganizationMembership>;
  removeMember(organizationId: string, userId: string): Promise<void>;
  setRole(organizationId: string, userId: string, role: Role): Promise<void>;
}
