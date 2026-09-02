import { PrismaClient } from "@prisma/client";
import type { Organization } from "@/src/domain/entities/Organization";
import type { OrganizationMembership } from "@/src/domain/entities/Membership";
import type { Role } from "@/src/domain/entities/Role";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import { DomainError } from "@/src/domain/errors";

function toOrg(row: {
  id: string;
  name: string;
  slug: string;
  plan: string;
  defaultWorkspaceId: string | null;
  createdAt: Date;
}): Organization {
  return { id: row.id, name: row.name, slug: row.slug, plan: row.plan, defaultWorkspaceId: row.defaultWorkspaceId, createdAt: row.createdAt };
}

function toMembership(row: {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}): OrganizationMembership {
  return { id: row.id, organizationId: row.organizationId, userId: row.userId, role: row.role as Role, createdAt: row.createdAt };
}

/**
 * Local IOrganizationProvider — orgs + memberships in their respective tables.
 * `create` seeds the owner membership. There are no Prisma relation fields
 * (just foreign-key strings), so `listForUser` does two queries.
 */
export class LocalOrganizationProvider implements IOrganizationProvider {
  constructor(private readonly prisma: PrismaClient) {}

  async create(name: string, slug: string, ownerId: string, plan = "free"): Promise<Organization> {
    const existing = await this.prisma.organization.findUnique({ where: { slug } });
    if (existing) throw new DomainError("Organization slug is already taken.");
    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name, slug, plan } });
      await tx.organizationMembership.create({ data: { organizationId: created.id, userId: ownerId, role: "owner" } });
      const workspaceName = `${name} Workspace`;
      const normalizedName = workspaceName.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
      const normalizedSlug = `${slug}-workspace`.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
      const workspace = await tx.workspace.create({ data: { organizationId: created.id, name: workspaceName, normalizedName, slug: normalizedSlug, normalizedSlug, description: "Default Workspace", createdById: ownerId } });
      await tx.workspaceMembership.create({ data: { workspaceId: workspace.id, userId: ownerId, role: "owner", createdById: ownerId } });
      return tx.organization.update({ where: { id: created.id }, data: { defaultWorkspaceId: workspace.id } });
    });
    return toOrg(org);
  }

  async get(id: string): Promise<Organization | null> {
    const r = await this.prisma.organization.findUnique({ where: { id } });
    return r ? toOrg(r) : null;
  }

  async listForUser(userId: string): Promise<Organization[]> {
    const memberships = await this.prisma.organizationMembership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    if (memberships.length === 0) return [];
    const orgs = await this.prisma.organization.findMany({
      where: { id: { in: memberships.map((m) => m.organizationId) } },
    });
    return orgs.map(toOrg);
  }

  async getMembership(organizationId: string, userId: string): Promise<OrganizationMembership | null> {
    const r = await this.prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
    });
    return r ? toMembership(r) : null;
  }

  async addMember(organizationId: string, userId: string, role: Role): Promise<OrganizationMembership> {
    const r = await this.prisma.organizationMembership.create({
      data: { organizationId, userId, role },
    });
    return toMembership(r);
  }

  async removeMember(organizationId: string, userId: string): Promise<void> {
    try {
      await this.prisma.organizationMembership.delete({
        where: { organizationId_userId: { organizationId, userId } },
      });
    } catch {
      // idempotent
    }
  }

  async setRole(organizationId: string, userId: string, role: Role): Promise<void> {
    await this.prisma.organizationMembership.update({
      where: { organizationId_userId: { organizationId, userId } },
      data: { role },
    });
  }
}
