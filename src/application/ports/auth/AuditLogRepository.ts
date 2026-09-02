import type { AuditLog, ActorType } from "@/src/domain/entities/AuditLog";

/**
 * AuditLogRepository port — append-only security audit log. The auth flow
 * records register/login/logout here; M2.8 (enterprise) adds org/billing/api-
 * key events. Reads are admin-gated. `metadata` is an arbitrary JSON-serializable
 * object (the adapter serializes to the DB's string column).
 */
export interface AuditEventInput {
  actorType: ActorType;
  actorId?: string | null;
  organizationId?: string | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: unknown;
  ip?: string | null;
}

export interface IAuditLogRepository {
  record(input: AuditEventInput): Promise<AuditLog>;
  listByOrg(organizationId: string, limit?: number): Promise<AuditLog[]>;
}
