"use client";

import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { BRAND } from "@/lib/brand";
import { LogoMark } from "@/components/layout/Logo";
import { appIcon } from "./appIcons";
import { AppWorkspaceSwitcher, type AppWorkspaceItem } from "./AppWorkspaceSwitcher";
import { AppUserMenu } from "./AppUserMenu";
import { navItemHref, navItemsForSection, sectionLabel, type AppNavSection } from "./appShellLogic";

export interface AppSidebarProps {
  workspaces: AppWorkspaceItem[];
  workspaceId: string;
  organizationId: string;
  activeItemId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  user: { name: string | null; email: string };
  settingsHref: string | null;
  /** Mobile drawer: rendered as a dialog and closable. */
  mobile?: boolean;
  onCloseMobile?: () => void;
  onCreateWorkspace?: () => void;
}

const SECTIONS: AppNavSection[] = ["workspace", "tools"];

/**
 * The authenticated application sidebar.
 *
 * Deep navy against the light workspace surfaces, matching the target
 * direction. It is one component for both the desktop rail and the mobile
 * drawer: the two differ only in positioning and whether a close button is
 * shown, and keeping them as one implementation is what stops the drawer's
 * navigation from drifting out of step with the rail's.
 *
 * Collapsed mode keeps the icons and drops the labels. The labels move into
 * `title` + `aria-label`, so a collapsed rail is still navigable by screen
 * reader and shows a native tooltip on hover.
 */
export function AppSidebar({
  workspaces,
  workspaceId,
  organizationId,
  activeItemId,
  collapsed,
  onToggleCollapsed,
  user,
  settingsHref,
  mobile = false,
  onCloseMobile,
  onCreateWorkspace,
}: AppSidebarProps) {
  // The drawer is always expanded: a collapsed rail inside a slide-over would
  // be a 64px panel over a dimmed screen, which helps nobody.
  const isCollapsed = collapsed && !mobile;

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-app-sidebar text-white",
        isCollapsed ? "w-[68px]" : "w-[248px]",
      )}
    >
      {/* Brand */}
      <div className={cn("flex h-14 shrink-0 items-center gap-2 px-3", isCollapsed && "justify-center px-0")}>
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          aria-label={`${BRAND.name} home`}
        >
          <LogoMark size={28} />
          {!isCollapsed && (
            <span className="truncate text-[15px] font-bold tracking-tight text-white">
              {BRAND.wordmark.lead}
              <span className="bg-gradient-to-r from-violet-400 to-pink-400 bg-clip-text text-transparent">
                {BRAND.wordmark.accent}
              </span>
            </span>
          )}
        </Link>
        {mobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            aria-label="Close navigation"
            className="ml-auto grid h-9 w-9 place-items-center rounded-control text-app-sidebartext hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Workspace switcher */}
      {!isCollapsed && (
        <div className="px-3 pb-2">
          <AppWorkspaceSwitcher
            items={workspaces}
            currentId={workspaceId}
            organizationId={organizationId}
            onCreate={onCreateWorkspace}
          />
        </div>
      )}

      {/* Navigation */}
      <nav aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {SECTIONS.map((section) => {
          const items = navItemsForSection(section);
          if (items.length === 0) return null;
          return (
            <div key={section} className="mb-3">
              {!isCollapsed && (
                <h2 className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-app-sidebartext/70">
                  {sectionLabel(section)}
                </h2>
              )}
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => {
                  const Icon = appIcon(item.icon);
                  const active = item.id === activeItemId;
                  return (
                    <li key={item.id}>
                      <Link
                        href={navItemHref(item, workspaceId, organizationId)}
                        aria-current={active ? "page" : undefined}
                        aria-label={isCollapsed ? item.label : undefined}
                        title={isCollapsed ? item.label : undefined}
                        onClick={mobile ? onCloseMobile : undefined}
                        className={cn(
                          "relative flex min-h-[38px] items-center gap-2.5 rounded-control px-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
                          isCollapsed && "justify-center px-0",
                          active
                            ? "bg-app-sidebaractive text-white"
                            : "text-slate-300 hover:bg-app-sidebarhover hover:text-white",
                        )}
                      >
                        {/* The active item is marked by an accent bar as well as
                            colour, so state is not carried by colour alone. */}
                        {active && !isCollapsed && (
                          <span aria-hidden="true" className="absolute left-0 h-5 w-[3px] rounded-r bg-primary" />
                        )}
                        <Icon size={17} aria-hidden="true" className={cn("shrink-0", active && "text-primary")} />
                        {!isCollapsed && <span className="truncate">{item.label}</span>}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      {/* Footer: collapse toggle + account */}
      <div className="shrink-0 border-t border-white/[0.07] p-2">
        {!mobile && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "mb-1 flex min-h-[38px] w-full items-center gap-2.5 rounded-control px-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-app-sidebarhover hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70",
              isCollapsed && "justify-center px-0",
            )}
          >
            {collapsed ? (
              <PanelLeftOpen size={17} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={17} aria-hidden="true" />
            )}
            {!isCollapsed && <span>Collapse</span>}
          </button>
        )}
        {isCollapsed ? (
          <Link
            href={settingsHref ?? "#"}
            aria-label={`Account: ${user.email}`}
            title={user.email}
            className="grid h-10 w-full place-items-center rounded-control text-slate-300 hover:bg-app-sidebarhover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            <span
              aria-hidden="true"
              className="grid h-7 w-7 place-items-center rounded-full bg-white/10 text-[10px] font-bold text-white"
            >
              {(user.name ?? user.email).trim().slice(0, 2).toUpperCase()}
            </span>
          </Link>
        ) : (
          <AppUserMenu name={user.name} email={user.email} settingsHref={settingsHref} />
        )}
      </div>
    </div>
  );
}
