import type { AttachmentRecord } from "@/src/domain/entities/DocumentMetadata";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type {
  AttachmentListQuery,
  AttachmentRepository,
  CreateAttachmentInput,
  UpdateAttachmentInput,
} from "@/src/application/ports/workspaces/AttachmentRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-attachment-${counter}`;
}

/** Prisma's unique-constraint error, reproduced so both adapters fail alike. */
function uniqueViolation(): Error {
  const error = new Error(
    "Unique constraint failed on the fields: (`documentId`,`normalizedName`)",
  );
  (error as Error & { code: string }).code = "P2002";
  return error;
}

interface StoredAttachment {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  storedFileId: string | null;
  origin: string;
  name: string;
  normalizedName: string;
  description: string | null;
  mimeType: string;
  byteSize: number;
  checksum: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory AttachmentRepository — for tests and as a zero-dependency fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its compare-and-swap update
 * and its ordering. The (documentId, normalizedName) unique constraint is
 * enforced here too, and enforced *globally* as the real index is — so a test
 * cannot pass by relying on a per-Workspace uniqueness the database does not
 * provide.
 */
export class InMemoryAttachmentRepository implements AttachmentRepository {
  private readonly rows = new Map<string, StoredAttachment>();

  private toDomain(row: StoredAttachment): AttachmentRecord {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      storedFileId: row.storedFileId,
      // Fails closed to the read-only side, matching the Prisma adapter.
      origin: row.origin === "workspace" ? "workspace" : "embedded",
      name: row.name,
      normalizedName: row.normalizedName,
      description: row.description,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      checksum: row.checksum,
      createdById: row.createdById,
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private sorted(rows: StoredAttachment[]): StoredAttachment[] {
    return rows
      .slice()
      .sort(
        (a, b) =>
          a.normalizedName.localeCompare(b.normalizedName) || a.id.localeCompare(b.id),
      );
  }

  async create(input: CreateAttachmentInput): Promise<AttachmentRecord> {
    const clash = [...this.rows.values()].some(
      (row) =>
        row.documentId === input.documentId && row.normalizedName === input.normalizedName,
    );
    if (clash) throw uniqueViolation();

    const now = new Date();
    const row: StoredAttachment = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      storedFileId: input.storedFileId,
      origin: input.origin,
      name: input.name,
      normalizedName: input.normalizedName,
      description: input.description,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      checksum: input.checksum,
      createdById: input.createdById,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, attachmentId: string): Promise<AttachmentRecord | null> {
    const row = this.rows.get(attachmentId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async getByNormalizedName(
    workspaceId: string,
    documentId: string,
    normalizedName: string,
  ): Promise<AttachmentRecord | null> {
    // Workspace-scoped even though the unique key is not: reading through the
    // global key would return a row from another tenant.
    const row = [...this.rows.values()].find(
      (candidate) =>
        candidate.workspaceId === workspaceId &&
        candidate.documentId === documentId &&
        candidate.normalizedName === normalizedName,
    );
    return row ? this.toDomain(row) : null;
  }

  async list(query: AttachmentListQuery): Promise<AttachmentRecord[]> {
    const matching = [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === query.workspaceId &&
        row.documentId === query.documentId &&
        (query.origin === undefined || row.origin === query.origin),
    );
    return this.sorted(matching)
      .slice(0, Math.min(Math.trunc(query.limit), METADATA_LIMITS.maxListLimit))
      .map((row) => this.toDomain(row));
  }

  async update(
    workspaceId: string,
    attachmentId: string,
    expectedRevision: number,
    input: UpdateAttachmentInput,
  ): Promise<AttachmentRecord | null> {
    const row = this.rows.get(attachmentId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.revision !== expectedRevision) return null;

    if (input.normalizedName !== undefined && input.normalizedName !== row.normalizedName) {
      const clash = [...this.rows.values()].some(
        (candidate) =>
          candidate.id !== row.id &&
          candidate.documentId === row.documentId &&
          candidate.normalizedName === input.normalizedName,
      );
      if (clash) throw uniqueViolation();
    }

    if (input.name !== undefined) row.name = input.name;
    if (input.normalizedName !== undefined) row.normalizedName = input.normalizedName;
    if (input.description !== undefined) row.description = input.description;
    row.revision += 1;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
    return this.toDomain(row);
  }

  async delete(workspaceId: string, attachmentId: string): Promise<boolean> {
    const row = this.rows.get(attachmentId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(attachmentId);
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

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.documentId === documentId,
    ).length;
  }

  async totalBytesForDocument(workspaceId: string, documentId: string): Promise<number> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.documentId === documentId)
      .reduce((total, row) => total + row.byteSize, 0);
  }
}
