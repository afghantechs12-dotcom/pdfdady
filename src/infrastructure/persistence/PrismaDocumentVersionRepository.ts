import type { PrismaClient, DocumentVersion as DocumentVersionRow } from "@prisma/client";
import type { DocumentVersion, DocumentVersionOrigin } from "@/src/domain/entities/DocumentVersion";
import {
  DOCUMENT_VERSION_LIMITS as L,
  documentVersionListLimit,
  isDocumentVersionOrigin,
  readManifest,
} from "@/src/domain/entities/DocumentVersion";
import type {
  CreateDocumentVersionInput,
  DocumentVersionListQuery,
  DocumentVersionRepository,
} from "@/src/application/ports/workspaces/DocumentVersionRepository";

/**
 * `origin` is a plain String column (SQLite portability), so a row could hold a
 * value outside the union. An unrecognized origin degrades to "checkpoint"
 * rather than being cast blindly: a version of unknown provenance must not be
 * presented as an ordinary save or, worse, as a restore.
 */
function toOrigin(value: string): DocumentVersionOrigin {
  return isDocumentVersionOrigin(value) ? value : "checkpoint";
}

/** Keeps a stored counter finite and non-negative even if a row was written badly. */
function toCounter(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(0, Math.trunc(value)), L.maxCounter);
}

function toDomain(row: DocumentVersionRow): DocumentVersion {
  const { manifest, degraded } = readManifest(row.manifest);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    documentId: row.documentId,
    versionNumber: toCounter(row.versionNumber, 0),
    revision: toCounter(row.revision, 0),
    origin: toOrigin(row.origin),
    restoredFromVersionId: row.restoredFromVersionId,
    label: row.label?.slice(0, L.maxLabelLength) ?? null,
    manifest,
    manifestDegraded: degraded,
    checksum: row.checksum,
    createdById: row.createdById,
    // Copied, not aliased: a caller mutating this Date must not reach the row.
    createdAt: new Date(row.createdAt),
  };
}

/** Whether a thrown error is Prisma's unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export class PrismaDocumentVersionRepository implements DocumentVersionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Inserts a version, allocating its number inside a transaction.
   *
   * The allocation deliberately does *not* trust a number read outside the
   * transaction. Each attempt re-reads the document's authoritative maximum and
   * inserts; if a concurrent writer took that number first, the unique index on
   * (documentId, versionNumber) rejects the insert and the next attempt re-reads
   * a maximum that now includes the winner. This is why version numbers are
   * never duplicated and never silently skipped by a lost update
   * (docs/milestone-7-plan.md 6.2).
   */
  async create(input: CreateDocumentVersionInput): Promise<DocumentVersion> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < L.maxAllocationAttempts; attempt += 1) {
      try {
        const row = await this.prisma.$transaction(async (tx) => {
          const highest = await tx.documentVersion.findFirst({
            where: { documentId: input.documentId },
            orderBy: { versionNumber: "desc" },
            select: { versionNumber: true },
          });
          const versionNumber = (highest?.versionNumber ?? 0) + 1;

          return tx.documentVersion.create({
            data: {
              workspaceId: input.workspaceId,
              organizationId: input.organizationId,
              documentId: input.documentId,
              versionNumber,
              revision: input.revision,
              origin: input.origin,
              restoredFromVersionId: input.restoredFromVersionId,
              label: input.label === null ? null : input.label.slice(0, L.maxLabelLength),
              manifest: input.manifest,
              checksum: input.checksum,
              createdById: input.createdById,
            },
          });
        });
        return toDomain(row);
      } catch (error) {
        // Only a version-number collision is retryable; anything else is a real
        // failure and must surface rather than be retried into a timeout.
        if (!isUniqueViolation(error)) throw error;
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Could not allocate a version number after repeated contention.");
  }

  async getById(workspaceId: string, versionId: string): Promise<DocumentVersion | null> {
    // Scoped by workspace as well as id, so an id belonging to another tenant
    // reads as missing rather than as forbidden.
    const row = await this.prisma.documentVersion.findFirst({
      where: { id: versionId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async getByNumber(
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<DocumentVersion | null> {
    const row = await this.prisma.documentVersion.findFirst({
      where: { workspaceId, documentId, versionNumber },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: DocumentVersionListQuery): Promise<DocumentVersion[]> {
    const rows = await this.prisma.documentVersion.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.beforeVersionNumber === undefined
          ? {}
          : { versionNumber: { lt: query.beforeVersionNumber } }),
      },
      orderBy: { versionNumber: "desc" },
      take: documentVersionListLimit(query.limit),
    });
    return rows.map(toDomain);
  }

  async latest(workspaceId: string, documentId: string): Promise<DocumentVersion | null> {
    const row = await this.prisma.documentVersion.findFirst({
      where: { workspaceId, documentId },
      orderBy: { versionNumber: "desc" },
    });
    return row ? toDomain(row) : null;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.documentVersion.count({ where: { workspaceId, documentId } });
  }

  /**
   * Whether another version still references an artifact key.
   *
   * The manifest is stored as an opaque JSON string, so this cannot be a column
   * predicate. `contains` narrows the scan at the database, and every candidate
   * is then confirmed against the parsed manifest — a substring match alone
   * would report a false reference for a key that merely shares a prefix, which
   * would leak artifacts by never letting them be collected.
   */
  async isArtifactReferenced(
    workspaceId: string,
    key: string,
    excludingVersionId?: string,
  ): Promise<boolean> {
    if (!key) return false;
    const candidates = await this.prisma.documentVersion.findMany({
      where: {
        workspaceId,
        manifest: { contains: key },
        ...(excludingVersionId === undefined ? {} : { id: { not: excludingVersionId } }),
      },
      select: { manifest: true },
      take: L.maxListLimit,
    });
    return candidates.some((candidate) => {
      const { manifest } = readManifest(candidate.manifest);
      return (
        manifest.sourceKey === key ||
        manifest.editorStateKey === key ||
        manifest.outputKey === key ||
        manifest.thumbnailKeys.includes(key)
      );
    });
  }

  async delete(workspaceId: string, versionId: string): Promise<boolean> {
    const result = await this.prisma.documentVersion.deleteMany({
      where: { id: versionId, workspaceId },
    });
    return result.count > 0;
  }
}
