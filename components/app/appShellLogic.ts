/**
 * Pure logic for the authenticated application shell.
 *
 * No React, no DOM: navigation structure, active-item resolution, and the
 * tenant-scoped URL builder are all decided here so they are unit-testable in
 * Node, matching the convention the M6/M7 UI logic modules established
 * (`toolbarLayout.ts`, `fileManagerLogic.ts`, `splitViewLogic.ts`).
 */

/** Which section of the sidebar a navigation item belongs to. */
export type AppNavSection = "workspace" | "tools";

/** One sidebar navigation entry. */
export interface AppNavItem {
  id: string;
  label: string;
  /** Icon identifier; the React shell maps these to components. */
  icon: string;
  section: AppNavSection;
  /**
   * The document-manager view this item selects, when it is a view of the
   * Workspace rather than a separate route. Null for standalone routes.
   */
  view: string | null;
  /** A standalone route, for items that are not a Workspace view. */
  route: string | null;
}

/**
 * The sidebar's items in render order.
 *
 * "Shared with me" is deliberately absent. `DocumentPermissionGrant` exists and
 * per-document grants are enforced, but `DocumentRecordService.list` has no
 * "granted to me" view, so the item would either be empty or lie about scope.
 * It belongs here the moment that view exists.
 *
 * "AI Assistant" is absent because no AI capability is implemented (M8 is not
 * started); a navigation entry for it would be a control that does nothing.
 */
export const APP_NAV_ITEMS: readonly AppNavItem[] = [
  { id: "home", label: "Home", icon: "home", section: "workspace", view: null, route: "" },
  { id: "documents", label: "Documents", icon: "documents", section: "workspace", view: "all", route: null },
  { id: "favorites", label: "Favorites", icon: "favorites", section: "workspace", view: "favorites", route: null },
  { id: "recent", label: "Recent", icon: "recent", section: "workspace", view: "recent", route: null },
  { id: "archived", label: "Archived", icon: "archived", section: "workspace", view: "archived", route: null },
  { id: "trash", label: "Trash", icon: "trash", section: "workspace", view: "trashed", route: null },
  { id: "editor", label: "Editor", icon: "editor", section: "tools", view: null, route: "/editor" },
];

/** The items belonging to one sidebar section, in order. */
export function navItemsForSection(section: AppNavSection): AppNavItem[] {
  return APP_NAV_ITEMS.filter((item) => item.section === section);
}

/** Human heading for a sidebar section. */
export function sectionLabel(section: AppNavSection): string {
  return section === "workspace" ? "Workspace" : "Tools";
}

/**
 * Builds a tenant-scoped Workspace URL.
 *
 * Both ids are encoded: a Workspace id or Organization id containing a slash or
 * a space would otherwise produce a URL pointing somewhere else entirely.
 */
export function workspaceHref(
  workspaceId: string,
  organizationId: string,
  options: { view?: string | null; path?: string } = {},
): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}${options.path ?? ""}`;
  const params = new URLSearchParams({ organizationId });
  if (options.view != null && options.view !== "" && options.view !== "all") {
    params.set("view", options.view);
  }
  return `${base}?${params.toString()}`;
}

/** The href a sidebar item navigates to. */
export function navItemHref(
  item: AppNavItem,
  workspaceId: string,
  organizationId: string,
): string {
  if (item.route !== null && item.route !== "") return item.route;
  return workspaceHref(workspaceId, organizationId, { view: item.view });
}

/**
 * Resolves which navigation item is current.
 *
 * Matching is on the resolved route + view rather than a raw string compare, so
 * `/workspaces/x` and `/workspaces/x?view=all` both land on the same item
 * instead of leaving the sidebar with nothing marked current.
 */
export function activeNavItemId(input: {
  pathname: string;
  view?: string | null;
  workspaceId: string;
}): string | null {
  const { pathname, workspaceId } = input;
  const view = input.view ?? null;

  if (pathname === "/editor" || pathname.startsWith("/editor/")) return "editor";

  const workspaceRoot = `/workspaces/${encodeURIComponent(workspaceId)}`;
  if (pathname !== workspaceRoot && !pathname.startsWith(`${workspaceRoot}/`)) {
    return null;
  }
  // A sub-route of the Workspace (settings, a document workbench) is not one of
  // the list views, so no view item is marked current.
  if (pathname !== workspaceRoot) return null;

  if (view === null || view === "") return "home";
  const match = APP_NAV_ITEMS.find((item) => item.view === view);
  return match ? match.id : null;
}

/** Quick-access cards on the dashboard, mapped to the views they open. */
export interface QuickAccessCard {
  id: string;
  label: string;
  icon: string;
  view: string;
}

/**
 * The dashboard's quick-access cards.
 *
 * Every card opens a document-manager view that actually exists. Counts are
 * supplied by the caller from real data and omitted when unknown — a card
 * showing a fabricated number is worse than one showing none.
 */
export const QUICK_ACCESS_CARDS: readonly QuickAccessCard[] = [
  { id: "recent", label: "Recent", icon: "recent", view: "recent" },
  { id: "favorites", label: "Favorites", icon: "favorites", view: "favorites" },
  { id: "archived", label: "Archived", icon: "archived", view: "archived" },
  { id: "trash", label: "Trash", icon: "trash", view: "trashed" },
];

/**
 * Formats a count for display, or null when there is no real number.
 *
 * `undefined` means "not loaded" and yields null so the card renders no count
 * at all. A real zero renders as "0" — that is information, not absence.
 */
export function formatCount(count: number | undefined | null): string | null {
  if (count === undefined || count === null) return null;
  if (!Number.isFinite(count) || count < 0) return null;
  if (count >= 1000) return `${Math.floor(count / 100) / 10}k`;
  return String(count);
}

/** Pluralizes an item count for accessible labels. */
export function itemCountLabel(count: number | undefined | null, noun = "document"): string | null {
  if (count === undefined || count === null || !Number.isFinite(count) || count < 0) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
