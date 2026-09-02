"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEditorContext } from "@/components/editor/EditorContext";
import type { EditorTool } from "@/components/editor/editorTypes";
import {
  toolPersistence,
  toolStateLabel,
} from "@/src/application/editor/tools/toolSession";
import type { PointerSubject, ValueSubject } from "@/components/editor/viewport/pointerSubject";
import {
  TOOL_LABELS,
  formatPageCoords,
  formatZoomPercent,
  interactionSummary,
  summarizeSelection,
  type InteractionStatus,
} from "@/components/editor/statusBarLogic";
import type { Point } from "@/src/domain/editor/geometry";

/**
 * The editor status bar (M6): a full-width bottom strip with the current zoom,
 * the page indicator with prev/next chevrons (replacing the old floating
 * page-nav footer), the selection summary, live pointer coordinates in page
 * units, and the active tool. The coordinates update every pointer frame, so
 * they are NOT a live region (no role="status" — that would spam screen
 * readers); they subscribe to a {@link PointerSubject} so only the small
 * readout re-renders, not the workspace tree.
 */
export interface StatusBarProps {
  zoom: number;
  tool: EditorTool;
  pointer: PointerSubject;
  /** Live crop/pen interaction state (M6.14); rendered only while relevant. */
  interaction?: ValueSubject<InteractionStatus>;
  /**
   * Compact presentation: the workspace measured the editor's own container as
   * narrow, so page/zoom/tool navigation has moved into the floating bottom
   * capsule (FloatingCanvasControls). The status bar keeps only the selection
   * summary and live interaction readout — the things the capsule does not
   * replace. The page/zoom controls stay wired for keyboard shortcuts; they are
   * just no longer duplicated on screen.
   */
  compact?: boolean;
  /**
   * Whether the active tool is pinned. Turns the tool readout from a NAME into a
   * name plus a persistence — "Rectangle" alone cannot tell you whether the next
   * click draws another rectangle or selects the one you just made, and that is
   * the question this readout exists to answer.
   */
  toolPinned?: boolean;
  /**
   * Rendered hard right, after a flexible gap.
   *
   * The save-status readout lives here rather than being built in: this bar states
   * what the VIEW is (zoom, page, tool, pointer) and the save status states where the
   * user's work IS. Keeping the second one a slot means the status bar has no opinion
   * about persistence, and the surface that owns the persistence binding passes it in.
   */
  trailing?: React.ReactNode;
}

export function StatusBar({
  zoom,
  tool,
  pointer,
  interaction,
  compact = false,
  toolPinned = false,
  trailing,
}: StatusBarProps) {
  const { state, activePage, selection, actions } = useEditorContext();
  const pages = state.document.pages;
  const pageIndex = pages.findIndex((p) => p.id === activePage.id);

  const goTo = (index: number) => {
    const page = pages[index];
    if (page) actions.setActivePage(page.id);
  };

  return (
    <div className="flex w-full items-center gap-3 border-t border-editor-border bg-editor-surface px-3 py-1 text-xs text-editor-muted">
      {!compact ? (
        <>
          {/* Page indicator + navigation (replaces the old floating footer). */}
          <div className="flex items-center gap-1">
            <button
              className="inline-flex min-h-6 min-w-6 items-center justify-center rounded outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent disabled:opacity-30"
              onClick={() => goTo(pageIndex - 1)}
              disabled={pageIndex <= 0}
              aria-label="Previous page (PageUp)"
              title="Previous page (PageUp)"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <span className="tabular-nums">
              Page {pageIndex + 1} of {pages.length}
            </span>
            <button
              className="inline-flex min-h-6 min-w-6 items-center justify-center rounded outline-none hover:bg-editor-subtle focus-visible:ring-2 focus-visible:ring-editor-accent disabled:opacity-30"
              onClick={() => goTo(pageIndex + 1)}
              disabled={pageIndex >= pages.length - 1}
              aria-label="Next page (PageDown)"
              title="Next page (PageDown)"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <Divider />
          <span className="tabular-nums" aria-label={`Zoom ${formatZoomPercent(zoom)}`}>
            {formatZoomPercent(zoom)}
          </span>
        </>
      ) : null}

      {/* Selection summary — hidden in the compact (mobile) layout. */}
      <span className="hidden sm:inline">
        <Divider />
      </span>
      <span className="hidden sm:inline">{summarizeSelection(selection.objects.map((o) => o.kind))}</span>

      {/* Crop / pen interaction state — rendered only while relevant. */}
      {interaction ? <InteractionReadout interaction={interaction} /> : null}

      <div className="flex-1" />

      {/* Live pointer coordinates — intentionally hidden from screen readers,
          and from the compact layout (no room, and touch has no hover pointer). */}
      <span className="hidden sm:inline">
        <PointerReadout pointer={pointer} />
      </span>

      {!compact ? (
        <>
          <Divider />
          <span
            aria-label={`Active tool: ${TOOL_LABELS[tool]} — ${toolStateLabel({
              active: tool,
              pinned: toolPinned,
            })}`}
          >
            {TOOL_LABELS[tool]}
            {/* The persistence in words, not a colour: a one-shot tool that is
                about to disarm looks identical to a pinned one otherwise. */}
            <span className="ml-1.5 text-editor-muted">
              {toolPinned ? "· pinned" : toolPersistence(tool) === "one-shot" ? "· one use" : ""}
            </span>
          </span>
        </>
      ) : null}

      {/* `ml-auto` on the wrapper, not a spacer element: an empty flex child would
          still take the row's gap and shift every readout left of it. */}
      {trailing ? <div className="ml-auto flex items-center">{trailing}</div> : null}
    </div>
  );
}

/** The live x/y readout; the only component that re-renders on pointer move. */
function PointerReadout({ pointer }: { pointer: PointerSubject }) {
  const [coords, setCoords] = useState<Point | null>(() => pointer.get());
  useEffect(() => pointer.subscribe(setCoords), [pointer]);
  return (
    <span className="min-w-20 text-right tabular-nums text-editor-muted" aria-hidden="true">
      {formatPageCoords(coords)}
    </span>
  );
}

/**
 * The crop-size / pen-anchor readout (M6.14). Subscribes to the interaction
 * subject so only this leaf re-renders during a crop drag; renders nothing
 * while idle (no misleading placeholder). Not a live region — per-frame crop
 * sizes would spam screen readers; the tool announcement covers mode entry.
 */
function InteractionReadout({ interaction }: { interaction: ValueSubject<InteractionStatus> }) {
  const [status, setStatus] = useState<InteractionStatus>(() => interaction.get());
  useEffect(() => interaction.subscribe(setStatus), [interaction]);
  const text = interactionSummary(status);
  if (!text) return null;
  return (
    <>
      <Divider />
      <span className="tabular-nums text-editor-accent">{text}</span>
    </>
  );
}

function Divider() {
  // A span (not a div) so it can nest inside inline wrappers legally.
  return <span className="inline-block h-4 w-px bg-editor-border align-middle" aria-hidden="true" />;
}
