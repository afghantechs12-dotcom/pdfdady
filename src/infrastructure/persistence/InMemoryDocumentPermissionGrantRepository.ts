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

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-grant-${counter}`;
}

interface StoredGrant {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  granteeUserId: string;
  role: string;
  grantedById: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedById: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory DocumentPermissionGrantRepository — for tests and as a
 * zero-dependency fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping and, critically, its *active*
 * predicate: revocation and expiry are re-evaluated on every lookup rather than
 * cached, because a grant is a standing capability whose validity only matters
 * at the moment it is exercised.
 */
export class InMemoryDocumentPermissionGrantRepository
  implements DocumentPermissionGrantRepository
{
  private readonly rows = new Map<string, StoredGrant>();
  private tick = 0;

  private now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, 0, 0) + this.tick * 1000);
  }

  private toDomain(row: StoredGrant): DocumentPermissionGrant {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      granteeUserId: row.granteeUserId,
      // A row holding a role this build does not know degrades to the weakest
      // one rather than being trusted: an unknown role must never read as more.
      role: (isDocumentPermissionRole(row.role) ? row.role : "viewer") as DocumentPermissionRole,
      grantedById: row.grantedById,
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
      revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
      revokedById: row.revokedById,
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  async create(input: CreateDocumentPermissionGrantInput): Promise<DocumentPermissionGrant> {
    const now = this.now();
    const row: StoredGrant = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      granteeUserId: input.granteeUserId,
      role: input.role,
      grantedById: input.grantedById,
      expiresAt: input.expiresAt,
      revokedAt: null,
      revokedById: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, grantId: string): Promise<DocumentPermissionGrant | null> {
    const row = this.rows.get(grantId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async findActiveForUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    now: Date,
  ): Promise<DocumentPermissionGrant | null> {
    const live = [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === workspaceId &&
        row.documentId === documentId &&
        row.granteeUserId === userId &&
        row.revokedAt === null &&
        (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
    );
    if (live.length === 0) return null;
    // The strongest grant wins when several are live: revoking one of two shares
    // must not silently leave the weaker one deciding.
    const strongest = live.reduce((best, row) => {
      const bestRank = documentPermissionRank(this.toDomain(best).role);
      const rowRank = documentPermissionRank(this.toDomain(row).role);
      return rowRank > bestRank ? row : best;
    });
    return this.toDomain(strongest);
  }

  async findLiveForUser(
    workspaceId: string,
    documentId: string,
    userId: string,
  ): Promise<DocumentPermissionGrant | null> {
    const live = [...this.rows.values()]
      .filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.documentId === documentId &&
          row.granteeUserId === userId &&
          row.revokedAt === null,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    return live.length === 0 ? null : this.toDomain(live[0]);
  }

  async list(query: DocumentPermissionGrantListQuery): Promise<DocumentPermissionGrant[]> {
    const matching = [...this.rows.values()].filter((row) => {
      if (row.workspaceId !== query.workspaceId) return false;
      if (row.documentId !== query.documentId) return false;
      if (query.activeOnly === true && row.revokedAt !== null) return false;
      return true;
    });
    return matching
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, Math.min(Math.trunc(query.limit), COLLABORATION_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async update(
    workspaceId: string,
    grantId: string,
    expectedRevision: number,
    input: { role?: DocumentPermissionRole; expiresAt?: Date | null },
  ): Promise<DocumentPermissionGrant | null> {
    const row = this.rows.get(grantId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.revision !== expectedRevision) return null;
    // A revoked grant is terminal: re-arming it would let a revocation be undone
    // by an edit, which is exactly the escalation revocation exists to prevent.
    if (row.revokedAt !== null) return null;
    if (input.role !== undefined) row.role = input.role;
    if (input.expiresAt !== undefined) row.expiresAt = input.expiresAt;
    row.revision += 1;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async revoke(
    workspaceId: string,
    grantId: string,
    actorId: string,
    revokedAt: Date,
  ): Promise<DocumentPermissionGrant | null> {
    const row = this.rows.get(grantId);
    if (!row || row.workspaceId !== workspaceId) return null;
    // Idempotent: revoking twice succeeds without moving the original timestamp,
    // because the moment access was withdrawn is the fact worth keeping.
    if (row.revokedAt !== null) return this.toDomain(row);
    row.revokedAt = revokedAt;
    row.revokedById = actorId;
    row.revision += 1;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async countActiveForDocument(
    workspaceId: string,
    documentId: string,
    now: Date,
  ): Promise<number> {
    return [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === workspaceId &&
        row.documentId === documentId &&
        row.revokedAt === null &&
        (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
    ).length;
  }
}
