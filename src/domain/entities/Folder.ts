export type FolderLifecycleState = "active" | "archived" | "trashed";

export interface Folder {
  id: string;
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  parentId: string | null;
  name: string;
  normalizedName: string;
  orderKey: string;
  lifecycleState: FolderLifecycleState;
  createdById: string;
  revision: number;
  depth: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  trashedAt: Date | null;
  archivedById: string | null;
  trashedById: string | null;
}
