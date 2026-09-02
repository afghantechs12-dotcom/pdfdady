import type { PrismaClient, DocumentMetadata as DocumentMetadataRow } from "@prisma/client";
import type { DocumentMetadata, MetadataFields } from "@/src/domain/entities/DocumentMetadata";
import {
  METADATA_LIMITS,
  parseMetadataFields,
  serializeMetadataFields,
} from "@/src/domain/entities/DocumentMetadata";
import type {
  DocumentMetadataRepository,
  UpsertDocumentMetadataInput,
} from "@/src/application/ports/workspaces/DocumentMetadataRepository";

function toDomain(row: DocumentMetadataRow): DocumentMetadata {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    // Parsed tolerantly: a field a newer build wrote, or one that no longer
    // validates, is dropped rather than failing the whole read. Losing one
    // unknown property is recoverable; refusing to open the panel is not.
    fields: parseMetadataFields(row.fields),
    schemaVersion: row.schemaVersion,
    createdById: row.createdById,
    updatedById: row.updatedById,
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    // Copied, not aliased: a caller mutating these Dates must not reach the row.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed DocumentMetadataRepository.
 *
 * Every predicate carries `workspaceId`, so a properties row belonging to
 * another Workspace reads as missing rather than as forbidden. The
 * (workspaceId, documentId) unique index is what makes `upsert` converge under
 * a repeated save instead of inserting a second set of properties.
 */
export class PrismaDocumentMetadataRepository implements DocumentMetadataRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(input: UpsertDocumentMetadataInput): Promise<DocumentMetadata> {
    const fields = serializeMetadataFields(input.fields);
    const row = await this.prisma.documentMetadata.upsert({
      where: {
        workspaceId_documentId: {
          workspaceId: input.workspaceId,
          documentId: input.documentId,
        },
      },
      create: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        fields,
        schemaVersion: input.schemaVersion,
        createdById: input.actorId,
        updatedById: input.actorId,
      },
      update: {
        fields,
        schemaVersion: input.schemaVersion,
        updatedById: input.actorId,
        revision: { increment: 1 },
      },
    });
    return toDomain(row);
  }

  async getByDocumentId(
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentMetadata | null> {
    const row = await this.prisma.documentMetadata.findUnique({
      where: { workspaceId_documentId: { workspaceId, documentId } },
    });
    return row ? toDomain(row) : null;
  }

  async replaceFields(
    workspaceId: string,
    documentId: string,
    expectedRevision: number,
    fields: MetadataFields,
    actorId: string,
  ): Promise<DocumentMetadata | null> {
    const result = await this.prisma.documentMetadata.updateMany({
      where: { workspaceId, documentId, revision: expectedRevision },
      data: {
        fields: serializeMetadataFields(fields),
        updatedById: actorId,
        revision: { increment: 1 },
      },
    });
    // updateMany returns a count, not the row: the mutation is compare-and-swap
    // and the fresh row is re-read so the caller gets its current state. A count
    // of zero means a stale revision *or* a missing row, and the caller must not
    // be able to tell those apart.
    if (result.count === 0) return null;
    return this.getByDocumentId(workspaceId, documentId);
  }

  async listForDocuments(
    workspaceId: string,
    documentIds: string[],
  ): Promise<DocumentMetadata[]> {
    if (documentIds.length === 0) return [];
    const rows = await this.prisma.documentMetadata.findMany({
      where: {
        workspaceId,
        documentId: { in: documentIds.slice(0, METADATA_LIMITS.maxListLimit) },
      },
    });
    return rows.map(toDomain);
  }

  async delete(workspaceId: string, documentId: string): Promise<boolean> {
    const result = await this.prisma.documentMetadata.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count > 0;
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return this.prisma.documentMetadata.count({ where: { workspaceId } });
  }
}
