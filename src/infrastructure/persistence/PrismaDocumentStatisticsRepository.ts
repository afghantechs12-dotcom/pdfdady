import type { PrismaClient, DocumentStatistics as StatisticsRow } from "@prisma/client";
import type {
  DocumentStatistics,
  StatisticsStatus,
} from "@/src/domain/entities/DocumentStatistics";
import {
  STATISTICS_LIMITS,
  isStatisticsStatus,
  parseCounts,
  serializeCounts,
} from "@/src/domain/entities/DocumentStatistics";
import type {
  DocumentStatisticsRepository,
  UpsertDocumentStatisticsInput,
} from "@/src/application/ports/workspaces/DocumentStatisticsRepository";

function toDomain(row: StatisticsRow): DocumentStatistics {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    versionId: row.versionId,
    schemaVersion:
      Number.isFinite(row.schemaVersion) && row.schemaVersion >= 1
        ? Math.trunc(row.schemaVersion)
        : 1,
    // Tolerant: a field this build no longer understands degrades to "not
    // measured" rather than failing the whole read.
    counts: parseCounts(row.counts),
    checksum: row.checksum,
    status: (isStatisticsStatus(row.status) ? row.status : "pending") as StatisticsStatus,
    error: row.error,
    calculatedAt: row.calculatedAt === null ? null : new Date(row.calculatedAt),
    revision: Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed DocumentStatisticsRepository.
 *
 * `upsert` keys on `versionId`, which the schema makes unique. That is what
 * makes a recompute converge on one row rather than accumulating a second set of
 * numbers for the same immutable bytes — and it is why a redelivered
 * calculation job is harmless.
 *
 * Reads carry `workspaceId`, so a statistics row from another tenant reads as
 * missing. A count must never confirm a document the actor cannot see.
 */
export class PrismaDocumentStatisticsRepository implements DocumentStatisticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertDocumentStatisticsInput): Promise<DocumentStatistics> {
    const counts = serializeCounts(input.counts);
    const row = await this.prisma.documentStatistics.upsert({
      where: { versionId: input.versionId },
      create: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        versionId: input.versionId,
        schemaVersion: input.schemaVersion,
        counts,
        checksum: input.checksum,
        status: input.status,
        error: input.error,
        calculatedAt: input.calculatedAt,
      },
      update: {
        schemaVersion: input.schemaVersion,
        counts,
        checksum: input.checksum,
        status: input.status,
        error: input.error,
        calculatedAt: input.calculatedAt,
        revision: { increment: 1 },
      },
    });
    return toDomain(row);
  }

  async getByVersionId(
    workspaceId: string,
    versionId: string,
  ): Promise<DocumentStatistics | null> {
    const row = await this.prisma.documentStatistics.findFirst({
      where: { versionId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async listForDocument(
    workspaceId: string,
    documentId: string,
    limit: number,
  ): Promise<DocumentStatistics[]> {
    const rows = await this.prisma.documentStatistics.findMany({
      where: { workspaceId, documentId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.trunc(limit), STATISTICS_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
  }

  async delete(workspaceId: string, versionId: string): Promise<boolean> {
    const result = await this.prisma.documentStatistics.deleteMany({
      where: { versionId, workspaceId },
    });
    return result.count > 0;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.documentStatistics.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count;
  }
}
