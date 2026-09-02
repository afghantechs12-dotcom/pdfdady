"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Search, SlidersHorizontal, X, ChevronDown } from "lucide-react";
import { ToolCard } from "./ToolCard";
import { buildCatalog, type ModeFilter } from "./catalogLogic";
import { PROCESSING_MODE_COPY } from "@/lib/tools/processingMode";
import { cn } from "@/lib/utils/cn";
import type { Tool, ToolCategory } from "@/data/tools";

const MODE_FILTERS: { id: ModeFilter; label: string }[] = [
  { id: "all", label: "Any" },
  { id: "browser", label: PROCESSING_MODE_COPY.browser.label },
  { id: "secure-cloud", label: PROCESSING_MODE_COPY["secure-cloud"].label },
];

/**
 * The /tools catalog.
 *
 * Rebuilt from a flat grid of 45 cards with category chips. The problems it
 * fixes, in order of how much they cost a visitor:
 *
 *  - **No way to find a tool by name.** 45 cards and no search. There is now a
 *    search box, focusable from anywhere with `/`.
 *  - **Planned and AI tools sat in the same grids as working ones**, so a third
 *    of what looked available was not. Available tools come first, grouped by
 *    category; everything else is in one clearly labelled section at the end.
 *  - **No sense of place while scrolling.** Category navigation is now sticky
 *    on desktop and reflects which group you are in.
 *
 * All filtering is `useMemo` over props — no fetching, no effects driving data.
 * The tool list is rendered server-side into the initial HTML; this component
 * only narrows it.
 */
export function ToolsCatalog({
  tools,
  categories,
}: {
  tools: Tool[];
  categories: { id: string; label: string; tabLabel: string }[];
}) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<ToolCategory | "all">("all");
  const [mode, setMode] = useState<ModeFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Typing stays responsive on the 45-card grid: the input updates immediately,
  // the (heavier) grid re-renders from the deferred value.
  const deferredSearch = useDeferredValue(search);

  const catalog = useMemo(
    () => buildCatalog(tools, categories, { search: deferredSearch, category, mode }),
    [tools, categories, deferredSearch, category, mode],
  );

  // "/" focuses search, the convention on tool directories. Ignored while the
  // user is typing somewhere else, so it never eats a literal slash.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      searchRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtersActive = category !== "all" || mode !== "all" || search !== "";

  function clearAll() {
    setSearch("");
    setCategory("all");
    setMode("all");
    searchRef.current?.focus();
  }

  return (
    <div className="mt-10">
      {/* Search + filter controls */}
      <div className="rounded-card border border-softborder bg-white p-4 shadow-card sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1">
            <Search
              size={18}
              aria-hidden="true"
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-navy-soft"
            />
            <input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tools — try “compress” or “pdf to word”"
              aria-label="Search tools"
              aria-describedby="tools-result-count"
              className="h-12 w-full rounded-button border border-softborder bg-white pl-11 pr-11 text-sm text-navy placeholder:text-navy-soft/70 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
            {search && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-navy-soft hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Mobile: reveal the category list as a disclosure rather than a
              horizontal chip scroller that hides most of its options. */}
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            aria-controls="tool-filters"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-button border border-softborder px-4 text-sm font-semibold text-navy hover:bg-lavender focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden"
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
            Filters
            {filtersActive && (
              <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-white">
                on
              </span>
            )}
          </button>
        </div>

        <div
          id="tool-filters"
          className={cn("mt-4 flex-col gap-4", filtersOpen ? "flex" : "hidden lg:flex")}
        >
          <FilterRow
            label="Category"
            options={[
              { id: "all", label: "All" },
              ...categories.map((c) => ({ id: c.id, label: c.tabLabel })),
            ]}
            value={category}
            onChange={(v) => setCategory(v as ToolCategory | "all")}
          />
          <FilterRow
            label="Runs on"
            options={MODE_FILTERS.map((m) => ({ id: m.id, label: m.label }))}
            value={mode}
            onChange={(v) => setMode(v as ModeFilter)}
          />
        </div>
      </div>

      {/* Result count — a live region so filtering is announced, not silent. */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <p
          id="tools-result-count"
          role="status"
          aria-live="polite"
          className="text-sm text-navy-soft"
        >
          {catalog.availableCount === 0
            ? "No tools match these filters"
            : `${catalog.availableCount} tool${catalog.availableCount === 1 ? "" : "s"} you can use now`}
        </p>
        {filtersActive && (
          <button
            type="button"
            onClick={clearAll}
            className="text-sm font-semibold text-primary underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="mt-8 lg:grid lg:grid-cols-[200px_1fr] lg:gap-10">
        {/* Sticky in-page navigation, desktop only. */}
        <nav
          aria-label="Tool categories"
          // `z-sticky` is the layer this rail was the named consumer of:
          // `styles/tokens.ts` documents `sticky: 30` as "sticky section
          // sub-navigation (tools category rail)" and the rail shipped at
          // `z-auto`, so the one element the token names could be painted over
          // by any later sibling that gains a stacking context.
          className="hidden lg:sticky lg:top-24 lg:z-sticky lg:block lg:self-start"
        >
          <p className="text-xs font-semibold uppercase tracking-wider text-navy-soft">
            Jump to
          </p>
          <ul className="mt-3 flex flex-col gap-1">
            {catalog.availableGroups.map((group) => (
              <li key={group.id}>
                <a
                  href={`#cat-${group.id}`}
                  className="block rounded-button px-3 py-2 text-sm font-medium text-navy-soft transition-colors hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  {group.label}
                  <span className="ml-1.5 text-xs text-navy-soft/70">
                    {group.tools.length}
                  </span>
                </a>
              </li>
            ))}
            {catalog.comingLater.length > 0 && (
              <li>
                <a
                  href="#coming-later"
                  className="block rounded-button px-3 py-2 text-sm font-medium text-navy-soft transition-colors hover:bg-lavender hover:text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  Coming later
                  <span className="ml-1.5 text-xs text-navy-soft/70">
                    {catalog.comingLater.length}
                  </span>
                </a>
              </li>
            )}
          </ul>
        </nav>

        <div className="min-w-0">
          {catalog.isEmpty ? (
            <div className="rounded-card border border-dashed border-softborder bg-lavender/30 px-6 py-14 text-center">
              <p className="text-base font-semibold text-navy">
                Nothing matches “{search}”
              </p>
              <p className="mt-2 text-sm text-navy-soft">
                Try a shorter word, or clear the filters to see everything.
              </p>
              <button
                type="button"
                onClick={clearAll}
                className="mt-5 inline-flex h-11 items-center justify-center rounded-button bg-primary px-5 text-sm font-semibold text-white hover:bg-primary-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="space-y-12">
              {catalog.availableGroups.map((group) => (
                <section
                  key={group.id}
                  aria-labelledby={`cat-${group.id}-heading`}
                  className="scroll-mt-24"
                  id={`cat-${group.id}`}
                >
                  <h2
                    id={`cat-${group.id}-heading`}
                    className="text-xl font-bold text-navy"
                  >
                    {group.label}
                  </h2>
                  <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                    {group.tools.map((tool) => (
                      <ToolCard key={tool.slug} tool={tool} />
                    ))}
                  </div>
                </section>
              ))}

              {catalog.comingLater.length > 0 && (
                <ComingLaterSection
                  tools={catalog.comingLater}
                  /* A search that matched a planned tool should show it, not
                     hide it behind a disclosure the user has to find. */
                  forceOpen={filtersActive}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The planned-tools section, collapsed by default.
 *
 * There are 13 of these. Rendered open, they were 13 grey cards — more visual
 * weight than any single category of tools that actually work, at the bottom of
 * the page, advertising nothing the user can do. Collapsed, the page ends on
 * working tools and the roadmap is one click away. (Launch polish P2-16.)
 *
 * Honesty constraints this keeps:
 *
 *  - The count is stated up front, from the real list. No "and more".
 *  - Collapsed content is genuinely removed from the DOM, so the cards are not
 *    tab stops a keyboard user lands on inside a closed section, and they are
 *    not text a crawler reads as page content the visitor cannot see.
 *  - `ToolCard` still renders each planned tool as a non-link, so expanding
 *    reveals a roadmap, not a set of dead doorways.
 *
 * A native `<details>`/`<summary>` would give this for free, but its open state
 * cannot be driven from React when a search needs to force it open, so this is
 * a button with `aria-expanded` — the same semantics, under our control.
 */
function ComingLaterSection({
  tools,
  forceOpen,
}: {
  tools: Tool[];
  forceOpen: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || forceOpen;

  return (
    <section
      id="coming-later"
      aria-labelledby="coming-later-heading"
      className="scroll-mt-24 border-t border-softborder pt-10"
    >
      <h2 id="coming-later-heading" className="text-xl font-bold text-navy">
        Coming later
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-navy-soft">
        {tools.length} planned {tools.length === 1 ? "tool" : "tools"}. Not built
        yet — these are here so you can see what is planned, not so you can try
        it.
      </p>

      {/* Hidden while a filter forces the section open: the control would claim
          to collapse something that would immediately reopen. */}
      {!forceOpen && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={expanded}
          aria-controls="coming-later-grid"
          className="mt-4 inline-flex h-11 items-center gap-2 rounded-button border border-softborder bg-white px-5 text-sm font-semibold text-navy transition-colors hover:border-primary hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={cn("transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Hide planned tools" : "Show planned tools"}
        </button>
      )}

      {expanded && (
        <div
          id="coming-later-grid"
          className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {tools.map((tool) => (
            <ToolCard key={tool.slug} tool={tool} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * A row of mutually exclusive filter chips.
 *
 * `radiogroup` rather than a row of toggle buttons: only one value can be
 * active, and `aria-pressed` on four buttons would let a screen-reader user
 * believe they could select several.
 */
function FilterRow({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <span className="w-20 shrink-0 text-xs font-semibold uppercase tracking-wider text-navy-soft">
        {label}
      </span>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.id)}
              className={cn(
                "min-h-[36px] rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none",
                active
                  ? "bg-primary text-white"
                  : "border border-softborder bg-white text-navy-soft hover:bg-lavender hover:text-navy",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
