import { AppShell } from "@/components/app/AppShell";
import { WorkspaceDashboard } from "@/components/workspaces/WorkspaceDashboard";
import { WorkspaceSearch } from "@/components/workspaces/WorkspaceSearch";
import { OperationsIndicator } from "@/components/workspaces/OperationsIndicator";
import { appContainer } from "@/src/application/di/container";
import { Tokens } from "@/src/application/di/tokens";
import type { FolderService } from "@/src/application/services/FolderService";
import type { TagService } from "@/src/application/services/TagService";
import type { IAuditLogRepository } from "@/src/application/ports/auth/AuditLogRepository";
import {
  workspacePageActor,
  pageWorkspaceService,
  pageDocumentService,
} from "@/src/application/services/workspacePageData";
import { loadWorkspaceForRoute } from "@/src/application/services/workspaceRouteAccess";
import { brandTitle } from "@/lib/brand";

export const metadata = {
  title: { absolute: brandTitle("Workspace") },
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

type WorkspaceView = "all" | "favorites" | "recent" | "archived" | "trashed";

const VIEWS: readonly WorkspaceView[] = ["all", "favorites", "recent", "archived", "trashed"];

/** Resolves an untrusted `view` query value to a known view. */
function resolveView(raw: string | undefined): WorkspaceView {
  return VIEWS.find((view) => view === raw) ?? "all";
}

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ organizationId?: string; view?: string; documentId?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { user, org, actor } = await workspacePageActor(query.organizationId);
  const service = pageWorkspaceService();
  const docService = pageDocumentService();
  const view = resolveView(query.view);

  // `loadWorkspaceForRoute` is the only Workspace lookup a page performs: it
  // turns an authorization refusal into a controlled not-found instead of an
  // uncaught throw rendered as a server error.
  const [{ workspace, role }, { items: workspaces }] = await Promise.all([
    loadWorkspaceForRoute(service, actor, workspaceId),
    service.list(actor),
  ]);

  const { items: documents, nextCursor } = await docService.list(actor, workspaceId, {
    view,
    sortBy: "name",
    sortOrder: "asc",
    limit: 50,
  });

  // The dashboard's side data. Each is optional context rather than the point
  // of the page, so a failure in one degrades that card instead of 500ing the
  // whole Workspace — the services throw on authorization, which is exactly the
  // case where an empty card is the correct outcome.
  const [folders, tags, activity] = await Promise.all([
    appContainer
      .resolve<FolderService>(Tokens.FolderService)
      .list(actor, workspaceId, null, undefined, 12)
      .then((result) => result.items)
      .catch(() => []),
    appContainer
      .resolve<TagService>(Tokens.TagService)
      .listTags(actor, workspaceId, 20)
      .catch(() => []),
    appContainer
      .resolve<IAuditLogRepository>(Tokens.AuditLogRepository)
      .listByOrg(org.id, 12)
      .catch(() => []),
  ]);

  const canWrite = role !== "viewer";
  const settingsHref = `/workspaces/${encodeURIComponent(workspace.id)}/settings?organizationId=${encodeURIComponent(org.id)}`;
  const documentNames = Object.fromEntries(documents.map((doc) => [doc.id, doc.name]));

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
        <WorkspaceSearch
          workspaceId={workspace.id}
          organizationId={org.id}
          documentNames={documentNames}
          canReindex={canWrite}
        />
      }
      topbar={
        <OperationsIndicator
          workspaceId={workspace.id}
          organizationId={org.id}
          canWrite={canWrite}
        />
      }
    >
      <WorkspaceDashboard
        workspaceId={workspace.id}
        organizationId={org.id}
        workspaceName={workspace.name}
        workspaceDescription={workspace.description}
        canWrite={canWrite}
        documents={documents.map((doc) => ({
          id: doc.id,
          name: doc.name,
          favorite: doc.favorite,
          lifecycleState: doc.lifecycleState,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: doc.updatedAt.toISOString(),
          lastAccessedAt: doc.lastAccessedAt?.toISOString() ?? null,
          folderId: doc.folderId,
          projectId: doc.projectId,
          revision: doc.revision,
        }))}
        hasNextPage={!!nextCursor}
        nextCursor={nextCursor}
        initialView={view}
        folders={folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          updatedAt: folder.updatedAt.toISOString(),
        }))}
        tags={tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }))}
        activity={activity.map((entry) => ({
          id: entry.id,
          action: entry.action,
          createdAt: entry.createdAt.toISOString(),
          // The audit log stores an actor id, not a display name. Showing the
          // signed-in user's name for their own entries is accurate; anything
          // else stays anonymous rather than guessing at a name.
          actorLabel: entry.actorId === user.id ? (user.name ?? "You") : null,
          resourceLabel: entry.resourceId ? (documentNames[entry.resourceId] ?? null) : null,
          // The name the EVENT recorded, which is the only one that survives the
          // document leaving this page — renamed, archived, or simply past the
          // first 50. `resourceLabel` above stays as the historical fallback for
          // entries written before events carried metadata.
          metadata: entry.metadata,
        }))}
        settingsHref={settingsHref}
      />
    </AppShell>
  );
}
