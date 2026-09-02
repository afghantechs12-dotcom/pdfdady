import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import type { BulkOperationResult, CreateDocumentRecordInput, DocumentRecordListQuery, DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";

function toDomain(row: any): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    folderId: row.folderId,
    name: row.name,
    normalizedName: row.normalizedName,
    lifecycleState: row.lifecycleState,
    orderKey: row.orderKey,
    currentVersionId: row.currentVersionId,
    favorite: row.favorite,
    lastAccessedAt: row.lastAccessedAt,
    createdById: row.createdById,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
    trashedAt: row.trashedAt,
    archivedById: row.archivedById,
    trashedById: row.trashedById,
  };
}

export class PrismaDocumentRecordRepository implements DocumentRecordRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: DocumentRecordListQuery): Promise<{ items: DocumentRecord[]; nextCursor: string | null }> {
    const where: any = { workspaceId: query.workspaceId };
    if (query.lifecycleState) where.lifecycleState = query.lifecycleState;
    if ("folderId" in query) where.folderId = query.folderId ?? null;
    if ("projectId" in query && query.projectId !== undefined) where.projectId = query.projectId;
    if (query.favorite !== undefined) where.favorite = query.favorite;
    if (query.openedOnly) where.lastAccessedAt = { not: null };

    const sortBy = query.sortBy ?? "name";
    const sortOrder = query.sortOrder ?? "asc";
    const orderBy: any[] = [];
    if (sortBy === "name") orderBy.push({ name: sortOrder });
    else if (sortBy === "createdAt") orderBy.push({ createdAt: sortOrder });
    else if (sortBy === "updatedAt") orderBy.push({ updatedAt: sortOrder });
    else if (sortBy === "lastAccessedAt") orderBy.push({ lastAccessedAt: sortOrder });
    orderBy.push({ id: "asc" }); // deterministic tie-breaker

    const rows = await this.prisma.documentRecord.findMany({
      where,
      orderBy,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit).map(toDomain);
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async getById(workspaceId: string, documentId: string): Promise<DocumentRecord | null> {
    const row = await this.prisma.documentRecord.findFirst({ where: { id: documentId, workspaceId } });
    return row ? toDomain(row) : null;
  }

  async create(input: CreateDocumentRecordInput): Promise<DocumentRecord> {
    return toDomain(
      await this.prisma.documentRecord.create({
        data: {
          workspaceId: input.workspaceId,
          organizationId: input.organizationId,
          projectId: input.projectId ?? null,
          folderId: input.folderId ?? null,
          name: input.name,
          normalizedName: input.normalizedName,
          orderKey: input.orderKey,
          createdById: input.createdById,
        },
      }),
    );
  }

  async update(
    workspaceId: string,
    documentId: string,
    data: Partial<Pick<DocumentRecord, "name" | "normalizedName" | "projectId" | "folderId" | "orderKey" | "favorite" | "currentVersionId" | "revision">>,
  ): Promise<DocumentRecord> {
    const result = await this.prisma.documentRecord.updateMany({
      where: { id: documentId, workspaceId, ...(data.revision ? { revision: data.revision } : {}) },
      data: { ...data, revision: { increment: 1 } },
    });
    if (result.count !== 1) throw new Error("Document update conflict.");
    return toDomain(await this.prisma.documentRecord.findFirstOrThrow({ where: { id: documentId, workspaceId } }));
  }

  async setCurrentVersionIfUnset(
    workspaceId: string,
    documentId: string,
    versionId: string,
  ): Promise<boolean> {
    // `currentVersionId: null` is part of the predicate, so the database — not a
    // value this process read moments ago — decides whether the pointer is still
    // unset. A concurrent save that already advanced the document makes this a
    // no-op (count 0) instead of a regression to the import version.
    const result = await this.prisma.documentRecord.updateMany({
      where: { id: documentId, workspaceId, currentVersionId: null },
      data: { currentVersionId: versionId, revision: { increment: 1 } },
    });
    return result.count === 1;
  }

  async setLifecycle(workspaceId: string, documentId: string, state: DocumentRecordLifecycleState, actorId: string): Promise<DocumentRecord> {
    const data =
      state === "archived"
        ? { lifecycleState: state, archivedAt: new Date(), archivedById: actorId, revision: { increment: 1 } }
        : state === "active"
          ? { lifecycleState: state, archivedAt: null, archivedById: null, trashedAt: null, trashedById: null, revision: { increment: 1 } }
          : { lifecycleState: state, trashedAt: new Date(), trashedById: actorId, revision: { increment: 1 } };
    await this.prisma.documentRecord.updateMany({ where: { id: documentId, workspaceId }, data });
    return toDomain(await this.prisma.documentRecord.findFirstOrThrow({ where: { id: documentId, workspaceId } }));
  }

  /**
   * Raw, because `updatedAt` is `@updatedAt` and Prisma has no per-call opt-out:
   * any `update`/`updateMany` here would also stamp it. `updatedAt` is what the
   * file manager renders and sorts as **Modified**, so writing it on an open would
   * say a document changed when nobody changed it — and would reshuffle the
   * Modified column every time a viewer looked at something. Recency lives in
   * `lastAccessedAt`, which is the column this writes and the only one.
   *
   * Parameterized (`$executeRaw` tagged template), and the identifiers are the
   * names Prisma itself generates, so this is not SQLite-specific.
   */
  async touchLastAccessed(workspaceId: string, documentId: string): Promise<void> {
    await this.prisma.$executeRaw`UPDATE "document_records" SET "lastAccessedAt" = ${new Date()} WHERE "id" = ${documentId} AND "workspaceId" = ${workspaceId}`;
  }

  async bulkSetLifecycle(workspaceId: string, documentIds: string[], state: DocumentRecordLifecycleState, actorId: string): Promise<BulkOperationResult> {
    const operationId = randomUUID();
    const itemResults: Array<{ documentId: string; success: boolean; error?: string }> = [];
    for (const docId of documentIds) {
      try {
        await this.setLifecycle(workspaceId, docId, state, actorId);
        itemResults.push({ documentId: docId, success: true });
      } catch (error) {
        itemResults.push({ documentId: docId, success: false, error: error instanceof Error ? error.message : "Unknown error" });
      }
    }
    return { operationId, itemResults };
  }

  async bulkMove(workspaceId: string, documentIds: string[], targetFolderId: string | null, _actorId: string): Promise<BulkOperationResult> {
    const operationId = randomUUID();
    const itemResults: Array<{ documentId: string; success: boolean; error?: string }> = [];
    for (const docId of documentIds) {
      try {
        const doc = await this.getById(workspaceId, docId);
        if (!doc) throw new Error("Document not found");
        await this.update(workspaceId, docId, { folderId: targetFolderId, revision: doc.revision });
        itemResults.push({ documentId: docId, success: true });
      } catch (error) {
        itemResults.push({ documentId: docId, success: false, error: error instanceof Error ? error.message : "Unknown error" });
      }
    }
    return { operationId, itemResults };
  }

  async maxOrderKey(workspaceId: string, folderId: string | null): Promise<string | null> {
    const row = await this.prisma.documentRecord.findFirst({
      where: { workspaceId, folderId, lifecycleState: "active" },
      orderBy: [{ orderKey: "desc" }, { id: "desc" }],
      select: { orderKey: true },
    });
    return row?.orderKey ?? null;
  }
}
