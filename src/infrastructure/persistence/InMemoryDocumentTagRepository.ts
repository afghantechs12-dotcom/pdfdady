import type { DocumentTag } from "@/src/domain/entities/Tag";
import { TAG_LIMITS } from "@/src/domain/entities/Tag";
import type {
  AssignDocumentTagInput,
  DocumentTagRepository,
} from "@/src/application/ports/workspaces/DocumentTagRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-doc-tag-${counter}`;
}

function uniqueViolation(): Error {
  const error = new Error("Unique constraint failed on the fields: (`documentId`,`tagId`)");
  (error as Error & { code: string }).code = "P2002";
  return error;
}

interface StoredDocumentTag {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  tagId: string;
  assignedById: string;
  createdAt: Date;
}

/**
 * In-memory DocumentTagRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter: Workspace-scoped predicates, the
 * (documentId, tagId) unique constraint that makes assignment idempotent, and
 * bounded listings. Rows are copied on the way out.
 */
export class InMemoryDocumentTagRepository implements DocumentTagRepository {
  private readonly rows = new Map<string, StoredDocumentTag>();

  private toDomain(row: StoredDocumentTag): DocumentTag {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      tagId: row.tagId,
      assignedById: row.assignedById,
      createdAt: new Date(row.createdAt),
    };
  }

  private forWorkspace(workspaceId: string): StoredDocumentTag[] {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId);
  }

  async assign(input: AssignDocumentTagInput): Promise<DocumentTag> {
    const existing = this.forWorkspace(input.workspaceId).find(
      (row) => row.documentId === input.documentId && row.tagId === input.tagId,
    );
    // Idempotent: re-assigning an existing pair returns the existing row. The
    // Workspace check above keeps this from resolving a cross-Workspace pair
    // that happens to share ids.
    if (existing) return this.toDomain(existing);

    const row: StoredDocumentTag = {
      id: uid(),
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      tagId: input.tagId,
      assignedById: input.assignedById,
      createdAt: new Date(),
    };
    // The unique constraint rejects a concurrent duplicate, exactly as the
    // database would; the happy path re-checks only to be idempotent for the
    // sequential case.
    const colliding = [...this.rows.values()].some(
      (candidate) => candidate.documentId === input.documentId && candidate.tagId === input.tagId,
    );
    if (colliding) throw uniqueViolation();
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async remove(workspaceId: string, documentId: string, tagId: string): Promise<boolean> {
    const row = this.forWorkspace(workspaceId).find(
      (candidate) => candidate.documentId === documentId && candidate.tagId === tagId,
    );
    if (!row) return false;
    this.rows.delete(row.id);
    return true;
  }

  async isAssigned(workspaceId: string, documentId: string, tagId: string): Promise<boolean> {
    return this.forWorkspace(workspaceId).some(
      (row) => row.documentId === documentId && row.tagId === tagId,
    );
  }

  async listForDocument(workspaceId: string, documentId: string): Promise<DocumentTag[]> {
    return this.forWorkspace(workspaceId)
      .filter((row) => row.documentId === documentId)
      .slice(0, TAG_LIMITS.maxTagsPerDocument)
      .map((row) => this.toDomain(row));
  }

  async listDocumentIdsWithAllTags(
    workspaceId: string,
    tagIds: string[],
    limit: number,
  ): Promise<string[]> {
    if (tagIds.length === 0) return [];
    const wanted = new Set(tagIds);
    const byDocument = new Map<string, Set<string>>();
    for (const row of this.forWorkspace(workspaceId)) {
      if (!wanted.has(row.tagId)) continue;
      let set = byDocument.get(row.documentId);
      if (!set) {
        set = new Set();
        byDocument.set(row.documentId, set);
      }
      set.add(row.tagId);
    }
    const bounded = Number.isNaN(limit) || limit <= 0 ? 1 : Math.min(Math.trunc(limit), 1000);
    return [...byDocument.entries()]
      .filter(([, tags]) => tags.size === wanted.size)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, bounded)
      .map(([documentId]) => documentId);
  }

  async listForDocuments(workspaceId: string, documentIds: string[]): Promise<DocumentTag[]> {
    const wanted = new Set(documentIds);
    return this.forWorkspace(workspaceId)
      .filter((row) => wanted.has(row.documentId))
      .map((row) => this.toDomain(row));
  }

  async countForTag(workspaceId: string, tagId: string): Promise<number> {
    return this.forWorkspace(workspaceId).filter((row) => row.tagId === tagId).length;
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.forWorkspace(workspaceId).filter((row) => row.documentId === documentId).length;
  }

  async removeAllForTag(workspaceId: string, tagId: string): Promise<number> {
    const rows = this.forWorkspace(workspaceId).filter((row) => row.tagId === tagId);
    for (const row of rows) this.rows.delete(row.id);
    return rows.length;
  }
}
