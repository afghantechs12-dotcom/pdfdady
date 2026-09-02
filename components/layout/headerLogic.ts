import type { NavLink, NavToolGroup } from "@/data/nav";
import type { Tool } from "@/data/tools";
import { isFunctional } from "@/data/tools";

/**
 * Pure navigation logic for the public header.
 *
 * Extracted from the component so the launch acceptance gates — "Tools has its
 * own header item", "Get Started does not link to Tools", "signed-in and
 * signed-out headers are correct" — are assertions against functions rather
 * than against rendered markup. A test that reads JSX is a test that breaks on
 * restyling; these do not.
 */

/**
 * Where an unauthenticated visitor goes when they accept the primary call to
 * action. Mandated by the launch brief.
 *
 * `/register` is the canonical public registration URL and `returnTo` is the
 * canonical parameter name. Both are aliased to the pre-existing `/signup`
 * page and its `next` parameter rather than duplicating the signup flow — see
 * app/register/page.tsx.
 */
export const GET_STARTED_HREF = "/register?returnTo=/workspaces";

/** Where a signed-in visitor's primary call to action goes. */
export const OPEN_WORKSPACE_HREF = "/workspaces";

/** The label pairing for each session state's primary action. */
export const PRIMARY_CTA = {
  signedOut: { label: "Get Started Free", href: GET_STARTED_HREF },
  signedIn: { label: "Open Workspace", href: OPEN_WORKSPACE_HREF },
} as const;

/** Sign-in affordance — absent from the header entirely before this milestone. */
export const LOGIN_LINK = { label: "Log in", href: "/login" } as const;

/**
 * Navigation shown to a signed-in visitor on the public site.
 *
 * Someone who already has an account does not need to be re-sold the product,
 * so only items that stay useful after signup survive, and the space goes to
 * routes back into the application.
 *
 * The keep-list is matched against whatever the caller passes rather than
 * against `data/nav.ts`: `nav` is admin-editable, so it names every href that
 * would still be worth keeping, including ones the committed nav does not
 * currently carry.
 */
export function authenticatedNavLinks(publicLinks: NavLink[]): NavLink[] {
  const keep = new Set(["/tools", "/pricing", "/blog"]);
  const kept = publicLinks.filter((link) => keep.has(link.href));
  return [
    ...kept,
    { label: "Workspace", href: "/workspaces" },
    { label: "Editor", href: "/editor" },
  ];
}

/**
 * Chooses the nav list for the current session state.
 *
 * While the session is still resolving we show the signed-out list: it is the
 * static markup already in the HTML, so no swap occurs for the common case of
 * an actually-signed-out visitor.
 */
export function navLinksForSession(
  publicLinks: NavLink[],
  signedIn: boolean,
): NavLink[] {
  return signedIn ? authenticatedNavLinks(publicLinks) : publicLinks;
}

/**
 * True when `href` is the active route for `pathname`.
 *
 * Hash links ("/#features") are never active: they address a section of a page,
 * and marking them active on every scroll position is noise. The root path must
 * match exactly, or every route would report the homepage as active.
 */
export function isActiveNavHref(href: string, pathname: string): boolean {
  if (href.includes("#")) return false;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Builds a registration URL that returns the visitor to where they were.
 *
 * The auth pages re-validate the value with `safeRedirectPath` before using it
 * — that is the security boundary, not this function. But a link builder that
 * happily emits `?returnTo=//evil.test` is still a defect: a naive
 * `startsWith("/")` check accepts scheme-relative URLs, which browsers resolve
 * as absolute. Rejecting the obviously-hostile shapes here means this helper
 * never authors a link it would be embarrassing to render.
 */
export function registerHrefFor(returnTo?: string | null): string {
  const destination = isPlausibleInternalPath(returnTo) ? returnTo : "/workspaces";
  return `/register?returnTo=${encodeURIComponent(destination)}`;
}

/**
 * A conservative "looks like an internal path" test. Deliberately narrower than
 * `safeRedirectPath`: this rejects anything it is not sure about, because the
 * fallback (`/workspaces`) is always a reasonable destination.
 */
function isPlausibleInternalPath(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.startsWith("/")) return false;
  // "//host" and "/\host" are resolved by browsers as absolute URLs.
  if (value.startsWith("//") || value.startsWith("/\\")) return false;
  if (value.includes("\\")) return false;
  // A colon before the first path separator implies a scheme.
  if (/^\/[^/?#]*:/u.test(value)) return false;
  return true;
}

/** A tool link as rendered in the header's Tools dropdown. */
export interface ResolvedNavTool {
  slug: string;
  name: string;
  href: string;
}

export interface ResolvedNavGroup {
  title: string;
  tools: ResolvedNavTool[];
}

/**
 * Resolves the dropdown's slug lists against the live tool registry.
 *
 * Two rules, both of which exist so the menu cannot lie:
 *
 *  - A slug with no matching tool is dropped rather than rendered as a dead
 *    link. The registry is admin-mergeable at runtime, so a tool named here can
 *    genuinely disappear.
 *  - A tool that cannot run is dropped too. `ToolCard` already refuses to link
 *    unavailable tools (they render as a plain div, out of the tab order); a
 *    navigation menu that happily linked the same tool would undo that.
 *
 * Groups that end up empty are omitted entirely, so the menu never renders a
 * heading over nothing.
 */
export function resolveNavToolGroups(
  groups: NavToolGroup[],
  tools: Tool[],
): ResolvedNavGroup[] {
  const bySlug = new Map(tools.map((t) => [t.slug, t]));

  return groups
    .map((group) => ({
      title: group.title,
      tools: group.slugs
        .map((slug) => bySlug.get(slug))
        .filter((tool): tool is Tool => tool !== undefined && isFunctional(tool))
        .map((tool) => ({ slug: tool.slug, name: tool.name, href: tool.href })),
    }))
    .filter((group) => group.tools.length > 0);
}

/** Every resolved menu the header can open, keyed by `NavLink.menu`. */
export type ResolvedNavMenus = Record<string, ResolvedNavGroup[]>;

/**
 * Resolves every named menu against the registry.
 *
 * A menu whose groups all resolve empty is omitted from the map entirely, not
 * left as an empty array — `menuFor` treats a missing key as "this item is a
 * plain link", so a menu can never render as a trigger that opens onto nothing.
 */
export function resolveNavToolMenus(
  menus: Record<string, NavToolGroup[]>,
  tools: Tool[],
): ResolvedNavMenus {
  const resolved: ResolvedNavMenus = {};
  for (const [key, groups] of Object.entries(menus)) {
    const groupsForKey = resolveNavToolGroups(groups, tools);
    if (groupsForKey.length > 0) resolved[key] = groupsForKey;
  }
  return resolved;
}

/**
 * The menu a nav item opens, or `null` if it is a plain link.
 *
 * `hasDropdown` is honoured as an alias for the Tools menu because `nav` is
 * admin-editable: a stored entry written before menus existed still opens the
 * menu it meant to.
 */
export function menuKeyFor(link: NavLink, menus: ResolvedNavMenus): string | null {
  const key = link.menu ?? (link.hasDropdown ? "tools" : undefined);
  if (!key) return null;
  return menus[key] ? key : null;
}
