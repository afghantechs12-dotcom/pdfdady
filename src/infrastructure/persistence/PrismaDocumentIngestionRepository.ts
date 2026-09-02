import type { PrismaClient, DocumentIngestion as DocumentIngestionRow } from "@prisma/client";
import type {
  DocumentIngestion,
  DocumentIngestionStatus,
} from "@/src/domain/entities/DocumentIngestion";
import { DOCUMENT_INGESTION_LIMITS as L } from "@/src/domain/entities/DocumentIngestion";
import type {
  CreateDocumentIngestionInput,
  DocumentIngestionRepository,
  UpdateDocumentIngestionInput,
} from "@/src/application/ports/workspaces/DocumentIngestionRepository";

const VALID_STATUSES: readonly string[] = ["pending", "processing", "complete", "failed"];

/**
 * `status` is a plain String column (SQLite portability), so a row could in
 * principle hold a value outside the union. An unrecognized status is surfaced
 * as "failed" rather than cast blindly: an ingestion in an unknown state is not
 * safe to treat as complete.
 */
function toStatus(value: string): DocumentIngestionStatus {
  return VALID_STATUSES.includes(value) ? (value as DocumentIngestionStatus) : "failed";
}

function toDomain(row: DocumentIngestionRow): DocumentIngestion {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    documentId: row.documentId,
    storedFileId: row.storedFileId,
    status: toStatus(row.status),
    checksum: row.checksum,
    byteSize: row.byteSize,
    mimeType: row.mimeType,
    originalName: row.originalName,
    pageCount:
      row.pageCount == null ? null : Math.min(Math.max(1, row.pageCount), L.maxPageCount),
    failureReason: row.failureReason?.slice(0, L.maxFailureReasonLength) ?? null,
    uploadedById: row.uploadedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export class PrismaDocumentIngestionRepository implements DocumentIngestionRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateDocumentIngestionInput): Promise<DocumentIngestion> {
    const existing = await this.getByDocumentId(input.workspaceId, input.documentId);
    if (existing) return existing;

    const row = await this.prisma.documentIngestion.create({
      data: {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        documentId: input.documentId,
        storedFileId: input.storedFileId,
        status: input.status,
        checksum: input.checksum,
        byteSize: input.byteSize,
        mimeType: input.mimeType,
        originalName: input.originalName.slice(0, L.maxFilenameLength),
        uploadedById: input.uploadedById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, ingestionId: string): Promise<DocumentIngestion | null> {
    // workspaceId is part of the predicate, not a post-read check, so another
    // Workspace's row is never loaded into memory.
    const row = await this.prisma.documentIngestion.findFirst({
      where: { id: ingestionId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async getByDocumentId(workspaceId: string, documentId: string): Promise<DocumentIngestion | null> {
    const row = await this.prisma.documentIngestion.findFirst({ where: { workspaceId, documentId } });
    return row ? toDomain(row) : null;
  }

  async findByChecksum(workspaceId: string, checksum: string): Promise<DocumentIngestion | null> {
    const row = await this.prisma.documentIngestion.findFirst({ where: { workspaceId, checksum } });
    return row ? toDomain(row) : null;
  }

  async update(
    workspaceId: string,
    ingestionId: string,
    data: UpdateDocumentIngestionInput,
  ): Promise<DocumentIngestion | null> {
    // updateMany keeps workspaceId in the WHERE clause, so a cross-Workspace
    // write is impossible rather than merely unlikely.
    const result = await this.prisma.documentIngestion.updateMany({
      where: { id: ingestionId, workspaceId },
      data: {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.pageCount !== undefined
          ? {
              pageCount:
                data.pageCount == null
                  ? null
                  : Math.min(Math.max(1, data.pageCount), L.maxPageCount),
            }
          : {}),
        ...(data.failureReason !== undefined
          ? { failureReason: data.failureReason?.slice(0, L.maxFailureReasonLength) ?? null }
          : {}),
        ...(data.completedAt !== undefined ? { completedAt: data.completedAt } : {}),
      },
    });
    if (result.count === 0) return null;

    return this.getById(workspaceId, ingestionId);
  }

  async listUnfinished(limit: number, olderThan?: Date): Promise<DocumentIngestion[]> {
    const rows = await this.prisma.documentIngestion.findMany({
      where: {
        status: { in: ["pending", "processing"] },
        ...(olderThan ? { updatedAt: { lt: olderThan } } : {}),
      },
      // Oldest first so a backlog drains in a deterministic order and repeated
      // sweeps make progress from the front rather than re-picking the same
      // arbitrary subset.
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.trunc(limit)),
    });
    return rows.map(toDomain);
  }

  async delete(workspaceId: string, ingestionId: string): Promise<boolean> {
    const result = await this.prisma.documentIngestion.deleteMany({
      where: { id: ingestionId, workspaceId },
    });
    return result.count > 0;
  }
}
