import type {
  ComparisonDifference,
  ComparisonResult,
  ComparisonSummary,
  ComparisonType,
} from "@/src/domain/entities/DocumentStatistics";
import {
  STATISTICS_LIMITS,
  emptySummary,
  isComparisonType,
} from "@/src/domain/entities/DocumentStatistics";
import type {
  ComparisonResultRepository,
  CreateComparisonResultInput,
} from "@/src/application/ports/workspaces/ComparisonResultRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-result-${counter}`;
}

interface StoredResult {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  comparisonId: string;
  type: string;
  summary: string;
  differences: string;
  checksum: string;
  createdAt: Date;
}

/**
 * Reads a stored summary back tolerantly. A row written by another build
 * degrades to "no differences recorded" rather than failing the read — and it is
 * distinguishable from a real empty result by the operation that produced it.
 */
export function parseSummary(serialized: unknown): ComparisonSummary {
  if (typeof serialized !== "string" || serialized.trim() === "") return emptySummary();
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return emptySummary();
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return emptySummary();
  const record = raw as Record<string, unknown>;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
  const pages = (value: unknown): number[] =>
    Array.isArray(value)
      ? value
          .filter((page): page is number => typeof page === "number" && Number.isInteger(page) && page >= 1)
          .slice(0, STATISTICS_LIMITS.maxComparedPages)
      : [];
  return {
    added: count(record.added),
    removed: count(record.removed),
    changed: count(record.changed),
    pagesAdded: pages(record.pagesAdded),
    pagesRemoved: pages(record.pagesRemoved),
    truncated: record.truncated === true,
  };
}

/** Reads a stored difference list back, bounded and tolerant. */
export function parseDifferences(serialized: unknown): ComparisonDifference[] {
  if (typeof serialized !== "string" || serialized.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const differences: ComparisonDifference[] = [];
  for (const entry of raw.slice(0, STATISTICS_LIMITS.maxDifferences)) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (record.kind !== "added" && record.kind !== "removed" && record.kind !== "changed") continue;
    const pageNumber =
      typeof record.pageNumber === "number" && Number.isInteger(record.pageNumber)
        ? record.pageNumber
        : null;
    const excerpt =
      typeof record.excerpt === "string"
        ? [...record.excerpt].slice(0, STATISTICS_LIMITS.maxExcerptLength + 1).join("")
        : null;
    differences.push({ kind: record.kind, pageNumber, excerpt });
  }
  return differences;
}

/**
 * In-memory ComparisonResultRepository — for tests and as a zero-dependency
 * fallback.
 *
 * Mirrors the Prisma adapter's one-result-per-operation uniqueness, so a
 * redelivered completion converges on the existing artifact instead of writing a
 * second one.
 */
export class InMemoryComparisonResultRepository implements ComparisonResultRepository {
  private readonly rows = new Map<string, StoredResult>();
  private tick = 0;

  private now(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 7, 3, 12, 0, 0, 0) + this.tick * 1000);
  }

  private toDomain(row: StoredResult): ComparisonResult {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      comparisonId: row.comparisonId,
      type: (isComparisonType(row.type) ? row.type : "structural") as ComparisonType,
      summary: parseSummary(row.summary),
      differences: parseDifferences(row.differences),
      checksum: row.checksum,
      createdAt: new Date(row.createdAt),
    };
  }

  async create(input: CreateComparisonResultInput): Promise<ComparisonResult> {
    // One result per operation: a redelivered completion converges rather than
    // writing a second artifact.
    const existing = [...this.rows.values()].find(
      (row) => row.workspaceId === input.workspaceId && row.comparisonId === input.comparisonId,
    );
    if (existing) return this.toDomain(existing);

    const row: StoredResult = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      comparisonId: input.comparisonId,
      type: input.type,
      summary: JSON.stringify(input.summary),
      differences: JSON.stringify(
        input.differences.slice(0, STATISTICS_LIMITS.maxDifferences),
      ),
      checksum: input.checksum,
      createdAt: this.now(),
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, resultId: string): Promise<ComparisonResult | null> {
    const row = this.rows.get(resultId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async getByComparisonId(
    workspaceId: string,
    comparisonId: string,
  ): Promise<ComparisonResult | null> {
    const row = [...this.rows.values()].find(
      (candidate) => candidate.workspaceId === workspaceId && candidate.comparisonId === comparisonId,
    );
    return row ? this.toDomain(row) : null;
  }

  async delete(workspaceId: string, resultId: string): Promise<boolean> {
    const row = this.rows.get(resultId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(resultId);
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    let removed = 0;
    for (const [id, row] of [...this.rows.entries()]) {
      if (row.workspaceId !== workspaceId || row.documentId !== documentId) continue;
      this.rows.delete(id);
      removed += 1;
    }
    return removed;
  }
}
