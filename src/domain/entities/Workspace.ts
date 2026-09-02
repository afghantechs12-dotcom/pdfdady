export type WorkspaceLifecycleState = "active" | "archived" | "trashed";

export interface Workspace {
  id: string;
  organizationId: string;
  name: string;
  normalizedName: string;
  slug: string;
  normalizedSlug: string;
  description: string | null;
  lifecycleState: WorkspaceLifecycleState;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  trashedAt: Date | null;
  archivedById: string | null;
  trashedById: string | null;
}
