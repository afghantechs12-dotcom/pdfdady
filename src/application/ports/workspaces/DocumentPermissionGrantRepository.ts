import type {
  DocumentPermissionGrant,
  DocumentPermissionRole,
} from "@/src/domain/entities/Collaboration";

export interface CreateDocumentPermissionGrantInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  granteeUserId: string;
  role: DocumentPermissionRole;
  grantedById: string;
  expiresAt: Date | null;
}

export interface DocumentPermissionGrantListQuery {
  workspaceId: string;
  documentId: string;
  /** When true, revoked grants are excluded. Expiry is evaluated by the caller. */
  activeOnly?: boolean;
  limit: number;
}

/**
 * Document-scoped permission grants.
 *
 * A grant is a *standing capability*, so the only moment its validity matters is
 * the moment it is exercised — which is why `findActiveForUser` re-evaluates
 * revocation and expiry on every call rather than trusting a cached decision.
 *
 * Revoked grants are retained rather than deleted: "who could see this, and
 * until when" is an audit question, and a deleted row cannot answer it. They are
 * excluded from active lookups by predicate, not by absence.
 */
export interface DocumentPermissionGrantRepository {
  create(input: CreateDocumentPermissionGrantInput): Promise<DocumentPermissionGrant>;

  getById(workspaceId: string, grantId: string): Promise<DocumentPermissionGrant | null>;

  /**
   * The strongest *currently valid* grant for one user on one document, or null.
   * Implementations must exclude revoked grants and grants whose expiry has
   * passed relative to `now`.
   */
  findActiveForUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    now: Date,
  ): Promise<DocumentPermissionGrant | null>;

  /**
   * Any existing non-revoked grant for this grantee, whatever its role. Lets the
   * service converge a duplicate share onto the existing row instead of stacking
   * grants that would each have to be revoked separately.
   */
  findLiveForUser(
    workspaceId: string,
    documentId: string,
    userId: string,
  ): Promise<DocumentPermissionGrant | null>;

  list(query: DocumentPermissionGrantListQuery): Promise<DocumentPermissionGrant[]>;

  /** Compare-and-swap role/expiry change on a live grant. */
  update(
    workspaceId: string,
    grantId: string,
    expectedRevision: number,
    input: { role?: DocumentPermissionRole; expiresAt?: Date | null },
  ): Promise<DocumentPermissionGrant | null>;

  /**
   * Marks a grant revoked. Idempotent: revoking an already-revoked grant
   * succeeds without moving the original revocation timestamp, because the
   * moment access was withdrawn is the fact worth keeping.
   */
  revoke(
    workspaceId: string,
    grantId: string,
    actorId: string,
    revokedAt: Date,
  ): Promise<DocumentPermissionGrant | null>;

  countActiveForDocument(workspaceId: string, documentId: string, now: Date): Promise<number>;
}
