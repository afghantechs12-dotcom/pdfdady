"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { SearchPanel } from "./SearchPanel";
import { activeFilterChips, type FilterChip } from "./dashboardLogic";

export interface WorkspaceSearchProps {
  workspaceId: string;
  organizationId: string;
  documentNames?: Record<string, string>;
  canReindex?: boolean;
  onOpenDocument?: (documentId: string, pageNumber: number | null) => void;
}

/**
 * The Workspace search entry point in the top bar.
 *
 * The full `SearchPanel` (M7.9) is unchanged — it is mounted inside a dialog
 * instead of occupying the top third of the dashboard. On the previous layout,
 * search plus its always-expanded filter block pushed the actual documents
 * below the fold on a laptop, which is why the first screenshot shows an empty
 * viewport above an empty document list.
 *
 * Opening focuses the panel's own input; Escape closes and returns focus to the
 * trigger. Cmd/Ctrl+F is deliberately NOT bound: overriding the browser's find
 * is hostile, and the command palette already offers a keyboard route.
 */
export function WorkspaceSearch({
  workspaceId,
  organizationId,
  documentNames,
  canReindex,
  onOpenDocument,
}: WorkspaceSearchProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) {
      triggerRef.current?.focus({ preventScroll: true });
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      {/* Desktop: a real-looking search field that opens the panel. Mobile: an
          icon button, since a full field would crowd the bar off-screen. */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="hidden min-h-[38px] w-full max-w-sm items-center gap-2 rounded-control border border-app-border bg-app-subtle px-3 text-left text-sm text-app-muted transition-colors hover:border-app-borderstrong hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 md:flex"
      >
        <Search size={15} aria-hidden="true" className="shrink-0" />
        <span className="flex-1 truncate">Search documents…</span>
      </button>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search documents"
        className="grid h-9 w-9 place-items-center rounded-control text-app-muted transition-colors hover:bg-lavender hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 md:hidden"
      >
        <Search size={17} aria-hidden="true" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close search"
            onClick={() => setOpen(false)}
            className="fixed inset-0 bg-app-text/40"
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative z-10 mt-4 w-full max-w-3xl rounded-panel border border-app-border bg-app-surface p-4 shadow-apppanel sm:p-5"
          >
            <div className="mb-3 flex items-center justify-between">
              <h2 id={titleId} className="text-[15px] font-bold text-app-text">
                Search documents
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close search"
                className="grid h-9 w-9 place-items-center rounded-control text-app-muted hover:bg-lavender hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <X size={17} aria-hidden="true" />
              </button>
            </div>
            <SearchPanel
              workspaceId={workspaceId}
              organizationId={organizationId}
              documentNames={documentNames}
              canReindex={canReindex}
              onOpenDocument={(documentId, pageNumber) => {
                setOpen(false);
                onOpenDocument?.(documentId, pageNumber);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The row of removable chips describing what is currently narrowing the list.
 *
 * Rendered only when something is actually filtering, so an unfiltered view
 * does not carry a "Clear all" for nothing.
 */
export function FilterChips({
  chips,
  onRemove,
  onClearAll,
}: {
  chips: FilterChip[];
  onRemove?: (chip: FilterChip) => void;
  onClearAll?: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <SlidersHorizontal size={13} aria-hidden="true" className="text-app-muted" />
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex items-center gap-1 rounded-full border border-app-border bg-app-subtle py-0.5 pl-2.5 pr-1 text-xs text-app-text"
        >
          <span className="text-app-muted">{chip.label}:</span>
          <span className="font-medium">{chip.value}</span>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(chip)}
              aria-label={`Remove ${chip.label} filter ${chip.value}`}
              className="grid h-5 w-5 place-items-center rounded-full text-app-muted transition-colors hover:bg-app-border hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
      {onClearAll && chips.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className={cn(
            "rounded-control px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          )}
        >
          Clear all
        </button>
      )}
    </div>
  );
}

export { activeFilterChips };
