import type { PrismaClient, AttachmentRecord as AttachmentRow } from "@prisma/client";
import type { AttachmentRecord } from "@/src/domain/entities/DocumentMetadata";
import { METADATA_LIMITS, isMetadataOrigin } from "@/src/domain/entities/DocumentMetadata";
import type {
  AttachmentListQuery,
  AttachmentRepository,
  CreateAttachmentInput,
  UpdateAttachmentInput,
} from "@/src/application/ports/workspaces/AttachmentRepository";

function toDomain(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    storedFileId: row.storedFileId,
    // Fails closed to the read-only side, as elsewhere in M7.9: an unknown
    // origin must not be presented as workspace-owned and therefore editable.
    origin: isMetadataOrigin(row.origin) ? row.origin : "embedded",
    name: row.name,
    normalizedName: row.normalizedName,
    description: row.description,
    mimeType: row.mimeType.slice(0, METADATA_LIMITS.maxMimeTypeLength),
    byteSize:
      Number.isFinite(row.byteSize) && row.byteSize >= 0 ? Math.trunc(row.byteSize) : 0,
    checksum: row.checksum.slice(0, METADATA_LIMITS.maxChecksumLength),
    createdById: row.createdById,
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed AttachmentRepository.
 *
 * Every predicate carries `workspaceId`, so an attachment addressed from another
 * Workspace reads as missing — which matters more here than elsewhere, because
 * the id of a record is also the handle used to stream its bytes.
 *
 * `totalBytesForDocument` aggregates in the database rather than summing a
 * fetched list, so the quota check costs one query regardless of how many
 * attachments a document has accumulated.
 */
export class PrismaAttachmentRepository implements AttachmentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAttachmentInput): Promise<AttachmentRecord> {
    const row = await this.prisma.attachmentRecord.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        storedFileId: input.storedFileId,
        origin: input.origin,
        name: input.name,
        normalizedName: input.normalizedName,
        description: input.description,
        mimeType: input.mimeType.slice(0, METADATA_LIMITS.maxMimeTypeLength),
        byteSize: input.byteSize,
        checksum: input.checksum.slice(0, METADATA_LIMITS.maxChecksumLength),
        createdById: input.createdById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, attachmentId: string): Promise<AttachmentRecord | null> {
    const row = await this.prisma.attachmentRecord.findFirst({
      where: { id: attachmentId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async getByNormalizedName(
    workspaceId: string,
    documentId: string,
    normalizedName: string,
  ): Promise<AttachmentRecord | null> {
    // Queried by findFirst with the Workspace in the predicate rather than by
    // the (documentId, normalizedName) unique key: the unique key is global, and
    // reading through it would return a row from another Workspace.
    const row = await this.prisma.attachmentRecord.findFirst({
      where: { workspaceId, documentId, normalizedName },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: AttachmentListQuery): Promise<AttachmentRecord[]> {
    const rows = await this.prisma.attachmentRecord.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.origin === undefined ? {} : { origin: query.origin }),
      },
      orderBy: [{ normalizedName: "asc" }, { id: "asc" }],
      take: Math.min(Math.trunc(query.limit), METADATA_LIMITS.maxListLimit),
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    attachmentId: string,
    expectedRevision: number,
    input: UpdateAttachmentInput,
  ): Promise<AttachmentRecord | null> {
    const result = await this.prisma.attachmentRecord.updateMany({
      where: { id: attachmentId, workspaceId, revision: expectedRevision },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.normalizedName === undefined
          ? {}
          : { normalizedName: input.normalizedName }),
        ...(input.description === undefined ? {} : { description: input.description }),
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, attachmentId);
  }

  async delete(workspaceId: string, attachmentId: string): Promise<boolean> {
    const result = await this.prisma.attachmentRecord.deleteMany({
      where: { id: attachmentId, workspaceId },
    });
    return result.count > 0;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.attachmentRecord.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.attachmentRecord.count({ where: { workspaceId, documentId } });
  }

  async totalBytesForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.attachmentRecord.aggregate({
      where: { workspaceId, documentId },
      _sum: { byteSize: true },
    });
    const total = result._sum.byteSize;
    // Null when no rows matched. Falling back to 0 rather than to the quota is
    // the right direction: a document with no attachments has consumed nothing.
    return typeof total === "number" && Number.isFinite(total) && total > 0
      ? Math.trunc(total)
      : 0;
  }
}
