import { PrismaClient } from "@prisma/client";
import type { AuditLog, ActorType } from "@/src/domain/entities/AuditLog";
import type {
  IAuditLogRepository,
  AuditEventInput,
} from "@/src/application/ports/auth/AuditLogRepository";

type AuditRow = {
  id: string;
  actorType: string;
  actorId: string | null;
  organizationId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: string | null;
  ip: string | null;
  createdAt: Date;
};

function safeParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toDomain(row: AuditRow): AuditLog {
  return {
    id: row.id,
    actorType: row.actorType as ActorType,
    actorId: row.actorId,
    organizationId: row.organizationId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: safeParse(row.metadata),
    ip: row.ip,
    createdAt: row.createdAt,
  };
}

/** Prisma-backed AuditLogRepository against the `audit_logs` table. */
export class PrismaAuditLogRepository implements IAuditLogRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async record(input: AuditEventInput): Promise<AuditLog> {
    const row = await this.prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        organizationId: input.organizationId ?? null,
        action: input.action,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        ip: input.ip ?? null,
      },
    });
    return toDomain(row);
  }

  async listByOrg(organizationId: string, limit = 100): Promise<AuditLog[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { organizationId },
      take: limit,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(toDomain);
  }
}
