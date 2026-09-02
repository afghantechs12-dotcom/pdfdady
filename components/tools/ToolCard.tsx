import { memo } from "react";
import Link from "next/link";
import { Cloud, Lock, ShieldCheck } from "lucide-react";
import { Icon } from "@/components/ui/Icon";
import { iconToneClasses } from "@/styles/tokens";
import { cn } from "@/lib/utils/cn";
import {
  isComingLater,
  processingCopyForStatus,
  type ProcessingMode,
} from "@/lib/tools/processingMode";
import type { Tool } from "@/data/tools";

interface ToolCardProps {
  tool: Tool;
  /** Compact variant for dense grids (related tools, sidebars). */
  compact?: boolean;
}

const MODE_ICON: Record<ProcessingMode, typeof ShieldCheck> = {
  browser: ShieldCheck,
  "secure-cloud": Cloud,
  workspace: Lock,
};

/**
 * The processing-mode badge.
 *
 * Replaces three badges that leaked internals or misled: a literal `SERVER`
 * (the internal `functional-server` status, which tells a visitor nothing),
 * `AI SOON` on a fully clickable card, and `PLANNED` likewise. The label now
 * comes from `processingCopyForStatus`, derived from the tool registry, so a
 * card cannot describe processing differently from the tool page it links to.
 *
 * Exported because the homepage's dense tile (`PopularTools`) is a different
 * shape from this card but must not be a different promise: both read the badge
 * from the registry through this one component.
 */
export function ProcessingBadge({ tool }: { tool: Tool }) {
  const copy = processingCopyForStatus(tool.status);
  if (!copy) return null;
  const ModeIcon = MODE_ICON[copy.mode];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
        copy.mode === "browser"
          ? "bg-green-50 text-green-700"
          : "bg-primary-soft text-primary",
      )}
      // The badge is two words of jargon on its own; the tooltip and the
      // screen-reader name carry the actual explanation.
      title={copy.description}
    >
      <ModeIcon size={11} strokeWidth={2.4} aria-hidden="true" />
      <span className="sr-only">Processing: </span>
      {copy.label}
    </span>
  );
}

/**
 * The one tool card used everywhere: homepage grid, /tools index, related
 * tools.
 *
 * Availability and processing location are separate signals and are shown
 * separately. A tool that cannot run does not render as a link at all — the
 * previous version wrapped every card in a `<Link>` regardless of status, so a
 * planned tool looked identical to a working one and led to a stub page. Here
 * an unavailable tool is a plain `<div>`: no hover lift, no pointer cursor, no
 * focus stop, and it is explicitly labelled "Coming later".
 */
export const ToolCard = memo(function ToolCard({ tool, compact }: ToolCardProps) {
  const unavailable = isComingLater(tool.status);

  const body = (
    <>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-2xl",
          compact ? "h-10 w-10" : "h-12 w-12",
          iconToneClasses[tool.iconTone],
          unavailable && "opacity-60 grayscale",
        )}
      >
        <Icon
          name={tool.icon}
          size={compact ? 18 : 22}
          strokeWidth={2.1}
          aria-hidden="true"
        />
      </span>
      <div className="flex-1">
        <h3
          className={cn(
            "font-semibold",
            compact ? "text-sm" : "text-sm",
            unavailable ? "text-navy-soft" : "text-navy",
          )}
        >
          {tool.name}
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-navy-soft">
          {tool.description}
        </p>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        {unavailable ? (
          <span className="inline-flex items-center rounded-full bg-lavender px-2 py-0.5 text-[10px] font-semibold text-navy-soft">
            Coming later
          </span>
        ) : (
          <ProcessingBadge tool={tool} />
        )}
        {!unavailable && tool.multiple && (
          <span className="inline-flex items-center rounded-full bg-lavender px-2 py-0.5 text-[10px] font-semibold text-navy-soft">
            Batch
          </span>
        )}
      </div>
    </>
  );

  const shared = cn(
    "group relative flex h-full flex-col items-start gap-3 rounded-card border p-5",
    compact && "p-4",
  );

  if (unavailable) {
    return (
      <div
        className={cn(shared, "border-dashed border-softborder bg-lavender/25")}
      >
        {body}
        {tool.plannedReason && (
          <p className="text-[11px] leading-relaxed text-navy-soft/80">
            {tool.plannedReason}
          </p>
        )}
      </div>
    );
  }

  return (
    <Link
      href={tool.href}
      className={cn(
        shared,
        "border-softborder bg-white shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-cardhover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
      )}
    >
      {body}
    </Link>
  );
});
