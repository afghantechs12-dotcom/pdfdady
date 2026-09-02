/** Audit log domain entity — append-only record of security-relevant actions. */
export type ActorType = "user" | "api_key" | "system";

export interface AuditLog {
  id: string;
  actorType: ActorType;
  actorId: string | null;
  organizationId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  /** Deserialized metadata (stored as JSON string in the DB). */
  metadata: unknown;
  ip: string | null;
  createdAt: Date;
}
