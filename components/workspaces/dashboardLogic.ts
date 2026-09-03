/**
 * Pure view-model logic for the Workspace dashboard.
 *
 * The dashboard's whole risk is showing numbers and states it does not actually
 * have. Every function here is built around one rule: a value the server did not
 * supply renders as absent, never as zero, and never as an invented figure.
 * Keeping that decision in one testable module is what stops "0 documents" from
 * appearing next to a list that simply has not loaded.
 */

import { getToolBySlug } from "@/data/tools";

/** A folder as the dashboard receives it. */
export interface DashboardFolder {
  id: string;
  name: string;
  updatedAt: string | Date;
  /** Item count, when the server supplied one. Undefined = unknown. */
  itemCount?: number;
}

/** A document as the dashboard receives it. */
export interface DashboardDocument {
  id: string;
  name: string;
  favorite: boolean;
  lifecycleState: "active" | "archived" | "trashed";
  updatedAt: string | Date;
  folderId: string | null;
  projectId: string | null;
}

/** An audit entry rendered in the activity card. */
export interface DashboardActivity {
  id: string;
  action: string;
  createdAt: string | Date;
  actorLabel: string | null;
  /**
   * The resource's name as the PAGE could resolve it — by looking the resource id
   * up among the documents it happens to have loaded. Null whenever it could not,
   * which is most of the time: anything past the first page, or since renamed,
   * archived or deleted.
   */
  resourceLabel: string | null;
  /**
   * The event's own metadata, as recorded when it happened. `unknown` because it
   * comes from the audit log as parsed JSON and is not this module's to trust —
   * every read below is a checked one.
   *
   * This is what makes an old event describable. A name resolved from the current
   * page describes the document as it is NOW and fails whenever it is absent; a
   * name recorded with the event describes what actually happened.
   */
  metadata?: unknown;
}

/** One string field of an audit entry's metadata, if it is really there. */
function metaText(metadata: unknown, key: string): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** One positive integer field of an audit entry's metadata, if it is really there. */
function metaCount(metadata: unknown, key: string): number | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** How many rows each dashboard section renders before "view all". */
export const DASHBOARD_LIMITS = {
  recentDocuments: 8,
  folders: 6,
  activity: 6,
  tags: 8,
} as const;

/**
 * Bounds a list for display and reports whether anything was hidden.
 *
 * Returning `hiddenCount` rather than a bare truncated array is deliberate: a
 * section that silently drops rows reads as complete when it is not.
 */
export function boundedForDisplay<T>(items: readonly T[], limit: number): {
  visible: T[];
  hiddenCount: number;
} {
  if (limit <= 0) return { visible: [], hiddenCount: items.length };
  const visible = items.slice(0, limit);
  return { visible, hiddenCount: Math.max(0, items.length - visible.length) };
}

/**
 * Documents for the "Recent" dashboard table, newest first.
 *
 * Sorted by `updatedAt` rather than filtered by a recency window: the list
 * answers "what did I touch last", and a window would leave the section empty
 * for a user returning after a break.
 */
export function recentDocuments(
  documents: readonly DashboardDocument[],
  limit: number = DASHBOARD_LIMITS.recentDocuments,
): DashboardDocument[] {
  return [...documents]
    .filter((doc) => doc.lifecycleState === "active")
    .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt))
    .slice(0, Math.max(0, limit));
}

function toTime(value: string | Date): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

/**
 * Counts documents per view from a loaded page of documents.
 *
 * Returns `undefined` for a view whose count cannot be known from this data.
 * The page loads one bounded page of ACTIVE documents, so it can honestly count
 * favorites among them, but it knows nothing about archived or trashed
 * documents — those must not be reported as zero.
 */
export function viewCountsFromLoadedPage(input: {
  documents: readonly DashboardDocument[];
  /** True when the loaded page is the complete set (no further pages). */
  complete: boolean;
}): Record<string, number | undefined> {
  const { documents, complete } = input;
  if (!complete) {
    // A partial page cannot support any total, and a count of "what happens to
    // be loaded" is a number that changes as you scroll.
    return { all: undefined, favorites: undefined, recent: undefined, archived: undefined, trashed: undefined };
  }
  const active = documents.filter((doc) => doc.lifecycleState === "active");
  return {
    all: active.length,
    favorites: active.filter((doc) => doc.favorite).length,
    // "Recent" is an ordering of the same set, not a distinct subset.
    recent: undefined,
    // Not present in an active-only listing.
    archived: undefined,
    trashed: undefined,
  };
}

/**
 * A short relative time, e.g. "2 hours ago".
 *
 * Every render of this MUST carry `data-relative-time`, which is the visual
 * harness's global mask. Without it a screenshot reference of the dashboard is
 * only stable while the run stays inside one minute of the document it created:
 * `docs/evidence/final-prelaunch/visual/` records a full pass that was green for
 * that reason rather than because the pixels were stable.
 */
export function relativeTime(value: string | Date, now: number = Date.now()): string {
  const time = toTime(value);
  if (time === 0) return "—";
  const diff = now - time;
  if (diff < 0) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Turns an audit action id into a human sentence.
 *
 * Unknown actions fall back to a readable form of the id rather than being
 * hidden: an activity feed that drops entries it does not recognize is an
 * activity feed that quietly under-reports.
 */
export function describeActivity(entry: DashboardActivity): string {
  /*
   * The name, in the order the answers can be trusted.
   *
   * 1. What the event recorded. True of the moment it happened, and available for
   *    every document whether or not the dashboard loaded it.
   * 2. What the page could resolve. The HISTORICAL FALLBACK: every event written
   *    before this phase has no metadata, and those still read correctly for the
   *    documents on the page.
   * 3. "a document" — never "an item". A dashboard row that cannot name its
   *    subject should still say what kind of thing it was.
   */
  const named = metaText(entry.metadata, "documentName");
  const document = named ?? entry.resourceLabel ?? "a document";
  const subject = named ?? entry.resourceLabel ?? "an item";
  const version = metaCount(entry.metadata, "versionNumber");
  const toolSlug = metaText(entry.metadata, "toolSlug");

  switch (entry.action) {
    case "document.create":
      return `created ${subject}`;
    case "document.update":
      return `updated ${subject}`;
    case "document.upload":
      /*
       * The two ways bytes arrive, told apart by the tool the save came from —
       * which the cloud-result save route records. "uploaded" is wrong for a result
       * the user never had on their machine, and it is the line a user reads when
       * checking whether their compressed file made it into the Workspace.
       */
      return toolSlug
        ? `saved ${document} from ${toolLabel(toolSlug)} to this Workspace`
        : `uploaded ${subject}`;
    case "document.version.create":
      // The version number is the entire point of the entry: it is what
      // distinguishes this publish from the next one on the same document.
      return version === null
        ? `published a new version of ${document}`
        : `published version ${version} of ${document}`;
    case "document.rename":
      // The recorded name is the NEW one, so it is phrased as the destination
      // rather than the thing renamed.
      return named ? `renamed a document to ${named}` : `renamed ${subject}`;
    case "document.move":
      return `moved ${document}`;
    case "document.archived":
      return `archived ${document}`;
    case "document.trashed":
      return `moved ${document} to trash`;
    case "document.active":
      return `restored ${document}`;
    case "document.lifecycle":
      // The older, undifferentiated lifecycle action. Kept so historical entries
      // stay readable, even though nothing writes it now.
      return `changed the state of ${subject}`;
    case "folder.create":
      return `created folder ${entry.resourceLabel ?? ""}`.trim();
    case "project.create":
      return `created project ${entry.resourceLabel ?? ""}`.trim();
    case "tag.create":
      return `created a tag`;
    case "workspace.update":
      return `updated the Workspace`;
    case "user.login":
      return "signed in";
    case "user.logout":
      return "signed out";
    default:
      return entry.action.replace(/[._]/g, " ");
  }
}

/**
 * A tool's own name for an activity line, from the one catalog that has them.
 *
 * The slug is what the audit log stores, deliberately: a display name recorded in
 * the database is a copy of the catalog that goes stale the day a tool is renamed.
 * An unknown slug renders as the slug rather than as nothing, so an entry for a
 * retired tool still says where the document came from.
 */
function toolLabel(slug: string): string {
  return getToolBySlug(slug)?.name ?? slug;
}

/** The states the document area can be in. Drives which panel is rendered. */
export type DocumentAreaPhase =
  | "loading"
  | "error"
  | "empty-workspace"
  | "empty-view"
  | "empty-search"
  | "ready";

/**
 * Resolves what the document area should render.
 *
 * "No documents at all" and "no documents matching this filter" are different
 * situations needing different actions — offering "Upload your first PDF" to
 * someone whose search simply missed is unhelpful, and offering "Clear filters"
 * to an empty Workspace is nonsense.
 */
export function documentAreaPhase(input: {
  loading: boolean;
  error: string | null;
  itemCount: number;
  hasQuery: boolean;
  hasFilters: boolean;
  /** True when the Workspace has no documents in ANY view. */
  workspaceEmpty: boolean;
}): DocumentAreaPhase {
  if (input.error !== null) return "error";
  if (input.loading && input.itemCount === 0) return "loading";
  if (input.itemCount > 0) return "ready";
  if (input.hasQuery) return "empty-search";
  if (input.hasFilters) return "empty-view";
  if (input.workspaceEmpty) return "empty-workspace";
  return "empty-view";
}

/** One active filter, rendered as a removable chip. */
export interface FilterChip {
  id: string;
  label: string;
  value: string;
}

/**
 * Serializes the active filters into chips.
 *
 * Only filters that actually narrow the result produce a chip: the default view
 * is not a filter the user set, so showing "Active" as a removable chip would
 * invite them to remove something that is not there.
 */
export function activeFilterChips(input: {
  view?: string | null;
  query?: string | null;
  folderName?: string | null;
  projectName?: string | null;
  tagNames?: readonly string[];
  favoritesOnly?: boolean;
}): FilterChip[] {
  const chips: FilterChip[] = [];
  if (input.query && input.query.trim() !== "") {
    chips.push({ id: "query", label: "Search", value: input.query.trim() });
  }
  if (input.view && input.view !== "all") {
    chips.push({ id: "view", label: "View", value: viewLabel(input.view) });
  }
  if (input.folderName) chips.push({ id: "folder", label: "Folder", value: input.folderName });
  if (input.projectName) chips.push({ id: "project", label: "Project", value: input.projectName });
  if (input.favoritesOnly) chips.push({ id: "favorites", label: "Filter", value: "Favorites only" });
  for (const tag of input.tagNames ?? []) {
    chips.push({ id: `tag:${tag}`, label: "Tag", value: tag });
  }
  return chips;
}

/** Human label for a document-manager view id. */
export function viewLabel(view: string): string {
  switch (view) {
    case "all":
      return "All Documents";
    case "favorites":
      return "Favorites";
    case "recent":
      return "Recent";
    case "archived":
      return "Archived";
    case "trashed":
      return "Trash";
    default:
      return view;
  }
}

/** Formats a byte count for display. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/**
 * The actions the "New" menu offers.
 *
 * Every entry maps to a capability that exists server-side. `requiresWrite`
 * mirrors the API's own authorization so a viewer is not shown an action that
 * would fail — the server re-checks regardless.
 */
export interface NewMenuAction {
  id: string;
  label: string;
  description: string;
  icon: string;
  requiresWrite: boolean;
}

export const NEW_MENU_ACTIONS: readonly NewMenuAction[] = [
  {
    id: "upload",
    label: "Upload PDF",
    description: "Add a document to this Workspace",
    icon: "upload",
    requiresWrite: true,
  },
  {
    id: "folder",
    label: "New folder",
    description: "Organize documents into a folder",
    icon: "folder",
    requiresWrite: true,
  },
  {
    id: "project",
    label: "New project",
    description: "Group related work into a project",
    icon: "project",
    requiresWrite: true,
  },
  {
    id: "editor",
    label: "Open blank editor",
    description: "Start a document in the PDF editor",
    icon: "editor",
    requiresWrite: false,
  },
];

/** The New-menu actions available to a role. */
export function availableNewActions(canWrite: boolean): NewMenuAction[] {
  return NEW_MENU_ACTIONS.filter((action) => canWrite || !action.requiresWrite);
}
