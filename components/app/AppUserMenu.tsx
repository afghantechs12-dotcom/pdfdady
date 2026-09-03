"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LogOut, Settings, User as UserIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";

export interface AppUserMenuProps {
  name: string | null;
  email: string;
  /** Workspace settings destination, when the actor may reach it. */
  settingsHref?: string | null;
  tone?: "dark" | "light";
}

/** Initials for the avatar, from the display name or the email local part. */
function initialsFor(name: string | null, email: string): string {
  const source = (name ?? email.split("@")[0] ?? "").trim();
  if (!source) return "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/**
 * The account menu at the foot of the authenticated sidebar.
 *
 * Sign out posts to `/api/auth/logout`. That endpoint is POST-only and
 * same-origin checked on purpose — a GET logout can be triggered by any
 * third-party `<img src>`, so this must never become a link. On success the
 * router is refreshed as well as pushed, otherwise the server components for
 * the signed-in view stay in the client cache after the session is gone.
 */
export function AppUserMenu({ name, email, settingsHref = null, tone = "dark" }: AppUserMenuProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const dark = tone === "dark";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Sign out failed.");
      setOpen(false);
      router.push("/login");
      router.refresh();
    } catch {
      // Surfaced in place: a blocking dialog would steal focus and cannot be
      // read back in context.
      setError("Could not sign out. Please try again.");
      setPending(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      {open && (
        <div
          role="menu"
          aria-label="Account"
          className={cn(
            "absolute bottom-[calc(100%+6px)] left-0 right-0 z-40 overflow-hidden rounded-controllg border py-1 shadow-appmenu",
            dark ? "border-white/10 bg-app-sidebarmenu" : "border-app-border bg-white",
          )}
        >
          {settingsHref && (
            <Link
              href={settingsHref}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-2 px-3 py-2 text-sm transition-colors",
                dark ? "text-slate-200 hover:bg-white/10" : "text-app-text hover:bg-lavender",
              )}
            >
              <Settings size={14} aria-hidden="true" />
              Workspace settings
            </Link>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={pending}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-60",
              dark ? "text-slate-200 hover:bg-white/10" : "text-app-text hover:bg-lavender",
            )}
          >
            <LogOut size={14} aria-hidden="true" />
            {pending ? "Signing out…" : "Sign out"}
          </button>
          {error && (
            <p role="alert" className="px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-controllg px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2",
          dark
            ? "text-white hover:bg-white/[0.08] focus-visible:ring-primary/70"
            : "text-app-text hover:bg-lavender focus-visible:ring-primary/40",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-bold",
            dark ? "bg-white/10 text-white" : "bg-primary-soft text-primary",
          )}
        >
          {initialsFor(name, email)}
        </span>
        {/*
          `data-user-identity` marks the two lines that are per-account rather than
          per-design: a visual-regression run signs up a throwaway user, so without a
          hook to mask this chip every authenticated reference diffs on the email and
          a probe reports a product failure. It is a marker only — no behaviour,
          no styling, and nothing reads it at runtime.
        */}
        <span className="min-w-0 flex-1" data-user-identity>
          <span className={cn("block truncate text-sm font-semibold", dark ? "text-white" : "text-app-text")}>
            {name ?? email.split("@")[0]}
          </span>
          <span className={cn("block truncate text-[11px]", dark ? "text-app-sidebartext" : "text-app-muted")}>
            {email}
          </span>
        </span>
        <UserIcon
          size={14}
          aria-hidden="true"
          className={cn("shrink-0", dark ? "text-app-sidebartext" : "text-app-muted")}
        />
      </button>
    </div>
  );
}
