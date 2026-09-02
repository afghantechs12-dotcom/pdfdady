import type {
  DocumentStatistics,
  StatisticsCounts,
  StatisticsStatus,
} from "@/src/domain/entities/DocumentStatistics";

export interface UpsertDocumentStatisticsInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string;
  schemaVersion: number;
  counts: StatisticsCounts;
  checksum: string;
  status: StatisticsStatus;
  error: string | null;
  calculatedAt: Date | null;
}

/**
 * Version-keyed document statistics.
 *
 * One row per version, which is what makes a recompute converge rather than
 * accumulate a second set of numbers for the same immutable bytes. Every
 * predicate carries `workspaceId`, so a statistics row belonging to another
 * tenant reads as missing rather than as forbidden — a count must never confirm
 * a document the actor cannot see.
 *
 * There is deliberately no `getForDocument`: statistics describe a *version*,
 * and a method that returned "the document's statistics" would have to guess
 * which version the caller meant.
 */
export interface DocumentStatisticsRepository {
  /** Creates or replaces the row for one version. */
  upsert(input: UpsertDocumentStatisticsInput): Promise<DocumentStatistics>;

  getByVersionId(workspaceId: string, versionId: string): Promise<DocumentStatistics | null>;

  /** Bounded bulk read, for showing statistics across a version list. */
  listForDocument(
    workspaceId: string,
    documentId: string,
    limit: number,
  ): Promise<DocumentStatistics[]>;

  delete(workspaceId: string, versionId: string): Promise<boolean>;

  /** Removes every row for a document. Used when the document is purged. */
  deleteForDocument(workspaceId: string, documentId: string): Promise<number>;
}
