import type { PrismaClient, DocumentTag as DocumentTagRow } from "@prisma/client";
import type { DocumentTag } from "@/src/domain/entities/Tag";
import { TAG_LIMITS as L } from "@/src/domain/entities/Tag";
import type {
  AssignDocumentTagInput,
  DocumentTagRepository,
} from "@/src/application/ports/workspaces/DocumentTagRepository";

function toDomain(row: DocumentTagRow): DocumentTag {
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

/**
 * SQLite-backed DocumentTagRepository.
 *
 * Every predicate carries `workspaceId`, so a cross-Workspace assignment is
 * unrepresentable: the workspace is a parameter here, never something derived
 * from a document or tag id. The (documentId, tagId) unique index makes
 * duplicate assignment impossible, which is what lets `assign` be idempotent
 * rather than merely usually-idempotent under concurrency.
 */
export class PrismaDocumentTagRepository implements DocumentTagRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async assign(input: AssignDocumentTagInput): Promise<DocumentTag> {
    // Idempotent: a repeat assignment finds the existing pair and returns it.
    // The Workspace predicate keeps this from resolving a cross-Workspace pair
    // that happens to share ids.
    const existing = await this.prisma.documentTag.findFirst({
      where: { workspaceId: input.workspaceId, documentId: input.documentId, tagId: input.tagId },
    });
    if (existing) return toDomain(existing);

    const row = await this.prisma.documentTag.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        tagId: input.tagId,
        assignedById: input.assignedById,
      },
    });
    return toDomain(row);
  }

  async remove(workspaceId: string, documentId: string, tagId: string): Promise<boolean> {
    const result = await this.prisma.documentTag.deleteMany({
      where: { workspaceId, documentId, tagId },
    });
    return result.count > 0;
  }

  async isAssigned(workspaceId: string, documentId: string, tagId: string): Promise<boolean> {
    const count = await this.prisma.documentTag.count({
      where: { workspaceId, documentId, tagId },
    });
    return count > 0;
  }

  async listForDocument(workspaceId: string, documentId: string): Promise<DocumentTag[]> {
    const rows = await this.prisma.documentTag.findMany({
      where: { workspaceId, documentId },
      take: L.maxTagsPerDocument,
    });
    return rows.map(toDomain);
  }

  async listDocumentIdsWithAllTags(
    workspaceId: string,
    tagIds: string[],
    limit: number,
  ): Promise<string[]> {
    if (tagIds.length === 0) return [];
    const wanted = new Set(tagIds);
    const rows = await this.prisma.documentTag.findMany({
      where: { workspaceId, tagId: { in: tagIds } },
      orderBy: { documentId: "asc" },
      take: 1000,
    });
    const byDocument = new Map<string, Set<string>>();
    for (const row of rows) {
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
      .slice(0, bounded)
      .map(([documentId]) => documentId);
  }

  async listForDocuments(workspaceId: string, documentIds: string[]): Promise<DocumentTag[]> {
    if (documentIds.length === 0) return [];
    const rows = await this.prisma.documentTag.findMany({
      where: { workspaceId, documentId: { in: documentIds.slice(0, 1000) } },
    });
    return rows.map(toDomain);
  }

  async countForTag(workspaceId: string, tagId: string): Promise<number> {
    return this.prisma.documentTag.count({ where: { workspaceId, tagId } });
  }

  async countForDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.prisma.documentTag.count({ where: { workspaceId, documentId } });
  }

  async removeAllForTag(workspaceId: string, tagId: string): Promise<number> {
    const result = await this.prisma.documentTag.deleteMany({ where: { workspaceId, tagId } });
    return result.count;
  }
}
