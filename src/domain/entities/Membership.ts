import type { Role } from "./Role";

/** A user's membership in an organization, with their role. */
export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt: Date;
}
