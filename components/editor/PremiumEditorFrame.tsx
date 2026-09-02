"use client";

import type { Ref } from "react";

/**
 * PremiumEditorFrame — the presentation shell of the premium editor redesign.
 *
 * PURE PRESENTATION. This component owns no editor/domain state, imports no
 * editor services, and cannot mutate a document. It is the skeleton every
 * editor surface shares: the branded app-header region, the document tabs /
 * breadcrumb strip, the toolbar, the left navigation rail, the canvas (the
 * dominant centered surface), the right inspector regions, the floating
 * control capsule, the status bar, transient notices, and the scrims/drawers
 * that overlay the frame.
 *
 * All the real state lives above it: `EditorWorkspace` owns the tool/viewport/
 * page/load state and hands this frame plain rendered slots. The frame's only
 * job is to lay those slots out with the shell's measurement discipline:
 *
 *   - `min-w-0` / `min-h-0` on every flex child, so no slot can grow a
 *     horizontal scrollbar of its own or refuse to shrink under its widest
 *     content;
 *   - explicit overflow containment (the editor is `overflow-hidden` at the
 *     root — any scrolling happens inside a slot, never the shell);
 *   - the `editor-*` token family for surfaces/borders/accent;
 *   - a cool light application background behind the canvas so the white page
 *     reads as the surface being edited.
 */
export interface PremiumEditorFrameProps {
  /**
   * The branded app-header region. The standalone shell passes its own header
   * here; the workbench keeps its chrome outside the frame.
   */
  appHeader?: React.ReactNode;
  /** Document tabs / breadcrumb strip, rendered between appHeader and toolbar. */
  tabsSlot?: React.ReactNode;
  /** The toolbar region. */
  toolbar?: React.ReactNode;
  /** Left navigation (Pages | Layers | History). Omit where absent. */
  leftNav?: React.ReactNode;
  /** The canvas region — dominant and centered. Required. */
  canvas: React.ReactNode;
  /**
   * Docked right inspector regions (Properties / Document). Rendered as a
   * shrink-0 strip on the right; nothing docks unless the measured width
   * affords it (`useEditorPanels` decides).
   */
  rightInspector?: React.ReactNode;
  /**
   * The floating control capsule, over the canvas bottom.
   *
   * Rendered INSIDE the canvas region, not at the frame root. It used to be a
   * frame-root sibling pinned with `left-1/2`, which centred it on the whole
   * editor — but the canvas is inset by the left rail (176px) and the Inspector
   * dock (320px), so the capsule was measurably off-centre: 72px right of the
   * canvas centre at 1440px, and 88px LEFT of it at 1024px where the dock
   * disappears. It also overlapped the status bar by 13px, because the frame
   * bottom is below the canvas. Living in the canvas region makes it track the
   * rail collapsing and the Inspector docking with no measurement at all.
   */
  floatingControls?: React.ReactNode;
  /** The status bar. */
  statusBar?: React.ReactNode;
  /** Transient alerts/notices, under the toolbar. */
  notices?: React.ReactNode;
  /** Scrims, drawers, and context menus that overlay the frame. */
  overlays?: React.ReactNode;
  /**
   * Assigned to the frame root so a caller can drive container-width-driven
   * presentation (floating controls, compact status bar) from the real editor
   * width rather than a viewport breakpoint.
   */
  containerRef?: Ref<HTMLDivElement>;
}

export function PremiumEditorFrame({
  appHeader,
  tabsSlot,
  toolbar,
  leftNav,
  canvas,
  rightInspector,
  floatingControls,
  statusBar,
  notices,
  overlays,
  containerRef,
}: PremiumEditorFrameProps) {
  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-editor-bg"
    >
      {/* Branded app header (standalone shell). */}
      {appHeader}

      {/* Document tabs / breadcrumb (workbench tab strip). */}
      {tabsSlot}

      {/* Toolbar */}
      {toolbar}

      {/* Transient notices */}
      {notices}

      {/* The working region: left nav · canvas · right inspector. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {leftNav}

        {/* Canvas is the dominant surface; the shell's background is the cool
            light application tone so the white page reads as the surface being
            edited. All scrolling is contained inside the canvas region.

            A REGION, not `<main>`. This frame is mounted in two places: the
            standalone `/editor` route and, inside `AppShell`, the Workspace
            document workbench. `AppShell` already renders `<main id="main">`, so
            claiming a document-level landmark for a region put two `main`
            landmarks in one document there (invalid HTML, and an ARIA violation)
            while `/editor` still had none — which is why the root layout's
            "Skip to content" link pointed at nothing on that route. One `main`
            per document is now the route's job, matching what the layout comment
            has always claimed; this stays a labelled region so the canvas is
            still reachable from a landmark list. */}
        <section
          aria-label="Document canvas"
          className="relative flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden"
        >
          {canvas}

          {/*
            The floating capsule, anchored to the CANVAS region's bottom centre.

            The wrapper is `pointer-events-none` and full-width so it can centre
            its child without becoming an invisible click-blocking band across
            the page: everything the capsule itself does not cover keeps reaching
            the canvas, which is what keeps an in-progress draw stroke or a drag
            near the page bottom from being swallowed.
          */}
          {floatingControls ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
              {floatingControls}
            </div>
          ) : null}
        </section>

        {rightInspector}
      </div>

      {/* Status bar */}
      {statusBar}

      {/* Scrims / drawers / context menus */}
      {overlays}
    </div>
  );
}
