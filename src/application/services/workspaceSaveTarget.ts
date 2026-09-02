/**
 * The Workspace a signed-in visitor would save into, resolved on the server.
 *
 * WHY THE SERVER PICKS. The client never names a Workspace it wants: it asks where
 * it may write and is told, so a destination it was not authorized for cannot be
 * typed into a request. The routes it then calls re-check membership anyway
 * (`getWorkspaceActor` on every Workspace route), which is the check that actually
 * enforces this — this function only keeps the UI from offering a destination that
 * check would refuse.
 *
 * Best-effort by design: every failure degrades to "no destination" so a surface
 * that offers saving stays usable for guests and for accounts in an odd state,
 * rather than throwing a visitor out of a result page. No provisioning happens
 * here either — creating a tenant as a side effect of finishing a merge is the
 * signup flow's job.
 *
 * ## Why a LIST, and why the filtering is here
 *
 * `resolveSaveDestinations` answers with every Workspace the actor may save into,
 * because a member of several was previously given the account default and left to
 * move the document afterwards. The set comes from `WorkspaceService.list`, which
 * is membership-scoped, organization-scoped and `lifecycleState: "active"` — so
 * cross-organization, non-member and archived Workspaces are excluded by the
 * repository query, not by the browser. Nothing the client can say widens it, and
 * the save routes re-authorize the chosen id regardless.
 */

import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { IOrganizationProvider } from "@/src/application/ports/auth/OrganizationProvider";
import type { IRoleProvider } from "@/src/application/ports/auth/RoleProvider";
import type { WorkspaceService } from "@/src/application/services/WorkspaceService";

export interface WorkspaceSaveTarget {
  workspaceId: string;
  organizationId: string;
  workspaceName: string;
}

export interface WorkspaceSaveDestinations {
  /** Every Workspace this actor may save into. Empty for an account with none. */
  destinations: WorkspaceSaveTarget[];
  /**
   * The account's default Workspace, when it is one of `destinations`.
   *
   * A LABEL, not a preselection: a user who belongs to several Workspaces has to
   * choose, and this only tells them which one the rest of the product treats as
   * home. `resolveInitialSelection` is what decides whether anything is selected
   * for them, and it only does so when there is a single destination.
   */
  defaultWorkspaceId: string | null;
}

/**
 * Every Workspace this session may save a tool result into.
 *
 * ponytail: the first 100 Workspaces (the service's own ceiling). An account past
 * that gets a truncated selector; add cursor paging to the selector if one ever
 * does.
 */
export async function resolveSaveDestinations(userId: string): Promise<WorkspaceSaveDestinations> {
  const empty: WorkspaceSaveDestinations = { destinations: [], defaultWorkspaceId: null };
  try {
    const orgs = await appContainer
      .resolve<IOrganizationProvider>(Tokens.OrganizationProvider)
      .listForUser(userId);
    // ponytail: the first organization, as before. Multi-organization destination
    // choice stays a documented limitation — the selector answers "which
    // Workspace", which is the gap users actually hit.
    const org = orgs[0];
    if (!org) return empty;

    const role = await appContainer
      .resolve<IRoleProvider>(Tokens.RoleProvider)
      .getRole(userId, org.id);
    if (!role) return empty;

    const { items } = await appContainer
      .resolve<WorkspaceService>(Tokens.WorkspaceService)
      .list(
        {
          userId,
          organizationId: org.id,
          organizationRole: role,
          organizationDefaultWorkspaceId: org.defaultWorkspaceId,
        },
        undefined,
        100,
      );

    const destinations = items.map((item) => ({
      workspaceId: item.id,
      organizationId: org.id,
      workspaceName: item.name,
    }));
    // Only label a default the actor can actually reach. An organization default
    // they are not a member of is not in `items`, and naming it would advertise a
    // destination the save routes would refuse.
    const defaultWorkspaceId =
      destinations.some((d) => d.workspaceId === org.defaultWorkspaceId)
        ? (org.defaultWorkspaceId ?? null)
        : null;
    return { destinations, defaultWorkspaceId };
  } catch {
    return empty;
  }
}

/**
 * The single Workspace a surface that cannot ask should use — the editor's own
 * save target.
 *
 * Delegates, so there is one authorization query in this module and not two that
 * can drift. The editor picks for the user on purpose: it saves an open document
 * rather than publishing a fresh one, and its destination question is answered by
 * where that document already lives.
 */
export async function resolveSaveTarget(userId: string): Promise<WorkspaceSaveTarget | null> {
  const { destinations, defaultWorkspaceId } = await resolveSaveDestinations(userId);
  return destinations.find((d) => d.workspaceId === defaultWorkspaceId) ?? destinations[0] ?? null;
}
