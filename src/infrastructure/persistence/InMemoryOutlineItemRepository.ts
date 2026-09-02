import type { MetadataOrigin, OutlineItem } from "@/src/domain/entities/DocumentMetadata";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type {
  CreateOutlineItemInput,
  OutlineItemRepository,
  OutlineListQuery,
  UpdateOutlineItemInput,
} from "@/src/application/ports/workspaces/OutlineItemRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-outline-${counter}`;
}

interface StoredOutlineItem {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  parentId: string | null;
  title: string;
  pageNumber: number;
  depth: number;
  orderKey: string;
  origin: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory OutlineItemRepository — for tests and as a zero-dependency fallback.
 *
 * Mirrors the Prisma adapter's Workspace scoping, its origin-scoped
 * `replaceForDocument`, its compare-and-swap update and its (orderKey, id)
 * ordering. `origin` is stored as a string, as the column is, so an unknown
 * value degrades to the read-only side here too.
 */
export class InMemoryOutlineItemRepository implements OutlineItemRepository {
  private readonly rows = new Map<string, StoredOutlineItem>();

  private toDomain(row: StoredOutlineItem): OutlineItem {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workspaceId: row.workspaceId,
      documentId: row.documentId,
      parentId: row.parentId,
      title: row.title,
      pageNumber: row.pageNumber,
      depth: Math.min(row.depth, METADATA_LIMITS.maxOutlineDepth),
      orderKey: row.orderKey,
      // Fails closed to "embedded", matching the Prisma adapter: an unknown
      // origin must never present as workspace-owned and therefore editable.
      origin: row.origin === "workspace" ? "workspace" : "embedded",
      createdById: row.createdById,
      revision: row.revision,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    };
  }

  private sorted(rows: StoredOutlineItem[]): StoredOutlineItem[] {
    return rows
      .slice()
      .sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a.id.localeCompare(b.id));
  }

  async create(input: CreateOutlineItemInput): Promise<OutlineItem> {
    const now = new Date();
    const row: StoredOutlineItem = {
      id: uid(),
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
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return this.toDomain(row);
  }

  async getById(workspaceId: string, outlineItemId: string): Promise<OutlineItem | null> {
    const row = this.rows.get(outlineItemId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return this.toDomain(row);
  }

  async list(query: OutlineListQuery): Promise<OutlineItem[]> {
    const matching = [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === query.workspaceId &&
        row.documentId === query.documentId &&
        (query.origin === undefined || row.origin === query.origin),
    );
    return this.sorted(matching)
      .slice(0, Math.min(Math.trunc(query.limit), METADATA_LIMITS.maxOutlineItems))
      .map((row) => this.toDomain(row));
  }

  async update(
    workspaceId: string,
    outlineItemId: string,
    expectedRevision: number,
    input: UpdateOutlineItemInput,
  ): Promise<OutlineItem | null> {
    const row = this.rows.get(outlineItemId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (row.revision !== expectedRevision) return null;
    if (input.title !== undefined) row.title = input.title;
    if (input.pageNumber !== undefined) row.pageNumber = input.pageNumber;
    if (input.parentId !== undefined) row.parentId = input.parentId;
    if (input.depth !== undefined) row.depth = input.depth;
    if (input.orderKey !== undefined) row.orderKey = input.orderKey;
    row.revision += 1;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
    return this.toDomain(row);
  }

  async delete(workspaceId: string, outlineItemId: string): Promise<boolean> {
    const row = this.rows.get(outlineItemId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(outlineItemId);
  }

  async replaceForDocument(
    workspaceId: string,
    documentId: string,
    origin: MetadataOrigin,
    items: CreateOutlineItemInput[],
  ): Promise<OutlineItem[]> {
    // Scoped to the one origin: a re-inspection replaces the file's outline and
    // must never delete what the user authored.
    for (const [id, row] of [...this.rows.entries()]) {
      if (
        row.workspaceId === workspaceId &&
        row.documentId === documentId &&
        row.origin === origin
      ) {
        this.rows.delete(id);
      }
    }
    for (const input of items.slice(0, METADATA_LIMITS.maxOutlineItems)) {
      await this.create(input);
    }
    return this.list({
      workspaceId,
      documentId,
      origin,
      limit: METADATA_LIMITS.maxOutlineItems,
    });
  }

  async listChildren(workspaceId: string, parentId: string): Promise<OutlineItem[]> {
    const matching = [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.parentId === parentId,
    );
    return this.sorted(matching).map((row) => this.toDomain(row));
  }

  async deleteDescendants(
    workspaceId: string,
    documentId: string,
    outlineItemId: string,
  ): Promise<number> {
    // Same breadth-first walk as the Prisma adapter, bounded to the document and
    // terminating on an already-seen id so a cycle in stored links cannot loop.
    const scoped = [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.documentId === documentId,
    );
    const childrenOf = new Map<string, string[]>();
    for (const row of scoped) {
      if (row.parentId === null) continue;
      const siblings = childrenOf.get(row.parentId);
      if (siblings) siblings.push(row.id);
      else childrenOf.set(row.parentId, [row.id]);
    }

    const seen = new Set<string>([outlineItemId]);
    const queue = [...(childrenOf.get(outlineItemId) ?? [])];
    let removed = 0;
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      for (const child of childrenOf.get(id) ?? []) queue.push(child);
      if (this.rows.delete(id)) removed += 1;
    }
    return removed;
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

  async countForDocument(
    workspaceId: string,
    documentId: string,
    origin?: MetadataOrigin,
  ): Promise<number> {
    return [...this.rows.values()].filter(
      (row) =>
        row.workspaceId === workspaceId &&
        row.documentId === documentId &&
        (origin === undefined || row.origin === origin),
    ).length;
  }

  async lastOrderKey(
    workspaceId: string,
    documentId: string,
    parentId: string | null,
  ): Promise<string | null> {
    const matching = this.sorted(
      [...this.rows.values()].filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.documentId === documentId &&
          row.parentId === parentId,
      ),
    );
    return matching.length === 0 ? null : matching[matching.length - 1].orderKey;
  }
}
