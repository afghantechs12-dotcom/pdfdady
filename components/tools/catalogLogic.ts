import {
  availabilityForStatus,
  processingModeForStatus,
  type ProcessingMode,
} from "@/lib/tools/processingMode";
import type { Tool } from "@/data/tools";

/**
 * Pure filtering/grouping for the /tools index.
 *
 * Kept out of the component so the behaviour that matters — that a planned tool
 * can never appear in an available group, that a search for "word" finds
 * "PDF to Word", that filters compose — is unit-testable without a DOM.
 */

export type ModeFilter = "all" | ProcessingMode;

export interface CatalogQuery {
  search: string;
  category: string | "all";
  mode: ModeFilter;
}

/** Normalizes for accent- and case-insensitive substring matching. */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Whether a tool matches a free-text query.
 *
 * Matches name, description and slug. The slug matters more than it looks:
 * someone typing "jpg to pdf" with spaces should still find `jpg-to-pdf`, so
 * separators are flattened on both sides.
 */
export function matchesSearch(tool: Tool, search: string): boolean {
  const q = normalize(search);
  if (!q) return true;
  const flat = (s: string) => normalize(s).replace(/[\s-]+/g, " ");
  const haystack = flat(`${tool.name} ${tool.description} ${tool.slug}`);
  return flat(q)
    .split(" ")
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function matchesMode(tool: Tool, mode: ModeFilter): boolean {
  if (mode === "all") return true;
  return processingModeForStatus(tool.status) === mode;
}

export function matchesCategory(tool: Tool, category: string | "all"): boolean {
  return category === "all" || tool.category === category;
}

export function isAvailable(tool: Tool): boolean {
  return availabilityForStatus(tool.status) === "available";
}

export interface CatalogResult {
  /** Tools a user can run today, grouped by category in the given order. */
  availableGroups: { id: string; label: string; tools: Tool[] }[];
  /** Everything not yet runnable, flat — never mixed into the groups above. */
  comingLater: Tool[];
  /** Count of available tools matching the query. */
  availableCount: number;
  /** True when nothing at all matched, so the UI can show an empty state. */
  isEmpty: boolean;
}

/**
 * Applies a query and splits the result into available and coming-later.
 *
 * The split is unconditional. Filtering by "Secure cloud" cannot surface a
 * planned tool, because a planned tool has no processing mode at all — which is
 * also why the mode filter is not offered as a way to reach them.
 */
export function buildCatalog(
  tools: Tool[],
  categories: { id: string; label: string }[],
  query: CatalogQuery,
): CatalogResult {
  const matched = tools.filter(
    (t) =>
      matchesSearch(t, query.search) &&
      matchesCategory(t, query.category) &&
      matchesMode(t, query.mode),
  );

  const available = matched.filter(isAvailable);
  // A mode filter is a statement about running a tool, so it excludes tools
  // that cannot run. Without this, selecting "Browser" would still list the
  // coming-later section underneath, implying those are browser tools.
  const comingLater =
    query.mode === "all" ? matched.filter((t) => !isAvailable(t)) : [];

  const availableGroups = categories
    .map((c) => ({
      id: c.id,
      label: c.label,
      tools: available.filter((t) => t.category === c.id),
    }))
    .filter((g) => g.tools.length > 0);

  return {
    availableGroups,
    comingLater,
    availableCount: available.length,
    isEmpty: available.length === 0 && comingLater.length === 0,
  };
}
