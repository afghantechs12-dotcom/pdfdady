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

/** The bit of the session user every caller here actually needs. */
export interface SessionUser {
  id: string;
}

/**
 * The signed-in user, or the 401 to return.
 *
 * Resolved from the session cookie ALONE — no path parameter, no body, no header
 * a client can shape. That is what makes it callable BEFORE a multipart body is
 * read, which is the whole reason it exists: an upload route that authenticates
 * after parsing has already spent the memory it was trying to protect.
 *
 * The response is byte-for-byte the one `getWorkspaceActor` returns for the same
 * situation, so moving authentication earlier changes WHEN a caller is refused,
 * never WHAT it learns.
 */
export async function getSessionUser(request: NextRequest): Promise<{ user: SessionUser } | { response: Response }> {
  const token = request.cookies.get(USER_SESSION_COOKIE)?.value;
  if (!token) return { response: workspaceError(request, "UNAUTHORIZED", "Authentication is required.", 401) };
  const auth = appContainer.resolve<AuthService>(Tokens.AuthService);
  const user = await auth.getMe(token);
  if (!user) return { response: workspaceError(request, "UNAUTHORIZED", "Authentication is required.", 401) };
  return { user: { id: user.id } };
}

/**
 * The full actor: session user + the organization named by the caller + their role
 * in it.
 *
 * `sessionUser` is an optional hand-off from {@link getSessionUser}, for the routes
 * that had to authenticate before reading the body. It only ever skips the cookie
 * lookup this function would repeat — the caller cannot use it to name a different
 * user than its own cookie resolved to, because the only thing that produces one
 * is that cookie.
 */
export async function getWorkspaceActor(request: NextRequest, organizationId?: string, sessionUser?: SessionUser): Promise<{ actor: ActorContext } | { response: Response }> {
  let user: SessionUser;
  if (sessionUser) {
    user = sessionUser;
  } else {
    const resolved = await getSessionUser(request);
    if ("response" in resolved) return resolved;
    user = resolved.user;
  }
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
