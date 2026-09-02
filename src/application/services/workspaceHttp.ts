import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { AuthService, USER_SESSION_COOKIE } from "./AuthService";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";
import type { ActorContext } from "./WorkspaceService";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import { WorkspaceService } from "./WorkspaceService";
import { WorkspaceMembershipService } from "./WorkspaceMembershipService";
import { ProjectService } from "./ProjectService";
import { FolderService } from "./FolderService";
import { DocumentRecordService } from "./DocumentRecordService";
export { requireSameOrigin } from "./workspaceCsrf";

export function requestId(request: Request): string {
  return request.headers.get("x-request-id")?.slice(0, 128) || randomUUID();
}

export function workspaceError(request: Request, code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message, requestId: requestId(request) } }, { status });
}

export function mapWorkspaceError(request: Request, error: unknown) {
  if (error instanceof NotFoundError) return workspaceError(request, "NOT_FOUND", error.message, 404);
  if (error instanceof DomainError) return workspaceError(request, "WORKSPACE_OPERATION_REJECTED", error.message, 409);
  return workspaceError(request, "INTERNAL_ERROR", "Workspace operation failed.", 500);
}

export async function getWorkspaceActor(request: NextRequest, organizationId?: string): Promise<{ actor: ActorContext } | { response: Response }> {
  const token = request.cookies.get(USER_SESSION_COOKIE)?.value;
  if (!token) return { response: workspaceError(request, "UNAUTHORIZED", "Authentication is required.", 401) };
  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);
  const user = await auth.getMe(token);
  if (!user) return { response: workspaceError(request, "UNAUTHORIZED", "Authentication is required.", 401) };
  const organizations = appContainer.resolve<IOrganizationProvider>(Tokens.OrganizationProvider);
  const roles = appContainer.resolve<IRoleProvider>(Tokens.RoleProvider);
  const orgs = await organizations.listForUser(user.id);
  const org = organizationId ? orgs.find((item) => item.id === organizationId) : orgs[0];
  if (!org) return { response: workspaceError(request, "FORBIDDEN", "Organization access is not permitted.", 403) };
  const role = await roles.getRole(user.id, org.id);
  if (!role) return { response: workspaceError(request, "FORBIDDEN", "Organization access is not permitted.", 403) };
  return { actor: { userId: user.id, organizationId: org.id, organizationRole: role, organizationDefaultWorkspaceId: org.defaultWorkspaceId } };
}

export function workspaceServices() {
  return {
    workspaces: appContainer.resolve<WorkspaceService>(Tokens.WorkspaceService),
    memberships: appContainer.resolve<WorkspaceMembershipService>(Tokens.WorkspaceMembershipService),
    projects: appContainer.resolve<ProjectService>(Tokens.ProjectService),
    folders: appContainer.resolve<FolderService>(Tokens.FolderService),
    documents: appContainer.resolve<DocumentRecordService>(Tokens.DocumentRecordService),
    audit: appContainer.resolve<import("@/src/application/ports/auth/AuditLogRepository").IAuditLogRepository>(Tokens.AuditLogRepository),
  };
}
