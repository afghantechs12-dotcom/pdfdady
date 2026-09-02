import type { DocumentVersion } from "@/src/domain/entities/DocumentVersion";
import {
  DOCUMENT_VERSION_LIMITS as L,
  documentVersionListLimit,
  readManifest,
} from "@/src/domain/entities/DocumentVersion";
import type {
  CreateDocumentVersionInput,
  DocumentVersionListQuery,
  DocumentVersionRepository,
} from "@/src/application/ports/workspaces/DocumentVersionRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-version-${counter}`;
}

/** A stored row: the manifest is held serialized, exactly as the database holds it. */
interface StoredRow {
  id: string;
  workspaceId: string;
  organizationId: string;
  documentId: string;
  versionNumber: number;
  revision: number;
  origin: string;
  restoredFromVersionId: string | null;
  label: string | null;
  manifest: string;
  checksum: string;
  createdById: string;
  createdAt: Date;
}

/**
 * In-memory DocumentVersionRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter's Workspace scoping, transactional
 * version-number allocation, bounded listings, and manifest degradation on read.
 *
 * Rows are stored serialized and re-read through `readManifest` on the way out,
 * so this adapter degrades a corrupt manifest exactly as the database-backed one
 * does rather than handing back an object the database could never have stored.
 */
export class InMemoryDocumentVersionRepository implements DocumentVersionRepository {
  private readonly rows = new Map<string, StoredRow>();

  private toDomain(row: StoredRow): DocumentVersion {
    const { manifest, degraded } = readManifest(row.manifest);
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      organizationId: row.organizationId,
      documentId: row.documentId,
      versionNumber: row.versionNumber,
      revision: row.revision,
      // An unrecognized origin degrades to "checkpoint" rather than being
      // asserted: a row written by a newer build must not widen this union.
      origin:
        row.origin === "save" ||
        row.origin === "restore" ||
        row.origin === "import" ||
        row.origin === "checkpoint"
          ? row.origin
          : "checkpoint",
      restoredFromVersionId: row.restoredFromVersionId,
      label: row.label,
      manifest,
      manifestDegraded: degraded,
      checksum: row.checksum,
      createdById: row.createdById,
      // Copied, not aliased: a caller mutating this Date must not reach stored state.
      createdAt: new Date(row.createdAt),
    };
  }

  private forDocument(workspaceId: string, documentId: string): StoredRow[] {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.documentId === documentId,
    );
  }

  async create(input: CreateDocumentVersionInput): Promise<DocumentVersion> {
    // Allocation and insert happen together, which is what the Prisma adapter's
    // transaction buys. Re-reading the maximum here — rather than caching it —
    // keeps the two adapters behaving alike under repeated creates.
    const existing = this.forDocument(input.workspaceId, input.documentId);
    const versionNumber =
      existing.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;

    const row: StoredRow = {
      id: uid(),
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
      createdAt: new Date(),
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, versionId: string): Promise<DocumentVersion | null> {
    const row = this.rows.get(versionId);
    // Scoped by workspace, not by id alone: an id from another tenant reads as
    // missing rather than as forbidden.
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async getByNumber(
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<DocumentVersion | null> {
    const row = this.forDocument(workspaceId, documentId).find(
      (candidate) => candidate.versionNumber === versionNumber,
    );
    return row ? this.toDomain(row) : null;
  }

  async list(query: DocumentVersionListQuery): Promise<DocumentVersion[]> {
    return this.forDocument(query.workspaceId, query.documentId)
      .filter((row) =>
        query.beforeVersionNumber === undefined
          ? true
          : row.versionNumber < query.beforeVersionNumber,
      )
      .sort((a, b) => b.versionNumber - a.versionNumber)
      .slice(0, documentVersionListLimit(query.limit))
      .map((row) => this.toDomain(row));
  }

  async latest(workspaceId: string, documentId: string): Promise<DocumentVersion | null> {
    const rows = this.forDocument(workspaceId, documentId).sort(
      (a, b) => b.versionNumber - a.versionNumber,
    );
    return rows.length ? this.toDomain(rows[0]) : null;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.forDocument(workspaceId, documentId).length;
  }

  async isArtifactReferenced(
    workspaceId: string,
    key: string,
    excludingVersionId?: string,
  ): Promise<boolean> {
    if (!key) return false;
    for (const row of this.rows.values()) {
      if (row.workspaceId !== workspaceId) continue;
      if (excludingVersionId !== undefined && row.id === excludingVersionId) continue;
      const { manifest } = readManifest(row.manifest);
      if (
        manifest.sourceKey === key ||
        manifest.editorStateKey === key ||
        manifest.outputKey === key ||
        manifest.thumbnailKeys.includes(key)
      ) {
        return true;
      }
    }
    return false;
  }

  async delete(workspaceId: string, versionId: string): Promise<boolean> {
    const row = this.rows.get(versionId);
    if (!row || row.workspaceId !== workspaceId) return false;
    this.rows.delete(versionId);
    return true;
  }
}
