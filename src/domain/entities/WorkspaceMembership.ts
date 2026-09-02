export type WorkspaceRole = "owner" | "editor" | "commenter" | "viewer";

export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdById: string;
  revision: number;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
