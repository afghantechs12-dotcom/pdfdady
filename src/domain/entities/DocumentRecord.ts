export type DocumentRecordLifecycleState = "active" | "archived" | "trashed";

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  folderId: string | null;
  name: string;
  normalizedName: string;
  lifecycleState: DocumentRecordLifecycleState;
  orderKey: string;
  currentVersionId: string | null;
  favorite: boolean;
  lastAccessedAt: Date | null;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  trashedAt: Date | null;
  archivedById: string | null;
  trashedById: string | null;
}
