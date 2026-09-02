"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Download, FileUp, Files, Pin, PinOff, Redo2, Undo2 } from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import type { EditorTool } from "@/components/editor/editorTypes";
import { toolIcon } from "@/components/editor/toolbarIcons";
import {
  isPinnable,
  pinHint,
  toolStateLabel,
} from "@/src/application/editor/tools/toolSession";
import {
  placeAnchoredOverlay,
  type AnchoredPlacement,
} from "@/components/editor/anchoredOverlay";
import {
  groupPresentation,
  labelledGroups,
  labelledOverflowTools,
  overflowTools,
  resolveToolbarMode,
  toolActionLabel,
  toolbarWraps,
  toolAvailability,
  visibleGroups,
  type ToolbarGroup,
  type ToolbarMode,
  type ToolbarTool,
} from "@/components/editor/toolbarLayout";

/**
 * The editor toolbar (M6.12; premium labelled redesign).
 *
 * Renders the canonical tool table from `toolbarLayout.ts` — no tool metadata
 * lives in this file: labels, aria names, icons, shortcuts, grouping, priorities
 * and cluster policy all come from the layout module, and icons resolve through
 * the single `toolbarIcons` registry.
 *
 * Two presentations, chosen from the REAL container width (ResizeObserver):
 *
 *  - **labelled** (`desktop`) — the premium command row the redesign targets:
 *    icon + text on every button, high-frequency tools flat, the 11 shapes and
 *    the draw tools collapsed into labelled `Add Shape ▾` / `Draw ▾` menus. That
 *    clustering is what lets the labelled row fit a 1366px laptop; a labelled
 *    button per tool needed a 1900px container, so labels never appeared at the
 *    widths most people use.
 *  - **icon row** (`tablet` / `compact`) — the measured-to-fit icon presentation,
 *    priority-cut, with everything hidden reachable through `More`.
 *
 * The tool buttons form one `role="toolbar"` with a roving tabindex
 * (Left/Right/Home/End), so keyboard users tab in once and arrow between tools.
 * When the ACTIVE tool sits inside a cluster or the overflow menu, that trigger
 * renders in the active style — the current tool is never invisible.
 *
 * Zoom lives in the bottom capsule (`FloatingCanvasControls`), not here: the
 * reference design puts page/zoom at the canvas edge, and keeping a zoom stepper
 * + preset select in this row is what crowded out the labels and competed with
 * Export for the pinned right edge.
 */
export interface EditorToolbarProps {
  tool: EditorTool;
  onToolChange: (t: EditorTool) => void;
  onExport: () => void;
  /**
   * The local "Open PDF" flow. Omitted when the editor is mounted against a
   * Workspace document, where replacing the open document with an unrelated
   * local file would contradict the tab it is shown in.
   */
  onOpenPdf?: () => void;
  /**
   * Opens the page-organisation surface (the Pages rail). Omitted where no such
   * surface is reachable.
   */
  onOrganizePages?: () => void;
  /** Whether the Pages rail is currently the visible left panel. */
  organizePagesActive?: boolean;
  /**
   * Whether the active tool is PINNED — i.e. stays armed after each use instead
   * of disarming to Select. Only one-shot tools can be pinned; see
   * `toolSession.ts`, which owns the policy this row only reports.
   */
  toolPinned?: boolean;
  /**
   * Explicit pin control for the active tool. Omitted (an embedder that has not
   * adopted the session model) hides the pin affordance entirely rather than
   * showing a control that cannot do anything.
   */
  onToolPinnedChange?: (pinned: boolean) => void;
}

export function EditorToolbar({
  tool,
  onToolChange,
  onExport,
  onOpenPdf,
  onOrganizePages,
  organizePagesActive = false,
  toolPinned = false,
  onToolPinnedChange,
}: EditorToolbarProps) {
  const { canUndo, canRedo, undoLabel, redoLabel, actions, state, activePage } = useEditorContext();

  // --- Responsive mode from the REAL container width -------------------------
  const rootRef = useRef<HTMLDivElement>(null);
  // The measured width itself is state, not the mode derived from it: the row
  // makes TWO decisions from one measurement (which controls to show, and
  // whether they still fit on one line), and two `useState`s fed by one
  // observer can disagree. `resolveToolbarMode(0)` is `desktop`, so the first
  // paint is unchanged from when this held the mode directly.
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const mode: ToolbarMode = resolveToolbarMode(containerWidth);
  const labelled = mode === "desktop";
  const wraps = toolbarWraps(containerWidth);

  // Availability context: the kinds of the selected objects (crop's rule).
  const selectedObjects = state.selection.ids
    .map((id) => activePage.objects[id])
    .filter((obj): obj is NonNullable<typeof obj> => Boolean(obj));
  const selectedKinds = selectedObjects.map((obj) => obj.kind);
  const availabilityOf = (t: ToolbarTool) => toolAvailability(t.id, { selectedKinds, selectedObjects });

  const groups = labelled ? labelledGroups(mode) : visibleGroups(mode);
  const overflow = labelled ? labelledOverflowTools(mode) : overflowTools(mode);

  // Which cluster (if any) holds the active tool, so its trigger can show it.
  const clusterGroups = groups.filter((g) => groupPresentation(mode, g) === "cluster");
  const activeClusterId =
    clusterGroups.find((g) => g.tools.some((t) => t.id === tool))?.id ?? null;
  const activeInOverflow = overflow.some((t) => t.id === tool);

  // --- Roving tabindex across the tool stops --------------------------------
  // A cluster is ONE stop (its trigger), not one per hidden tool: arrowing
  // through 11 invisible shapes would be a keyboard trap in all but name.
  type Stop = string;
  const stops: Stop[] = [];
  for (const g of groups) {
    if (groupPresentation(mode, g) === "cluster") stops.push(`cluster:${g.id}`);
    else for (const t of g.tools) if (availabilityOf(t).available) stops.push(t.id);
  }
  if (overflow.length) stops.push("overflow");

  const [focusStop, setFocusStop] = useState<Stop | null>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const currentStop: Stop | undefined =
    focusStop && stops.includes(focusStop)
      ? focusStop
      : stops.includes(tool)
        ? tool
        : activeClusterId && stops.includes(`cluster:${activeClusterId}`)
          ? `cluster:${activeClusterId}`
          : stops[0];

  const onToolbarKeyDown = (e: React.KeyboardEvent) => {
    if (stops.length === 0) return;
    const index = currentStop ? stops.indexOf(currentStop) : 0;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % stops.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + stops.length) % stops.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = stops.length - 1;
    if (next === null) return;
    e.preventDefault();
    const stop = stops[next];
    setFocusStop(stop);
    buttonRefs.current.get(stop)?.focus();
  };

  // --- Menus (clusters + overflow) ------------------------------------------
  // One open menu at a time, keyed by stop id, so opening Add Shape closes More.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openMenu) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The menu is PORTALLED to document.body, so `menuRootRef` (the toolbar
      // row) no longer contains it. Checking only the row would close the menu on
      // the very pointerdown that is selecting an item — the menu would vanish
      // before the click completed and no tool would be chosen. Both the trigger
      // area and the open menu count as "inside".
      const insideToolbar = menuRootRef.current?.contains(target) ?? false;
      const insideMenu = document
        .querySelector(`[data-menu="${openMenu}"]`)
        ?.contains(target) ?? false;
      if (!insideToolbar && !insideMenu) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [openMenu]);

  const selectFromMenu = (id: EditorTool, returnTo: string) => {
    setOpenMenu(null);
    onToolChange(id);
    buttonRefs.current.get(returnTo)?.focus();
  };

  const registerRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) buttonRefs.current.set(key, el);
    else buttonRefs.current.delete(key);
  };

  /*
   * Anchor refs for the PORTALLED menus. The roving-tabindex `buttonRefs` map is
   * a plain Map, and a portalled menu needs a real ref object to measure its
   * trigger from after mount — so cluster/overflow triggers register in both.
   * Keyed per menu so two triggers cannot share one anchor.
   */
  const anchorRefs = useRef(new Map<string, { current: HTMLButtonElement | null }>());
  const anchorRefFor = (key: string) => {
    let ref = anchorRefs.current.get(key);
    if (!ref) {
      ref = { current: null };
      anchorRefs.current.set(key, ref);
    }
    return ref;
  };
  const registerTrigger = (key: string) => (el: HTMLButtonElement | null) => {
    registerRef(key)(el);
    anchorRefFor(key).current = el;
  };

  /**
   * Shared menu keyboard model: Esc/Tab closes, arrows move, Home/End jump.
   *
   * Items are looked up from `document`, not from the toolbar subtree: the menu is
   * portalled to `document.body`, so a `menuRootRef`-scoped query would find
   * nothing and arrow keys would silently stop working.
   */
  const onMenuKeyDown = (e: React.KeyboardEvent, returnTo: string) => {
    const enabled = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        `[data-menu="${returnTo}"] [role="menuitem"]:not(:disabled)`,
      ),
    );
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      setOpenMenu(null);
      if (e.key === "Escape") buttonRefs.current.get(returnTo)?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || enabled.length === 0) return;
    e.preventDefault();
    const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? enabled.length - 1
          : e.key === "ArrowDown"
            ? (index + 1 + enabled.length) % enabled.length
            : (index - 1 + enabled.length) % enabled.length;
    enabled[next].focus();
  };

  /** Opens a menu from its trigger's keyboard, focusing the first item. */
  const onTriggerKeyDown = (e: React.KeyboardEvent, key: string) => {
    if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && openMenu !== key) {
      e.preventDefault();
      setOpenMenu(key);
      requestAnimationFrame(() => {
        // Portalled: query the document, not the toolbar subtree.
        document
          .querySelector<HTMLButtonElement>(`[data-menu="${key}"] [role="menuitem"]:not(:disabled)`)
          ?.focus();
      });
    } else if (e.key === "Escape" && openMenu === key) {
      e.stopPropagation();
      setOpenMenu(null);
    }
  };

  // The active tool's persistence, in the SAME words the pure policy uses. This
  // row must not decide what "pinned" means — it only reports it, and it reports
  // it as TEXT plus a glyph, because the accent surface can say "this tool is
  // active" but cannot say "and it will disarm after one use".
  const session = { active: tool, pinned: toolPinned };
  const stateLabel = toolStateLabel(session);
  const hint = pinHint(session);
  const pinnableActive = isPinnable(tool);

  // --- Renderers -------------------------------------------------------------

  const renderToolButton = (t: ToolbarTool) => {
    const availability = availabilityOf(t);
    const Icon = toolIcon(t.icon);
    const active = tool === t.id;
    const text = labelled ? toolActionLabel(t) : t.label;
    // The active tool's title/name carries its PERSISTENCE, not just its name:
    // "one use, then Select" vs "pinned — stays after each use" is the whole
    // distinction, and no amount of accent colour conveys it.
    const shortcutText = t.shortcut ? `${text} (${t.shortcut})` : text;
    const title = !availability.available
      ? `${text} — ${availability.reason}`
      : active
        ? [shortcutText, stateLabel, hint].filter(Boolean).join(" — ")
        : shortcutText;
    return (
      <button
        key={t.id}
        type="button"
        ref={registerRef(t.id)}
        className={toolButtonClass(active, availability.available, labelled)}
        onClick={() => onToolChange(t.id)}
        onFocus={() => setFocusStop(t.id)}
        title={title}
        aria-label={active ? `${t.ariaLabel} — ${stateLabel}` : t.ariaLabel}
        aria-keyshortcuts={t.shortcut ?? undefined}
        aria-pressed={active}
        aria-disabled={!availability.available || undefined}
        disabled={!availability.available}
        tabIndex={currentStop === t.id ? 0 : -1}
      >
        {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
        {labelled ? <span className="whitespace-nowrap">{text}</span> : null}
        {/*
          A pinned tool wears a pin. Decorative here — the state is already in
          `aria-label`, so announcing it twice would be noise — but it is the
          SHAPE difference that distinguishes pinned from one-shot for anyone who
          cannot separate the two accent surfaces by hue.
        */}
        {active && toolPinned ? (
          <Pin className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : null}
      </button>
    );
  };

  /** A labelled cluster: one trigger, the group as a menu. */
  const renderCluster = (g: ToolbarGroup) => {
    const key = `cluster:${g.id}`;
    const holdsActive = activeClusterId === g.id;
    // The trigger shows the ACTIVE tool's icon when this cluster owns it, so the
    // current mode stays visible without expanding the menu.
    const activeTool = holdsActive ? g.tools.find((t) => t.id === tool) : undefined;
    const Icon = toolIcon(activeTool?.icon ?? g.clusterIcon ?? g.tools[0].icon);
    const label = g.clusterLabel ?? g.label;
    const open = openMenu === key;
    return (
      <div key={key} className="relative">
        <button
          type="button"
          ref={registerTrigger(key)}
          className={toolButtonClass(holdsActive, true, labelled)}
          onClick={() => setOpenMenu(open ? null : key)}
          onFocus={() => setFocusStop(key)}
          onKeyDown={(e) => onTriggerKeyDown(e, key)}
          title={holdsActive && activeTool ? `${label} — ${activeTool.label}` : label}
          aria-label={
            holdsActive && activeTool ? `${label} (current: ${activeTool.label})` : label
          }
          aria-haspopup="menu"
          aria-expanded={open}
          tabIndex={currentStop === key ? 0 : -1}
        >
          {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
          {labelled ? <span className="whitespace-nowrap">{label}</span> : null}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </button>
        {open ? (
          <ToolMenu
            menuKey={key}
            label={g.label}
            tools={g.tools}
            activeTool={tool}
            availabilityOf={availabilityOf}
            onSelect={(id) => selectFromMenu(id, key)}
            onKeyDown={(e) => onMenuKeyDown(e, key)}
            anchorRef={anchorRefFor(key)}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={`flex shrink-0 items-center gap-1.5 border-b border-editor-border bg-editor-surface px-2 py-2 sm:px-3 ${
        wraps ? "flex-wrap gap-y-1.5" : ""
      }`}
    >
      {/*
        Two layouts, chosen by `toolbarWraps` from the measured container width.

        At or above `TOOLBAR_WRAP_MIN_WIDTH` (732px — the measured worst-case
        single-row fit, pin toggle present) the row is a single line and `min-w-0` + `overflow-x-auto`
        is the structural backstop behind the priority/cluster model. The cuts
        are sized from measured button widths, but a longer locale or a larger
        minimum font can still push the row past its container — and a plain
        non-wrapping flex row CLIPS, leaving tools that are in the DOM and
        keyboard-reachable but invisible and unclickable. Scrolling degrades
        honestly instead. `scrollbar-none` keeps the chrome quiet; the row still
        scrolls by wheel, trackpad, touch and keyboard.

        BELOW 609px that backstop was the primary mechanism, and it was not
        honest: measured at 320px the scroller was a 90px window onto 437px of
        tools — 21% visible, four fifths of the row reachable only by swiping a
        scrollbar `scrollbar-none` had removed. So below the fit the row wraps
        instead. No priority cut can rescue a single line there; see the
        arithmetic in `toolbarLayout.ts`.
      */}
      <div
        ref={menuRootRef}
        className={
          wraps
            ? // Below the measured single-row fit there is no scrolling to do:
              // the row takes the full width and wraps, and the pinned cluster
              // wraps with it onto its own line. `basis-full` is what makes the
              // pinned cluster drop rather than share this line — without it a
              // flex-wrap container gives the cluster the first line's tail and
              // the tools wrap around it, which reads as a broken layout.
              "flex w-full basis-full flex-wrap items-center gap-1"
            : "flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
        }
      >
        <div
          /*
           * `shrink-0`, NOT `min-w-0`. This row is a flex ITEM of the scroller
           * above, and `min-w-0` let it shrink BELOW its own content while its
           * own `overflow-x` stayed `visible`. Measured at 1100px: the row's box
           * was 700.7px wide around 761px of buttons, so the last ~60px of tools
           * spilled out of the box — and the scroller, reading the shrunken box,
           * saw scrollWidth === clientWidth and never offered a scrollbar. The
           * siblings after this row (Organize Pages, More) were then laid out
           * from the box's edge, i.e. ON TOP of the spilled tools: "Crop image
           * tool" at x 729-773 underneath "Organize pages" at x 725.7-769.7, so
           * a click aimed at Crop hit Organize Pages (later sibling wins).
           *
           * With `shrink-0` the row keeps its content width, the scroller's
           * scrollWidth becomes true, and an overflow degrades into the sideways
           * scroll the comment below has always claimed it does.
           */
          className={`flex items-center gap-1 ${wraps ? "flex-wrap" : "shrink-0"}`}
          role="toolbar"
          aria-label="Tools"
          onKeyDown={onToolbarKeyDown}
        >
          {groups.map((g, gi) => (
            <div
              key={g.id}
              className="flex shrink-0 items-center gap-1"
              role="group"
              aria-label={g.label}
            >
              {gi > 0 ? <Divider /> : null}
              {groupPresentation(mode, g) === "cluster"
                ? renderCluster(g)
                : g.tools.map(renderToolButton)}
            </div>
          ))}
        </div>

        {/*
          The pin toggle for the active tool (AC6). One control in ONE place
          rather than a nested button per tool: a button inside a button is
          invalid, and an extra roving-tabindex stop per tool would make arrowing
          across the row twice as long. Sitting outside `role="toolbar"` gives it
          its own tab stop, so it is reachable by keyboard without changing the
          row's arrow-key model.

          Only rendered for a pinnable (one-shot) tool: Select and Hand are modal
          and Draw already keeps drawing, so a pin control there would offer a
          state the policy refuses to enter.

          Icon + tooltip, not a label — the same choice Organize Pages makes, and
          for the same measured reason: a label here can clip in the row.
        */}
        {onToolPinnedChange && pinnableActive ? (
          <div className="flex shrink-0 items-center gap-1">
            <Divider />
            <button
              type="button"
              className={toggleButtonClass(toolPinned, labelled)}
              onClick={() => onToolPinnedChange(!toolPinned)}
              title={`${stateLabel}${hint ? ` — ${hint}` : ""}`}
              aria-label={
                toolPinned
                  ? `Unpin the current tool — it will return to Select after each use`
                  : `Pin the current tool — it will stay selected after each use`
              }
              aria-pressed={toolPinned}
            >
              {toolPinned ? (
                <Pin className="h-4 w-4 shrink-0" aria-hidden="true" />
              ) : (
                <PinOff className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}

        {/* Document-level actions that belong with the tools, not with Export. */}
        {onOrganizePages ? (
          <div className="flex shrink-0 items-center gap-1">
            <Divider />
            <button
              type="button"
              /*
               * P1 Phase C4/C5 — a PANEL TOGGLE, not an interaction tool.
               *
               * This used to render in `toolButtonClass(active)`, i.e. the pale
               * indigo + accent ring that means "this is the tool your pointer is
               * currently using". Because the Pages rail is open on Pages by
               * default, the row therefore shipped with TWO buttons in the
               * selected style — Select and Organize Pages — which trains the
               * user that the style means nothing.
               *
               * The state is real either way (`leftRailOpen && tab === pages`),
               * so the fix is presentational: a toggle reads as pressed via a
               * neutral inset surface, leaving the accent style to mean exactly
               * one thing.
               *
               * ICON-ONLY IN EVERY MODE (premium visual pass). It used to carry
               * the label "Organize Pages" in the labelled row, at 139.8px the
               * widest control there — and measured in Chrome, that label is what
               * made the labelled row overflow its scroller between 1290px and
               * ~1440px, so at 1366px (a flagship width for this redesign) the
               * label was CLIPPED mid-word and the button needed a sideways
               * scroll to reach. A clipped label is worse than no label, and of
               * everything in this row it is the best candidate to lose one: it
               * is the only non-tool control here, and the same command is also
               * reachable from the left rail's "Pages" tab and the bottom
               * capsule's "Page overview" toggle. `title` + `aria-label` keep it
               * named for pointer and screen-reader users, and it keeps the
               * labelled row's 38px control box (NOT the 44px icon-mode box) so
               * the row still has one rhythm.
               */
              className={toggleButtonClass(organizePagesActive, labelled)}
              onClick={onOrganizePages}
              title={organizePagesActive ? "Organize pages (panel open)" : "Organize pages"}
              aria-label="Organize pages"
              aria-pressed={organizePagesActive}
            >
              <Files className="h-4 w-4 shrink-0" aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {/* `More` — whatever the mode could not place inline. */}
        {overflow.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1">
            <Divider />
            <div className="relative">
              <button
                type="button"
                ref={registerTrigger("overflow")}
                className={toolButtonClass(activeInOverflow, true, labelled)}
                onClick={() => setOpenMenu(openMenu === "overflow" ? null : "overflow")}
                onFocus={() => setFocusStop("overflow")}
                onKeyDown={(e) => onTriggerKeyDown(e, "overflow")}
                title="More tools"
                aria-label={
                  activeInOverflow ? "More tools (current tool is in this menu)" : "More tools"
                }
                aria-haspopup="menu"
                aria-expanded={openMenu === "overflow"}
                tabIndex={currentStop === "overflow" ? 0 : -1}
              >
                {activeInOverflow
                  ? (() => {
                      const ActiveIcon = toolIcon(tool);
                      return ActiveIcon ? (
                        <ActiveIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      ) : null;
                    })()
                  : null}
                {labelled ? <span className="whitespace-nowrap">More</span> : null}
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
              </button>
              {openMenu === "overflow" ? (
                <ToolMenu
                  menuKey="overflow"
                  label="More tools"
                  tools={overflow}
                  activeTool={tool}
                  availabilityOf={availabilityOf}
                  onSelect={(id) => selectFromMenu(id, "overflow")}
                  onKeyDown={(e) => onMenuKeyDown(e, "overflow")}
                  anchorRef={anchorRefFor("overflow")}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {/*
        Pinned document actions: `shrink-0` so a long tool row scrolls under them
        rather than pushing Export off the right edge. Export being unreachable
        is the worst failure this row can have.
      */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Undo and redo are deliberately separated from the tools — and from
            each other — because they undo each other, and an adjacent pair
            invites misclicks exactly when the user is agitated. */}
        <Divider />
        <ActionButton
          label={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)"}
          labelled={labelled}
          onClick={() => actions.undo()}
          disabled={!canUndo}
        >
          <Undo2 className="h-4 w-4" aria-hidden="true" />
        </ActionButton>
        <ActionButton
          label={redoLabel ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)"}
          labelled={labelled}
          onClick={() => actions.redo()}
          disabled={!canRedo}
        >
          <Redo2 className="h-4 w-4" aria-hidden="true" />
        </ActionButton>

        {onOpenPdf ? (
          <>
            <Divider />
            <ActionButton label="Open PDF to edit" labelled={labelled} onClick={onOpenPdf}>
              <FileUp className="h-4 w-4" aria-hidden="true" />
            </ActionButton>
          </>
        ) : null}

        {/* The row's ONE filled control (P8): a primary action is solid accent,
            an active tool is a pale accent surface, a state is neutral. Two
            filled buttons in one row is how a toolbar stops having a primary
            action at all. Shares `rowControlBox` so it cannot drift from the
            tools it sits beside. */}
        <button
          type="button"
          className={`ml-0.5 flex ${rowControlBox(labelled)} items-center justify-center gap-1.5 rounded-control bg-editor-accent px-3.5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(16,24,40,0.08)] transition-colors duration-100 hover:bg-editor-accenthover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent focus-visible:ring-offset-2`}
          onClick={onExport}
          title="Export edited PDF (Ctrl+Shift+S)"
          aria-label="Export edited PDF"
        >
          <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
          {mode !== "compact" ? <span>Export</span> : null}
        </button>
      </div>
    </div>
  );
}

/**
 * The row's control box, by presentation. ONE source for EVERY interactive
 * control in the bar — tools, cluster triggers, the Organize Pages toggle,
 * undo/redo/open and Export — because a row whose buttons disagree on height
 * reads as assembled rather than designed.
 *
 * The labelled variant is the reference design's control: a 38px minimum (P1
 * Phase C3 — measured at 36px before, below the 38–42px the brief calls for and
 * below what reads as a comfortable pointer target in a dense row). The icon
 * variant keeps the 44px touch target the icon modes were measured with;
 * shrinking it to match the labelled row would take touch targets below the
 * accessible minimum on exactly the narrow screens that need them most.
 *
 * P1: `ActionButton` and Export previously hardcoded 38px in ALL modes, so at
 * compact width the row rendered 44px tools beside 38px undo/redo/Export — two
 * rhythms in one strip, at the width where targets matter most.
 */
function rowControlBox(labelled: boolean): string {
  return labelled ? "min-h-[38px] min-w-[38px]" : "min-h-11 min-w-11";
}

/**
 * One tool/cluster button's classes.
 *
 * Height comes from {@link rowControlBox}. The rest is the accent contract (P8):
 * the ACTIVE tool — and only the active tool — wears the pale-accent surface plus
 * an accent ring. Hover deepens that surface rather than leaving it inert: a
 * pressed control with no hover response reads as a static badge, and the active
 * tool is the one button in the row a user most often re-aims at.
 */
function toolButtonClass(active: boolean, available: boolean, labelled: boolean): string {
  const base = labelled
    ? `flex ${rowControlBox(true)} shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent`
    : `flex ${rowControlBox(false)} shrink-0 items-center justify-center gap-1 rounded-control px-2 text-[13px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent`;
  const tone = active
    ? "bg-editor-accentsoft text-editor-accent ring-1 ring-inset ring-editor-accent/25 hover:bg-editor-accent/15 hover:ring-editor-accent/45"
    : "text-editor-text hover:bg-editor-subtle";
  // `opacity-40` is the row's ONE disabled treatment (P1). `ActionButton` used
  // `opacity-30`, which put two disabled strengths in a single strip — and the
  // weaker one on undo/redo, the disabled state this editor shows most often.
  const disabled = available ? "" : "cursor-not-allowed opacity-40";
  return `${base} ${tone} ${disabled}`;
}

/**
 * A tool menu (cluster or overflow). Same item semantics in both places.
 *
 * PORTALLED, and that is not a style choice — it is the fix for the bug that made
 * Shape and Draw unusable. This menu used to be an `absolute` child of the tool
 * row, which is `overflow-x-auto`; CSS computes the other axis of a non-`visible`
 * overflow to `auto`, so the row clipped the menu to its own 38px height. The
 * menu still measured 320px tall and was keyboard reachable, so it LOOKED fine,
 * but hit-testing stops at the clip: `elementFromPoint` at a menu item's centre
 * returned the canvas `<svg>`, so clicking "Rectangle" pressed the page and the
 * tool was never entered. A portal has no clipping ancestor by construction.
 *
 * Because it is no longer inside the trigger's offsetParent, its position comes
 * from the trigger's measured viewport rect through the pure
 * `placeAnchoredOverlay` (flip-above and viewport clamping included) rather than
 * from `top-full`.
 */
function ToolMenu({
  menuKey,
  label,
  tools,
  activeTool,
  availabilityOf,
  onSelect,
  onKeyDown,
  anchorRef,
}: {
  menuKey: string;
  label: string;
  tools: readonly ToolbarTool[];
  activeTool: EditorTool;
  availabilityOf: (t: ToolbarTool) => { available: boolean; reason?: string };
  onSelect: (id: EditorTool) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const MENU_WIDTH = 208;
  const ITEM_HEIGHT = 40;
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);

  /*
   * Position is measured, not guessed, and re-measured while open: the toolbar
   * row can scroll and the window can resize under an open menu, and a portalled
   * overlay does not move with its trigger the way an absolute child does.
   */
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      setPlacement(
        placeAnchoredOverlay(
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          { width: MENU_WIDTH, height: tools.length * ITEM_HEIGHT + 8 },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    window.addEventListener("resize", measure);
    // `true` (capture) so an ancestor scrolling — the tool row itself — is seen.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchorRef, tools.length]);

  // Nothing is rendered until the position is known, so the menu never appears
  // at the top-left corner for a frame before jumping into place.
  if (!placement || typeof document === "undefined") return null;

  return createPortal(
    <div
      data-menu={menuKey}
      data-side={placement.side}
      role="menu"
      aria-label={label}
      className="fixed z-popover overflow-y-auto rounded-appmenu border border-editor-border bg-editor-surface p-1 shadow-appmenu"
      style={{
        left: placement.left,
        top: placement.top,
        width: MENU_WIDTH,
        maxHeight: placement.maxHeight,
      }}
      onKeyDown={onKeyDown}
    >
      {tools.map((t) => {
        const availability = availabilityOf(t);
        const Icon = toolIcon(t.icon);
        return (
          <button
            key={t.id}
            type="button"
            role="menuitem"
            className={`flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent ${
              activeTool === t.id
                ? "bg-editor-accentsoft font-medium text-editor-accent"
                : "text-editor-text hover:bg-editor-subtle"
            } ${!availability.available ? "cursor-not-allowed opacity-40" : ""}`}
            onClick={() => onSelect(t.id)}
            disabled={!availability.available}
            aria-disabled={!availability.available || undefined}
            title={availability.available ? undefined : availability.reason}
          >
            {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
            <span className="flex-1 truncate">{t.label}</span>
            {t.shortcut ? (
              <kbd className="rounded border border-editor-border bg-editor-subtle px-1 text-[10px] font-medium text-editor-muted">
                {t.shortcut}
              </kbd>
            ) : null}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * A non-tool toolbar action (undo/redo/open). Icon-only, and on the row's shared
 * control box so it matches the tools beside it in every mode.
 */
function ActionButton({
  children,
  active,
  label,
  labelled,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  active?: boolean;
  label: string;
  /** The row's presentation, so this control shares the tools' height. */
  labelled: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex ${rowControlBox(labelled)} items-center justify-center rounded-control transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent ${
        active
          ? "bg-editor-accentsoft text-editor-accent hover:bg-editor-accent/15"
          : "text-editor-muted hover:bg-editor-subtle hover:text-editor-text"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-6 w-px shrink-0 bg-editor-border" aria-hidden="true" />;
}

/**
 * A panel/mode TOGGLE's classes (P1 Phase C4).
 *
 * Deliberately different from {@link toolButtonClass}'s active style. The editor
 * has two kinds of "on": the tool the pointer is using (exactly one at a time,
 * pale indigo + accent ring) and a panel that happens to be open (any number,
 * neutral inset). Sharing one style made the toolbar report two selected tools,
 * which is why "is Organize Pages a tool?" was a reasonable question to ask of
 * the shipped UI. Pressed here is a cool grey surface with a hairline border —
 * clearly engaged, clearly not the active instrument.
 *
 * Pressed hovers too (P1), for the same reason the active tool does: the state
 * is a toggle, so the button remains a target, and a target that does not
 * respond to the pointer reads as disabled.
 */
function toggleButtonClass(pressed: boolean, labelled: boolean): string {
  const base = labelled
    ? `flex ${rowControlBox(true)} shrink-0 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent`
    : `flex ${rowControlBox(false)} shrink-0 items-center justify-center gap-1 rounded-control px-2 text-[13px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent`;
  const tone = pressed
    ? "bg-editor-subtle text-editor-text ring-1 ring-inset ring-editor-borderstrong hover:bg-editor-border"
    : "text-editor-text hover:bg-editor-subtle";
  return `${base} ${tone}`;
}
