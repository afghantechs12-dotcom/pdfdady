import type { PrismaClient, ComparisonResult as ResultRow } from "@prisma/client";
import type { ComparisonResult, ComparisonType } from "@/src/domain/entities/DocumentStatistics";
import { STATISTICS_LIMITS, isComparisonType } from "@/src/domain/entities/DocumentStatistics";
import type {
  ComparisonResultRepository,
  CreateComparisonResultInput,
} from "@/src/application/ports/workspaces/ComparisonResultRepository";
import {
  parseDifferences,
  parseSummary,
} from "./InMemoryComparisonResultRepository";

function toDomain(row: ResultRow): ComparisonResult {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    comparisonId: row.comparisonId,
    type: (isComparisonType(row.type) ? row.type : "structural") as ComparisonType,
    // Shared parsers with the in-memory adapter, so a row cannot be read one way
    // in tests and another in production.
    summary: parseSummary(row.summary),
    differences: parseDifferences(row.differences),
    checksum: row.checksum,
    createdAt: new Date(row.createdAt),
  };
}

/**
 * SQLite-backed ComparisonResultRepository.
 *
 * There is no `update`: a result records what two immutable versions differed
 * by, and those versions cannot change, so an editable result would be one that
 * no longer described anything. `create` converges on the existing row for an
 * operation rather than inserting a second — a redelivered completion is
 * therefore harmless.
 */
export class PrismaComparisonResultRepository implements ComparisonResultRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateComparisonResultInput): Promise<ComparisonResult> {
    const existing = await this.prisma.comparisonResult.findFirst({
      where: { comparisonId: input.comparisonId, workspaceId: input.workspaceId },
    });
    if (existing) return toDomain(existing);

    const row = await this.prisma.comparisonResult.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        comparisonId: input.comparisonId,
        type: input.type,
        summary: JSON.stringify(input.summary),
        // Bounded on the way in as well as on the way out: a pathological pair
        // of documents must not be able to write an unbounded row.
        differences: JSON.stringify(
          input.differences.slice(0, STATISTICS_LIMITS.maxDifferences),
        ),
        checksum: input.checksum,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, resultId: string): Promise<ComparisonResult | null> {
    const row = await this.prisma.comparisonResult.findFirst({
      where: { id: resultId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async getByComparisonId(
    workspaceId: string,
    comparisonId: string,
  ): Promise<ComparisonResult | null> {
    const row = await this.prisma.comparisonResult.findFirst({
      where: { comparisonId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async delete(workspaceId: string, resultId: string): Promise<boolean> {
    const result = await this.prisma.comparisonResult.deleteMany({
      where: { id: resultId, workspaceId },
    });
    return result.count > 0;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.comparisonResult.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count;
  }
}
