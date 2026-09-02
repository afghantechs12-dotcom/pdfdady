export type ProjectStatus = "active" | "on_hold" | "completed" | "cancelled";
export type ProjectLifecycleState = "active" | "archived" | "trashed";

export interface Project {
  id: string;
  workspaceId: string;
  organizationId: string;
  name: string;
  normalizedName: string;
  slug: string;
  normalizedSlug: string;
  description: string | null;
  status: ProjectStatus;
  lifecycleState: ProjectLifecycleState;
  orderKey: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  trashedAt: Date | null;
  archivedById: string | null;
  trashedById: string | null;
}
