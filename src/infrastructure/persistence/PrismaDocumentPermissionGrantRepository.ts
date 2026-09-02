import type { PrismaClient, DocumentPermissionGrant as GrantRow } from "@prisma/client";
import type {
  DocumentPermissionGrant,
  DocumentPermissionRole,
} from "@/src/domain/entities/Collaboration";
import {
  COLLABORATION_LIMITS,
  documentPermissionRank,
  isDocumentPermissionRole,
} from "@/src/domain/entities/Collaboration";
import type {
  CreateDocumentPermissionGrantInput,
  DocumentPermissionGrantListQuery,
  DocumentPermissionGrantRepository,
} from "@/src/application/ports/workspaces/DocumentPermissionGrantRepository";

function toDomain(row: GrantRow): DocumentPermissionGrant {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    granteeUserId: row.granteeUserId,
    // A row holding a role this build does not know degrades to the weakest one
    // rather than being trusted. An unknown role must never read as *more*
    // access than the weakest one we understand.
    role: (isDocumentPermissionRole(row.role) ? row.role : "viewer") as DocumentPermissionRole,
    grantedById: row.grantedById,
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
    revokedById: row.revokedById,
    revision: Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed DocumentPermissionGrantRepository.
 *
 * The active predicate — not revoked, and either no expiry or an expiry still in
 * the future — is applied in SQL on every lookup rather than resolved once and
 * cached. A grant is a standing capability, so the only moment its validity
 * matters is the moment it is exercised; a cached decision is a revocation that
 * has not taken effect yet.
 */
export class PrismaDocumentPermissionGrantRepository
  implements DocumentPermissionGrantRepository
{
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateDocumentPermissionGrantInput): Promise<DocumentPermissionGrant> {
    const row = await this.prisma.documentPermissionGrant.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        granteeUserId: input.granteeUserId,
        role: input.role,
        grantedById: input.grantedById,
        expiresAt: input.expiresAt,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, grantId: string): Promise<DocumentPermissionGrant | null> {
    const row = await this.prisma.documentPermissionGrant.findFirst({
      where: { id: grantId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async findActiveForUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    now: Date,
  ): Promise<DocumentPermissionGrant | null> {
    const rows = await this.prisma.documentPermissionGrant.findMany({
      where: {
        workspaceId,
        documentId,
        granteeUserId: userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
    if (rows.length === 0) return null;
    // The strongest live grant wins: revoking one of two shares must not leave
    // the weaker one silently deciding, nor the stronger one ignored.
    const grants = rows.map(toDomain);
    return grants.reduce((best, grant) =>
      documentPermissionRank(grant.role) > documentPermissionRank(best.role) ? grant : best,
    );
  }

  async findLiveForUser(
    workspaceId: string,
    documentId: string,
    userId: string,
  ): Promise<DocumentPermissionGrant | null> {
    const row = await this.prisma.documentPermissionGrant.findFirst({
      where: { workspaceId, documentId, granteeUserId: userId, revokedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return row ? toDomain(row) : null;
  }

  async list(query: DocumentPermissionGrantListQuery): Promise<DocumentPermissionGrant[]> {
    const rows = await this.prisma.documentPermissionGrant.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.activeOnly === true ? { revokedAt: null } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.trunc(query.limit), COLLABORATION_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    grantId: string,
    expectedRevision: number,
    input: { role?: DocumentPermissionRole; expiresAt?: Date | null },
  ): Promise<DocumentPermissionGrant | null> {
    const result = await this.prisma.documentPermissionGrant.updateMany({
      // `revokedAt: null` is in the predicate: a revoked grant is terminal, and
      // re-arming one through an edit is exactly the escalation that revocation
      // exists to prevent.
      where: { id: grantId, workspaceId, revision: expectedRevision, revokedAt: null },
      data: {
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, grantId);
  }

  async revoke(
    workspaceId: string,
    grantId: string,
    actorId: string,
    revokedAt: Date,
  ): Promise<DocumentPermissionGrant | null> {
    const result = await this.prisma.documentPermissionGrant.updateMany({
      where: { id: grantId, workspaceId, revokedAt: null },
      data: { revokedAt, revokedById: actorId, revision: { increment: 1 } },
    });
    // Idempotent: a second revoke matches nothing and returns the existing row
    // with its original timestamp, because the moment access was withdrawn is
    // the fact worth keeping. Null only when the grant does not exist here.
    if (result.count === 0) return this.getById(workspaceId, grantId);
    return this.getById(workspaceId, grantId);
  }

  async countActiveForDocument(
    workspaceId: string,
    documentId: string,
    now: Date,
  ): Promise<number> {
    return this.prisma.documentPermissionGrant.count({
      where: {
        workspaceId,
        documentId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    });
  }
}
