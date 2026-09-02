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

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-metadata-${counter}`;
}

interface StoredMetadata {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  /** Serialized exactly as the database column holds it, not as an object. */
  fields: string;
  schemaVersion: number;
  createdById: string;
  updatedById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory DocumentMetadataRepository — for tests and as a zero-dependency
 * fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its (workspaceId, documentId)
 * uniqueness, its compare-and-swap replace, and — importantly — its *storage
 * form*: fields are held serialized and parsed on the way out, so a test that
 * passes here cannot pass by keeping an object the database could not hold.
 */
export class InMemoryDocumentMetadataRepository implements DocumentMetadataRepository {
  private readonly rows = new Map<string, StoredMetadata>();

  private key(workspaceId: string, documentId: string): string {
    return `${workspaceId}:${documentId}`;
  }

  private toDomain(row: StoredMetadata): DocumentMetadata {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      fields: parseMetadataFields(row.fields),
      schemaVersion: row.schemaVersion,
      createdById: row.createdById,
      updatedById: row.updatedById,
      revision: row.revision,
      // Copied, not aliased: a caller mutating these must not reach stored state.
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  async upsert(input: UpsertDocumentMetadataInput): Promise<DocumentMetadata> {
    const key = this.key(input.workspaceId, input.documentId);
    const existing = this.rows.get(key);
    const fields = serializeMetadataFields(input.fields);
    if (existing) {
      existing.fields = fields;
      existing.schemaVersion = input.schemaVersion;
      existing.updatedById = input.actorId;
      existing.revision += 1;
      // Advanced rather than set to `now`: two saves inside one millisecond
      // would otherwise be indistinguishable, and a test asserting that an
      // update moved the timestamp would pass or fail on clock granularity.
      existing.updatedAt = new Date(existing.updatedAt.getTime() + 1000);
      return this.toDomain(existing);
    }
    const now = new Date();
    const row: StoredMetadata = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      fields,
      schemaVersion: input.schemaVersion,
      createdById: input.actorId,
      updatedById: input.actorId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, row);
    return this.toDomain(row);
  }

  async getByDocumentId(
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentMetadata | null> {
    const row = this.rows.get(this.key(workspaceId, documentId));
    return row ? this.toDomain(row) : null;
  }

  async replaceFields(
    workspaceId: string,
    documentId: string,
    expectedRevision: number,
    fields: MetadataFields,
    actorId: string,
  ): Promise<DocumentMetadata | null> {
    const row = this.rows.get(this.key(workspaceId, documentId));
    // A stale revision and a missing row both return null: neither may disclose
    // the other, exactly as in the database-backed adapter.
    if (!row || row.revision !== expectedRevision) return null;
    row.fields = serializeMetadataFields(fields);
    row.updatedById = actorId;
    row.revision += 1;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
    return this.toDomain(row);
  }

  async listForDocuments(
    workspaceId: string,
    documentIds: string[],
  ): Promise<DocumentMetadata[]> {
    if (documentIds.length === 0) return [];
    const wanted = new Set(documentIds.slice(0, METADATA_LIMITS.maxListLimit));
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && wanted.has(row.documentId))
      .map((row) => this.toDomain(row));
  }

  async delete(workspaceId: string, documentId: string): Promise<boolean> {
    return this.rows.delete(this.key(workspaceId, documentId));
  }

  async countForWorkspace(workspaceId: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).length;
  }
}
