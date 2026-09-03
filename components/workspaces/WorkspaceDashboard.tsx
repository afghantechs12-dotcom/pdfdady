"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { FileText, PenTool } from "lucide-react";
import { AppCard, EmptyState, SectionHeader } from "@/components/app/primitives";
import { UsageCard } from "@/components/app/UsageCard";
import { workspaceHref } from "@/components/app/appShellLogic";
import { CommandPalette } from "./CommandPalette";
import { DocumentFileManager } from "./DocumentFileManager";
import { QuickAccess } from "./QuickAccess";
import { NewMenu } from "./NewMenu";
import { ActivityCard, FoldersCard, TagsCard, type DashboardTag } from "./DashboardCards";
import { relativeTime, recentDocuments, viewCountsFromLoadedPage } from "./dashboardLogic";
import type { DashboardActivity, DashboardFolder } from "./dashboardLogic";
import type { DocumentItem, ViewFilter } from "./fileManagerLogic";

export interface WorkspaceDashboardProps {
  workspaceId: string;
  organizationId: string;
  workspaceName: string;
  workspaceDescription: string | null;
  canWrite: boolean;
  documents: DocumentItem[];
  hasNextPage: boolean;
  nextCursor: string | null;
  initialView: ViewFilter;
  folders: DashboardFolder[];
  tags: DashboardTag[];
  activity: DashboardActivity[];
  settingsHref: string;
}

/**
 * The Workspace dashboard.
 *
 * Layout follows the target: a heading row, quick access, the folder overview
 * and the document manager in the main column, with activity and tags in a
 * right-hand column that drops below the content on tablet and narrower.
 *
 * The usage card is the one figure here that is real: it reads the caller's own
 * metered allowance from `GET /api/usage`. There is still no *storage* card,
 * because nothing computes stored bytes per workspace — a meter has to be real or
 * not present, and that one would be neither. There is no AI panel: no AI
 * capability is implemented.
 */
export function WorkspaceDashboard({
  workspaceId,
  organizationId,
  workspaceName,
  workspaceDescription,
  canWrite,
  documents,
  hasNextPage,
  nextCursor,
  initialView,
  folders,
  tags,
  activity,
  settingsHref,
}: WorkspaceDashboardProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const onChanged = useCallback(() => setRefreshKey((value) => value + 1), []);

  // Counts come from the loaded page and are reported only when that page is
  // the complete set — a partial page cannot support a total.
  const counts = useMemo(
    () =>
      viewCountsFromLoadedPage({
        documents: documents.map((doc) => ({
          id: doc.id,
          name: doc.name,
          favorite: doc.favorite,
          lifecycleState: doc.lifecycleState,
          updatedAt: doc.updatedAt,
          folderId: doc.folderId,
          projectId: doc.projectId,
        })),
        complete: !hasNextPage,
      }),
    [documents, hasNextPage],
  );

  const recent = useMemo(
    () =>
      recentDocuments(
        documents.map((doc) => ({
          id: doc.id,
          name: doc.name,
          favorite: doc.favorite,
          lifecycleState: doc.lifecycleState,
          updatedAt: doc.updatedAt,
          folderId: doc.folderId,
          projectId: doc.projectId,
        })),
      ),
    [documents],
  );

  const workspaceEmpty = documents.length === 0 && initialView === "all";

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 lg:px-7">
      {/* Heading row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold tracking-tight text-app-text sm:text-2xl">
            {workspaceName}
          </h1>
          <p className="mt-0.5 truncate text-sm text-app-muted">
            {workspaceDescription ?? "Document workspace"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CommandPalette
            workspaceId={workspaceId}
            organizationId={organizationId}
            activeDocumentId={null}
          />
          <NewMenu
            workspaceId={workspaceId}
            organizationId={organizationId}
            canWrite={canWrite}
            onChanged={onChanged}
          />
        </div>
      </div>

      {/* Quick access */}
      <div className="mt-4">
        <QuickAccess
          workspaceId={workspaceId}
          organizationId={organizationId}
          counts={counts}
        />
      </div>

      {/* Main + side columns */}
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-4">
          <FoldersCard
            folders={folders}
            workspaceId={workspaceId}
            organizationId={organizationId}
            canWrite={canWrite}
          />

          {/* Recent documents — a compact overview above the full manager. */}
          {recent.length > 0 && (
            <AppCard as="section" className="p-0">
              <div className="border-b border-app-border px-4 py-3">
                <SectionHeader title="Recent documents" />
              </div>
              <ul className="divide-y divide-app-border">
                {recent.slice(0, 5).map((doc) => (
                  <li key={doc.id}>
                    <Link
                      href={workspaceHref(workspaceId, organizationId, {
                        path: `/documents/${encodeURIComponent(doc.id)}`,
                      })}
                      className="flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-app-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                    >
                      <FileText size={16} aria-hidden="true" className="shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-app-text">
                        {doc.name}
                      </span>
                      <span className="shrink-0 text-[11px] text-app-muted" data-relative-time>
                        {relativeTime(doc.updatedAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </AppCard>
          )}

          {/* The full document manager */}
          <AppCard as="section" className="p-0">
            {workspaceEmpty ? (
              <EmptyState
                icon={<FileText size={22} aria-hidden="true" />}
                title="No documents yet"
                description={
                  canWrite
                    ? "Upload a PDF to start working, or open the editor to build one from scratch."
                    : "Documents added to this Workspace will appear here."
                }
                actions={
                  canWrite ? (
                    <>
                      <NewMenu
                        workspaceId={workspaceId}
                        organizationId={organizationId}
                        canWrite={canWrite}
                        onChanged={onChanged}
                      />
                      <Link
                        href="/editor"
                        className="inline-flex min-h-[38px] items-center gap-1.5 rounded-control border border-app-border px-3 text-sm font-semibold text-app-text transition-colors hover:border-primary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      >
                        <PenTool size={15} aria-hidden="true" />
                        Open editor
                      </Link>
                    </>
                  ) : undefined
                }
              />
            ) : (
              <div className="p-3 sm:p-4">
                <DocumentFileManager
                  key={refreshKey}
                  workspaceId={workspaceId}
                  organizationId={organizationId}
                  items={documents}
                  hasNextPage={hasNextPage}
                  nextCursor={nextCursor}
                  initialView={initialView}
                />
              </div>
            )}
          </AppCard>
        </div>

        {/* Side column: below the content on tablet and narrower. */}
        <div className="flex min-w-0 flex-col gap-4">
          <UsageCard organizationId={organizationId} />
          <ActivityCard entries={activity} />
          <TagsCard tags={tags} settingsHref={settingsHref} canWrite={canWrite} />
        </div>
      </div>
    </div>
  );
}

/** The top-bar slot: search plus the operations indicator. */
