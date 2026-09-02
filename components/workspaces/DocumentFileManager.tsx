"use client";

import { useCallback, useId, useState } from "react";
import Link from "next/link";
import {
  AlignJustify,
  Archive,
  ChevronDown,
  ChevronUp,
  FileText,
  LayoutGrid,
  LayoutList,
  MoreHorizontal,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Modal } from "@/components/ui/Modal";
import { workspaceHref } from "@/components/app/appShellLogic";
import {
  EMPTY_SELECTION,
  VIEW_EMPTY_MESSAGE,
  bulkLifecycleActions,
  bulkResultMessage,
  lifecycleActionsFor,
  lifecycleCopy,
  reduceDocumentClick,
  relativeDate,
  sortDocuments,
  toggleAll,
  type DocumentItem,
  type LifecycleAction,
  type SelectionState,
  type SortField,
  type SortOrder,
  type ViewFilter,
  type ViewMode,
} from "./fileManagerLogic";

export interface DocumentFileManagerProps {
  workspaceId: string;
  organizationId: string;
  items: DocumentItem[];
  hasNextPage?: boolean;
  nextCursor?: string | null;
  initialView?: ViewFilter;
}

const VIEW_LABELS: Record<ViewFilter, string> = {
  all: "All documents",
  favorites: "Favorites",
  recent: "Recent",
  archived: "Archived",
  trashed: "Trash",
};

/**
 * The heading above the list. It names the view the sidebar selected, so the
 * user can still tell Archived from Trash at a glance now that this component
 * no longer owns a view switcher of its own.
 *
 * The in-panel rail that used to sit here — All documents / Favorites / Recent
 * / Archived / Trash — repeated the dark sidebar's Workspace section verbatim
 * and was removed for the launch (P1-9). It was not merely redundant:
 *
 *  - The sidebar navigates (`?view=…`, a real URL). The rail only called
 *    `loadView`, mutating local state. Picking "Favorites" in the rail
 *    therefore left the sidebar still highlighting "Documents", and the URL
 *    still said `all` — so a refresh, a shared link, or the browser Back button
 *    silently disagreed with what was on screen.
 *  - It cost ~160px of horizontal space on every desktop width, taken from the
 *    document list it was navigating.
 *
 * No filtering capability was lost: every view it offered is one click away in
 * the sidebar, which was already the canonical control for exactly these five
 * views (`APP_NAV_ITEMS`), and the dashboard's quick-access cards link to the
 * same URLs.
 */
const ACTION_LABEL: Record<LifecycleAction, string> = {
  archive: "Archive",
  trash: "Move to trash",
  restore: "Restore",
};

/** The shared control styling for a small bordered button. */
const GHOST_BUTTON =
  "inline-flex min-h-[32px] items-center gap-1.5 rounded-control border border-app-border bg-app-surface px-2.5 text-xs font-semibold text-app-text transition-colors hover:border-primary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60";

// ── Sort button ──────────────────────────────────────────────────────────────

function SortButton({
  field,
  label,
  current,
  order,
  onSort,
}: {
  field: SortField;
  label: string;
  current: SortField;
  order: SortOrder;
  onSort: (field: SortField) => void;
}) {
  const active = field === current;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "flex items-center gap-1 rounded text-[11px] font-semibold uppercase tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "text-primary" : "text-app-muted hover:text-app-text",
      )}
    >
      {label}
      {active &&
        (order === "asc" ? (
          <ChevronUp size={12} aria-hidden="true" />
        ) : (
          <ChevronDown size={12} aria-hidden="true" />
        ))}
    </button>
  );
}

// ── Rename dialog ────────────────────────────────────────────────────────────

function RenameDialog({
  name,
  onClose,
  onRename,
}: {
  name: string;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const titleId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setStatus("");
    try {
      await onRename(value.trim());
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Rename failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledById={titleId}>
      <form onSubmit={submit} className="space-y-4 p-5">
        <h2 id={titleId} className="text-lg font-bold text-app-text">
          Rename document
        </h2>
        <label className="block text-sm font-semibold text-app-text">
          Name
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            required
            maxLength={255}
            className="mt-1.5 w-full rounded-control border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
        </label>
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-app-muted">
          {status}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={GHOST_BUTTON}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || value.trim().length === 0}
            className="inline-flex min-h-[32px] items-center rounded-control bg-primary px-3 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-60"
          >
            {loading ? "Renaming…" : "Rename"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ── Lifecycle confirm dialog ─────────────────────────────────────────────────

function LifecycleConfirmDialog({
  action,
  count,
  onClose,
  onConfirm,
}: {
  action: LifecycleAction;
  count: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const titleId = useId();
  const copy = lifecycleCopy(action, count);

  async function confirm() {
    setLoading(true);
    setStatus("");
    try {
      await onConfirm();
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Operation failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} labelledById={titleId}>
      <div className="space-y-4 p-5">
        <h2 id={titleId} className="text-lg font-bold text-app-text">
          {copy.title}
        </h2>
        <p className="text-sm text-app-muted">{copy.body}</p>
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-red-600">
          {status}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={GHOST_BUTTON}>
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={loading}
            className={cn(
              "inline-flex min-h-[32px] items-center rounded-control px-3 text-xs font-semibold text-white transition-colors focus:outline-none focus-visible:ring-2 disabled:opacity-60",
              copy.destructive
                ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500/40"
                : "bg-primary hover:bg-primary-hover focus-visible:ring-primary/40",
            )}
          >
            {loading ? "Working…" : copy.confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── Per-row context menu ─────────────────────────────────────────────────────

const ACTION_ICONS: Record<LifecycleAction, React.ReactNode> = {
  archive: <Archive size={13} aria-hidden="true" />,
  trash: <Trash2 size={13} aria-hidden="true" />,
  restore: <RotateCcw size={13} aria-hidden="true" />,
};

function RowMenu({
  item,
  openHref,
  onRename,
  onLifecycle,
}: {
  item: DocumentItem;
  openHref: string;
  onRename: (item: DocumentItem) => void;
  onLifecycle: (item: DocumentItem, action: LifecycleAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  // Derived from the document's own state, so a stale list cannot offer a
  // transition the service would reject.
  const actions = lifecycleActionsFor(item);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`More actions for ${item.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="rounded-control p-1.5 text-app-muted transition-colors hover:bg-app-subtle hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </button>
      {open && (
        <>
          {/* Dismiss layer. Not focusable and hidden from assistive tech —
              Escape and the trigger are the keyboard paths. */}
          <div className="fixed inset-0 z-10" aria-hidden="true" onClick={close} />
          <div
            role="menu"
            aria-label={`Actions for ${item.name}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
            className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-controllg border border-app-border bg-app-surface py-1 shadow-appmenu"
          >
            <Link
              role="menuitem"
              href={openHref}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-app-text transition-colors hover:bg-app-subtle focus:outline-none focus-visible:bg-app-subtle"
            >
              <FileText size={13} aria-hidden="true" />
              Open
            </Link>
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                close();
                onRename(item);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-app-text transition-colors hover:bg-app-subtle focus:outline-none focus-visible:bg-app-subtle"
            >
              Rename
            </button>
            {actions.map((action) => (
              <button
                key={action}
                role="menuitem"
                type="button"
                onClick={() => {
                  close();
                  onLifecycle(item, action);
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-app-subtle focus:outline-none focus-visible:bg-app-subtle",
                  action === "trash" ? "text-red-600" : "text-app-text",
                )}
              >
                {ACTION_ICONS[action]}
                {ACTION_LABEL[action]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Row-level callback bundle shared by the three views ──────────────────────

interface RowCallbacks {
  onSelect: (id: string, mods: { ctrl?: boolean; shift?: boolean }) => void;
  onFavorite: (item: DocumentItem) => void;
  onRename: (item: DocumentItem) => void;
  onLifecycle: (item: DocumentItem, action: LifecycleAction) => void;
  hrefFor: (item: DocumentItem) => string;
}

function favoriteLabel(item: DocumentItem): string {
  return item.favorite
    ? `Remove ${item.name} from favorites`
    : `Add ${item.name} to favorites`;
}

/**
 * Selection keyboard/pointer handling shared by all three views.
 *
 * Selection is a checkbox-and-click affordance; opening is a link. Keeping the
 * two separate is what lets a row be both selectable and navigable without the
 * click target being ambiguous.
 */
function selectionHandlers(id: string, onSelect: RowCallbacks["onSelect"]) {
  return {
    onClick: (event: React.MouseEvent) =>
      onSelect(id, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }),
  };
}

function FavoriteButton({
  item,
  onFavorite,
  size = 14,
}: {
  item: DocumentItem;
  onFavorite: (item: DocumentItem) => void;
  size?: number;
}) {
  return (
    <button
      type="button"
      aria-label={favoriteLabel(item)}
      aria-pressed={item.favorite}
      onClick={() => onFavorite(item)}
      className="rounded-control p-1.5 transition-colors hover:bg-app-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Star
        size={size}
        aria-hidden="true"
        className={cn(item.favorite ? "fill-amber-400 text-amber-400" : "text-app-muted")}
      />
    </button>
  );
}

// ── List view ────────────────────────────────────────────────────────────────

function DocumentRowList({
  items,
  selection,
  sortField,
  sortOrder,
  onSort,
  onToggleAll,
  ...cb
}: RowCallbacks & {
  items: DocumentItem[];
  selection: SelectionState;
  sortField: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  onToggleAll: () => void;
}) {
  const allChecked = selection.ids.size === items.length && items.length > 0;
  const someChecked = selection.ids.size > 0 && selection.ids.size < items.length;

  return (
    <table className="w-full min-w-0 border-collapse text-left">
      <caption className="sr-only">Documents in this view</caption>
      <thead>
        <tr className="border-b border-app-border">
          <th scope="col" className="w-8 px-3 py-2">
            <input
              type="checkbox"
              aria-label="Select all documents"
              checked={allChecked}
              ref={(el) => {
                if (el) el.indeterminate = someChecked;
              }}
              onChange={onToggleAll}
              className="h-4 w-4 rounded border-app-border text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </th>
          <th
            scope="col"
            className="px-2 py-2"
            aria-sort={sortField === "name" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton field="name" label="Name" current={sortField} order={sortOrder} onSort={onSort} />
          </th>
          <th
            scope="col"
            className="hidden w-32 px-2 py-2 md:table-cell"
            aria-sort={sortField === "updatedAt" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton field="updatedAt" label="Modified" current={sortField} order={sortOrder} onSort={onSort} />
          </th>
          <th
            scope="col"
            className="hidden w-32 px-2 py-2 lg:table-cell"
            aria-sort={sortField === "createdAt" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton field="createdAt" label="Created" current={sortField} order={sortOrder} onSort={onSort} />
          </th>
          <th
            scope="col"
            className="hidden w-28 px-2 py-2 xl:table-cell"
            aria-sort={
              sortField === "lastAccessedAt" ? (sortOrder === "asc" ? "ascending" : "descending") : "none"
            }
          >
            <SortButton
              field="lastAccessedAt"
              label="Opened"
              current={sortField}
              order={sortOrder}
              onSort={onSort}
            />
          </th>
          <th scope="col" className="w-24 px-3 py-2">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const selected = selection.ids.has(item.id);
          return (
            <tr
              key={item.id}
              className={cn(
                "border-b border-app-border/70 transition-colors last:border-b-0",
                selected ? "bg-primary/5" : "hover:bg-app-subtle",
              )}
            >
              <td className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${item.name}`}
                  checked={selected}
                  onChange={() => cb.onSelect(item.id, { ctrl: true })}
                  className="h-4 w-4 rounded border-app-border text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                />
              </td>
              <td className="min-w-0 px-2 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText size={16} aria-hidden="true" className="shrink-0 text-primary" />
                  <Link
                    href={cb.hrefFor(item)}
                    {...selectionHandlers(item.id, cb.onSelect)}
                    className="min-w-0 flex-1 truncate rounded text-[13px] font-semibold text-app-text transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {item.name}
                  </Link>
                  {item.lifecycleState !== "active" && (
                    <span className="shrink-0 rounded-control bg-app-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase text-app-muted">
                      {item.lifecycleState}
                    </span>
                  )}
                </div>
              </td>
              <td className="hidden px-2 py-2 text-xs text-app-muted md:table-cell">
                {relativeDate(item.updatedAt)}
              </td>
              <td className="hidden px-2 py-2 text-xs text-app-muted lg:table-cell">
                {relativeDate(item.createdAt)}
              </td>
              <td className="hidden px-2 py-2 text-xs text-app-muted xl:table-cell">
                {relativeDate(item.lastAccessedAt)}
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center justify-end gap-0.5">
                  <FavoriteButton item={item} onFavorite={cb.onFavorite} />
                  <RowMenu
                    item={item}
                    openHref={cb.hrefFor(item)}
                    onRename={cb.onRename}
                    onLifecycle={cb.onLifecycle}
                  />
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── Grid view ────────────────────────────────────────────────────────────────

function DocumentGrid({
  items,
  selection,
  ...cb
}: RowCallbacks & { items: DocumentItem[]; selection: SelectionState }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
      {items.map((item) => {
        const selected = selection.ids.has(item.id);
        return (
          <li key={item.id}>
            <div
              className={cn(
                "group relative flex flex-col items-center gap-1.5 rounded-appcard border p-3 pt-9 transition-all",
                selected
                  ? "border-primary bg-primary/5"
                  : "border-app-border bg-app-surface hover:border-primary/30 hover:shadow-appcardhover",
              )}
            >
              <div className="absolute left-2 top-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${item.name}`}
                  checked={selected}
                  onChange={() => cb.onSelect(item.id, { ctrl: true })}
                  className="h-4 w-4 rounded border-app-border text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                />
              </div>
              <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <FavoriteButton item={item} onFavorite={cb.onFavorite} size={13} />
                <RowMenu
                  item={item}
                  openHref={cb.hrefFor(item)}
                  onRename={cb.onRename}
                  onLifecycle={cb.onLifecycle}
                />
              </div>
              <div className="grid h-14 w-14 place-items-center rounded-appcard bg-lavender">
                <FileText size={26} aria-hidden="true" className="text-primary" />
              </div>
              <Link
                href={cb.hrefFor(item)}
                {...selectionHandlers(item.id, cb.onSelect)}
                className="w-full truncate rounded text-center text-xs font-semibold text-app-text transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {item.name}
              </Link>
              <span className="text-[11px] text-app-muted">{relativeDate(item.updatedAt)}</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ── Compact view ─────────────────────────────────────────────────────────────

function DocumentCompact({
  items,
  selection,
  ...cb
}: RowCallbacks & { items: DocumentItem[]; selection: SelectionState }) {
  return (
    <ul className="flex flex-col divide-y divide-app-border">
      {items.map((item) => {
        const selected = selection.ids.has(item.id);
        return (
          <li
            key={item.id}
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 transition-colors",
              selected ? "bg-primary/5" : "hover:bg-app-subtle",
            )}
          >
            <input
              type="checkbox"
              aria-label={`Select ${item.name}`}
              checked={selected}
              onChange={() => cb.onSelect(item.id, { ctrl: true })}
              className="h-3.5 w-3.5 shrink-0 rounded border-app-border text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            <FileText size={14} aria-hidden="true" className="shrink-0 text-app-muted" />
            <Link
              href={cb.hrefFor(item)}
              {...selectionHandlers(item.id, cb.onSelect)}
              className="min-w-0 flex-1 truncate rounded text-[13px] text-app-text transition-colors hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {item.name}
            </Link>
            {item.favorite && (
              <Star size={11} aria-hidden="true" className="shrink-0 fill-amber-400 text-amber-400" />
            )}
            <span className="hidden shrink-0 text-[11px] text-app-muted sm:block">
              {relativeDate(item.updatedAt)}
            </span>
            <RowMenu
              item={item}
              openHref={cb.hrefFor(item)}
              onRename={cb.onRename}
              onLifecycle={cb.onLifecycle}
            />
          </li>
        );
      })}
    </ul>
  );
}

// ── Main exported component ──────────────────────────────────────────────────

/**
 * The Workspace document manager.
 *
 * Three presentations over one selection model. Every row's title is a real
 * link into the document workbench, so the manager is a way to reach documents
 * rather than a display of them; selection remains a separate affordance driven
 * by the checkbox and by modifier-clicks on the title.
 *
 * Lifecycle actions are derived from each document's own state rather than from
 * the active view, and the bulk bar only offers a transition valid for every
 * selected document. Bulk results report partial failure as partial.
 */
export function DocumentFileManager({
  workspaceId,
  organizationId,
  items: initialItems,
  hasNextPage: initialHasNext = false,
  nextCursor: initialCursor = null,
  initialView = "all",
}: DocumentFileManagerProps) {
  const [view, setView] = useState<ViewFilter>(initialView);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [items, setItems] = useState<DocumentItem[]>(initialItems);
  const [hasNext, setHasNext] = useState(initialHasNext);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION);

  const [renameTarget, setRenameTarget] = useState<DocumentItem | null>(null);
  const [lifecycleTarget, setLifecycleTarget] = useState<{
    items: DocumentItem[];
    action: LifecycleAction;
  } | null>(null);

  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const sorted = sortDocuments(items, sortField, sortOrder);
  const allIds = sorted.map((doc) => doc.id);

  const hrefFor = useCallback(
    (item: DocumentItem) =>
      workspaceHref(workspaceId, organizationId, {
        path: `/documents/${encodeURIComponent(item.id)}`,
      }),
    [workspaceId, organizationId],
  );

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortOrder((order) => (order === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortOrder("asc");
    }
  }

  function handleSelect(id: string, mods: { ctrl?: boolean; shift?: boolean }) {
    // A plain click on a title navigates; only a modified click changes the
    // selection, so the link and the selection do not fight each other.
    if (!mods.ctrl && !mods.shift) return;
    setSelection((state) => reduceDocumentClick(state, allIds, id, mods));
  }

  function handleToggleAll() {
    setSelection((state) => toggleAll(state, allIds));
  }

  async function loadView(nextView: ViewFilter) {
    setView(nextView);
    setSelection(EMPTY_SELECTION);
    setLoading(true);
    setLoadError(null);
    try {
      const qs = new URLSearchParams({
        organizationId,
        view: nextView,
        sortBy: sortField,
        sortOrder,
        limit: "50",
      });
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${qs}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) throw new Error("Failed to load documents.");
      const data = await response.json();
      setItems(data.items ?? []);
      setHasNext(!!data.nextCursor);
      setCursor(data.nextCursor ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load documents.");
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        organizationId,
        view,
        sortBy: sortField,
        sortOrder,
        cursor,
        limit: "50",
      });
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/documents?${qs}`,
        { credentials: "same-origin" },
      );
      if (!response.ok) throw new Error("Failed to load more.");
      const data = await response.json();
      setItems((prev) => [...prev, ...(data.items ?? [])]);
      setHasNext(!!data.nextCursor);
      setCursor(data.nextCursor ?? null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Failed to load more.");
      announce("Could not load more documents. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleFavorite(item: DocumentItem) {
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(item.id)}/favorite`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, revision: item.revision }),
        },
      );
      if (!response.ok) throw new Error("Failed to update favorite.");
      const data = await response.json();
      setItems((prev) => prev.map((doc) => (doc.id === item.id ? { ...doc, ...data.document } : doc)));
      announce(
        data.document.favorite
          ? `${item.name} added to favorites`
          : `${item.name} removed from favorites`,
      );
    } catch {
      announce("Could not update favorite. Please try again.");
    }
  }

  async function handleRename(name: string) {
    if (!renameTarget) return;
    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(renameTarget.id)}`,
      {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ organizationId, name, revision: renameTarget.revision }),
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message ?? "Rename failed.");
    }
    const data = await response.json();
    setItems((prev) =>
      prev.map((doc) => (doc.id === renameTarget.id ? { ...doc, ...data.document } : doc)),
    );
    announce(`${renameTarget.name} renamed to ${name}`);
    setRenameTarget(null);
  }

  async function handleLifecycle(targetItems: DocumentItem[], action: LifecycleAction) {
    const state = action === "restore" ? "active" : action === "archive" ? "archived" : "trashed";

    if (targetItems.length === 1) {
      const item = targetItems[0];
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/${encodeURIComponent(item.id)}/lifecycle`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organizationId, state }),
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error?.message ?? "Operation failed.");
      }
      const data = await response.json();
      setItems((prev) => prev.map((doc) => (doc.id === item.id ? { ...doc, ...data.document } : doc)));
      setSelection(EMPTY_SELECTION);
      announce(bulkResultMessage({ action, succeeded: 1, failed: 0 }));
      setLifecycleTarget(null);
      return;
    }

    const response = await fetch(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/documents/bulk`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId,
          documentIds: targetItems.map((doc) => doc.id),
          state,
        }),
      },
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message ?? "Bulk operation failed.");
    }
    const data = await response.json();
    const results: { documentId: string; success: boolean }[] = data.itemResults ?? [];
    const succeeded = new Set(results.filter((r) => r.success).map((r) => r.documentId));
    const failedIds = results.filter((r) => !r.success).map((r) => r.documentId);

    setItems((prev) =>
      prev.map((doc) =>
        succeeded.has(doc.id)
          ? { ...doc, lifecycleState: state as DocumentItem["lifecycleState"] }
          : doc,
      ),
    );
    // The documents that failed stay selected, so a retry acts on exactly them.
    setSelection({ ids: new Set(failedIds), anchorId: null });
    announce(bulkResultMessage({ action, succeeded: succeeded.size, failed: failedIds.length }));
    setLifecycleTarget(null);
  }

  const selectedItems = sorted.filter((doc) => selection.ids.has(doc.id));
  const selCount = selectedItems.length;
  const bulkActions = bulkLifecycleActions(selectedItems);

  const rowCb: RowCallbacks = {
    onSelect: handleSelect,
    onFavorite: handleFavorite,
    onRename: (item) => setRenameTarget(item),
    onLifecycle: (item, action) => setLifecycleTarget({ items: [item], action }),
    hrefFor,
  };

  return (
    <div className="flex min-h-0 flex-col">
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>

      <div className="min-w-0 flex-1">
        {/* Toolbar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-[15px] font-bold tracking-tight text-app-text">
            {VIEW_LABELS[view]}
          </h2>
          <div
            role="group"
            aria-label="View mode"
            className="flex items-center gap-0.5 rounded-control border border-app-border p-0.5"
          >
            {(
              [
                ["list", <LayoutList key="l" size={15} aria-hidden="true" />],
                ["grid", <LayoutGrid key="g" size={15} aria-hidden="true" />],
                ["compact", <AlignJustify key="c" size={15} aria-hidden="true" />],
              ] as [ViewMode, React.ReactNode][]
            ).map(([mode, icon]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={viewMode === mode}
                aria-label={`${mode} view`}
                onClick={() => setViewMode(mode)}
                className={cn(
                  "rounded-control p-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  viewMode === mode
                    ? "bg-primary/10 text-primary"
                    : "text-app-muted hover:text-app-text",
                )}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>

        {/* Bulk action bar */}
        {selCount > 0 && (
          <div
            role="toolbar"
            aria-label="Bulk actions"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-control border border-primary/20 bg-primary/5 px-3 py-2"
          >
            <span className="flex-1 text-[13px] font-semibold text-primary">{selCount} selected</span>
            <button type="button" onClick={handleToggleAll} className={GHOST_BUTTON}>
              {selCount === sorted.length ? "Deselect all" : "Select all"}
            </button>
            {/* Only transitions valid for EVERY selected document are offered. */}
            {bulkActions.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => setLifecycleTarget({ items: selectedItems, action })}
                className={cn(GHOST_BUTTON, action === "trash" && "text-red-600 hover:border-red-400 hover:text-red-700")}
              >
                {ACTION_ICONS[action]}
                {ACTION_LABEL[action]}
              </button>
            ))}
            <button type="button" onClick={() => setSelection(EMPTY_SELECTION)} className={GHOST_BUTTON}>
              Clear
            </button>
          </div>
        )}

        {loadError && (
          <div
            role="alert"
            className="mb-3 flex flex-wrap items-center gap-2 rounded-control border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            <span className="flex-1">{loadError}</span>
            <button
              type="button"
              onClick={() => loadView(view)}
              className="rounded underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Retry
            </button>
          </div>
        )}

        {loading && items.length === 0 && (
          <div className="flex items-center justify-center py-14" role="status" aria-live="polite">
            <span
              aria-hidden="true"
              className="h-7 w-7 animate-spin rounded-full border-[3px] border-app-border border-t-primary"
            />
            <span className="sr-only">Loading documents</span>
          </div>
        )}

        {!loading && !loadError && items.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-appcard border border-dashed border-app-border bg-app-subtle py-14 text-center">
            <FileText size={32} aria-hidden="true" className="mb-2 text-app-muted/50" />
            <p className="text-[13px] font-semibold text-app-muted">{VIEW_EMPTY_MESSAGE[view]}</p>
            {/*
              A filtered view with nothing in it is otherwise a dead end: the
              only way back is the sidebar, which is exactly where the user is
              not looking. A LINK to the canonical `?view=all` URL rather than a
              local `loadView` call — see the P1-9 note above for why this
              component must not switch views behind the URL's back.
            */}
            {view !== "all" && (
              <Link
                href={workspaceHref(workspaceId, organizationId, { view: "all" })}
                className={cn(GHOST_BUTTON, "mt-3")}
              >
                View all documents
              </Link>
            )}
          </div>
        )}

        {items.length > 0 && (
          <div className="overflow-hidden rounded-appcard border border-app-border bg-app-surface">
            {viewMode === "list" && (
              <DocumentRowList
                items={sorted}
                selection={selection}
                sortField={sortField}
                sortOrder={sortOrder}
                onSort={handleSort}
                onToggleAll={handleToggleAll}
                {...rowCb}
              />
            )}
            {viewMode === "grid" && (
              <div className="p-3">
                <DocumentGrid items={sorted} selection={selection} {...rowCb} />
              </div>
            )}
            {viewMode === "compact" && (
              <DocumentCompact items={sorted} selection={selection} {...rowCb} />
            )}
          </div>
        )}

        {hasNext && (
          <div className="mt-3 flex justify-center">
            <button type="button" onClick={loadMore} disabled={loading} className={GHOST_BUTTON}>
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>

      {renameTarget && (
        <RenameDialog
          name={renameTarget.name}
          onClose={() => setRenameTarget(null)}
          onRename={handleRename}
        />
      )}
      {lifecycleTarget && (
        <LifecycleConfirmDialog
          action={lifecycleTarget.action}
          count={lifecycleTarget.items.length}
          onClose={() => setLifecycleTarget(null)}
          onConfirm={() => handleLifecycle(lifecycleTarget.items, lifecycleTarget.action)}
        />
      )}
    </div>
  );
}
