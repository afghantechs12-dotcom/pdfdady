/**
 * Pure logic for the document file manager.
 * Extracted from the component so all reducer/selector functions are
 * unit-testable in Node without a DOM or React.
 */

export type ViewMode = "list" | "grid" | "compact";
export type SortField = "name" | "createdAt" | "updatedAt" | "lastAccessedAt";
export type SortOrder = "asc" | "desc";
export type ViewFilter = "all" | "favorites" | "recent" | "archived" | "trashed";

export interface DocumentItem {
  id: string;
  name: string;
  favorite: boolean;
  lifecycleState: "active" | "archived" | "trashed";
  createdAt: string | Date;
  updatedAt: string | Date;
  lastAccessedAt: string | Date | null;
  folderId: string | null;
  projectId: string | null;
  revision: number;
}

/** The current selection state: a Set of document ids. */
export interface SelectionState {
  ids: Set<string>;
  anchorId: string | null;
}

export const EMPTY_SELECTION: SelectionState = { ids: new Set(), anchorId: null };

/**
 * Cleans up the selection: removes ids that are no longer in `allIds`.
 * Resets the anchor if it was removed.
 */
export function normalizeSelection(sel: SelectionState, allIds: string[]): SelectionState {
  const present = new Set(allIds);
  const ids = new Set([...sel.ids].filter((id) => present.has(id)));
  const anchorId = sel.anchorId !== null && present.has(sel.anchorId) ? sel.anchorId : null;
  return { ids, anchorId };
}

/**
 * Selection click reducer.
 * - Plain click: select only this item.
 * - Ctrl/Cmd click: toggle this item.
 * - Shift click: range-select from anchor to this item (by display order).
 */
export function reduceDocumentClick(
  sel: SelectionState,
  allIds: string[],
  clickedId: string,
  mods: { ctrl?: boolean; shift?: boolean },
): SelectionState {
  if (!allIds.includes(clickedId)) return normalizeSelection(sel, allIds);
  const current = normalizeSelection(sel, allIds);

  if (mods.shift && current.anchorId !== null) {
    const a = allIds.indexOf(current.anchorId);
    const b = allIds.indexOf(clickedId);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return { ids: new Set(allIds.slice(lo, hi + 1)), anchorId: current.anchorId };
  }

  if (mods.ctrl) {
    const ids = new Set(current.ids);
    if (ids.has(clickedId)) {
      ids.delete(clickedId);
      const anchorId = current.anchorId === clickedId ? [...ids].at(-1) ?? null : current.anchorId;
      return { ids, anchorId };
    }
    ids.add(clickedId);
    return { ids, anchorId: clickedId };
  }

  return { ids: new Set([clickedId]), anchorId: clickedId };
}

/** Toggle-all: select all if fewer than all are selected; deselect if all selected. */
export function toggleAll(sel: SelectionState, allIds: string[]): SelectionState {
  if (sel.ids.size === allIds.length && allIds.length > 0) {
    return EMPTY_SELECTION;
  }
  return { ids: new Set(allIds), anchorId: allIds[0] ?? null };
}

/** Sort a flat array of DocumentItems in-place according to field + order. */
export function sortDocuments(items: DocumentItem[], field: SortField, order: SortOrder): DocumentItem[] {
  return [...items].sort((a, b) => {
    let cmp: number;
    if (field === "name") {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    } else {
      const av = a[field];
      const bv = b[field];
      const at = av ? new Date(av as string | Date).getTime() : 0;
      const bt = bv ? new Date(bv as string | Date).getTime() : 0;
      cmp = at - bt;
    }
    // Deterministic tie-breaker: id ascending
    if (cmp === 0) cmp = a.id.localeCompare(b.id);
    return order === "asc" ? cmp : -cmp;
  });
}

/** Returns a human-readable relative date label for display. */
export function relativeDate(date: string | Date | null | undefined): string {
  if (!date) return "—";
  const ms = typeof date === "string" ? Date.parse(date) : date.getTime();
  if (Number.isNaN(ms)) return "—";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** A lifecycle transition offered in the row menu and the bulk bar. */
export type LifecycleAction = "archive" | "trash" | "restore";

/**
 * The lifecycle actions that make sense for a document in a given state.
 *
 * Derived from the document rather than from the active view: a view is a
 * filter, and a stale list can hold a document whose state has since changed.
 * Offering "Archive" on an already-archived document produces a request the
 * service rejects, which reads to the user as a broken button.
 */
export function lifecycleActionsFor(item: Pick<DocumentItem, "lifecycleState">): LifecycleAction[] {
  switch (item.lifecycleState) {
    case "active":
      return ["archive", "trash"];
    case "archived":
      return ["restore", "trash"];
    case "trashed":
      return ["restore"];
  }
}

/**
 * The lifecycle actions offered for a whole selection.
 *
 * Only actions valid for *every* selected document are offered. A bulk button
 * that silently succeeds for part of the selection is the failure mode this
 * prevents — the per-item results are still reported, but the button itself
 * should not promise something it cannot do for the set.
 */
export function bulkLifecycleActions(
  items: readonly Pick<DocumentItem, "lifecycleState">[],
): LifecycleAction[] {
  if (items.length === 0) return [];
  const perItem = items.map((item) => new Set(lifecycleActionsFor(item)));
  return (["restore", "archive", "trash"] as LifecycleAction[]).filter((action) =>
    perItem.every((set) => set.has(action)),
  );
}

/**
 * The label and description for a lifecycle confirmation.
 *
 * Counts are stated explicitly so a bulk confirmation cannot be mistaken for a
 * single-document one.
 */
export function lifecycleCopy(
  action: LifecycleAction,
  count: number,
): { title: string; body: string; confirm: string; destructive: boolean } {
  const noun = count === 1 ? "this document" : `these ${count} documents`;
  switch (action) {
    case "archive":
      return {
        title: "Archive",
        body: `Archive ${noun}? Archived documents stay available and can be restored.`,
        confirm: "Archive",
        destructive: false,
      };
    case "trash":
      return {
        title: "Move to trash",
        body: `Move ${noun} to trash? You can restore from the Trash view.`,
        confirm: "Move to trash",
        destructive: true,
      };
    case "restore":
      return {
        title: "Restore",
        body: `Restore ${noun} to active?`,
        confirm: "Restore",
        destructive: false,
      };
  }
}

/**
 * Announces the result of a bulk lifecycle change.
 *
 * Partial failure is reported as partial. Reporting the requested count as the
 * succeeded count is how a user ends up believing documents moved when they
 * did not.
 */
export function bulkResultMessage(input: {
  action: LifecycleAction;
  succeeded: number;
  failed: number;
}): string {
  const { action, succeeded, failed } = input;
  const verb = action === "restore" ? "restored" : action === "archive" ? "archived" : "moved to trash";
  if (failed === 0) return `${succeeded} document${succeeded === 1 ? "" : "s"} ${verb}.`;
  if (succeeded === 0) return `No documents were ${verb}; ${failed} failed.`;
  return `${succeeded} document${succeeded === 1 ? "" : "s"} ${verb}; ${failed} failed.`;
}

/** The empty-state copy for a view. Each names the view, not "no results". */
export const VIEW_EMPTY_MESSAGE: Record<ViewFilter, string> = {
  all: "No documents in this Workspace yet.",
  favorites: "No favorite documents. Star a document to keep it here.",
  recent: "No recently opened documents.",
  archived: "No archived documents.",
  trashed: "Trash is empty.",
};

