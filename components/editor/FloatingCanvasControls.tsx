"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Files,
  Hand,
  Maximize,
  MousePointer2,
  PanelRight,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { ZOOM_PRESETS, type FitMode } from "@/components/editor/viewport/zoom";
import {
  FIT_MODE_LABELS,
  canGoNextPage,
  canGoPrevPage,
  canZoomIn,
  canZoomOut,
  isPanPressed,
  isSelectPressed,
  pageNavDisabledReason,
  resolveCapsuleDensity,
  resolveCapsuleVisibility,
  resolvePageEntry,
  zoomDisabledReason,
  zoomReadout,
  zoomTriggerAccessibleName,
  zoomTriggerLabel,
  zoomTriggerLabelCompact,
} from "@/components/editor/floatingControlsLogic";

/**
 * FloatingCanvasControls — the floating viewport controller over the canvas.
 *
 * This is the reference design's canvas control bar: pointer mode, zoom out /
 * zoom readout / zoom in, fit modes, page navigation with a jump-to-page field,
 * a page-overview shortcut and the Inspector toggle. It is the PRIMARY home of
 * zoom and page navigation at every width, not a compact-only substitute:
 *
 *  - putting zoom here is what freed the toolbar to show labels on a 1366px
 *    laptop (a zoom stepper + preset select cost ~200px in a row that also has
 *    to fit Export);
 *  - it sits at the canvas edge where the reference puts it, so the eye finds
 *    page/zoom near the page rather than in the far corner of the app chrome.
 *
 * It owns NO navigation or zoom state — it is a pure projection of the
 * workspace's viewport/page state through the same callbacks the shortcut
 * manager uses, so the capsule, the shortcuts and the status bar can never
 * disagree. Every derivation (disabled states, readouts, which groups a width
 * affords) lives in `floatingControlsLogic`, which is Node-tested.
 * `pageNumber`/`pageCount` are 1-based for display.
 *
 * ## Phase I: what changed, and why
 *
 * Four defects here were found by MEASURING the shipped bar in a real browser,
 * not by reading it:
 *
 *  1. It was centred on the whole editor FRAME (`left-1/2` of the frame),
 *     while the canvas is offset by the 176px left rail and the 320px Inspector
 *     dock. Measured at 1440px the bar sat 72px right of the canvas centre, and
 *     at 1024px (Inspector undocked) 88px LEFT of it. It is now positioned
 *     inside the canvas region itself, so it tracks the rail collapsing and the
 *     Inspector docking for free.
 *  2. It overlapped the status bar by 13px, because it was pinned to the frame
 *     bottom and the status bar is a sibling below the canvas.
 *  3. Zoom ±  were never disabled — at 800% the "+" still looked live and did
 *     nothing, and the same at 10% for "−".
 *  4. It hid page navigation entirely for a 1-page document while still showing
 *     zoom, so the group separators implied a missing control.
 */
export interface FloatingCanvasControlsProps {
  /** Current page, 1-based. */
  pageNumber: number;
  pageCount: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  /** Jumps to a 1-based page number (already range-checked by the caller). */
  onGoToPage?: (pageNumber: number) => void;
  /** Current zoom as a factor (1 = 100%). */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitPage: () => void;
  /** Applies an explicit zoom factor (1 = 100%), clearing any fit mode. */
  onZoomPreset?: (zoom: number) => void;
  /** Selects a sticky fit mode. */
  onFitMode?: (mode: FitMode) => void;
  /** The active fit mode, or null when the zoom is manual. */
  fitMode?: FitMode | null;
  /** Pan/select mode switch — omitted where the surface has no tool concept. */
  panActive?: boolean;
  onPanMode?: () => void;
  onSelectMode?: () => void;
  /**
   * The CANONICAL active tool id, so the pointer-mode pair can be truthful.
   *
   * `panActive` alone could only express Hand-vs-not-Hand, and the capsule
   * rendered Select as its negation — which meant Select reported
   * `aria-pressed=true` while Rectangle, Draw, Text or the eraser was the actual
   * instrument. Passing the tool the engine is really in lets BOTH buttons be
   * unpressed, which is the honest state for every tool the capsule does not
   * itself offer. Optional so surfaces with no tool concept keep working; when
   * absent the pair falls back to `panActive`.
   */
  activeTool?: string;
  /**
   * Reveals the page overview (the Pages rail). Omitted where no such surface
   * exists — this must never be a decorative grid icon.
   */
  onPageOverview?: () => void;
  /** Whether the page overview is currently the visible surface. */
  pageOverviewActive?: boolean;
  /**
   * The Inspector toggle. One control for the single right-hand panel: where the
   * width lets it dock this collapses/restores the dock, and where it cannot it
   * opens the drawer. There is no second panel toggle any more — the Inspector's
   * own tab strip is how you reach Outline/Comments/Versions.
   */
  onToggleInspector?: () => void;
  inspectorActive?: boolean;
  /**
   * The measured width of the canvas region, for the responsive density. Null
   * before measurement, which resolves to the full layout (see
   * `resolveCapsuleDensity`) rather than guessing a phone.
   */
  containerWidth?: number | null;
}

const FIT_OPTIONS: Array<{ value: FitMode; label: string }> = [
  { value: "fit-page", label: FIT_MODE_LABELS["fit-page"] },
  { value: "fit-width", label: FIT_MODE_LABELS["fit-width"] },
  { value: "fit-height", label: FIT_MODE_LABELS["fit-height"] },
];

export function FloatingCanvasControls({
  pageNumber,
  pageCount,
  onPrevPage,
  onNextPage,
  onGoToPage,
  zoom,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onZoomPreset,
  onFitMode,
  fitMode = null,
  panActive = false,
  onPanMode,
  onSelectMode,
  activeTool,
  onPageOverview,
  pageOverviewActive = false,
  onToggleInspector,
  inspectorActive = false,
  containerWidth = null,
}: FloatingCanvasControlsProps) {
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!zoomOpen) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (!zoomRef.current?.contains(e.target as Node)) setZoomOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [zoomOpen]);

  const hasZoomMenu = Boolean(onZoomPreset || onFitMode);
  const density = resolveCapsuleDensity(containerWidth ?? Number.NaN);
  const show = resolveCapsuleVisibility(density);

  // Derived, not stored: a second copy of "can I zoom out" is a second thing to
  // keep in sync with the ladder the button actually calls.
  const zoomOutBlocked = zoomDisabledReason("out", zoom);
  const zoomInBlocked = zoomDisabledReason("in", zoom);
  const prevBlocked = pageNavDisabledReason("prev", pageNumber, pageCount);
  const nextBlocked = pageNavDisabledReason("next", pageNumber, pageCount);

  /*
   * Pointer-mode pressed states, derived from the canonical tool id.
   *
   * Both can be false — and must be, whenever the active instrument is a tool the
   * capsule does not offer (Rectangle, Draw, Text, Eraser, Crop…). The old
   * `active={!panActive}` made Select claim every one of those, which is a lie in
   * the UI and in `aria-pressed`. Where no tool id is supplied the pair degrades
   * to the previous Hand-vs-Select reading rather than going blank.
   */
  const panPressed = activeTool === undefined ? panActive : isPanPressed(activeTool);
  const selectPressed = activeTool === undefined ? !panActive : isSelectPressed(activeTool);

  return (
    <div
      role="toolbar"
      aria-label="Page and zoom controls"
      /*
       * `pointer-events-auto` on the bar, `pointer-events-none` on its
       * positioning wrapper (in the workspace): the capsule floats over a canvas
       * that must keep receiving pointer events everywhere the bar is not, so an
       * active draw stroke or a drag near the page bottom is never swallowed by
       * an invisible full-width box.
       *
       * LAYERING. This element carries no z-index of its own — its positioning
       * wrapper in `EditorWorkspace` does (`z-30`), which is the box the browser
       * actually stacks and the one to read when measuring. Measured order with
       * the Inspector open as a modal drawer: capsule wrapper 30 < drawer scrim 40
       * < drawer 50. So the scrim DOES cover the capsule, which is the point: a
       * control that is unreachable behind a modal must not still look live.
       * (An earlier revision of this comment claimed the scrim was `z-20` and the
       * capsule deliberately floated above it. That was true before the modal
       * click-through fix and is no longer; `editor-final-visual-probe.mjs` f03
       * and `editor-responsive-probe.mjs` both assert the current order.)
       */
      className="pointer-events-auto flex max-w-full items-center gap-1 overflow-x-auto rounded-[16px] border border-editor-border bg-editor-surface/95 px-2 py-1.5 shadow-editorfloating backdrop-blur scrollbar-none"
    >
      {/* Pointer mode: the reference's hand/arrow pair. */}
      {show.pointerMode && onPanMode && onSelectMode ? (
        <>
          <CapsuleGroup>
            <CapsuleButton label="Pan tool (H)" onClick={onPanMode} active={panPressed}>
              <Hand className="h-4 w-4" aria-hidden="true" />
            </CapsuleButton>
            <CapsuleButton label="Select tool (V)" onClick={onSelectMode} active={selectPressed}>
              <MousePointer2 className="h-4 w-4" aria-hidden="true" />
            </CapsuleButton>
          </CapsuleGroup>
          <Divider />
        </>
      ) : null}

      {/* Zoom: [ − | readout | + ] as one visually grouped cluster (I18). */}
      <CapsuleGroup>
        <CapsuleButton
          label="Zoom out (Ctrl+-)"
          onClick={onZoomOut}
          disabled={!canZoomOut(zoom)}
          disabledReason={zoomOutBlocked}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </CapsuleButton>

        {hasZoomMenu ? (
          <div ref={zoomRef} className="relative">
            <button
              type="button"
              ref={zoomTriggerRef}
              onClick={() => setZoomOpen((o) => !o)}
              onKeyDown={(e) => {
                if ((e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") && !zoomOpen) {
                  e.preventDefault();
                  setZoomOpen(true);
                  requestAnimationFrame(() => {
                    zoomRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                  });
                } else if (e.key === "Escape" && zoomOpen) {
                  e.stopPropagation();
                  setZoomOpen(false);
                }
              }}
              className={`flex min-h-9 items-center gap-0.5 rounded-full px-2.5 text-xs font-semibold tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent focus-visible:ring-offset-1 focus-visible:ring-offset-editor-surface ${
                /*
                 * A fit mode is a sticky STATE (it recomputes on the next
                 * resize), so it earns a marker — but a filled accent chip here
                 * competed with the active-tool chip two groups away and made
                 * two different things look equally "selected". Reviewed against
                 * a real screenshot: the mode now reads as accent TEXT on the
                 * group's own surface, which states the fact without claiming
                 * the same emphasis as the active tool.
                 */
                fitMode
                  ? "bg-editor-surface text-editor-accent shadow-sm"
                  : "text-editor-text hover:bg-editor-surface hover:shadow-sm"
              }`}
              aria-label={zoomTriggerAccessibleName(zoom, fitMode)}
              aria-haspopup="menu"
              aria-expanded={zoomOpen}
              title="Zoom level (Ctrl+1 = 100%, Ctrl+2 = 200%, Ctrl+0 = fit page)"
            >
              <span className={show.fitModeOnTrigger ? "text-center" : "min-w-11 text-center"}>
                {show.fitModeOnTrigger ? zoomTriggerLabel(zoom, fitMode) : zoomTriggerLabelCompact(zoom)}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
            {zoomOpen ? (
              <div
                role="menu"
                aria-label="Zoom level"
                // Opens UPWARD: the capsule is pinned to the canvas bottom, so a
                // downward menu would render off-screen.
                className="absolute bottom-full left-1/2 z-50 mb-2 w-40 -translate-x-1/2 overflow-hidden rounded-appcard border border-editor-border bg-editor-surface py-1 shadow-appmenu"
                onKeyDown={(e) => {
                  const items = Array.from(
                    zoomRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
                  );
                  if (e.key === "Escape" || e.key === "Tab") {
                    if (e.key === "Escape") e.preventDefault();
                    setZoomOpen(false);
                    if (e.key === "Escape") zoomTriggerRef.current?.focus();
                    return;
                  }
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || items.length === 0) return;
                  e.preventDefault();
                  const index = items.indexOf(document.activeElement as HTMLButtonElement);
                  const next =
                    e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? items.length - 1
                        : e.key === "ArrowDown"
                          ? (index + 1 + items.length) % items.length
                          : (index - 1 + items.length) % items.length;
                  items[next].focus();
                }}
              >
                {onFitMode
                  ? FIT_OPTIONS.map((f) => (
                      <button
                        key={f.value}
                        type="button"
                        role="menuitem"
                        className={`flex min-h-9 w-full items-center px-3 text-left text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent ${
                          fitMode === f.value
                            ? "bg-editor-accentsoft text-editor-accent"
                            : "text-editor-text hover:bg-editor-subtle"
                        }`}
                        onClick={() => {
                          setZoomOpen(false);
                          onFitMode(f.value);
                          zoomTriggerRef.current?.focus();
                        }}
                      >
                        {f.label}
                      </button>
                    ))
                  : null}
                {onFitMode && onZoomPreset ? (
                  <div className="my-1 h-px bg-editor-border" aria-hidden="true" />
                ) : null}
                {onZoomPreset
                  ? ZOOM_PRESETS.map((z) => (
                      <button
                        key={z}
                        type="button"
                        role="menuitem"
                        className={`flex min-h-9 w-full items-center px-3 text-left text-[13px] tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent ${
                          fitMode === null && zoomReadout(z) === zoomReadout(zoom)
                            ? "bg-editor-accentsoft text-editor-accent"
                            : "text-editor-text hover:bg-editor-subtle"
                        }`}
                        onClick={() => {
                          setZoomOpen(false);
                          onZoomPreset(z);
                          zoomTriggerRef.current?.focus();
                        }}
                      >
                        {zoomReadout(z)}%
                      </button>
                    ))
                  : null}
              </div>
            ) : null}
          </div>
        ) : (
          <span className="min-w-12 text-center text-xs font-semibold tabular-nums text-editor-text">
            {zoomReadout(zoom)}%
          </span>
        )}

        <CapsuleButton
          label="Zoom in (Ctrl+=)"
          onClick={onZoomIn}
          disabled={!canZoomIn(zoom)}
          disabledReason={zoomInBlocked}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </CapsuleButton>
      </CapsuleGroup>

      {show.fitButton ? (
        <CapsuleButton
          label="Fit page (Ctrl+0)"
          onClick={onFitPage}
          active={fitMode === "fit-page"}
          /*
           * "state", not "tool": this is the same fact the zoom trigger states,
           * so it gets the same quieter treatment. Measured in the browser after
           * the trigger was toned down — this button was still painting the
           * filled accentsoft chip, byte-identical to the ACTIVE Select tool
           * (both rgb(243,238,255) + accent text), so a Fit-page document showed
           * two equally-"selected" chips and the actual interaction tool lost its
           * only visual claim to being the active one. `aria-pressed` still
           * reports the real pressed state; only the emphasis changes.
           */
          activeTone="state"
        >
          <Maximize className="h-4 w-4" aria-hidden="true" />
        </CapsuleButton>
      ) : null}

      {/*
       * Page navigation. Rendered for a single-page document too, with both
       * chevrons disabled and a stated reason — the previous build hid the group
       * entirely, which left a bar whose separators implied a control that was
       * not there, and removed the "1 / 1" confirmation that the document really
       * is one page.
       */}
      {show.pages ? (
        <>
          <Divider />
          <CapsuleGroup>
            <CapsuleButton
              label="Previous page (PageUp)"
              onClick={onPrevPage}
              disabled={!canGoPrevPage(pageNumber, pageCount)}
              disabledReason={prevBlocked}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </CapsuleButton>
            <PageField pageNumber={pageNumber} pageCount={pageCount} onGoToPage={onGoToPage} />
            <CapsuleButton
              label="Next page (PageDown)"
              onClick={onNextPage}
              disabled={!canGoNextPage(pageNumber, pageCount)}
              disabledReason={nextBlocked}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </CapsuleButton>
          </CapsuleGroup>
        </>
      ) : null}

      {/*
       * Page overview + Inspector. Both reveal a REAL surface: the overview is
       * the Pages rail (which owns every implemented page operation), and the
       * Inspector toggle drives the single right dock. There is no Fullscreen
       * control because this build integrates no Fullscreen API at all — an icon
       * that did nothing would be exactly the fake affordance the phase forbids.
       */}
      {(show.inspector && (onPageOverview || onToggleInspector)) ? (
        <>
          <Divider />
          <CapsuleGroup>
            {onPageOverview ? (
              <CapsuleButton
                label="Page overview"
                onClick={onPageOverview}
                active={pageOverviewActive}
              >
                <Files className="h-4 w-4" aria-hidden="true" />
              </CapsuleButton>
            ) : null}
            {onToggleInspector ? (
              <CapsuleButton
                label={inspectorActive ? "Hide inspector" : "Show inspector"}
                onClick={onToggleInspector}
                active={inspectorActive}
              >
                <PanelRight className="h-4 w-4" aria-hidden="true" />
              </CapsuleButton>
            ) : null}
          </CapsuleGroup>
        </>
      ) : null}
    </div>
  );
}

/**
 * The page readout — an input when jumping is wired, plain text otherwise.
 *
 * Kept as a controlled-on-blur field rather than on-change: re-rendering the
 * canvas on every keystroke of a multi-digit page number would jump the view
 * through pages 1 → 12 → 120 while the user is still typing "120".
 */
function PageField({
  pageNumber,
  pageCount,
  onGoToPage,
}: {
  pageNumber: number;
  pageCount: number;
  onGoToPage?: (pageNumber: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  if (!onGoToPage) {
    return (
      <span
        aria-live="polite"
        className="min-w-16 px-1 text-center text-xs font-semibold tabular-nums text-editor-text"
      >
        {pageNumber} / {pageCount}
      </span>
    );
  }

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const resolved = resolvePageEntry(draft, pageCount);
    if (resolved !== null && resolved !== pageNumber) onGoToPage(resolved);
  };

  return (
    <span className="flex items-center gap-1 px-1 text-xs font-semibold tabular-nums text-editor-text">
      <input
        type="text"
        inputMode="numeric"
        value={draft ?? String(pageNumber)}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`Page ${pageNumber} of ${pageCount}. Type a page number to jump.`}
        // h-8: a 32px field inside a 36px control row — the Inspector's shared
        // rhythm, and above WCAG 2.5.8's 24px minimum.
        className="h-8 w-9 rounded-control border border-editor-border bg-editor-surface text-center tabular-nums outline-none focus:border-editor-accent focus-visible:ring-2 focus-visible:ring-editor-accent"
      />
      <span className="text-editor-muted">/ {pageCount}</span>
    </span>
  );
}

/**
 * A visually grouped run of controls (I18).
 *
 * The inset surface is what makes `[ − | 100% | + ]` read as one zoom control
 * rather than three unrelated floating buttons. The tint is deliberately close to
 * the border token rather than a hairline outline: at this size a second ring
 * inside the capsule's own ring reads as clutter, while a filled trough reads as
 * one control. Reviewed against a real screenshot — at `subtle/70` the grouping
 * was invisible, so it is the solid inset tone.
 */
function CapsuleGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-editor-bg p-0.5 ring-1 ring-inset ring-editor-border/60">
      {children}
    </div>
  );
}

/**
 * One capsule control: 36px hit target, visible focus, accent when active.
 *
 * `disabledReason` is appended to the tooltip and the accessible name, so a
 * disabled control explains itself instead of being an unexplained grey icon
 * (I11). A `title` on a disabled button is still shown by browsers; the reason
 * is in the accessible name too, because `aria-disabled` content is reachable by
 * screen readers where a bare visual grey-out is not.
 *
 * `activeTone` separates two things that were previously drawn identically:
 *
 *  - "tool" (default) — an active INTERACTION MODE (Select/Hand, page overview,
 *    Inspector open). Exactly one interaction tool is active at a time and it
 *    changes what the pointer does, so it earns the filled accent chip.
 *  - "state" — a sticky VIEW STATE (Fit page). True at the same time as a tool,
 *    so drawing it with the same filled chip made two controls look equally
 *    "selected". It keeps the accent glyph (the state is still legible) on the
 *    group's own raised surface instead of the accent fill.
 */
function CapsuleButton({
  label,
  onClick,
  disabled,
  disabledReason,
  active = false,
  activeTone = "tool",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string | null;
  active?: boolean;
  activeTone?: "tool" | "state";
  children: React.ReactNode;
}) {
  const fullLabel = disabled && disabledReason ? `${label} — ${disabledReason}` : label;
  const activeClass =
    activeTone === "state"
      ? "bg-editor-surface text-editor-accent shadow-sm"
      : "bg-editor-accentsoft text-editor-accent shadow-sm";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={fullLabel}
      title={fullLabel}
      aria-pressed={active}
      className={`flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent focus-visible:ring-offset-1 focus-visible:ring-offset-editor-surface ${
        active
          ? activeClass
          : "text-editor-muted hover:bg-editor-surface hover:text-editor-text hover:shadow-sm"
      } ${disabled ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:shadow-none" : ""}`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-0.5 h-5 w-px shrink-0 bg-editor-border" aria-hidden="true" />;
}
