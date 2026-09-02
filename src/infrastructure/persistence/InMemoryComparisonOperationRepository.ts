import type {
  ComparisonOperation,
  ComparisonStatus,
  ComparisonType,
} from "@/src/domain/entities/DocumentStatistics";
import {
  STATISTICS_LIMITS,
  isComparisonStatus,
  isComparisonType,
  isTerminalComparisonStatus,
  progressForStatus,
} from "@/src/domain/entities/DocumentStatistics";
import type {
  ComparisonOperationListQuery,
  ComparisonOperationRepository,
  CreateComparisonOperationInput,
} from "@/src/application/ports/workspaces/ComparisonOperationRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-comparison-${counter}`;
}

interface StoredOperation {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  leftVersionId: string;
  rightVersionId: string;
  type: string;
  status: string;
  progress: number;
  requestedById: string;
  cancelRequestedAt: Date | null;
  error: string | null;
  resultId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

/**
 * In-memory ComparisonOperationRepository — for tests and as a zero-dependency
 * fallback.
 *
 * Mirrors the Prisma adapter's compare-and-swap on *status* rather than on a
 * revision counter, which is what makes a duplicate worker delivery idempotent:
 * the second arrival finds the state already moved and is refused.
 */
export class InMemoryComparisonOperationRepository implements ComparisonOperationRepository {
  private readonly rows = new Map<string, StoredOperation>();
  private tick = 0;

  private now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, 0, 0) + this.tick * 1000);
  }

  private toDomain(row: StoredOperation): ComparisonOperation {
    // A row written by another build may hold a status or type this build does
    // not know. Both degrade to the safest reading rather than being trusted.
    const status = (isComparisonStatus(row.status) ? row.status : "pending") as ComparisonStatus;
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      leftVersionId: row.leftVersionId,
      rightVersionId: row.rightVersionId,
      type: (isComparisonType(row.type) ? row.type : "structural") as ComparisonType,
      status,
      // Progress is derived from the status so a client never sees
      // "completed, 60%".
      progress: progressForStatus(status, row.progress),
      requestedById: row.requestedById,
      cancelRequestedAt:
        row.cancelRequestedAt === null ? null : new Date(row.cancelRequestedAt),
      error: row.error,
      resultId: row.resultId,
      createdAt: new Date(row.createdAt),
      startedAt: row.startedAt === null ? null : new Date(row.startedAt),
      completedAt: row.completedAt === null ? null : new Date(row.completedAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  async create(input: CreateComparisonOperationInput): Promise<ComparisonOperation> {
    const now = this.now();
    const row: StoredOperation = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      leftVersionId: input.leftVersionId,
      rightVersionId: input.rightVersionId,
      type: input.type,
      status: "pending",
      progress: 0,
      requestedById: input.requestedById,
      cancelRequestedAt: null,
      error: null,
      resultId: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, comparisonId: string): Promise<ComparisonOperation | null> {
    const row = this.rows.get(comparisonId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async list(query: ComparisonOperationListQuery): Promise<ComparisonOperation[]> {
    return [...this.rows.values()]
      .filter((row) => {
        if (row.workspaceId !== query.workspaceId) return false;
        if (row.documentId !== query.documentId) return false;
        if (query.status !== undefined && row.status !== query.status) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, Math.min(Math.trunc(query.limit), STATISTICS_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async transition(
    workspaceId: string,
    comparisonId: string,
    expectedStatus: ComparisonStatus,
    status: ComparisonStatus,
    patch: {
      progress?: number;
      error?: string | null;
      resultId?: string | null;
      startedAt?: Date | null;
      completedAt?: Date | null;
    },
  ): Promise<ComparisonOperation | null> {
    const row = this.rows.get(comparisonId);
    if (!row || row.workspaceId !== workspaceId) return null;
    // The compare-and-swap: a redelivered transition finds the state already
    // moved and is refused, rather than replaying.
    if (row.status !== expectedStatus) return null;
    row.status = status;
    if (patch.progress !== undefined) row.progress = patch.progress;
    if (patch.error !== undefined) row.error = patch.error;
    if (patch.resultId !== undefined) row.resultId = patch.resultId;
    if (patch.startedAt !== undefined) row.startedAt = patch.startedAt;
    if (patch.completedAt !== undefined) row.completedAt = patch.completedAt;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async reportProgress(
    workspaceId: string,
    comparisonId: string,
    progress: number,
  ): Promise<ComparisonOperation | null> {
    const row = this.rows.get(comparisonId);
    if (!row || row.workspaceId !== workspaceId) return null;
    // A slow worker must not animate a finished operation.
    if (isTerminalComparisonStatus(row.status as ComparisonStatus)) return null;
    row.progress = progress;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async requestCancellation(
    workspaceId: string,
    comparisonId: string,
    requestedAt: Date,
  ): Promise<ComparisonOperation | null> {
    const row = this.rows.get(comparisonId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (isTerminalComparisonStatus(row.status as ComparisonStatus)) return null;
    // Idempotent: the first request is the one that counts.
    if (row.cancelRequestedAt === null) row.cancelRequestedAt = requestedAt;
    row.updatedAt = this.now();
    return this.toDomain(row);
  }

  async countActiveForDocument(workspaceId: string, documentId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === workspaceId &&
        row.documentId === documentId &&
        !isTerminalComparisonStatus(row.status as ComparisonStatus),
    ).length;
  }

  async delete(workspaceId: string, comparisonId: string): Promise<boolean> {
    const row = this.rows.get(comparisonId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(comparisonId);
  }
}
