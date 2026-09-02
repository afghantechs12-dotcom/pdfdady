import { redirect, notFound } from "next/navigation";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import { currentUser, loginRedirectUrl } from "./authSession";
import { provisionPersonalAccount } from "./AccountProvisioningService";
import type { PrismaClient } from "@prisma/client";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";
import type { WorkspaceService } from "./WorkspaceService";
import type { WorkspaceMembershipService } from "./WorkspaceMembershipService";
import type { DocumentRecordService } from "./DocumentRecordService";

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
  if (!org) notFound();
  const role = await appContainer.resolve<IRoleProvider>(Tokens.RoleProvider).getRole(user.id, org.id);
  if (!role) notFound();
  return { user, org, actor: { userId: user.id, organizationId: org.id, organizationRole: role, organizationDefaultWorkspaceId: org.defaultWorkspaceId } };
}
export const pageWorkspaceService=()=>appContainer.resolve<WorkspaceService>(Tokens.WorkspaceService);
export const pageMembershipService=()=>appContainer.resolve<WorkspaceMembershipService>(Tokens.WorkspaceMembershipService);
export const pageDocumentService=()=>appContainer.resolve<DocumentRecordService>(Tokens.DocumentRecordService);
