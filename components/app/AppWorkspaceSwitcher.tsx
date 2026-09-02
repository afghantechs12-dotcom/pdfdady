"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { workspaceHref } from "./appShellLogic";

export interface AppWorkspaceItem {
  id: string;
  name: string;
  lifecycleState: string;
}

export interface WorkspaceSwitcherProps {
  items: AppWorkspaceItem[];
  currentId: string;
  organizationId: string;
  /** Rendered on the dark sidebar rather than a light surface. */
  tone?: "dark" | "light";
  /** Shown as the menu's create action when the actor may create Workspaces. */
  onCreate?: () => void;
}

/**
 * The Workspace switcher in the authenticated sidebar.
 *
 * This replaces a bare `<select>` that navigated on change. A native select
 * cannot show the Workspace avatar, the current-item check, or a "New
 * Workspace" action, and on mobile it opened the OS picker over the app.
 *
 * The menu is a real listbox: Up/Down move, Enter/Space select, Escape closes
 * and returns focus to the trigger, and an outside pointer press dismisses it.
 * Selecting an item is a link navigation, so middle-click and modifier-click
 * behave the way a user expects of navigation.
 */
export function AppWorkspaceSwitcher({
  items,
  currentId,
  organizationId,
  tone = "dark",
  onCreate,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const current = items.find((item) => item.id === currentId) ?? null;
  const dark = tone === "dark";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Opening lands the active option on the current Workspace, so Enter without
  // arrowing is a no-op navigation rather than a jump to an unrelated one.
  useEffect(() => {
    if (!open) return;
    const index = items.findIndex((item) => item.id === currentId);
    setActiveIndex(index >= 0 ? index : 0);
  }, [open, items, currentId]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % Math.max(items.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + items.length) % Math.max(items.length, 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(Math.max(items.length - 1, 0));
    } else if (event.key === "Enter" || event.key === " ") {
      const target = items[activeIndex];
      if (target) {
        event.preventDefault();
        window.location.assign(workspaceHref(target.id, organizationId));
      }
    }
  };

  const initial = (current?.name ?? "W").trim().charAt(0).toUpperCase();

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-controllg px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2",
          dark
            ? "bg-white/[0.06] text-white hover:bg-white/[0.11] focus-visible:ring-primary/70"
            : "border border-app-border bg-white text-app-text hover:border-app-borderstrong focus-visible:ring-primary/40",
        )}
      >
        <span
          aria-hidden="true"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-control bg-gradient-to-br from-primary to-aipink text-xs font-bold text-white"
        >
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-semibold", dark ? "text-white" : "text-app-text")}>
            {current?.name ?? "Select Workspace"}
          </span>
          <span className={cn("block truncate text-[11px]", dark ? "text-app-sidebartext" : "text-app-muted")}>
            {current && current.lifecycleState !== "active" ? current.lifecycleState : "Workspace"}
          </span>
        </span>
        <ChevronsUpDown
          size={15}
          aria-hidden="true"
          className={cn("shrink-0", dark ? "text-app-sidebartext" : "text-app-muted")}
        />
      </button>

      {open && (
        <div
          className={cn(
            "absolute left-0 right-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-controllg border shadow-appmenu",
            dark ? "border-white/10 bg-[#0D1B2E]" : "border-app-border bg-white",
          )}
        >
          <ul
            id={listId}
            role="listbox"
            aria-label="Switch Workspace"
            aria-activedescendant={items[activeIndex] ? `${listId}-${items[activeIndex].id}` : undefined}
            tabIndex={-1}
            className="max-h-64 overflow-y-auto py-1"
          >
            {items.length === 0 ? (
              <li className={cn("px-3 py-2 text-sm", dark ? "text-app-sidebartext" : "text-app-muted")}>
                No Workspaces
              </li>
            ) : (
              items.map((item, index) => {
                const selected = item.id === currentId;
                return (
                  <li key={item.id} id={`${listId}-${item.id}`} role="option" aria-selected={selected}>
                    <a
                      href={workspaceHref(item.id, organizationId)}
                      onMouseEnter={() => setActiveIndex(index)}
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 text-sm transition-colors",
                        dark
                          ? index === activeIndex
                            ? "bg-white/10 text-white"
                            : "text-slate-200 hover:bg-white/10"
                          : index === activeIndex
                            ? "bg-lavender text-app-text"
                            : "text-app-text hover:bg-lavender",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {item.name}
                        {item.lifecycleState !== "active" && (
                          <span className={cn("ml-1.5 text-[11px]", dark ? "text-app-sidebartext" : "text-app-muted")}>
                            ({item.lifecycleState})
                          </span>
                        )}
                      </span>
                      {selected && <Check size={14} aria-hidden="true" className="shrink-0 text-primary" />}
                    </a>
                  </li>
                );
              })
            )}
          </ul>
          {onCreate && (
            <div className={cn("border-t p-1", dark ? "border-white/10" : "border-app-border")}>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onCreate();
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-sm font-medium transition-colors",
                  dark ? "text-slate-200 hover:bg-white/10" : "text-app-text hover:bg-lavender",
                )}
              >
                <Plus size={14} aria-hidden="true" />
                New Workspace
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
