"use client";

import Link from "next/link";
import { Archive, Clock, Star, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { QUICK_ACCESS_CARDS, formatCount, itemCountLabel, workspaceHref } from "@/components/app/appShellLogic";

const ICONS: Record<string, LucideIcon> = {
  recent: Clock,
  favorites: Star,
  archived: Archive,
  trash: Trash2,
};

const ACCENTS: Record<string, string> = {
  recent: "bg-sky-50 text-sky-600",
  favorites: "bg-amber-50 text-amber-600",
  archived: "bg-slate-100 text-slate-600",
  trash: "bg-rose-50 text-rose-600",
};

export interface QuickAccessProps {
  workspaceId: string;
  organizationId: string;
  /**
   * Real counts by view id. A view absent from this map renders without a
   * count rather than as zero — see `formatCount`.
   */
  counts: Record<string, number | undefined>;
}

/**
 * The Quick Access row: one compact card per document view.
 *
 * Each card is a link to a view that exists in the document manager, so none of
 * these is decorative. Counts appear only where the page could establish a real
 * one; the rest show the label alone.
 */
export function QuickAccess({ workspaceId, organizationId, counts }: QuickAccessProps) {
  return (
    <section aria-labelledby="quick-access-heading">
      <h2 id="quick-access-heading" className="sr-only">
        Quick access
      </h2>
      <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {QUICK_ACCESS_CARDS.map((card) => {
          const Icon = ICONS[card.icon] ?? Clock;
          const count = formatCount(counts[card.view]);
          const countLabel = itemCountLabel(counts[card.view]);
          return (
            <li key={card.id}>
              <Link
                href={workspaceHref(workspaceId, organizationId, { view: card.view })}
                aria-label={countLabel ? `${card.label}, ${countLabel}` : card.label}
                className="group flex items-center gap-2.5 rounded-appcard border border-app-border bg-app-surface p-2.5 shadow-appcard transition-all hover:border-primary/30 hover:shadow-appcardhover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-control",
                    ACCENTS[card.icon] ?? "bg-lavender text-primary",
                  )}
                >
                  <Icon size={17} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-app-text">{card.label}</span>
                  {count !== null && (
                    <span className="block text-[11px] text-app-muted">
                      {count} {counts[card.view] === 1 ? "file" : "files"}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
