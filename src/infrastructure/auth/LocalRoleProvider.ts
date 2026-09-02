import { PrismaClient } from "@prisma/client";
import type { Role, Permission } from "@/src/domain/entities/Role";
import { roleHasPermission } from "@/src/domain/entities/Role";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";

/**
 * Local IRoleProvider — reads a user's role from `organization_memberships` and
 * evaluates it against the domain role→permission map. Clerk can map its org
 * roles onto the same `Role` union.
 */
export class LocalRoleProvider implements IRoleProvider {
  constructor(private readonly prisma: PrismaClient) {}

  async getRole(userId: string, organizationId: string): Promise<Role | null> {
    const m = await this.prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return m ? (m.role as Role) : null;
  }

  async hasPermission(
    userId: string,
    organizationId: string,
    permission: Permission,
  ): Promise<boolean> {
    const role = await this.getRole(userId, organizationId);
    if (!role) return false;
    return roleHasPermission(role, permission);
  }
}
