import type {
  ComparisonDifference,
  ComparisonResult,
  ComparisonSummary,
  ComparisonType,
} from "@/src/domain/entities/DocumentStatistics";

export interface CreateComparisonResultInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  comparisonId: string;
  type: ComparisonType;
  summary: ComparisonSummary;
  differences: ComparisonDifference[];
  checksum: string;
}

/**
 * Comparison results.
 *
 * Immutable by design: there is no `update`, and the absence of the method is
 * what enforces it. A result records what two specific versions differed by, and
 * those versions cannot change — so a result that could be edited would be a
 * result that no longer described anything.
 *
 * One row per operation (`@@unique([comparisonId])`), so a redelivered
 * completion converges on the existing artifact instead of writing a second one.
 */
export interface ComparisonResultRepository {
  create(input: CreateComparisonResultInput): Promise<ComparisonResult>;

  getById(workspaceId: string, resultId: string): Promise<ComparisonResult | null>;

  getByComparisonId(workspaceId: string, comparisonId: string): Promise<ComparisonResult | null>;

  /** Removes a result. Safe because results are derived and rebuildable. */
  delete(workspaceId: string, resultId: string): Promise<boolean>;

  deleteForDocument(workspaceId: string, documentId: string): Promise<number>;
}
