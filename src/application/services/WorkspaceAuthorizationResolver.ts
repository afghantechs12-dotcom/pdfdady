import type { Role } from "@/src/domain/entities/Role";
import type { Workspace } from "@/src/domain/entities/Workspace";
import type { WorkspaceMembership, WorkspaceRole } from "@/src/domain/entities/WorkspaceMembership";
import { INHERITED_WORKSPACE_ROLE, WORKSPACE_ROLE_CAPABILITIES, type WorkspaceCapability } from "@/src/domain/entities/WorkspaceRole";

export type WorkspaceAccessSource = "explicit" | "organization" | "none";
export interface WorkspaceAuthorizationResult {
  allowed: boolean;
  role: WorkspaceRole | null;
  capabilities: WorkspaceCapability[];
  source: WorkspaceAccessSource;
  reason: "unauthenticated" | "organization_unavailable" | "workspace_unavailable" | "lifecycle_restricted" | "explicit_revocation" | "allowed" | "denied";
}

export interface WorkspaceAuthorizationInput {
  actorId: string | null;
  organizationAvailable: boolean;
  organizationId: string;
  organizationDefaultWorkspaceId: string | null;
  organizationRole: Role | null;
  workspace: Workspace | null;
  explicitMembership: WorkspaceMembership | null;
  write?: boolean;
}

export class WorkspaceAuthorizationResolver {
  resolve(input: WorkspaceAuthorizationInput): WorkspaceAuthorizationResult {
    const deny = (reason: WorkspaceAuthorizationResult["reason"]): WorkspaceAuthorizationResult => ({ allowed: false, role: null, capabilities: [], source: "none", reason });
    if (!input.actorId) return deny("unauthenticated");
    if (!input.organizationAvailable || !input.organizationRole) return deny("organization_unavailable");
    if (!input.workspace || input.workspace.organizationId !== input.organizationId) return deny("workspace_unavailable");
    if (input.explicitMembership?.revokedAt) return deny("explicit_revocation");

    // Access first, lifecycle second. The lifecycle check used to run before
    // membership was resolved, which meant a stranger probing an archived
    // Workspace id got `lifecycle_restricted` while probing a live one got
    // `denied` — two distinguishable answers, i.e. an existence oracle. It also
    // made "archived" indistinguishable from "no access" for the owner, who is
    // the one person entitled to know the difference and act on it.
    const access = input.explicitMembership
      ? this.allow(input.explicitMembership.role, "explicit", false)
      : input.organizationDefaultWorkspaceId === input.workspace.id
        ? this.allow(INHERITED_WORKSPACE_ROLE[input.organizationRole], "organization", input.organizationRole === "admin")
        : null;
    if (!access) return deny("denied");
    if (input.write && input.workspace.lifecycleState !== "active") return deny("lifecycle_restricted");
    return access;
  }

  private allow(role: WorkspaceRole, source: Exclude<WorkspaceAccessSource, "none">, organizationAdmin: boolean): WorkspaceAuthorizationResult {
    const capabilities = [...WORKSPACE_ROLE_CAPABILITIES[role]];
    if (organizationAdmin) capabilities.push("org:admin");
    return { allowed: true, role, capabilities, source, reason: "allowed" };
  }
}
