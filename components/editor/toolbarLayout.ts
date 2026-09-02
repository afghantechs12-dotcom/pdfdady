import type { EditorTool } from "@/components/editor/editorTypes";
import { ALL_EDITOR_TOOLS } from "@/components/editor/editorTypes";
import type { EditorObject } from "@/src/domain/editor/objects";
import { resolveCropEligibility } from "@/src/application/editor/tools/cropEligibility";

/**
 * The canonical toolbar layout for the editor (M6.7). PURE — no React, no DOM.
 *
 * This module is the single source of truth for tool metadata: groups and
 * ordering, human labels, accessible names, icon identifiers, shortcut display
 * text, availability rules, and responsive visibility. The toolbar component
 * (`EditorToolbar`), the shortcut manager (`useShortcuts`), and the status bar
 * (`statusBarLogic`) all derive from these tables, so a tool is defined exactly
 * once.
 *
 * Responsive model: every tool has a `priority`. `compact` (mobile) shows
 * priority 1, `tablet` shows priorities 1–2, `desktop` shows everything;
 * whatever a mode hides moves into the overflow menu (grouped, same order).
 */

/** Layout modes the toolbar renders in. */
export type ToolbarMode = "desktop" | "tablet" | "compact";

/** Availability requirements a tool can declare (beyond "always"). */
export type ToolRequirement = "image-selection";

/** One tool's canonical metadata. */
export interface ToolbarTool {
  id: EditorTool;
  /** Short visible label ("Rectangle"). */
  label: string;
  /** Full accessible name announced to screen readers. */
  ariaLabel: string;
  /**
   * Icon identifier. The React toolbar maps these to icon components; keeping
   * a string id here keeps this module renderer-agnostic.
   */
  icon: string;
  /** Shortcut display text ("V"), or null when the tool has no key. */
  shortcut: string | null;
  /** Availability rule; undefined = always available. */
  requires?: ToolRequirement;
  /** Responsive visibility: 1 = always shown, 2 = tablet+, 3 = desktop only. */
  priority: 1 | 2 | 3;
  /**
   * Verb-first label for the premium labelled row ("Add Text" vs "Text").
   *
   * The bare `label` is a NOUN because the status bar reads it as the current
   * mode ("Text") and the overflow menu lists modes. The labelled toolbar reads
   * as a command surface, where the reference design's "Add Text" tells a
   * non-expert what the button will do. Only tools that create something carry
   * one; falls back to `label` where the verb form would be noise ("Select").
   */
  actionLabel?: string;
}

/** A titled group of tools (rendered with separators between groups). */
export interface ToolbarGroup {
  id: string;
  label: string;
  tools: ToolbarTool[];
  /**
   * How the labelled ("desktop") row presents this group.
   *
   * `flat` renders one labelled button per tool — right for the small set of
   * high-frequency commands the reference design shows across its top row.
   * `cluster` renders ONE labelled trigger that opens the group as a menu, with
   * the group's active tool reflected on the trigger. Shapes (11 tools) and
   * Draw (4) exist to be clustered: eleven labelled shape buttons is precisely
   * the icon-soup the redesign is meant to remove, and 11 × ~104px of labelled
   * button is what forced the labelled row past 1900px of container in the
   * first place.
   */
  presentation: "flat" | "cluster";
  /** Trigger label + icon for `cluster` groups (ignored for `flat`). */
  clusterLabel?: string;
  clusterIcon?: string;
}

const tool = (
  id: EditorTool,
  label: string,
  ariaLabel: string,
  icon: string,
  shortcut: string | null,
  priority: 1 | 2 | 3,
  requires?: ToolRequirement,
  actionLabel?: string,
): ToolbarTool => ({
  id,
  label,
  ariaLabel,
  icon,
  shortcut,
  priority,
  ...(requires ? { requires } : {}),
  ...(actionLabel ? { actionLabel } : {}),
});

/**
 * The toolbar's groups in render order. Shortcut letters must be unique across
 * the whole table (enforced by tests). NOTE (M6 shortcut remap): "H" moved
 * from Highlight to the new Hand tool (the professional convention);
 * Highlight is now "G".
 */
export const TOOLBAR_GROUPS: readonly ToolbarGroup[] = [
  {
    id: "navigate",
    label: "Navigation",
    presentation: "flat",
    tools: [
      tool("select", "Select", "Select tool", "select", "V", 1),
      tool("hand", "Hand", "Hand tool (pan the page)", "hand", "H", 1),
    ],
  },
  {
    id: "insert",
    label: "Insert",
    presentation: "flat",
    tools: [
      tool("text", "Text", "Text tool", "text", "T", 1, undefined, "Add Text"),
      tool("image", "Image", "Image tool", "image", "I", 1, undefined, "Add Image"),
      tool("signature", "Signature", "Signature tool", "signature", "S", 2, undefined, "Sign"),
      tool("annotation", "Note", "Note (annotation) tool", "annotation", "N", 2, undefined, "Comment"),
    ],
  },
  {
    id: "shapes",
    label: "Shapes",
    presentation: "cluster",
    clusterLabel: "Add Shape",
    clusterIcon: "rect",
    tools: [
      tool("rect", "Rectangle", "Rectangle shape tool", "rect", "R", 1),
      tool("roundedRect", "Rounded rectangle", "Rounded rectangle shape tool", "roundedRect", null, 3),
      tool("ellipse", "Ellipse", "Ellipse shape tool", "ellipse", "O", 1),
      tool("circle", "Circle", "Circle shape tool", "circle", null, 3),
      tool("triangle", "Triangle", "Triangle shape tool", "triangle", null, 3),
      tool("line", "Line", "Line shape tool", "line", "L", 2),
      tool("arrow", "Arrow", "Arrow shape tool", "arrow", null, 2),
      tool("polygon", "Polygon", "Polygon shape tool", "polygon", null, 3),
      tool("star", "Star", "Star shape tool", "star", null, 3),
      tool("speechBubble", "Speech bubble", "Speech bubble shape tool", "speechBubble", null, 3),
      tool("connector", "Connector", "Connector shape tool", "connector", null, 3),
    ],
  },
  {
    id: "markup",
    label: "Markup",
    presentation: "flat",
    tools: [
      tool("highlight", "Highlight", "Highlight tool", "highlight", "G", 2),
    ],
  },
  {
    id: "draw",
    label: "Draw",
    presentation: "cluster",
    clusterLabel: "Draw",
    clusterIcon: "draw",
    tools: [
      tool("draw", "Draw", "Freehand drawing tool", "draw", "D", 1),
      tool("eraser", "Eraser", "Eraser tool", "eraser", "E", 1),
      tool("path", "Pen", "Pen (Bézier path) tool", "path", "P", 2),
    ],
  },
  {
    id: "modify",
    label: "Modify",
    presentation: "flat",
    tools: [
      tool("crop", "Crop", "Crop image tool", "crop", "C", 2, "image-selection"),
    ],
  },
];

/** Flat list of every toolbar tool, in group/render order. */
export const ALL_TOOLBAR_TOOLS: readonly ToolbarTool[] = TOOLBAR_GROUPS.flatMap((g) => g.tools);

const TOOL_BY_ID = new Map<EditorTool, ToolbarTool>(ALL_TOOLBAR_TOOLS.map((t) => [t.id, t]));

/** A tool's metadata by id, or null for an unknown id. */
export function toolDefinition(id: string): ToolbarTool | null {
  return TOOL_BY_ID.get(id as EditorTool) ?? null;
}

/** Resolves an untrusted candidate to a valid active tool ("select" fallback). */
export function resolveActiveTool(candidate: string): EditorTool {
  return TOOL_BY_ID.has(candidate as EditorTool) ? (candidate as EditorTool) : "select";
}

/** The selection context availability rules are evaluated against. */
export interface ToolAvailabilityContext {
  /** Full selected objects are required for transform/dimension-safe crop gating. */
  selectedObjects?: readonly EditorObject[];
  /** Legacy pure-test context retained for selection-count/kind checks. */
  selectedKinds: string[];
  anyLocked?: boolean;
}

/** An availability verdict, with a human reason when unavailable. */
export interface ToolAvailability {
  available: boolean;
  /** Why the tool is disabled (shown as the tooltip); undefined when available. */
  reason?: string;
}

/**
 * Evaluates a tool's availability rule against the current selection. This is
 * the SINGLE crop-eligibility predicate — the toolbar, the shortcut manager,
 * and the context menu all consult it, so a locked image disables crop
 * everywhere consistently (the canvas's own guard mirrors it defensively).
 */
export function toolAvailability(id: EditorTool, ctx: ToolAvailabilityContext): ToolAvailability {
  const def = TOOL_BY_ID.get(id);
  if (!def) return { available: false, reason: "Unknown tool" };
  if (def.requires === "image-selection") {
    if (ctx.selectedObjects) {
      const { available, reason } = resolveCropEligibility(ctx.selectedObjects);
      return available ? { available: true } : { available: false, reason };
    }
    if (!(ctx.selectedKinds.length === 1 && ctx.selectedKinds[0] === "image")) {
      return { available: false, reason: "Select one image to crop" };
    }
    if (ctx.anyLocked) return { available: false, reason: "Unlock the image to crop" };
    return { available: true };
  }
  return { available: true };
}

/**
 * Resolves a raw keydown into a tool switch (M6.13), or null when the key is
 * not an available bare tool letter. Pure — `useShortcuts` dispatches through
 * this, so the gating rules (no modifiers, not while typing, availability)
 * are Node-testable without a DOM.
 */
export function resolveToolKey(
  key: string,
  ctx: { editing: boolean; ctrl: boolean; alt: boolean; shift: boolean } & ToolAvailabilityContext,
): EditorTool | null {
  if (ctx.editing || ctx.ctrl || ctx.alt || ctx.shift) return null;
  const tool = toolShortcutKeys()[key.toLowerCase()];
  if (!tool) return null;
  return toolAvailability(tool, ctx).available ? tool : null;
}

const MODE_MAX_PRIORITY: Record<ToolbarMode, number> = {
  compact: 1,
  tablet: 2,
  desktop: 3,
};

/**
 * Container widths (px) below which the toolbar drops to a smaller mode.
 *
 * Measured against the rendered toolbar rather than chosen for roundness.
 *
 * REVISED (premium labelled row). The previous 1900px desktop threshold was
 * measured against a row that rendered a labelled button for EVERY tool — 22 of
 * them, ~1380px of tools alone — so the labelled presentation only fitted on a
 * >=1900px container. In practice that meant the redesign's defining feature was
 * invisible at 1366px and 1440px, the two commonest laptop widths and the scale
 * of the reference design itself: measuring the real editor at 1440×900 found
 * 16 buttons, ZERO of them labelled.
 *
 * The fix is compositional, not a threshold fudge. `cluster` groups collapse the
 * 11 shape tools and the 3 draw tools into 2 labelled triggers, and the zoom
 * stepper/preset select moved out of the toolbar into the bottom capsule (where
 * the reference puts it, and where it no longer competes with Export for the
 * pinned right edge). The labelled row is now:
 *
 *   Select · Add Text · Add Image · Sign · Comment · Add Shape ▾ · Highlight ·
 *   Draw ▾ · Crop · ⧉ · More ▾             ⟨undo/redo⟩ ⟨Export⟩
 *
 * (⧉ = the Organize Pages toggle, icon-only in every mode — see below and the
 * comment on the button itself in `EditorToolbar`. The diagram used to read
 * "Pages ▾" here, which was wrong twice over: it is not a menu, and its label is
 * what made this row overflow at 1366px.)
 *
 * These numbers are measured from the REAL rendered editor via
 * `scripts/editor-audit.mjs`, not estimated. The toolbar root spans the full
 * frame width (it sits above the side rails), so its container width equals the
 * viewport width, and the scrollable tool row gets:
 *
 *   toolRow = container − 257px   (the pinned undo/redo/open/Export cluster)
 *   toolRow = container − 202px   in compact, where that cluster is smaller
 *
 * Measured row widths and the container each therefore needs:
 *
 *   desktop  9 labelled buttons + 2 clusters ≈ 1030px row → needs ≈ 1287px
 *   tablet   13 inline tools (icons)            761px row → needs ≈ 1018px
 *   compact   8 inline tools (icons)            407px row → needs ≈  609px
 *
 * CORRECTION (premium visual pass, measured in Chrome at 1045/1100/1180px). The
 * three row widths above are the TOOLS only. The scroller they sit in also holds
 * Organize Pages and More — 44px each plus a 13px divider, so 114px that the
 * arithmetic never counted. The real tablet requirement was 875px of content, not
 * 761px, i.e. a ~1160px container rather than the ~1018px claimed, and the flat
 * tablet row therefore overflowed everywhere below ~1160px. It did not overflow
 * VISIBLY: the row shrank below its content instead (`min-w-0` on a flex item
 * whose own overflow is `visible`), so the scroller saw no overflow to scroll and
 * Organize Pages was laid out on top of Crop. Both halves are fixed —
 * `EditorToolbar`'s row is now `shrink-0`, and `groupPresentation` clusters at
 * tablet too, which brings that row to 647px — so this constant does not move.
 * It is kept at the measured tablet fit, and 1024px still resolves to COMPACT.
 *
 * The lesson generalises: measure the SCROLLER's content, not the group of
 * buttons you were thinking about.
 *
 * `TOOLBAR_TABLET_MAX_WIDTH` is the width where the LABELLED row fits with the
 * pinned action cluster beside it, which is what puts labels on screen at 1366
 * and 1440.
 *
 * It was 1290, derived from the same arithmetic the CORRECTION above disowns, and
 * it was wrong in the same way: the labelled scroller's real content is 1162px,
 * not the ≈1030px of tool buttons, once Organize Pages (139.8px WITH its label)
 * and More are counted. Measured in Chrome, the labelled row overflowed its
 * scroller from 1290px up to ≈1440px — so at 1366px, a flagship width for this
 * redesign, "Organize Pages" was clipped 63px mid-word and reachable only by
 * scrolling the toolbar sideways. A clipped label is worse than no label, and the
 * P4 remedy that forbids silent ellipsis on primary navigation offers the other
 * branch: icon + tooltip.
 *
 * So Organize Pages became icon-only in every mode (38px, saving 101.8px), which
 * brings the labelled scroller's content to 1060.3px, and this constant was
 * re-measured against that rather than re-derived:
 *
 *   scroller float width = container − 267.3px   (the pinned cluster + gaps)
 *   1324 → 1056.7  over by 3.6      1327 → 1059.7  over by 0.6
 *   1325 → 1057.7  over by 2.6      1328 → 1060.7  FITS
 *   1326 → 1058.7  over by 1.6      1330 → 1062.7  fits
 *
 * 1328 is the first width that fits on float geometry, and `resolveToolbarMode`
 * uses a strict `<`, so the constant IS 1328. 1326 and 1327 are the integer-vs-
 * float straddle described below for the compact boundary — `clientWidth` says
 * "fits", `getBoundingClientRect` says 0.6px short — and they resolve to tablet,
 * where the row is 647px of content with room to spare. 1366 and 1440 stay
 * desktop, which was the whole point of the labelled row.
 *
 * `TOOLBAR_COMPACT_MAX_WIDTH` is 1045 and NOT a rounder, smaller number, because
 * the tablet row genuinely needs a container that wide. The original constant was
 * 1020, measured when the row's controls were 36px/44px with tighter padding and
 * documented as fitting 1024px "with 6px to spare".
 *
 * P1 Phase C3 raised the labelled controls to a 38px minimum and widened the
 * Export button's padding, and re-measuring in the real browser showed that 6px
 * of slack is now gone: at a 1024px viewport the tablet icon row overflowed its
 * scroller (`scrollWidth > clientWidth`), while 1040px fitted. Overflow there is
 * not catastrophic — the row scrolls rather than clipping, by design — but a
 * SCROLLING toolbar at iPad-landscape width is a worse outcome than one that
 * drops its two lowest-priority tools into `More`, which is what raising this
 * threshold does.
 *
 * The premium visual pass moved it again, 1040 → 1045, and for the same reason
 * one step further along. Undo/redo/Open/Export were hardcoded to 38px in EVERY
 * mode while the icon-mode TOOLS are 44px, so the icon row shipped with two
 * control rhythms in one strip at exactly the widths where touch targets matter
 * most. Putting the pinned cluster on the row's shared control box costs it ~6px
 * of width, and re-measuring found the tablet row overflowing by 6px at 1040 and
 * by 2px at 1044, fitting exactly at **1045** (row 761px, pinned cluster 285px).
 * 1045 is that measured fit plus nothing; the threshold sits there rather than at
 * a rounder 1048 because `resolveToolbarMode` uses a strict `<`, so 1045 itself
 * renders the tablet row it was measured to fit.
 *
 * One measurement caveat, because it WILL look like a 1px bug to the next person
 * who checks: at exactly 1045 the scroller reports `scrollWidth 761` against
 * `clientWidth 760`, i.e. one pixel of apparent overflow, while at 1046 both read
 * 761. Nothing is clipped at either width — the last control's `right` equals the
 * scroller's content-box `right` to the hundredth of a pixel. The scroller's real
 * client box is 759.72px, and `clientWidth` rounds that down while `scrollWidth`
 * rounds the content up, so the integer pair straddles a fractional fit. Judge
 * this boundary on float geometry (`getBoundingClientRect`), not on the integer
 * scroll properties.
 *
 * Below `TOOLBAR_COMPACT_MAX_WIDTH` the compact row is used, and below ≈609px
 * (e.g. a 390px phone) not even that fits, so the backstop takes over and the
 * row scrolls rather than clipping tools into unreachable space. That is the
 * honest degradation, not the primary mechanism.
 *
 * The lesson worth keeping: this constant is downstream of the control metrics.
 * Changing button height or padding invalidates it, and the only way to know is
 * to measure the rendered row (`scripts/editor-audit.mjs`), not to reason about it.
 * It has now been invalidated twice by exactly that, which is the argument for
 * `rowControlBox` in `EditorToolbar` being the only place a control height is
 * written down.
 */
export const TOOLBAR_COMPACT_MAX_WIDTH = 1045;
export const TOOLBAR_TABLET_MAX_WIDTH = 1328;

/**
 * Resolves the toolbar's responsive mode from its measured container width.
 * An unmeasured width (0 / NaN — first render before ResizeObserver fires)
 * resolves to desktop so nothing is hidden before a real measurement exists.
 */
export function resolveToolbarMode(width: number): ToolbarMode {
  if (!Number.isFinite(width) || width <= 0) return "desktop";
  if (width < TOOLBAR_COMPACT_MAX_WIDTH) return "compact";
  if (width < TOOLBAR_TABLET_MAX_WIDTH) return "tablet";
  return "desktop";
}

/**
 * Where a mode represents a tool: as an inline button or inside the overflow
 * menu. Every tool is always represented somewhere — the toolbar never hides
 * the active tool entirely. Unknown ids report "inline" (they resolve to
 * "select" upstream via {@link resolveActiveTool}).
 */
export function toolPlacement(mode: ToolbarMode, id: EditorTool): "inline" | "overflow" {
  const def = TOOL_BY_ID.get(id);
  if (!def) return "inline";
  return def.priority <= MODE_MAX_PRIORITY[mode] ? "inline" : "overflow";
}

/** The groups a mode renders inline (tools above the mode's priority cut). */
export function visibleGroups(mode: ToolbarMode): ToolbarGroup[] {
  const max = MODE_MAX_PRIORITY[mode];
  return TOOLBAR_GROUPS.map((g) => ({ ...g, tools: g.tools.filter((t) => t.priority <= max) })).filter(
    (g) => g.tools.length > 0,
  );
}

/** The tools a mode pushes into the overflow menu (group order preserved). */
export function overflowTools(mode: ToolbarMode): ToolbarTool[] {
  const max = MODE_MAX_PRIORITY[mode];
  return ALL_TOOLBAR_TOOLS.filter((t) => t.priority > max);
}

/**
 * The verb-first label for the labelled row ("Add Text"), falling back to the
 * noun label where no verb form is defined. One accessor so the toolbar and its
 * tests cannot disagree about which string a button shows.
 */
export function toolActionLabel(t: ToolbarTool): string {
  return t.actionLabel ?? t.label;
}

/**
 * How the row should present a group.
 *
 * A `cluster` group clusters in EVERY mode, for three different reasons that all
 * point the same way.
 *
 * On desktop it is about LABELS: a labelled button per tool needed a ~1900px
 * container, so collapsing the 11 shapes and the 3 draw tools into two labelled
 * triggers is what lets the labelled row fit a 1366px laptop.
 *
 * On compact (phone) it is about REACHABILITY, and it is a bug fix. Measured at
 * 390px: the flat icon row wanted 407px, the visible area was 178px, and only
 * Select / Hand / Text were on screen. Image, Rectangle, Ellipse, Draw and
 * Eraser were rendered but scrolled out of view with the scrollbar hidden — and
 * because they are all priority 1, they were NOT in `More` either. Five tools
 * were in the DOM, absent from the visible row, and absent from the overflow
 * menu: reachable only by discovering that a chromeless strip scrolls sideways.
 *
 * On tablet it is about FIT, and this is the case that changed. This function
 * used to return "flat" for tablet on the stated grounds that "tablet has the
 * width to show its tools inline, and adding a click to reach a rectangle there
 * would be a regression". Re-measuring the real row disproved the premise: the
 * flat tablet row is 875px of content (15 icon tools = 761px, PLUS Organize
 * Pages and More at 57px each — the two the threshold arithmetic below had
 * omitted), while the scroller it lives in is 759.7px at 1045px of container and
 * 814.7px at 1100px. So the flat tablet row does not fit anywhere in the lower
 * half of its own range, and what it did instead of scrolling was overlap:
 * "Crop image tool" and "Organize pages" rendered on the same pixels, with Crop
 * unclickable (see the layout comment in `EditorToolbar`).
 *
 * Clustering the two cluster groups brings the tablet row to 647px, which fits
 * with 112px of slack at the tightest width in the range. The alternative was to
 * raise `TOOLBAR_COMPACT_MAX_WIDTH` to the ~1160px the flat row genuinely needs,
 * which would have dropped 1045–1159px into COMPACT — a six-stop row with ~370px
 * of dead space, hiding NINE tools behind menus at widths where twelve fit. The
 * cost of this choice is that Eraser and Pen move behind the Draw trigger at
 * tablet, which is exactly where they already are at desktop and at compact; the
 * old rule's real weakness was that it made tablet the one mode with a different
 * answer to a question every other mode had already settled.
 *
 * `mode` is retained in the signature because presentation is a rendering
 * decision that has been mode-dependent twice and may be again; every caller
 * already has the mode in hand.
 */
export function groupPresentation(_mode: ToolbarMode, group: ToolbarGroup): "flat" | "cluster" {
  return group.presentation;
}

/**
 * The groups the LABELLED row renders, with cluster groups kept whole.
 *
 * Unlike {@link visibleGroups}, a cluster group is NOT filtered by priority: its
 * trigger opens a menu, and a menu that hides 6 of 11 shapes for lack of
 * horizontal space would be arbitrary — the space cost of a menu item is zero.
 * Flat groups still respect the priority cut, so what a mode cannot fit inline
 * still lands in `More`.
 */
export function labelledGroups(mode: ToolbarMode): ToolbarGroup[] {
  const max = MODE_MAX_PRIORITY[mode];
  return TOOLBAR_GROUPS.map((g) =>
    groupPresentation(mode, g) === "cluster"
      ? { ...g, tools: [...g.tools] }
      : { ...g, tools: g.tools.filter((t) => t.priority <= max) },
  ).filter((g) => g.tools.length > 0);
}

/**
 * The tools the labelled row leaves for the `More` menu: everything above the
 * mode's priority cut that is NOT already reachable through a cluster trigger.
 * Without the cluster exclusion the low-priority shapes would appear twice —
 * once in the Add Shape menu and again under More.
 */
export function labelledOverflowTools(mode: ToolbarMode): ToolbarTool[] {
  const clustered = new Set(
    TOOLBAR_GROUPS.filter((g) => groupPresentation(mode, g) === "cluster").flatMap((g) =>
      g.tools.map((t) => t.id),
    ),
  );
  return overflowTools(mode).filter((t) => !clustered.has(t.id));
}

/**
 * The single-letter tool shortcut table (lowercased key → tool id), derived
 * from the group metadata so the shortcut manager and the displayed shortcut
 * text can never diverge.
 */
export function toolShortcutKeys(): Record<string, EditorTool> {
  const out: Record<string, EditorTool> = {};
  for (const t of ALL_TOOLBAR_TOOLS) {
    if (t.shortcut) out[t.shortcut.toLowerCase()] = t.id;
  }
  return out;
}

/** Display labels for every tool (status bar readout), derived from the groups. */
export const TOOL_LABELS: Record<EditorTool, string> = Object.fromEntries(
  ALL_EDITOR_TOOLS.map((id) => [id, TOOL_BY_ID.get(id)?.label ?? id]),
) as Record<EditorTool, string>;
