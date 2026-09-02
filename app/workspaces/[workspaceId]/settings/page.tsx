import { AppShell } from "@/components/app/AppShell";
import { AppCard, EmptyState } from "@/components/app/primitives";
import { WorkspaceSettings } from "@/components/workspaces/WorkspaceSettings";
import { WorkspaceMembers } from "@/components/workspaces/WorkspaceMembers";
import { brandTitle } from "@/lib/brand";
import { ShieldAlert } from "lucide-react";
import type { WorkspaceMembership } from "@/src/domain/entities/WorkspaceMembership";
import {
  workspacePageActor,
  pageMembershipService,
  pageWorkspaceService,
} from "@/src/application/services/workspacePageData";
import { loadWorkspaceForRoute } from "@/src/application/services/workspaceRouteAccess";
import { memberIdentities } from "@/src/application/services/memberDirectory";

export const metadata = {
  title: brandTitle("Workspace settings"),
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/** The shape `WorkspaceMembershipService.list` resolves to. */
type MembershipPage = { items: WorkspaceMembership[]; nextCursor: string | null };

/**
 * Workspace settings.
 *
 * Renders inside the same authenticated `AppShell` as the dashboard — the same
 * sidebar, Workspace switcher and user menu — rather than the public marketing
 * container the first draft used.
 *
 * Membership listing is authorized separately from the Workspace itself: an
 * editor can open settings but `WorkspaceMembershipService.list` rejects them.
 * That rejection degrades the members card to an explanatory panel instead of
 * failing the whole page, so a user still reaches the settings they do have.
 * The service remains the authority; this only decides what to render.
 */
export default async function WorkspaceSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { user, org, actor } = await workspacePageActor(query.organizationId);
  const service = pageWorkspaceService();

  const [{ workspace, role }, { items: workspaces }] = await Promise.all([
    loadWorkspaceForRoute(service, actor, workspaceId),
    service.list(actor),
  ]);

  // Not permitted to see the member list => null. Everything else on this page
  // is still usable, so that is a degraded card rather than an error page.
  const members: MembershipPage | null = await pageMembershipService()
    .list(actor, workspaceId)
    .catch(() => null);

  // Display identities for the member rows, in one query. Best-effort: an empty
  // map degrades the list to ids rather than failing the page.
  const identities = members
    ? await memberIdentities(members.items.map((item) => item.userId))
    : new Map();

  const settingsHref = `/workspaces/${encodeURIComponent(workspace.id)}/settings?organizationId=${encodeURIComponent(org.id)}`;

  return (
    <AppShell
      workspaces={workspaces.map((item) => ({
        id: item.id,
        name: item.name,
        lifecycleState: item.lifecycleState,
      }))}
      workspaceId={workspace.id}
      organizationId={org.id}
      user={{ name: user.name ?? null, email: user.email }}
      role={role}
      settingsHref={settingsHref}
      title={
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-app-muted">
            {workspace.name}
          </p>
          <h1 className="truncate text-[15px] font-bold tracking-tight text-app-text">Settings</h1>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-[1100px] px-4 py-5 sm:px-6 lg:px-7">
        <div className="grid gap-4 xl:grid-cols-2">
          <WorkspaceSettings
            workspace={workspace}
            organizationId={org.id}
            canEdit={role === "owner" || role === "editor"}
          />

          {members ? (
            <WorkspaceMembers
              workspaceId={workspace.id}
              organizationId={org.id}
              canManage={role === "owner" || actor.organizationRole === "admin"}
              initial={members.items.map((item) => ({
                id: item.id,
                userId: item.userId,
                role: item.role,
                revision: item.revision,
                revokedAt: item.revokedAt ? item.revokedAt.toISOString() : null,
                email: identities.get(item.userId)?.email ?? null,
                name: identities.get(item.userId)?.name ?? null,
              }))}
            />
          ) : (
            <AppCard as="section" className="p-0">
              <EmptyState
                icon={<ShieldAlert size={22} aria-hidden="true" />}
                title="Members are not visible to your role"
                description="Ask a Workspace owner for the member list or for a role change."
              />
            </AppCard>
          )}
        </div>
      </div>
    </AppShell>
  );
}
