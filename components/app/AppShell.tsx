"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Menu, Settings } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFocusTrap } from "@/lib/a11y/focusTrap";
import { AppSidebar } from "./AppSidebar";
import type { AppWorkspaceItem } from "./AppWorkspaceSwitcher";
import { activeNavItemId } from "./appShellLogic";

export interface AppShellProps {
  workspaces: AppWorkspaceItem[];
  workspaceId: string;
  organizationId: string;
  user: { name: string | null; email: string };
  /** Role badge for the current Workspace, e.g. "owner". */
  role?: string | null;
  settingsHref?: string | null;
  /** Rendered in the top bar: search, command palette, operations, actions. */
  topbar?: React.ReactNode;
  /** Page heading rendered in the top bar's left slot. */
  title?: React.ReactNode;
  children: React.ReactNode;
}

const COLLAPSE_KEY = "pdfdadi.app.sidebarCollapsed";

/**
 * The authenticated application shell: dark sidebar, sticky top bar, and the
 * scrolling content region.
 *
 * The collapsed state is persisted to localStorage, read in an effect rather
 * than during render. Reading storage during the first render would produce
 * server/client markup that disagrees, and Next hydration would discard the
 * result anyway — the one-frame expansion is the honest cost of not lying to
 * the server renderer.
 *
 * The mobile drawer is a real dialog: focus is trapped while it is open,
 * Escape closes it, and focus returns to the trigger.
 */
export function AppShell({
  workspaces,
  workspaceId,
  organizationId,
  user,
  role = null,
  settingsHref = null,
  topbar,
  title,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(drawerRef, mobileOpen, () => setMobileOpen(false));

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // Private-mode / disabled storage: the default expanded rail is fine.
    }
  }, []);

  // Focus returns to the trigger when the drawer closes, so a keyboard user is
  // not dropped at the top of the document.
  useEffect(() => {
    if (!mobileOpen) menuButtonRef.current?.focus({ preventScroll: true });
  }, [mobileOpen]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Persisting is a convenience; failing to persist is not an error.
      }
      return next;
    });
  }, []);

  const activeItemId = activeNavItemId({
    pathname: pathname ?? "",
    view: searchParams?.get("view") ?? null,
    workspaceId,
  });

  const sidebarProps = {
    workspaces,
    workspaceId,
    organizationId,
    activeItemId,
    collapsed,
    onToggleCollapsed: toggleCollapsed,
    user,
    settingsHref,
  };

  return (
    <div className="flex min-h-screen w-full bg-app-bg">
      {/* Desktop rail */}
      <div className="sticky top-0 hidden h-screen shrink-0 lg:block">
        <AppSidebar {...sidebarProps} />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-drawer lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            tabIndex={-1}
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-app-text/40 backdrop-blur-[1px]"
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 shadow-apppanel"
          >
            <AppSidebar {...sidebarProps} mobile onCloseMobile={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-sticky flex min-h-[56px] items-center gap-2 border-b border-app-border bg-app-surface/95 px-3 backdrop-blur-sm sm:px-4">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-control text-app-muted transition-colors hover:bg-lavender hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden"
          >
            <Menu size={19} aria-hidden="true" />
          </button>

          {title && <div className="min-w-0 flex-1">{title}</div>}
          {!title && <div className="min-w-0 flex-1" />}

          <div className="flex shrink-0 items-center gap-1.5">
            {topbar}
            {role && (
              <span className="hidden rounded-full bg-primary-soft px-2.5 py-1 text-[11px] font-semibold capitalize text-primary sm:inline">
                {role}
              </span>
            )}
            {settingsHref && (
              <Link
                href={settingsHref}
                aria-label="Workspace settings"
                title="Workspace settings"
                className="grid h-9 w-9 place-items-center rounded-control text-app-muted transition-colors hover:bg-lavender hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Settings size={17} aria-hidden="true" />
              </Link>
            )}
          </div>
        </header>

        <main id="main" className={cn("min-w-0 flex-1")}>
          {children}
        </main>
      </div>
    </div>
  );
}
