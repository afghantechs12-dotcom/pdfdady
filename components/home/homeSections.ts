import type { IconTone } from "@/styles/tokens";
import { isFunctional, type Tool } from "@/data/tools";
import {
  getAiComingSoonCount,
  getAvailableToolCount,
  getBrowserToolCount,
} from "@/lib/tools/capability";
import type { HeroStat } from "./Hero";

/**
 * Pure derivations behind the homepage.
 *
 * They live outside the components for the reason the rest of this codebase
 * does it: a test that reads rendered JSX breaks on restyling, while these are
 * plain functions over the tool registry. The registry is admin-mergeable at
 * runtime, so every one of these must cope with a slug that no longer resolves
 * or a tool that stopped being runnable.
 *
 * Nothing here invents a number. The hero's figures are counted from the
 * registry precisely so that adding or removing a tool moves them, and so the
 * homepage cannot end up claiming a total that stopped being true.
 */

/** A tool as rendered in the shortcut strip below the hero. */
export interface ShortcutTool {
  slug: string;
  name: string;
  href: string;
  icon: string;
  iconTone: IconTone;
  /** Short verb phrase under the name. */
  tagline: string;
}

/**
 * The six entry points in the strip, in display order.
 *
 * Taglines are written here rather than reusing `tool.description`, which is a
 * full sentence sized for a catalog card and wraps to four lines in a 1/6-width
 * tile. The slugs mirror the reference design's strip.
 */
const SHORTCUT_SPECS: { slug: string; tagline: string }[] = [
  // "Text & images" was false of this route: /tools/edit-pdf renders the page
  // operations tool, not the standalone editor. See data/tools.ts.
  { slug: "edit-pdf", tagline: "Rotate & reorder" },
  { slug: "pdf-to-word", tagline: "To Word, Excel & more" },
  { slug: "merge-pdf", tagline: "Combine files" },
  { slug: "compress-pdf", tagline: "Reduce file size" },
  { slug: "sign-pdf", tagline: "Add signature" },
  { slug: "organize-pdf", tagline: "Rearrange pages" },
];

/**
 * Resolves the shortcut strip against the live registry.
 *
 * Unrunnable and unknown tools are dropped rather than rendered: `ToolCard`
 * already refuses to link a tool that cannot run, and a shortcut strip that
 * happily linked one would undo that.
 */
export function pickShortcutTools(tools: Tool[]): ShortcutTool[] {
  const bySlug = new Map(tools.map((t) => [t.slug, t]));

  return SHORTCUT_SPECS.flatMap(({ slug, tagline }) => {
    const tool = bySlug.get(slug);
    if (!tool || !isFunctional(tool)) return [];
    return [
      {
        slug: tool.slug,
        name: tool.name,
        href: tool.href,
        icon: tool.icon,
        iconTone: tool.iconTone,
        tagline,
      },
    ];
  });
}

/**
 * The figures shown in the hero, in place of the reference's star rating.
 *
 * Each is checkable against the registry:
 *
 *  - how many tools a visitor can actually run today,
 *  - how many of those never send the file anywhere (`functional-client`),
 *  - the account requirement, which is a property of those browser tools.
 *
 * The third is a fact rather than a count, but it occupies the same slot and is
 * the single most load-bearing thing a first-time visitor wants to know.
 *
 * The labels are lower-case fragments because the hero now sets them inline
 * after their value — "32 tools ready • 18 run in your browser • $0 today" —
 * rather than as three stacked blocks. They read as one sentence per item in
 * that position, and still as a term/value pair to a screen reader.
 */
export function heroStats(tools: Tool[]): HeroStat[] {
  return [
    { value: String(getAvailableToolCount(tools)), label: "tools ready" },
    { value: String(getBrowserToolCount(tools)), label: "run in your browser" },
    { value: "$0", label: "today" },
  ];
}

/** The three fields the hero's client-side tool picker actually renders. */
export interface HeroQuickTool {
  slug: string;
  name: string;
  href: string;
}

/** Slugs offered in the hero upload's "continue to" picker, in display order. */
const HERO_QUICK_SLUGS = ["merge-pdf", "split-pdf", "edit-pdf", "jpg-to-pdf"];

/**
 * The hero picker's tools, narrowed to what crosses into the client bundle.
 *
 * Passing whole `Tool` objects would serialize every icon name, MIME list and
 * description into the RSC payload for three fields' worth of use. Unrunnable
 * and unknown slugs are dropped: the picker's whole purpose is to carry the
 * chosen file into a tool, and a tool that cannot run cannot receive it.
 */
export function heroQuickTools(tools: Tool[]): HeroQuickTool[] {
  const bySlug = new Map(tools.map((t) => [t.slug, t]));

  return HERO_QUICK_SLUGS.flatMap((slug) => {
    const tool = bySlug.get(slug);
    if (!tool || !isFunctional(tool)) return [];
    return [{ slug: tool.slug, name: tool.name, href: tool.href }];
  });
}

/**
 * How many tools a visitor can run today.
 *
 * Used in the tool panel's header and the header's menu footer. Counted, never
 * written into copy: an admin who adds or removes a tool must not leave the page
 * claiming the old number.
 */
export function availableToolCount(tools: Tool[]): number {
  return getAvailableToolCount(tools);
}

/**
 * How many AI tools are planned.
 *
 * `coming-soon-ai` only — `planned` covers non-AI work and folding the two
 * together would overstate what the AI preview is previewing.
 */
export function aiToolCount(tools: Tool[]): number {
  return getAiComingSoonCount(tools);
}
