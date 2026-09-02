import type { Folder, FolderLifecycleState } from "@/src/domain/entities/Folder";

export interface FolderListQuery {
  workspaceId: string;
  parentId?: string | null;
  projectId?: string | null;
  lifecycleState?: FolderLifecycleState;
  cursor?: string;
  limit: number;
}

export interface CreateFolderInput {
  workspaceId: string;
  organizationId: string;
  projectId?: string | null;
  parentId?: string | null;
  name: string;
  normalizedName: string;
  orderKey: string;
  depth: number;
  createdById: string;
}

export interface FolderRepository {
  list(query: FolderListQuery): Promise<{ items: Folder[]; nextCursor: string | null }>;
  getById(workspaceId: string, folderId: string): Promise<Folder | null>;
  create(input: CreateFolderInput): Promise<Folder>;
  update(
    workspaceId: string,
    folderId: string,
    data: Partial<Pick<Folder, "name" | "normalizedName" | "orderKey" | "projectId" | "parentId" | "depth" | "revision">>,
  ): Promise<Folder>;
  setLifecycle(workspaceId: string, folderId: string, state: FolderLifecycleState, actorId: string): Promise<Folder>;
  /** All active ancestor IDs from root to direct parent (for cycle detection and breadcrumbs). */
  getAncestorIds(workspaceId: string, folderId: string): Promise<string[]>;
  /** All active descendant IDs (for subtree operations). */
  getDescendantIds(workspaceId: string, folderId: string): Promise<string[]>;
  /** Highest orderKey in a given parent scope (parentId=null means root). */
  maxOrderKey(workspaceId: string, parentId: string | null): Promise<string | null>;
}
