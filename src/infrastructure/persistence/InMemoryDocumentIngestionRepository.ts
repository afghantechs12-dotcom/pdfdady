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

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-ingestion-${counter}`;
}

function clamp(input: UpdateDocumentIngestionInput): UpdateDocumentIngestionInput {
  const clamped = { ...input };
  if (clamped.failureReason != null) {
    clamped.failureReason = clamped.failureReason.slice(0, L.maxFailureReasonLength);
  }
  if (clamped.pageCount != null) {
    clamped.pageCount = Math.min(Math.max(1, clamped.pageCount), L.maxPageCount);
  }
  return clamped;
}

function clone(ingestion: DocumentIngestion): DocumentIngestion {
  return {
    ...ingestion,
    createdAt: new Date(ingestion.createdAt),
    updatedAt: new Date(ingestion.updatedAt),
    completedAt: ingestion.completedAt ? new Date(ingestion.completedAt) : null,
  };
}

/**
 * In-memory DocumentIngestionRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter's Workspace scoping and the
 * (workspaceId, checksum) / (workspaceId, documentId) uniqueness rules.
 */
export class InMemoryDocumentIngestionRepository implements DocumentIngestionRepository {
  private readonly rows = new Map<string, DocumentIngestion>();

  async create(input: CreateDocumentIngestionInput): Promise<DocumentIngestion> {
    const existing = await this.getByDocumentId(input.workspaceId, input.documentId);
    if (existing) return existing;

    const now = new Date();
    const row: DocumentIngestion = {
      id: uid(),
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      documentId: input.documentId,
      storedFileId: input.storedFileId,
      status: input.status,
      checksum: input.checksum,
      byteSize: input.byteSize,
      mimeType: input.mimeType,
      originalName: input.originalName,
      pageCount: null,
      failureReason: null,
      uploadedById: input.uploadedById,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    this.rows.set(row.id, row);
    return clone(row);
  }

  async getById(workspaceId: string, ingestionId: string): Promise<DocumentIngestion | null> {
    const row = this.rows.get(ingestionId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return clone(row);
  }

  async getByDocumentId(workspaceId: string, documentId: string): Promise<DocumentIngestion | null> {
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.documentId === documentId) return clone(row);
    }
    return null;
  }

  async findByChecksum(workspaceId: string, checksum: string): Promise<DocumentIngestion | null> {
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.checksum === checksum) return clone(row);
    }
    return null;
  }

  async update(
    workspaceId: string,
    ingestionId: string,
    data: UpdateDocumentIngestionInput,
  ): Promise<DocumentIngestion | null> {
    const row = this.rows.get(ingestionId);
    if (!row || row.workspaceId !== workspaceId) return null;

    const changes = clamp(data);
    const updated: DocumentIngestion = {
      ...row,
      status: changes.status ?? row.status,
      pageCount: changes.pageCount !== undefined ? changes.pageCount : row.pageCount,
      failureReason: changes.failureReason !== undefined ? changes.failureReason : row.failureReason,
      completedAt: changes.completedAt !== undefined ? changes.completedAt : row.completedAt,
      updatedAt: new Date(),
    };
    this.rows.set(ingestionId, updated);
    return clone(updated);
  }

  async listUnfinished(limit: number, olderThan?: Date): Promise<DocumentIngestion[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === "pending" || row.status === "processing")
      .filter((row) => (olderThan ? row.updatedAt < olderThan : true))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, Math.max(1, Math.trunc(limit)))
      .map(clone);
  }

  async delete(workspaceId: string, ingestionId: string): Promise<boolean> {
    const row = this.rows.get(ingestionId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(ingestionId);
  }
}

/** Narrow type re-export so callers can build rows without importing Prisma. */
export type { DocumentIngestionStatus };
