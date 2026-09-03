import { AppShell } from "@/components/app/AppShell";
import { DocumentWorkbench } from "@/components/workspaces/DocumentWorkbench";
import { brandTitle } from "@/lib/brand";
import { WORKSPACE_SESSION_LIMITS } from "@/src/domain/entities/WorkspaceSession";
import {
  workspacePageActor,
  pageDocumentService,
  pageWorkspaceService,
} from "@/src/application/services/workspacePageData";
import {
  loadWorkspaceForRoute,
  routeOr404,
} from "@/src/application/services/workspaceRouteAccess";

export const metadata = {
  title: { absolute: brandTitle("Document") },
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

/**
 * The Workspace document workbench.
 *
 * The server's job here is narrow on purpose: authorize, resolve the document's
 * name and the actor's role, and hand those to the client. Specifically it does
 * not:
 *
 * - pass PDF bytes through props — the editor fetches its own content from the
 *   authorized content route, so document bytes never sit in the HTML payload;
 * - expose any storage key — none is read here, and none is available to the
 *   client at all;
 * - create a session — provisioning on render would mint a session row for
 *   every navigation and every prefetch. The client creates one once, on mount.
 *
 * `service.get` throws for a document outside this Workspace, which `routeOr404`
 * turns into a controlled not-found — the same outcome as a document that never
 * existed, which is what keeps this from being an existence probe.
 */
export default async function WorkspaceDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; documentId: string }>;
  searchParams: Promise<{ organizationId?: string }>;
}) {
  const { workspaceId, documentId } = await params;
  const query = await searchParams;
  const { user, org, actor } = await workspacePageActor(query.organizationId);

  const service = pageWorkspaceService();
  const [{ workspace, role }, { items: workspaces }, document] = await Promise.all([
    loadWorkspaceForRoute(service, actor, workspaceId),
    service.list(actor),
    routeOr404(pageDocumentService().get(actor, workspaceId, documentId)),
  ]);

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
          <h1 className="truncate text-[15px] font-bold tracking-tight text-app-text">
            {document.name}
          </h1>
        </div>
      }
    >
      <DocumentWorkbench
        workspaceId={workspace.id}
        organizationId={org.id}
        documentId={document.id}
        documentName={document.name}
        maxTabs={WORKSPACE_SESSION_LIMITS.maxTabs}
        canWrite={role !== "viewer"}
        viewerId={user.id}
        // Moderating another person's comment thread is an owner/admin act, not
        // an editor one. The comment routes re-check regardless.
        canModerate={role === "owner" || actor.organizationRole === "admin"}
      />
    </AppShell>
  );
}
