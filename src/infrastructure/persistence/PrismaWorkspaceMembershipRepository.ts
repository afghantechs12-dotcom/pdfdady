import { PrismaClient } from "@prisma/client";
import type { WorkspaceMembership, WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";
import type { WorkspaceMembershipRepository } from "@/src/application/ports/workspaces/WorkspaceMembershipRepository";

function toDomain(row: any): WorkspaceMembership {
  return { id: row.id, workspaceId: row.workspaceId, userId: row.userId, role: row.role as WorkspaceRole, createdById: row.createdById, revision: row.revision, revokedAt: row.revokedAt, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

export class PrismaWorkspaceMembershipRepository implements WorkspaceMembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(workspaceId: string, limit: number, cursor?: string) {
    const rows = await this.prisma.workspaceMembership.findMany({ where: { workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    const items = rows.slice(0, limit).map(toDomain);
    return { items, nextCursor: rows.length > limit ? items.at(-1)?.id ?? null : null };
  }

  async get(workspaceId: string, userId: string) {
    const row = await this.prisma.workspaceMembership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
    return row ? toDomain(row) : null;
  }

  async add(input: { workspaceId: string; userId: string; role: WorkspaceRole; createdById: string }) {
    return toDomain(await this.prisma.workspaceMembership.create({ data: input }));
  }

  async update(workspaceId: string, userId: string, role: WorkspaceRole, revision: number) {
    const result = await this.prisma.workspaceMembership.updateMany({ where: { workspaceId, userId, revision }, data: { role, revision: { increment: 1 }, revokedAt: null } });
    if (result.count !== 1) throw new Error("Workspace membership update conflict.");
    return toDomain(await this.prisma.workspaceMembership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } } }));
  }

  async revoke(workspaceId: string, userId: string, revision: number) {
    const result = await this.prisma.workspaceMembership.updateMany({ where: { workspaceId, userId, revision }, data: { revokedAt: new Date(), revision: { increment: 1 } } });
    if (result.count !== 1) throw new Error("Workspace membership revoke conflict.");
    return toDomain(await this.prisma.workspaceMembership.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId, userId } } }));
  }

  countActiveOwners(workspaceId: string) {
    return this.prisma.workspaceMembership.count({ where: { workspaceId, role: "owner", revokedAt: null } });
  }
}
