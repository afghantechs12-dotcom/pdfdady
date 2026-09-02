import type { Folder, FolderLifecycleState } from "@/src/domain/entities/Folder";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { ActorContext } from "./WorkspaceService";
import type { WorkspaceService } from "./WorkspaceService";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import { normalizeWorkspaceName } from "./workspaceNormalization";
import { generateOrderKeyBetween } from "./orderKey";

const MAX_FOLDER_DEPTH = 10;
const MAX_FOLDER_LIMIT = 100;

export class FolderService {
  constructor(
    private readonly folders: FolderRepository,
    private readonly projects: ProjectRepository,
    private readonly workspaces: WorkspaceService,
  ) {}

  async list(actor: ActorContext, workspaceId: string, parentId?: string | null, cursor?: string, limit = 50) {
    await this.workspaces.get(actor, workspaceId);
    return this.folders.list({
      workspaceId,
      parentId: parentId ?? null,
      lifecycleState: "active",
      cursor,
      limit: Math.min(Math.max(limit, 1), MAX_FOLDER_LIMIT),
    });
  }

  async get(actor: ActorContext, workspaceId: string, folderId: string): Promise<Folder> {
    await this.workspaces.get(actor, workspaceId);
    const folder = await this.folders.getById(workspaceId, folderId);
    if (!folder || folder.workspaceId !== workspaceId) throw new NotFoundError("Folder not found.");
    return folder;
  }

  async create(
    actor: ActorContext,
    workspaceId: string,
    input: { name: string; parentId?: string | null; projectId?: string | null },
  ) {
    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    if (workspace.organizationId !== actor.organizationId) throw new DomainError("Cross-organization folder creation is not permitted.");

    const name = input.name.trim();
    const normalizedName = normalizeWorkspaceName(name);
    if (!name || !normalizedName) throw new DomainError("Folder name is required.");

    let depth = 0;
    if (input.parentId) {
      const parent = await this.folders.getById(workspaceId, input.parentId);
      if (!parent || parent.workspaceId !== workspaceId) throw new NotFoundError("Parent folder not found in same workspace.");
      if (parent.lifecycleState !== "active") throw new DomainError("Cannot create a folder inside an archived or trashed folder.");
      depth = parent.depth + 1;
      if (depth > MAX_FOLDER_DEPTH) throw new DomainError(`Folder nesting limit (${MAX_FOLDER_DEPTH}) reached.`);
    }

    if (input.projectId) {
      const project = await this.projects.getById(workspaceId, input.projectId);
      if (!project || project.workspaceId !== workspaceId) throw new NotFoundError("Project not found in same workspace.");
    }

    const maxKey = await this.folders.maxOrderKey(workspaceId, input.parentId ?? null);
    const orderKey = generateOrderKeyBetween(maxKey, null);

    return this.folders.create({
      workspaceId,
      organizationId: actor.organizationId,
      projectId: input.projectId ?? null,
      parentId: input.parentId ?? null,
      name,
      normalizedName,
      orderKey,
      depth,
      createdById: actor.userId,
    });
  }

  async rename(actor: ActorContext, workspaceId: string, folderId: string, name: string, revision: number) {
    await this.workspaces.get(actor, workspaceId, true);
    const folder = await this.folders.getById(workspaceId, folderId);
    if (!folder) throw new NotFoundError("Folder not found.");
    const trimmed = name.trim();
    const normalizedName = normalizeWorkspaceName(trimmed);
    if (!trimmed || !normalizedName) throw new DomainError("Folder name is required.");
    return this.folders.update(workspaceId, folderId, { name: trimmed, normalizedName, revision });
  }

  async move(
    actor: ActorContext,
    workspaceId: string,
    folderId: string,
    input: { newParentId?: string | null; afterId?: string | null; beforeId?: string | null; revision: number },
  ) {
    await this.workspaces.get(actor, workspaceId, true);
    const folder = await this.folders.getById(workspaceId, folderId);
    if (!folder) throw new NotFoundError("Folder not found.");

    // Cycle prevention: new parent must not be a descendant of this folder
    if (input.newParentId != null) {
      if (input.newParentId === folderId) throw new DomainError("A folder cannot be its own parent.");
      const descendants = await this.folders.getDescendantIds(workspaceId, folderId);
      if (descendants.includes(input.newParentId)) throw new DomainError("Moving a folder into one of its own descendants would create a cycle.");
      const newParent = await this.folders.getById(workspaceId, input.newParentId);
      if (!newParent || newParent.workspaceId !== workspaceId) throw new NotFoundError("New parent folder not found in same workspace.");
      if (newParent.lifecycleState !== "active") throw new DomainError("Cannot move a folder into an archived or trashed folder.");
      const newDepth = newParent.depth + 1;
      if (newDepth > MAX_FOLDER_DEPTH) throw new DomainError(`Folder nesting limit (${MAX_FOLDER_DEPTH}) would be exceeded.`);
    }

    let loKey: string | null = null;
    let hiKey: string | null = null;
    const effectiveParentId = input.newParentId !== undefined ? (input.newParentId ?? null) : folder.parentId;

    if (input.afterId) {
      const after = await this.folders.getById(workspaceId, input.afterId);
      if (!after || after.workspaceId !== workspaceId) throw new DomainError("Reference folder not found in same workspace.");
      loKey = after.orderKey;
    }
    if (input.beforeId) {
      const before = await this.folders.getById(workspaceId, input.beforeId);
      if (!before || before.workspaceId !== workspaceId) throw new DomainError("Reference folder not found in same workspace.");
      hiKey = before.orderKey;
    }
    if (!input.afterId && !input.beforeId) {
      const maxKey = await this.folders.maxOrderKey(workspaceId, effectiveParentId);
      loKey = maxKey;
    }
    const orderKey = generateOrderKeyBetween(loKey, hiKey);
    const update: any = { orderKey, revision: input.revision };
    if (input.newParentId !== undefined) {
      update.parentId = input.newParentId;
      if (input.newParentId != null) {
        const newParent = await this.folders.getById(workspaceId, input.newParentId);
        update.depth = (newParent?.depth ?? 0) + 1;
      } else {
        update.depth = 0;
      }
    }
    return this.folders.update(workspaceId, folderId, update);
  }

  async setLifecycle(actor: ActorContext, workspaceId: string, folderId: string, state: FolderLifecycleState) {
    await this.workspaces.get(actor, workspaceId, true);
    const folder = await this.folders.getById(workspaceId, folderId);
    if (!folder) throw new NotFoundError("Folder not found.");
    return this.folders.setLifecycle(workspaceId, folderId, state, actor.userId);
  }

  /** Returns breadcrumbs from root to this folder (including this folder). */
  async breadcrumbs(actor: ActorContext, workspaceId: string, folderId: string): Promise<Folder[]> {
    await this.workspaces.get(actor, workspaceId);
    const folder = await this.folders.getById(workspaceId, folderId);
    if (!folder || folder.workspaceId !== workspaceId) throw new NotFoundError("Folder not found.");
    const ancestorIds = await this.folders.getAncestorIds(workspaceId, folderId);
    const crumbs: Folder[] = [];
    for (const id of ancestorIds) {
      const ancestor = await this.folders.getById(workspaceId, id);
      if (ancestor) crumbs.push(ancestor);
    }
    crumbs.push(folder);
    return crumbs;
  }
}
