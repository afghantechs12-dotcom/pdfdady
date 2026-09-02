import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { PageContainer } from "@/components/layout/PageContainer";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { ProcessingBadge } from "@/components/tools/ToolCard";
import { iconToneClasses } from "@/styles/tokens";
import { isComingLater } from "@/lib/tools/processingMode";
import type { Tool } from "@/data/tools";

/**
 * The curated tool grid on the homepage.
 *
 * Named "Essential PDF tools", not "Popular": the ordering comes from a
 * hand-written slug list, not usage data, and calling a manual pick "popular"
 * is a fabricated metric (docs/launch-feature-evidence.md, C13).
 *
 * ## One panel, not ten cards
 *
 * The reference groups the grid inside a single large bordered surface with the
 * heading and the actions on its top rail, and that is also the cheaper
 * composition to read: ten separate bordered cards put eleven borders on screen
 * where this puts one. With the panel carrying the structure the tiles inside
 * can be low — 36px icon, name, two clamped lines, badge — instead of the tall
 * catalog card sized for comparing 45 options.
 *
 * Tiles are divided by `gap-px` over a tinted panel background rather than by
 * per-tile borders, so the divider grid stays correct at 2, 3 and 5 columns
 * without any index arithmetic.
 *
 * ## The search control is a link, not an input
 *
 * The reference design puts a search field in this header. A real one here would
 * mean shipping the 45-entry catalog and a filtering client component into the
 * homepage bundle to duplicate what `/tools` already does well — the exact
 * regression lib/seo/publicBundles.test.ts exists to catch (`HeroUpload` once
 * imported the whole catalog to render four links).
 *
 * So this is a link styled as a search field: it looks like the reference, it
 * lands on the catalog's real search, and it costs nothing. It is marked up as a
 * link and reads as one — no `role="search"`, no fake `<input>` that would take
 * a keystroke and discard it.
 *
 * `availableCount` is counted from the merged registry by the caller, so the
 * number in the link cannot drift from the number of tools that work.
 */
export function PopularTools({
  items,
  availableCount,
}: {
  items: Tool[];
  availableCount: number;
}) {
  // `site.popularSlugs` is admin-editable and can name a planned tool. A dense
  // tile has no room to explain "Coming later" the way the catalog card does,
  // and `ToolCard` refuses to link an unrunnable tool for good reason — so this
  // block drops them instead of shipping a tile that leads nowhere.
  const runnable = items.filter((tool) => !isComingLater(tool.status));
  if (runnable.length === 0) return null;

  return (
    <section aria-labelledby="essential-tools" className="section-pad">
      <PageContainer maxWidth="wide">
        <Reveal className="overflow-hidden rounded-panel border border-softborder bg-white shadow-card">
          {/* ── Panel rail ──────────────────────────────────────────────── */}
          <div className="flex flex-col gap-3.5 border-b border-softborder bg-gradient-to-r from-lavender/60 to-white px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7 sm:py-5">
            <div className="min-w-0">
              <h2
                id="essential-tools"
                className="text-[clamp(1.4rem,2.2vw,1.875rem)] font-bold tracking-tight text-navy"
              >
                Essential PDF tools
              </h2>
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-navy-soft">
                Everything for everyday document work — and each one tells you
                where it runs before you pick a file.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2.5">
              <Link
                href="/tools"
                className="inline-flex items-center gap-2 rounded-button border border-softborder bg-white px-3.5 py-2.5 text-sm text-navy-soft transition-colors hover:border-primary/40 hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <Search size={15} aria-hidden="true" />
                Search all tools
              </Link>
              <Link
                href="/tools"
                className="group inline-flex items-center gap-1.5 rounded-button bg-primary px-3.5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
              >
                Explore all {availableCount}
                <ArrowRight
                  size={15}
                  aria-hidden="true"
                  className="transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                />
              </Link>
            </div>
          </div>

          {/* ── Tiles ───────────────────────────────────────────────────── */}
          <ul className="grid grid-cols-2 gap-px bg-softborder sm:grid-cols-3 lg:grid-cols-5">
            {runnable.map((tool) => (
              <li key={tool.slug} className="bg-white">
                <ToolTile tool={tool} />
              </li>
            ))}
          </ul>
        </Reveal>
      </PageContainer>
    </section>
  );
}

/**
 * A low tile.
 *
 * Deliberately not `ToolCard`: ten of those would run this section to a screen
 * and a half. The description is clamped to two lines rather than truncated in
 * the data, so the tool page and the catalog keep the full sentence.
 *
 * The badge is the real `ProcessingBadge`, not a re-implementation — a tile that
 * described processing differently from the catalog card for the same tool is
 * the exact drift `processingCopyForStatus` exists to prevent.
 *
 * ## Why the badge is pushed down rather than placed
 *
 * The tile is a column and the badge row carries `mt-auto`, so it sits on the
 * floor of whichever tile in the row is tallest. Some descriptions clamp to one
 * line and some to two; without this the badges landed on two different
 * baselines within a single row and the grid looked ragged even though the tiles
 * were the same height.
 *
 * Hover raises the tile out of the flush grid — `relative` plus `hover:z-10` so
 * the cast shadow paints over its neighbours instead of being clipped by them.
 */
function ToolTile({ tool }: { tool: Tool }) {
  return (
    <Link
      href={tool.href}
      className="group relative flex h-full items-start gap-3 p-4 transition-[background-color,box-shadow] duration-200 hover:z-10 hover:bg-lavender/50 hover:shadow-[0_2px_6px_rgba(30,27,46,0.05),0_16px_32px_-16px_rgba(76,29,149,0.32)] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 motion-reduce:transition-none sm:p-5"
    >
      <span
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:-translate-y-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0 ${iconToneClasses[tool.iconTone]}`}
      >
        <Icon name={tool.icon} size={17} strokeWidth={2.1} aria-hidden="true" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="block text-sm font-semibold leading-tight text-navy">
          {tool.name}
        </span>
        <span className="mt-1 line-clamp-2 block text-xs leading-snug text-navy-soft">
          {tool.description}
        </span>
        <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
          <ProcessingBadge tool={tool} />
        </span>
      </span>
    </Link>
  );
}
