"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import {
  LayoutDashboard,
  BarChart3,
  Settings,
  Search,
  Wrench,
  BookOpen,
  HelpCircle,
  ListChecks,
  Tag,
  DollarSign,
  Users2,
  ShieldCheck,
  Sparkles,
  ServerCog,
  Menu,
  X,
  LogOut,
  FileSearch,
  PanelLeftOpen,
  PanelLeftClose,
} from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { useFocusTrap } from "@/lib/a11y/focusTrap";

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ size?: number }>;
  group: "Overview" | "Content" | "Tools" | "Site" | "Settings";
}

const NAV: NavItem[] = [
  { label: "Dashboard", href: "/admin", icon: LayoutDashboard, group: "Overview" },
  { label: "Analytics", href: "/admin/analytics", icon: BarChart3, group: "Overview" },
  { label: "Site Settings", href: "/admin/site", icon: Settings, group: "Site" },
  { label: "SEO & Metadata", href: "/admin/seo", icon: Search, group: "Site" },
  { label: "Navigation", href: "/admin/nav", icon: Menu, group: "Site" },
  { label: "Pages", href: "/admin/pages", icon: FileSearch, group: "Content" },
  { label: "Blog", href: "/admin/blog", icon: BookOpen, group: "Content" },
  { label: "FAQ", href: "/admin/faq", icon: HelpCircle, group: "Content" },
  { label: "Pricing", href: "/admin/pricing", icon: DollarSign, group: "Content" },
  { label: "Features", href: "/admin/features", icon: ListChecks, group: "Content" },
  { label: "Use Cases", href: "/admin/use-cases", icon: Users2, group: "Content" },
  { label: "Trust Strip", href: "/admin/trust", icon: ShieldCheck, group: "Content" },
  { label: "AI Tools", href: "/admin/ai-tools", icon: Sparkles, group: "Content" },
  { label: "Tools", href: "/admin/tools", icon: Wrench, group: "Tools" },
  { label: "Server Tools", href: "/admin/server-tools", icon: ServerCog, group: "Tools" },
  { label: "Categories", href: "/admin/tools/categories", icon: Tag, group: "Tools" },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const router = useRouter();
  const sidebarRef = useRef<HTMLElement>(null);
  // Trap focus inside the mobile slide-over while it's open and close on Escape.
  // On desktop the sidebar is a static landmark (no trap); mobileOpen is always false there.
  useFocusTrap(sidebarRef, mobileOpen, () => setMobileOpen(false));

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    router.push("/admin/login");
    router.refresh();
  }

  const groups = ["Overview", "Content", "Tools", "Site", "Settings"] as const;

  return (
    <div className="flex min-h-screen bg-lavender/40">
      {/* The skip link lives in the root layout; this shell supplies the
          matching #main landmark below. */}

      {/* Mobile backdrop */}
      {mobileOpen && (
        <button
          aria-label="Close menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-navy/30 lg:hidden"
        />
      )}

      {/* Sidebar — a dialog only when the mobile slide-over is open */}
      <aside
        ref={sidebarRef}
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? "true" : undefined}
        aria-label="Admin navigation"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-softborder bg-white transition-all duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          collapsed ? "lg:w-20" : "lg:w-72",
          "w-72", // mobile width
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className="flex h-16 items-center justify-between px-4">
          <Link
            href="/admin"
            className="flex items-center gap-2"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white shadow-card">
              <FileTextMark />
            </span>
            {!collapsed && (
              <div>
                <p className="text-sm font-bold text-navy">PDFDadi</p>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                  Admin
                </p>
              </div>
            )}
          </Link>
          <button
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden h-8 w-8 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender lg:inline-flex"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender lg:hidden"
          >
            <X size={20} />
          </button>
        </div>

        <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 pb-6 pt-2">
          {groups.map((group) => {
            const items = NAV.filter((n) => n.group === group);
            if (!items.length) return null;
            return (
              <div key={group} className="mt-5 first:mt-0">
                {!collapsed && (
                  <p className="px-3 pb-1 text-[10px] font-bold uppercase tracking-wider text-navy-soft/70">
                    {group}
                  </p>
                )}
                <ul className="space-y-0.5">
                  {items.map((item) => {
                    const active =
                      pathname === item.href ||
                      (item.href !== "/admin" && pathname.startsWith(`${item.href}/`));
                    const Icon = item.icon;
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          onClick={() => setMobileOpen(false)}
                          title={collapsed ? item.label : undefined}
                          className={cn(
                            "flex items-center gap-2.5 rounded-button px-3 py-2 text-sm font-medium transition-colors",
                            active
                              ? "bg-primary text-white shadow-card"
                              : "text-navy-soft hover:bg-lavender hover:text-primary",
                          )}
                        >
                          <Icon size={16} />
                          {!collapsed && <span>{item.label}</span>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="border-t border-softborder p-3">
          <button
            onClick={logout}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-button px-3 py-2 text-sm font-medium text-navy-soft transition-colors hover:bg-red-50 hover:text-red-600",
            )}
          >
            <LogOut size={16} />
            {!collapsed && <span>Sign out</span>}
          </button>
          {!collapsed && (
            <Link
              href="/"
              target="_blank"
              className="mt-2 flex items-center justify-center gap-1.5 rounded-button px-3 py-2 text-xs font-semibold text-primary hover:bg-lavender"
            >
              View public site ↗
            </Link>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-softborder bg-white/85 px-5 backdrop-blur-md sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              className="inline-flex h-10 w-10 items-center justify-center rounded-button text-navy hover:bg-lavender lg:hidden"
            >
              <Menu size={20} />
            </button>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                PDFDadi Admin
              </p>
              <p className="text-sm font-bold text-navy">
                {breadcrumbFor(pathname)}
              </p>
            </div>
          </div>
          <Link
            href="/"
            target="_blank"
            className="hidden items-center gap-1.5 rounded-button border border-softborder bg-white px-3 py-1.5 text-xs font-semibold text-navy-soft transition-colors hover:border-primary hover:text-primary lg:inline-flex"
          >
            View website ↗
          </Link>
        </header>
        <main id="main" className="flex-1 px-5 py-6 sm:px-6 lg:px-8 lg:py-10">{children}</main>
      </div>
    </div>
  );
}

function FileTextMark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function breadcrumbFor(p: string) {
  if (p === "/admin") return "Dashboard";
  const seg = p.replace(/^\/admin\//, "").split("/")[0];
  const map: Record<string, string> = {
    site: "Site Settings",
    seo: "SEO & Metadata",
    nav: "Navigation",
    pages: "Pages",
    blog: "Blog",
    faq: "FAQ",
    pricing: "Pricing",
    features: "Features",
    "use-cases": "Use Cases",
    trust: "Trust Strip",
    "ai-tools": "AI Tools",
    tools: "Tools",
  };
  if (p.includes("/tools/categories")) return "Tool Categories";
  if (p.startsWith("/admin/server-tools")) return "Server Tools";
  if (p.startsWith("/blog/")) return "Blog Post";
  if (p.startsWith("/pages/")) return "Page Content";
  if (p.startsWith("/tools/")) return "Tool";
  return map[seg] ?? "Admin";
}
