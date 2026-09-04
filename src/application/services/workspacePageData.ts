import { redirect, notFound } from "next/navigation";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { currentUser, loginRedirectUrl } from "./authSession";
import { provisionPersonalAccount } from "./AccountProvisioningService";
import type { PrismaClient } from "@prisma/client";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";
import type { ILogger } from "@/src/application/ports/Logger";
import type { WorkspaceService } from "./WorkspaceService";
import type { WorkspaceMembershipService } from "./WorkspaceMembershipService";
import type { DocumentRecordService } from "./DocumentRecordService";

/**
 * One structured line per refused Workspace page, then Next's controlled 404.
 *
 * Naming another tenant's `organizationId` in the URL used to be the single
 * refusal that left no audit line at all: this guard runs BEFORE any Workspace
 * lookup, so `WorkspaceService.get` — which does log one — is never reached. The
 * answer was already correct (a 404 carrying nothing about the other tenant),
 * but invisible, and an explicit cross-tenant id is exactly the shape worth
 * seeing in a log. Same message and ids-only rule as `WorkspaceService`: no
 * email, no session token, no cookie.
 */
function denyOrganization(category: string, stage: string, actorId: string, organizationId?: string): never {
  appContainer.resolve<ILogger>(Tokens.Logger).warn("workspace.access.denied", {
    operation: "workspacePageActor",
    category,
    stage,
    actorId,
    organizationId: organizationId ?? null,
  });
  notFound();
}

/**
 * Resolves the acting user + Organization for a Workspace page.
 *
 * Unauthenticated visitors are sent to the `/login` PAGE carrying a `next`
 * parameter. This used to redirect to `/api/auth/login`, which exports only
 * POST — a redirect is a GET navigation, so the browser received 405 instead of
 * a login form. That was the reported bug.
 */
export async function workspacePageActor(organizationId?: string, intendedPath = "/workspaces") {
  const user = await currentUser();
  if (!user) redirect(loginRedirectUrl(intendedPath));

  const organizations = appContainer.resolve<IOrganizationProvider>(Tokens.OrganizationProvider);
  let orgs = await organizations.listForUser(user.id);
  // Self-heal accounts created before signup provisioned a tenant: without this
  // they would hit notFound() forever with no way to recover through the UI.
  if (orgs.length === 0) {
    await provisionPersonalAccount(appContainer.resolve<PrismaClient>(Tokens.PrismaClient), user.id, user.email, user.name);
    orgs = await organizations.listForUser(user.id);
  }

  const org = organizationId ? orgs.find(item => item.id === organizationId) : orgs[0];
  if (!org) denyOrganization("ORGANIZATION_NOT_FOUND", "organization_unavailable", user.id, organizationId);
  const role = await appContainer.resolve<IRoleProvider>(Tokens.RoleProvider).getRole(user.id, org.id);
  if (!role) denyOrganization("ORGANIZATION_ROLE_MISSING", "role_unavailable", user.id, org.id);
  return { user, org, actor: { userId: user.id, organizationId: org.id, organizationRole: role, organizationDefaultWorkspaceId: org.defaultWorkspaceId } };
}
export const pageWorkspaceService=()=>appContainer.resolve<WorkspaceService>(Tokens.WorkspaceService);
export const pageMembershipService=()=>appContainer.resolve<WorkspaceMembershipService>(Tokens.WorkspaceMembershipService);
export const pageDocumentService=()=>appContainer.resolve<DocumentRecordService>(Tokens.DocumentRecordService);
