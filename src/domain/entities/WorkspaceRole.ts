import type { Role } from "./Role";
import type { WorkspaceRole } from "./WorkspaceMembership";

export type WorkspaceCapability =
  | "workspace:read"
  | "workspace:update"
  | "workspace:archive"
  | "workspace:restore"
  | "workspace:delete"
  | "workspace:manage-members"
  | "workspace:transfer-owner"
  | "org:admin";

export const WORKSPACE_ROLE_CAPABILITIES: Record<WorkspaceRole, WorkspaceCapability[]> = {
  owner: [
    "workspace:read",
    "workspace:update",
    "workspace:archive",
    "workspace:restore",
    "workspace:delete",
    "workspace:manage-members",
    "workspace:transfer-owner",
  ],
  editor: ["workspace:read", "workspace:update"],
  commenter: ["workspace:read"],
  viewer: ["workspace:read"],
};

export const INHERITED_WORKSPACE_ROLE: Record<Extract<Role, "owner" | "admin" | "member" | "viewer">, WorkspaceRole> = {
  owner: "owner",
  admin: "editor",
  member: "editor",
  viewer: "viewer",
};

export function workspaceRoleHasCapability(role: WorkspaceRole, capability: WorkspaceCapability): boolean {
  return WORKSPACE_ROLE_CAPABILITIES[role].includes(capability);
}
