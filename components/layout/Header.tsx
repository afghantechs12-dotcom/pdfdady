"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, LayoutGrid, LogIn, Menu, X } from "lucide-react";
import { Logo } from "./Logo";
import { PageContainer } from "./PageContainer";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils/cn";
import { useFocusTrap } from "@/lib/a11y/focusTrap";
import { usePublicSession } from "@/hooks/usePublicSession";
import {
  LOGIN_LINK,
  PRIMARY_CTA,
  isActiveNavHref,
  menuKeyFor,
  navLinksForSession,
  type ResolvedNavMenus,
} from "./headerLogic";
import type { NavLink } from "@/data/nav";

/**
 * Secondary destinations that hang off every tool menu's footer.
 *
 * The reference header has six primary slots and tools fill all of them. Blog
 * and About still have to be reachable from the header, so they live one row
 * below the tool grid in each panel and as plain rows in the mobile drawer.
 */
const MENU_FOOTER_LINKS = [
  { label: "Blog", href: "/blog" },
  { label: "About", href: "/about" },
] as const;

/**
 * The single canonical public header.
 *
 * Behaviour preserved from the launch audit — do not regress any of it:
 *
 *  1. A sign-in affordance exists (there was none).
 *  2. "Get Started Free" goes to /register?returnTo=/workspaces, and becomes
 *     "Open Workspace" once signed in.
 *  3. The mobile menu is a real dialog — unmounted when closed, focus-trapped
 *     and Escape-closable when open, background scroll locked. It must never go
 *     back to animating `max-height` to zero, which leaves links focusable
 *     inside invisible content.
 *
 * Added in the homepage redesign: a scroll-state transition and the tool
 * mega-dropdowns. Both live here rather than in a new component because this is
 * already a client component — a separate one would add a second entry to the
 * homepage's client bundle for no benefit.
 *
 * The target-match pass turned the single Tools dropdown into N named menus
 * (Tools / Edit / Convert). One `menuOpen` key still drives all of them, so only
 * one panel can be open at a time and the dismissal logic did not have to grow;
 * the trigger refs became a map only because Escape must return focus to the
 * trigger that was actually used.
 *
 * Session state is resolved client-side on purpose; see hooks/usePublicSession
 * for why the alternative would cost every public page its static rendering.
 * The account area reserves a fixed-width slot so that swap never shifts layout.
 */
export function Header({
  navLinks,
  toolMenus,
  availableCount,
}: {
  navLinks: NavLink[];
  /**
   * Resolved on the server from the tool registry. Passing slugs and resolving
   * here would pull the whole 45-entry catalog into the client bundle — the
   * exact regression lib/seo/publicBundles.test.ts was written to catch.
   */
  toolMenus: ResolvedNavMenus;
  availableCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const pathname = usePathname();
  const session = usePublicSession();
  const drawerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Keyed by nav href: Escape has to restore focus to the trigger the user
  // actually opened, not to whichever one mounted last.
  const triggerRefs = useRef(new Map<string, HTMLButtonElement | null>());
  // Closing on pointer-out is delayed so the diagonal trip from the trigger to
  // the panel doesn't dismiss the menu mid-movement.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const signedIn = session.status === "signed-in";
  const links = navLinksForSession(navLinks, signedIn);
  const cta = signedIn ? PRIMARY_CTA.signedIn : PRIMARY_CTA.signedOut;

  useFocusTrap(drawerRef, open, () => setOpen(false));

  // Close the drawer on navigation: without this, following a link leaves the
  // overlay covering the page the user just asked for.
  useEffect(() => {
    setOpen(false);
    setMenuOpen(null);
  }, [pathname]);

  // Lock background scrolling while the drawer is open, and restore whatever
  // the document had before rather than assuming it was "visible".
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Shadow + opaque background once the page has moved. Passive listener: this
  // never calls preventDefault, and a non-passive scroll handler blocks
  // scrolling on the main thread.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Dismiss the dropdown on Escape (restoring focus to its trigger, or the user
  // is left with focus on a panel that no longer exists) and on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const trigger = triggerRefs.current.get(menuOpen) ?? null;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setMenuOpen(null);
      trigger?.focus();
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (trigger?.contains(target)) return;
      setMenuOpen(null);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuOpen]);

  // A focus leaving the menu subtree entirely means the user tabbed past it.
  const onMenuBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setMenuOpen(null);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setMenuOpen(null), 140);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  // Every group across every menu, deduplicated by title — the mobile drawer
  // flattens them into one list rather than nesting a menu inside a dialog.
  const mobileGroups = Array.from(
    new Map(
      Object.values(toolMenus)
        .flat()
        .map((group) => [group.title, group]),
    ).values(),
  );

  return (
    <header
      className={cn(
        "sticky top-0 z-40 w-full border-b transition-all duration-300 motion-reduce:transition-none",
        scrolled
          ? "border-softborder/70 bg-white/90 shadow-[0_4px_20px_rgba(124,58,237,0.07)] backdrop-blur-xl"
          : "border-transparent bg-white/70 backdrop-blur-md",
      )}
    >
      <PageContainer>
        {/* 72px, up from 64px: the target header carries more presence, and the
            extra 8px is what lets the logo grow without crowding the nav. */}
        <div className="flex h-[72px] items-center justify-between gap-4">
          <Logo />

          <nav
            aria-label="Primary"
            className="hidden items-center gap-0.5 lg:flex xl:gap-1"
          >
            {links.map((link) => {
              const active = isActiveNavHref(link.href, pathname);
              const menuKey = menuKeyFor(link, toolMenus);

              if (menuKey) {
                const groups = toolMenus[menuKey];
                const expanded = menuOpen === link.href;
                const panelId = `nav-menu-${menuKey}`;
                // The panel is sized to its content: Tools carries three
                // groups, Edit and Convert two. A fixed 620px panel over two
                // columns leaves a third of it empty.
                const wide = groups.length >= 3;

                return (
                  <div
                    key={link.href}
                    className="relative"
                    onPointerEnter={() => {
                      cancelClose();
                      setMenuOpen(link.href);
                    }}
                    onPointerLeave={scheduleClose}
                    onBlur={onMenuBlur}
                  >
                    {/*
                      A button, not a link: it toggles a panel. Every panel ends
                      with a link to the full catalog, so /tools is still one
                      keystroke away and nothing is lost by not navigating here.
                    */}
                    <button
                      ref={(node) => {
                        triggerRefs.current.set(link.href, node);
                      }}
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      aria-haspopup="true"
                      onClick={() => setMenuOpen(expanded ? null : link.href)}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-button px-3 py-2 text-[0.9375rem] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                        active || expanded
                          ? "bg-lavender text-navy"
                          : "text-navy-soft hover:bg-lavender hover:text-navy",
                      )}
                    >
                      {link.label}
                      <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={cn(
                          "transition-transform duration-200 motion-reduce:transition-none",
                          expanded && "rotate-180",
                        )}
                      />
                    </button>

                    {expanded && (
                      <div
                        id={panelId}
                        ref={menuRef}
                        className={cn(
                          "absolute left-1/2 top-full z-50 -translate-x-1/2 pt-3",
                          wide ? "w-[620px]" : "w-[440px]",
                        )}
                      >
                        <div className="animate-fade-up rounded-card border border-softborder bg-white p-5 shadow-cardhover">
                          <div
                            className={cn(
                              "grid gap-5",
                              wide ? "grid-cols-3" : "grid-cols-2",
                            )}
                          >
                            {groups.map((group) => (
                              <div key={group.title}>
                                <p className="px-2 text-xs font-semibold uppercase tracking-wider text-primary">
                                  {group.title}
                                </p>
                                <ul className="mt-2 space-y-0.5">
                                  {group.tools.map((tool) => (
                                    <li key={tool.slug}>
                                      <Link
                                        href={tool.href}
                                        onClick={() => setMenuOpen(null)}
                                        className="block rounded-button px-2 py-1.5 text-sm text-navy-soft transition-colors hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                                      >
                                        {tool.name}
                                      </Link>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-softborder pt-3">
                            <Link
                              href="/tools"
                              onClick={() => setMenuOpen(null)}
                              className="inline-flex items-center gap-1.5 rounded-button px-2 py-1.5 text-sm font-semibold text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              View all {availableCount} tools
                              <ChevronDown
                                size={14}
                                aria-hidden="true"
                                className="-rotate-90"
                              />
                            </Link>
                            {/*
                              Blog and About are not top-level items in this
                              header — the reference's nav has six slots and
                              tools earn them. They stay reachable in one click
                              from here and from the footer.
                            */}
                            {MENU_FOOTER_LINKS.map((item) => (
                              <Link
                                key={item.href}
                                href={item.href}
                                onClick={() => setMenuOpen(null)}
                                className="rounded-button px-1 py-1.5 text-sm text-navy-soft transition-colors hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                              >
                                {item.label}
                              </Link>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-button px-3 py-2 text-[0.9375rem] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    active
                      ? "bg-lavender text-navy"
                      : "text-navy-soft hover:bg-lavender hover:text-navy",
                  )}
                >
                  {link.label}
                  {link.badge && (
                    <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                      {link.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {/*
            Fixed minimum width: the signed-out state ("Log in" + "Get Started
            Free") and the signed-in state ("Open Workspace") must occupy the
            same space, or the post-hydration swap would shift the header.
          */}
          <div className="hidden min-w-[248px] items-center justify-end gap-2 lg:flex">
            {signedIn ? (
              <Button
                href={cta.href}
                size="md"
                leadingIcon={<LayoutGrid size={16} aria-hidden="true" />}
              >
                {cta.label}
              </Button>
            ) : (
              <>
                <Link
                  href={LOGIN_LINK.href}
                  className="rounded-button px-3 py-2 text-sm font-semibold text-navy-soft transition-colors hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {LOGIN_LINK.label}
                </Link>
                <Button href={cta.href} size="md">
                  {cta.label}
                </Button>
              </>
            )}
          </div>

          <button
            ref={toggleRef}
            type="button"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            aria-controls="mobile-menu"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-11 w-11 items-center justify-center rounded-button text-navy hover:bg-lavender focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden"
          >
            {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
          </button>
        </div>
      </PageContainer>

      {/*
        Rendered only when open. The previous implementation kept the markup
        mounted and collapsed it with max-height, which hides content visually
        while leaving it focusable.
      */}
      {open && (
        <>
          <div
            className="fixed inset-0 top-[72px] z-[55] bg-navy/20 lg:hidden"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <div
            id="mobile-menu"
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            className="fixed inset-x-0 top-[72px] z-[60] max-h-[calc(100dvh-72px)] overflow-y-auto border-t border-softborder bg-white shadow-cardhover lg:hidden"
          >
            <PageContainer className="py-4">
              <nav aria-label="Mobile" className="flex flex-col gap-1">
                {links.map((link) => {
                  const active = isActiveNavHref(link.href, pathname);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      onClick={() => setOpen(false)}
                      className={cn(
                        // 44px minimum touch target.
                        "flex min-h-[44px] items-center gap-2 rounded-button px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                        active
                          ? "bg-lavender text-navy"
                          : "text-navy-soft hover:bg-lavender hover:text-navy",
                      )}
                    >
                      {link.label}
                      {link.badge && (
                        <span className="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
                          {link.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}

                {/*
                  The dropdowns' groups, flattened and deduplicated. A nested
                  disclosure inside a drawer that is itself a dialog is two
                  layers of state for a list this short; native <details> keeps
                  it keyboard-operable with no JS at all.
                */}
                {mobileGroups.map((group) => (
                  <details key={group.title} className="group">
                    <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between rounded-button px-3 text-sm font-medium text-navy-soft transition-colors hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                      {group.title}
                      <ChevronDown
                        size={16}
                        aria-hidden="true"
                        className="transition-transform group-open:rotate-180 motion-reduce:transition-none"
                      />
                    </summary>
                    <ul className="ml-3 border-l border-softborder pl-3">
                      {group.tools.map((tool) => (
                        <li key={tool.slug}>
                          <Link
                            href={tool.href}
                            onClick={() => setOpen(false)}
                            className="flex min-h-[44px] items-center rounded-button px-3 text-sm text-navy-soft transition-colors hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          >
                            {tool.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}

                {MENU_FOOTER_LINKS.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-[44px] items-center rounded-button px-3 text-sm font-medium text-navy-soft transition-colors hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    {item.label}
                  </Link>
                ))}

                <div className="mt-3 flex flex-col gap-2 border-t border-softborder pt-3">
                  {signedIn ? (
                    <Button
                      href={cta.href}
                      fullWidth
                      leadingIcon={<LayoutGrid size={16} aria-hidden="true" />}
                    >
                      {cta.label}
                    </Button>
                  ) : (
                    <>
                      <Button
                        href={LOGIN_LINK.href}
                        variant="outline"
                        fullWidth
                        leadingIcon={<LogIn size={16} aria-hidden="true" />}
                      >
                        {LOGIN_LINK.label}
                      </Button>
                      <Button href={cta.href} fullWidth>
                        {cta.label}
                      </Button>
                    </>
                  )}
                </div>
              </nav>
            </PageContainer>
          </div>
        </>
      )}
    </header>
  );
}
