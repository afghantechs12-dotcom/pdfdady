import type { WorkspaceMembership, WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";

export interface WorkspaceMembershipRepository {
  list(workspaceId: string, limit: number, cursor?: string): Promise<{ items: WorkspaceMembership[]; nextCursor: string | null }>;
  get(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
  add(input: { workspaceId: string; userId: string; role: WorkspaceRole; createdById: string }): Promise<WorkspaceMembership>;
  update(workspaceId: string, userId: string, role: WorkspaceRole, revision: number): Promise<WorkspaceMembership>;
  revoke(workspaceId: string, userId: string, revision: number): Promise<WorkspaceMembership>;
  countActiveOwners(workspaceId: string): Promise<number>;
}
