import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import type { BulkOperationResult, DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { ActorContext } from "./WorkspaceService";
import type { WorkspaceService } from "./WorkspaceService";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import { normalizeWorkspaceName } from "./workspaceNormalization";
import { generateOrderKeyBetween } from "./orderKey";

const MAX_DOCUMENT_LIMIT = 100;
const MAX_BULK_OPERATION_SIZE = 50;

export class DocumentRecordService {
  constructor(
    private readonly documents: DocumentRecordRepository,
    private readonly folders: FolderRepository,
    private readonly projects: ProjectRepository,
    private readonly workspaces: WorkspaceService,
  ) {}

  async list(
    actor: ActorContext,
    workspaceId: string,
    options: {
      folderId?: string | null;
      projectId?: string | null;
      view?: "all" | "favorites" | "recent" | "archived" | "trashed";
      sortBy?: "name" | "createdAt" | "updatedAt" | "lastAccessedAt";
      sortOrder?: "asc" | "desc";
      cursor?: string;
      limit?: number;
    } = {},
  ) {
    await this.workspaces.get(actor, workspaceId);
    const view = options.view ?? "all";
    const lifecycleState = view === "archived" ? "archived" : view === "trashed" ? "trashed" : "active";
    const favorite = view === "favorites" ? true : undefined;
    /*
     * WHAT "RECENT" MEANS, decided in one place.
     *
     * It meant nothing before: `view: "recent"` selected active documents and
     * changed neither the filter nor the order, so the Recent view was the All
     * view sorted by name — under an empty state that reads "No recently opened
     * documents." It now means what it says: documents this Workspace has actually
     * opened, most recently opened first.
     *
     * Recency is `lastAccessedAt`, not `updatedAt`. A tool that publishes a version
     * updates a document nobody looked at, and a rename updates one nobody has ever
     * opened; neither belongs at the top of a list of what you were just working on.
     *
     * The view owns this ordering rather than the caller: every caller sends an
     * explicit `sortBy` (the page defaults to name, the file manager sends its
     * column), so honouring it here would leave Recent name-ordered again. The
     * client still sorts the loaded page by its own column, so the column controls
     * keep working — what the server decides is WHICH documents are in the page.
     */
    const recent = view === "recent";
    return this.documents.list({
      workspaceId,
      folderId: options.folderId,
      projectId: options.projectId,
      lifecycleState,
      favorite,
      openedOnly: recent,
      sortBy: recent ? "lastAccessedAt" : options.sortBy ?? "name",
      sortOrder: recent ? "desc" : options.sortOrder ?? "asc",
      cursor: options.cursor,
      limit: Math.min(Math.max(options.limit ?? 25, 1), MAX_DOCUMENT_LIMIT),
    });
  }

  async get(actor: ActorContext, workspaceId: string, documentId: string): Promise<DocumentRecord> {
    await this.workspaces.get(actor, workspaceId);
    const doc = await this.documents.getById(workspaceId, documentId);
    if (!doc || doc.workspaceId !== workspaceId) throw new NotFoundError("Document not found.");
    return doc;
  }

  async create(
    actor: ActorContext,
    workspaceId: string,
    input: { name: string; folderId?: string | null; projectId?: string | null },
  ) {
    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    if (workspace.organizationId !== actor.organizationId) throw new DomainError("Cross-organization document creation is not permitted.");

    const name = input.name.trim();
    const normalizedName = normalizeWorkspaceName(name);
    if (!name || !normalizedName) throw new DomainError("Document name is required.");

    if (input.folderId) {
      const folder = await this.folders.getById(workspaceId, input.folderId);
      if (!folder || folder.workspaceId !== workspaceId) throw new NotFoundError("Folder not found in same workspace.");
      if (folder.lifecycleState !== "active") throw new DomainError("Cannot create a document in an archived or trashed folder.");
    }

    if (input.projectId) {
      const project = await this.projects.getById(workspaceId, input.projectId);
      if (!project || project.workspaceId !== workspaceId) throw new NotFoundError("Project not found in same workspace.");
    }

    const maxKey = await this.documents.maxOrderKey(workspaceId, input.folderId ?? null);
    const orderKey = generateOrderKeyBetween(maxKey, null);

    return this.documents.create({
      workspaceId,
      organizationId: actor.organizationId,
      folderId: input.folderId ?? null,
      projectId: input.projectId ?? null,
      name,
      normalizedName,
      orderKey,
      createdById: actor.userId,
    });
  }

  async rename(actor: ActorContext, workspaceId: string, documentId: string, name: string, revision: number) {
    await this.workspaces.get(actor, workspaceId, true);
    const doc = await this.documents.getById(workspaceId, documentId);
    if (!doc) throw new NotFoundError("Document not found.");
    const trimmed = name.trim();
    const normalizedName = normalizeWorkspaceName(trimmed);
    if (!trimmed || !normalizedName) throw new DomainError("Document name is required.");
    return this.documents.update(workspaceId, documentId, { name: trimmed, normalizedName, revision });
  }

  async move(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    input: { targetFolderId?: string | null; afterId?: string | null; beforeId?: string | null; revision: number },
  ) {
    await this.workspaces.get(actor, workspaceId, true);
    const doc = await this.documents.getById(workspaceId, documentId);
    if (!doc) throw new NotFoundError("Document not found.");

    if (input.targetFolderId !== undefined) {
      if (input.targetFolderId != null) {
        const folder = await this.folders.getById(workspaceId, input.targetFolderId);
        if (!folder || folder.workspaceId !== workspaceId) throw new NotFoundError("Target folder not found in same workspace.");
        if (folder.lifecycleState !== "active") throw new DomainError("Cannot move a document into an archived or trashed folder.");
      }
    }

    let loKey: string | null = null;
    let hiKey: string | null = null;
    const effectiveFolderId = input.targetFolderId !== undefined ? (input.targetFolderId ?? null) : doc.folderId;

    if (input.afterId) {
      const after = await this.documents.getById(workspaceId, input.afterId);
      if (!after || after.workspaceId !== workspaceId) throw new DomainError("Reference document not found in same workspace.");
      loKey = after.orderKey;
    }
    if (input.beforeId) {
      const before = await this.documents.getById(workspaceId, input.beforeId);
      if (!before || before.workspaceId !== workspaceId) throw new DomainError("Reference document not found in same workspace.");
      hiKey = before.orderKey;
    }
    if (!input.afterId && !input.beforeId) {
      const maxKey = await this.documents.maxOrderKey(workspaceId, effectiveFolderId);
      loKey = maxKey;
    }
    const orderKey = generateOrderKeyBetween(loKey, hiKey);
    const update: any = { orderKey, revision: input.revision };
    if (input.targetFolderId !== undefined) update.folderId = input.targetFolderId;
    return this.documents.update(workspaceId, documentId, update);
  }

  async setLifecycle(actor: ActorContext, workspaceId: string, documentId: string, state: DocumentRecordLifecycleState) {
    await this.workspaces.get(actor, workspaceId, true);
    const doc = await this.documents.getById(workspaceId, documentId);
    if (!doc) throw new NotFoundError("Document not found.");
    return this.documents.setLifecycle(workspaceId, documentId, state, actor.userId);
  }

  async toggleFavorite(actor: ActorContext, workspaceId: string, documentId: string, revision: number) {
    await this.workspaces.get(actor, workspaceId, true);
    const doc = await this.documents.getById(workspaceId, documentId);
    if (!doc) throw new NotFoundError("Document not found.");
    return this.documents.update(workspaceId, documentId, { favorite: !doc.favorite, revision });
  }

  async touchAccessed(actor: ActorContext, workspaceId: string, documentId: string) {
    await this.workspaces.get(actor, workspaceId);
    const doc = await this.documents.getById(workspaceId, documentId);
    if (!doc) throw new NotFoundError("Document not found.");
    await this.documents.touchLastAccessed(workspaceId, documentId);
  }

  async bulkSetLifecycle(
    actor: ActorContext,
    workspaceId: string,
    documentIds: string[],
    state: DocumentRecordLifecycleState,
  ): Promise<BulkOperationResult> {
    await this.workspaces.get(actor, workspaceId, true);
    if (documentIds.length > MAX_BULK_OPERATION_SIZE) throw new DomainError(`Bulk operations are limited to ${MAX_BULK_OPERATION_SIZE} items.`);
    return this.documents.bulkSetLifecycle(workspaceId, documentIds, state, actor.userId);
  }

  async bulkMove(
    actor: ActorContext,
    workspaceId: string,
    documentIds: string[],
    targetFolderId: string | null,
  ): Promise<BulkOperationResult> {
    await this.workspaces.get(actor, workspaceId, true);
    if (documentIds.length > MAX_BULK_OPERATION_SIZE) throw new DomainError(`Bulk operations are limited to ${MAX_BULK_OPERATION_SIZE} items.`);
    if (targetFolderId) {
      const folder = await this.folders.getById(workspaceId, targetFolderId);
      if (!folder || folder.workspaceId !== workspaceId) throw new NotFoundError("Target folder not found in same workspace.");
      if (folder.lifecycleState !== "active") throw new DomainError("Cannot move documents into an archived or trashed folder.");
    }
    return this.documents.bulkMove(workspaceId, documentIds, targetFolderId, actor.userId);
  }
}
