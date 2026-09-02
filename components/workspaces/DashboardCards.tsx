"use client";

import Link from "next/link";
import { Activity, Folder, FolderPlus, Tag as TagIcon } from "lucide-react";
import { AppCard, EmptyState, SectionHeader } from "@/components/app/primitives";
import { workspaceHref } from "@/components/app/appShellLogic";
import {
  DASHBOARD_LIMITS,
  boundedForDisplay,
  describeActivity,
  relativeTime,
  type DashboardActivity,
  type DashboardFolder,
} from "./dashboardLogic";

/**
 * The folder overview.
 *
 * Item counts render only where the server supplied one. `FolderRepository`
 * has no per-folder document count, so the dashboard does not invent one; the
 * card shows the folder name and when it was last touched, both of which are
 * real.
 */
export function FoldersCard({
  folders,
  workspaceId,
  organizationId,
  canWrite,
  onCreateFolder,
}: {
  folders: DashboardFolder[];
  workspaceId: string;
  organizationId: string;
  canWrite: boolean;
  onCreateFolder?: () => void;
}) {
  const { visible, hiddenCount } = boundedForDisplay(folders, DASHBOARD_LIMITS.folders);

  return (
    <AppCard as="section" className="p-0">
      <div className="border-b border-app-border px-4 py-3">
        <SectionHeader
          title="Folders"
          action={
            hiddenCount > 0 ? (
              <span className="text-xs text-app-muted">+{hiddenCount} more</span>
            ) : undefined
          }
        />
      </div>

      {folders.length === 0 ? (
        <EmptyState
          compact
          icon={<Folder size={18} aria-hidden="true" />}
          title="No folders yet"
          description={canWrite ? "Group related documents into folders." : undefined}
          actions={
            canWrite && onCreateFolder ? (
              <button
                type="button"
                onClick={onCreateFolder}
                className="inline-flex items-center gap-1.5 rounded-control border border-app-border px-2.5 py-1.5 text-xs font-semibold text-app-text transition-colors hover:border-primary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <FolderPlus size={14} aria-hidden="true" />
                Create folder
              </button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((folder) => (
            <li key={folder.id}>
              <Link
                href={workspaceHref(workspaceId, organizationId, { view: "all" })}
                className="flex items-center gap-2.5 rounded-control border border-app-border bg-app-subtle p-2.5 transition-all hover:border-primary/30 hover:bg-white hover:shadow-appcard focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-control bg-amber-50 text-amber-600"
                >
                  <Folder size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-app-text">{folder.name}</span>
                  <span className="block truncate text-[11px] text-app-muted">
                    {folder.itemCount !== undefined
                      ? `${folder.itemCount} item${folder.itemCount === 1 ? "" : "s"} · `
                      : ""}
                    Updated {relativeTime(folder.updatedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppCard>
  );
}

/**
 * The activity card, built from the Organization's audit log.
 *
 * The audit log is organization-scoped, so entries are labelled by what they
 * are rather than claimed to be Workspace-specific. There is no "view all
 * activity" link because no such route exists for a non-admin user; adding one
 * that 404s would be worse than omitting it.
 */
export function ActivityCard({ entries }: { entries: DashboardActivity[] }) {
  const { visible } = boundedForDisplay(entries, DASHBOARD_LIMITS.activity);

  return (
    <AppCard as="section" className="p-0">
      <div className="border-b border-app-border px-4 py-3">
        <SectionHeader
          title={
            <span className="flex items-center gap-1.5">
              <Activity size={15} aria-hidden="true" className="text-primary" />
              Activity
            </span>
          }
        />
      </div>
      {visible.length === 0 ? (
        <EmptyState
          compact
          icon={<Activity size={18} aria-hidden="true" />}
          title="No recent activity"
          description="Actions in this account will appear here."
        />
      ) : (
        <ul className="divide-y divide-app-border">
          {visible.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2.5 px-4 py-2.5">
              <span
                aria-hidden="true"
                className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] leading-snug text-app-text">
                  <span className="font-semibold">{entry.actorLabel ?? "Someone"}</span>{" "}
                  {describeActivity(entry)}
                </span>
                <span className="block text-[11px] text-app-muted">{relativeTime(entry.createdAt)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </AppCard>
  );
}

/** One tag as the dashboard receives it. */
export interface DashboardTag {
  id: string;
  name: string;
  color: string | null;
  /** Document count where the server supplied one. */
  documentCount?: number;
}

/** The tag overview, linking into the Workspace's tag management. */
export function TagsCard({
  tags,
  settingsHref,
  canWrite,
}: {
  tags: DashboardTag[];
  settingsHref: string | null;
  canWrite: boolean;
}) {
  const { visible, hiddenCount } = boundedForDisplay(tags, DASHBOARD_LIMITS.tags);

  return (
    <AppCard as="section" className="p-0">
      <div className="border-b border-app-border px-4 py-3">
        <SectionHeader
          title={
            <span className="flex items-center gap-1.5">
              <TagIcon size={15} aria-hidden="true" className="text-primary" />
              Tags
            </span>
          }
          action={
            hiddenCount > 0 ? <span className="text-xs text-app-muted">+{hiddenCount}</span> : undefined
          }
        />
      </div>
      {visible.length === 0 ? (
        <EmptyState
          compact
          icon={<TagIcon size={18} aria-hidden="true" />}
          title="No tags yet"
          description={canWrite ? "Tags help you find documents across folders." : undefined}
          actions={
            canWrite && settingsHref ? (
              <Link
                href={settingsHref}
                className="inline-flex items-center gap-1.5 rounded-control border border-app-border px-2.5 py-1.5 text-xs font-semibold text-app-text transition-colors hover:border-primary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Manage tags
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-wrap gap-1.5 p-3">
          {visible.map((tag) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-app-border bg-app-subtle px-2.5 py-1 text-xs font-medium text-app-text"
            >
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: tag.color ?? "#94A3B8" }}
              />
              {tag.name}
              {tag.documentCount !== undefined && (
                <span className="text-app-muted">{tag.documentCount}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </AppCard>
  );
}
