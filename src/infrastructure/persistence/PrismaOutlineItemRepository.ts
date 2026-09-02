import type { PrismaClient, OutlineItem as OutlineItemRow } from "@prisma/client";
import type { MetadataOrigin, OutlineItem } from "@/src/domain/entities/DocumentMetadata";
import { METADATA_LIMITS, isMetadataOrigin } from "@/src/domain/entities/DocumentMetadata";
import type {
  CreateOutlineItemInput,
  OutlineItemRepository,
  OutlineListQuery,
  UpdateOutlineItemInput,
} from "@/src/application/ports/workspaces/OutlineItemRepository";

function toDomain(row: OutlineItemRow): OutlineItem {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    parentId: row.parentId,
    title: row.title,
    pageNumber: row.pageNumber,
    depth:
      Number.isFinite(row.depth) && row.depth >= 0
        ? Math.min(Math.trunc(row.depth), METADATA_LIMITS.maxOutlineDepth)
        : 0,
    orderKey: row.orderKey,
    // An unrecognized origin degrades to "embedded", the read-only side. Failing
    // closed here matters: treating an unknown row as "workspace" would present
    // it as editable, and an edit to something that is actually part of the PDF
    // is the one outcome this module exists to prevent.
    origin: isMetadataOrigin(row.origin) ? row.origin : "embedded",
    createdById: row.createdById,
    revision:
      Number.isFinite(row.revision) && row.revision >= 1 ? Math.trunc(row.revision) : 1,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * SQLite-backed OutlineItemRepository.
 *
 * Holds both origins in one table: a `workspace` item is ours and editable, an
 * `embedded` item mirrors the PDF's own outline. `replaceForDocument` is scoped
 * by origin so a re-inspection converges on the file's current outline without
 * touching anything the user authored.
 *
 * Every predicate carries `workspaceId`.
 */
export class PrismaOutlineItemRepository implements OutlineItemRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateOutlineItemInput): Promise<OutlineItem> {
    const row = await this.prisma.outlineItem.create({
      data: {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        parentId: input.parentId,
        title: input.title,
        pageNumber: input.pageNumber,
        depth: input.depth,
        orderKey: input.orderKey,
        origin: input.origin,
        createdById: input.createdById,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, outlineItemId: string): Promise<OutlineItem | null> {
    const row = await this.prisma.outlineItem.findFirst({
      where: { id: outlineItemId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async list(query: OutlineListQuery): Promise<OutlineItem[]> {
    const rows = await this.prisma.outlineItem.findMany({
      where: {
        workspaceId: query.workspaceId,
        documentId: query.documentId,
        ...(query.origin === undefined ? {} : { origin: query.origin }),
      },
      orderBy: [{ orderKey: "asc" }, { id: "asc" }],
      take: Math.min(Math.trunc(query.limit), METADATA_LIMITS.maxOutlineItems),
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    outlineItemId: string,
    expectedRevision: number,
    input: UpdateOutlineItemInput,
  ): Promise<OutlineItem | null> {
    const result = await this.prisma.outlineItem.updateMany({
      where: { id: outlineItemId, workspaceId, revision: expectedRevision },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.pageNumber === undefined ? {} : { pageNumber: input.pageNumber }),
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        ...(input.depth === undefined ? {} : { depth: input.depth }),
        ...(input.orderKey === undefined ? {} : { orderKey: input.orderKey }),
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    return this.getById(workspaceId, outlineItemId);
  }

  async delete(workspaceId: string, outlineItemId: string): Promise<boolean> {
    const result = await this.prisma.outlineItem.deleteMany({
      where: { id: outlineItemId, workspaceId },
    });
    return result.count > 0;
  }

  async replaceForDocument(
    workspaceId: string,
    documentId: string,
    origin: MetadataOrigin,
    items: CreateOutlineItemInput[],
  ): Promise<OutlineItem[]> {
    const bounded = items.slice(0, METADATA_LIMITS.maxOutlineItems);
    // Delete-then-insert inside one transaction, scoped to the one origin: a
    // re-inspection that failed midway must not leave a document showing a mix
    // of two files' outlines, and must never delete what the user authored.
    await this.prisma.$transaction(async (tx) => {
      await tx.outlineItem.deleteMany({ where: { workspaceId, documentId, origin } });
      for (const input of bounded) {
        await tx.outlineItem.create({
          data: {
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            documentId: input.documentId,
            parentId: input.parentId,
            title: input.title,
            pageNumber: input.pageNumber,
            depth: input.depth,
            orderKey: input.orderKey,
            origin: input.origin,
            createdById: input.createdById,
          },
        });
      }
    });
    return this.list({
      workspaceId,
      documentId,
      origin,
      limit: METADATA_LIMITS.maxOutlineItems,
    });
  }

  async listChildren(workspaceId: string, parentId: string): Promise<OutlineItem[]> {
    const rows = await this.prisma.outlineItem.findMany({
      where: { workspaceId, parentId },
      orderBy: [{ orderKey: "asc" }, { id: "asc" }],
      take: METADATA_LIMITS.maxOutlineItems,
    });
    return rows.map(toDomain);
  }

  async deleteDescendants(
    workspaceId: string,
    documentId: string,
    outlineItemId: string,
  ): Promise<number> {
    // The descendant set is resolved by breadth-first expansion over the
    // document's own rows and then deleted in one statement. Two properties
    // matter: the frontier never leaves the document (so a stray parent link
    // cannot reach another document's items), and a cycle in stored links
    // terminates because an id already visited is never expanded again.
    const rows = await this.prisma.outlineItem.findMany({
      where: { workspaceId, documentId },
      select: { id: true, parentId: true },
      take: METADATA_LIMITS.maxOutlineItems,
    });

    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parentId === null) continue;
      const siblings = childrenOf.get(row.parentId);
      if (siblings) siblings.push(row.id);
      else childrenOf.set(row.parentId, [row.id]);
    }

    const doomed: string[] = [];
    const seen = new Set<string>([outlineItemId]);
    const queue = [...(childrenOf.get(outlineItemId) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      doomed.push(id);
      for (const child of childrenOf.get(id) ?? []) queue.push(child);
    }
    if (doomed.length === 0) return 0;

    const result = await this.prisma.outlineItem.deleteMany({
      where: { workspaceId, documentId, id: { in: doomed } },
    });
    return result.count;
  }

  async deleteForDocument(workspaceId: string, documentId: string): Promise<number> {
    const result = await this.prisma.outlineItem.deleteMany({
      where: { workspaceId, documentId },
    });
    return result.count;
  }

  async countForDocument(
    workspaceId: string,
    documentId: string,
    origin?: MetadataOrigin,
  ): Promise<number> {
    return this.prisma.outlineItem.count({
      where: {
        workspaceId,
        documentId,
        ...(origin === undefined ? {} : { origin }),
      },
    });
  }

  async lastOrderKey(
    workspaceId: string,
    documentId: string,
    parentId: string | null,
  ): Promise<string | null> {
    const rows = await this.prisma.outlineItem.findMany({
      where: { workspaceId, documentId, parentId },
      orderBy: [{ orderKey: "desc" }, { id: "desc" }],
      take: 1,
    });
    return rows[0]?.orderKey ?? null;
  }
}
