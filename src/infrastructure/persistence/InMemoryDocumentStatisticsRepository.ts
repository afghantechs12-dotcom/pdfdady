import type { DocumentStatistics, StatisticsStatus } from "@/src/domain/entities/DocumentStatistics";
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

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-stats-${counter}`;
}

/** Stored in the column shape the database uses: counts as serialized text. */
interface StoredStatistics {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  schemaVersion: number;
  counts: string;
  checksum: string;
  status: string;
  error: string | null;
  calculatedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory DocumentStatisticsRepository — for tests and as a zero-dependency
 * fallback.
 *
 * Mirrors the Prisma adapter's one-row-per-version uniqueness, its Workspace
 * scoping and its tolerant count parsing. Counts are held as serialized text
 * rather than as an object, so a row written by another build degrades here
 * exactly as it would in the database.
 */
export class InMemoryDocumentStatisticsRepository implements DocumentStatisticsRepository {
  private readonly rows = new Map<string, StoredStatistics>();
  private tick = 0;

  private now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, 0, 0) + this.tick * 1000);
  }

  private toDomain(row: StoredStatistics): DocumentStatistics {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      versionId: row.versionId,
      schemaVersion: row.schemaVersion,
      counts: parseCounts(row.counts),
      checksum: row.checksum,
      status: (isStatisticsStatus(row.status) ? row.status : "pending") as StatisticsStatus,
      error: row.error,
      calculatedAt: row.calculatedAt === null ? null : new Date(row.calculatedAt),
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  /** Keyed by version: one statistics row per version, as the unique index says. */
  private keyFor(workspaceId: string, versionId: string): string {
    return `${workspaceId}:${versionId}`;
  }

  async upsert(input: UpsertDocumentStatisticsInput): Promise<DocumentStatistics> {
    const key = this.keyFor(input.workspaceId, input.versionId);
    const existing = this.rows.get(key);
    const now = this.now();
    if (existing) {
      existing.counts = serializeCounts(input.counts);
      existing.checksum = input.checksum;
      existing.status = input.status;
      existing.error = input.error;
      existing.calculatedAt = input.calculatedAt;
      existing.schemaVersion = input.schemaVersion;
      existing.revision += 1;
      existing.updatedAt = now;
      return this.toDomain(existing);
    }
    const row: StoredStatistics = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      versionId: input.versionId,
      schemaVersion: input.schemaVersion,
      counts: serializeCounts(input.counts),
      checksum: input.checksum,
      status: input.status,
      error: input.error,
      calculatedAt: input.calculatedAt,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return this.toDomain(row);
  }

  async getByVersionId(
    workspaceId: string,
    versionId: string,
  ): Promise<DocumentStatistics | null> {
    // Scoped by Workspace as well as version: a row from another tenant reads as
    // missing rather than as forbidden.
    const row = this.rows.get(this.keyFor(workspaceId, versionId));
    return row ? this.toDomain(row) : null;
  }

  async listForDocument(
    workspaceId: string,
    documentId: string,
    limit: number,
  ): Promise<DocumentStatistics[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.documentId === documentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, Math.min(Math.trunc(limit), STATISTICS_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async delete(workspaceId: string, versionId: string): Promise<boolean> {
    return this.rows.delete(this.keyFor(workspaceId, versionId));
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    let removed = 0;
    for (const [key, row] of [...this.rows.entries()]) {
      if (row.workspaceId !== workspaceId || row.documentId !== documentId) continue;
      this.rows.delete(key);
      removed += 1;
    }
    return removed;
  }
}
