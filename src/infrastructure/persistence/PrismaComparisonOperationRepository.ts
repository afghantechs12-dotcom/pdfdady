import type { PrismaClient, ComparisonOperation as OperationRow } from "@prisma/client";
import type {
  ComparisonOperation,
  ComparisonStatus,
  ComparisonType,
} from "@/src/domain/entities/DocumentStatistics";
import {
  STATISTICS_LIMITS,
  isComparisonStatus,
  isComparisonType,
  progressForStatus,
} from "@/src/domain/entities/DocumentStatistics";
import type {
  ComparisonOperationListQuery,
  ComparisonOperationRepository,
  CreateComparisonOperationInput,
} from "@/src/application/ports/workspaces/ComparisonOperationRepository";

/** The non-terminal states, as a SQL predicate. */
const ACTIVE_STATUSES: ComparisonStatus[] = ["pending", "running"];

function toDomain(row: OperationRow): ComparisonOperation {
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
    // Derived from status, so a client never sees "completed, 60%" after a
    // worker died between its last progress report and its completion write.
    progress: progressForStatus(status, row.progress),
    requestedById: row.requestedById,
    cancelRequestedAt: row.cancelRequestedAt === null ? null : new Date(row.cancelRequestedAt),
    error: row.error,
    resultId: row.resultId,
    createdAt: new Date(row.createdAt),
    startedAt: row.startedAt === null ? null : new Date(row.startedAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed ComparisonOperationRepository.
 *
 * `transition` compares and swaps on the *current status* rather than on a
 * revision counter. The rule being enforced is "this transition is legal from
 * this state", and a revision check would happily permit an illegal transition
 * that arrived with the right number. Because the check is in the `where`
 * clause, a duplicate worker delivery finds the state already moved and updates
 * nothing — which is what makes redelivery idempotent rather than replayed.
 */
export class PrismaComparisonOperationRepository implements ComparisonOperationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateComparisonOperationInput): Promise<ComparisonOperation> {
    const row = await this.prisma.comparisonOperation.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        leftVersionId: input.leftVersionId,
        rightVersionId: input.rightVersionId,
        type: input.type,
        requestedById: input.requestedById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, comparisonId: string): Promise<ComparisonOperation | null> {
    const row = await this.prisma.comparisonOperation.findFirst({
      where: { id: comparisonId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: ComparisonOperationListQuery): Promise<ComparisonOperation[]> {
    const rows = await this.prisma.comparisonOperation.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.trunc(query.limit), STATISTICS_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
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
    const result = await this.prisma.comparisonOperation.updateMany({
      // `status: expectedStatus` in the predicate is the atomicity: two workers
      // racing to complete the same operation cannot both succeed.
      where: { id: comparisonId, workspaceId, status: expectedStatus },
      data: {
        status,
        ...(patch.progress === undefined ? {} : { progress: patch.progress }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
        ...(patch.resultId === undefined ? {} : { resultId: patch.resultId }),
        ...(patch.startedAt === undefined ? {} : { startedAt: patch.startedAt }),
        ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, comparisonId);
  }

  async reportProgress(
    workspaceId: string,
    comparisonId: string,
    progress: number,
  ): Promise<ComparisonOperation | null> {
    const result = await this.prisma.comparisonOperation.updateMany({
      // Only while non-terminal: a slow worker must not animate a finished
      // operation, and the guard belongs in the predicate so it is atomic.
      where: { id: comparisonId, workspaceId, status: { in: ACTIVE_STATUSES } },
      data: { progress },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, comparisonId);
  }

  async requestCancellation(
    workspaceId: string,
    comparisonId: string,
    requestedAt: Date,
  ): Promise<ComparisonOperation | null> {
    const result = await this.prisma.comparisonOperation.updateMany({
      // Idempotent: `cancelRequestedAt: null` means a second request matches
      // nothing and leaves the first timestamp in place.
      where: {
        id: comparisonId,
        workspaceId,
        status: { in: ACTIVE_STATUSES },
        cancelRequestedAt: null,
      },
      data: { cancelRequestedAt: requestedAt },
    });
    if (result.count === 0) {
      // Either already requested, or terminal. Report the current row so a
      // repeat request reads as success, but null when it does not exist here.
      const existing = await this.getById(workspaceId, comparisonId);
      if (!existing) return null;
      return existing.cancelRequestedAt !== null ? existing : null;
    }
    return this.getById(workspaceId, comparisonId);
  }

  async countActiveForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.comparisonOperation.count({
      where: { workspaceId, documentId, status: { in: ACTIVE_STATUSES } },
    });
  }

  async delete(workspaceId: string, comparisonId: string): Promise<boolean> {
    const result = await this.prisma.comparisonOperation.deleteMany({
      where: { id: comparisonId, workspaceId },
    });
    return result.count > 0;
  }
}
