"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Columns2, Link2, Square, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  canOpenSplit,
  canSynchronize,
  historyControls,
  isCollapsedForWidth,
  isPaneSwitchShortcut,
  paneAnnouncement,
  paneLabel,
  paneSwitchLabel,
  paneSwitchTarget,
  paneTabLabel,
  splitToggleLabel,
  syncOptions,
  visiblePanes,
  type PaneViewModel,
} from "./splitViewLogic";
import type { NavigationHistory, PaneId, SplitLayout, SyncMode } from "@/src/domain/entities/SplitView";

export interface SplitWorkspaceViewProps {
  layout: SplitLayout;
  activePane: PaneId;
  panes: PaneViewModel[];
  syncMode: SyncMode;
  /** Per-pane navigation history, for the back and forward controls. */
  histories: Partial<Record<PaneId, NavigationHistory>>;
  error?: string | null;
  onFocusPane: (pane: PaneId) => void | Promise<void>;
  onSelectTab: (pane: PaneId, tabId: string) => void | Promise<void>;
  onMoveTabToPane: (tabId: string, pane: PaneId) => void | Promise<void>;
  onClosePane: (pane: PaneId) => void | Promise<void>;
  onOpenSplit: () => void | Promise<void>;
  onSyncModeChange: (mode: SyncMode) => void | Promise<void>;
  onBack: (pane: PaneId) => void | Promise<void>;
  onForward: (pane: PaneId) => void | Promise<void>;
  /** Renders a pane's document. The workbench supplies the viewer. */
  renderPane?: (pane: PaneViewModel) => React.ReactNode;
}

/**
 * The M7.13 split workspace view.
 *
 * Three behaviours are load-bearing and each is pinned by a test in
 * `splitViewLogic.test.ts`.
 *
 * **Narrow screens collapse the rendering, never the arrangement.** Below the
 * split breakpoint only the active pane is shown; the tab-to-pane assignment is
 * untouched, so rotating a phone does not silently rearrange a workspace and
 * widening the window restores it exactly.
 *
 * **Focus decides where commands go.** The active pane is the one holding the
 * active tab, so a keyboard user who moved to the right pane does not have their
 * next action applied to the left. Alt+Left / Alt+Right switch panes, chosen
 * because the browser and the editor already claim most Ctrl/Cmd combinations.
 *
 * **Every pane is a labelled region with its own history controls**, so a
 * screen-reader user can tell the two apart and navigate each independently.
 */
export function SplitWorkspaceView({
  layout,
  activePane,
  panes,
  syncMode,
  histories,
  error = null,
  onFocusPane,
  onSelectTab,
  onMoveTabToPane,
  onClosePane,
  onOpenSplit,
  onSyncModeChange,
  onBack,
  onForward,
  renderPane,
}: SplitWorkspaceViewProps) {
  const [viewportWidth, setViewportWidth] = useState(1280);
  const [announcement, setAnnouncement] = useState("");
  const statusId = useId();
  const syncId = useId();

  useEffect(() => {
    function measure() {
      setViewportWidth(window.innerWidth);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const switchTarget = paneSwitchTarget(layout, activePane, panes);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = isPaneSwitchShortcut(event);
      if (target === null) return;
      const pane = panes.find((p) => p.id === target);
      if (!pane || pane.tabs.length === 0) return;
      event.preventDefault();
      void onFocusPane(target);
      setAnnouncement(paneAnnouncement(target, layout));
    },
    [layout, onFocusPane, panes],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const shown = useMemo(
    () => visiblePanes(layout, activePane, viewportWidth),
    [layout, activePane, viewportWidth],
  );
  const collapsed = isCollapsedForWidth(layout, viewportWidth);
  const totalTabs = panes.reduce((sum, pane) => sum + pane.tabs.length, 0);

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {layout === "single" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenSplit()}
              disabled={!canOpenSplit(totalTabs)}
              title={
                canOpenSplit(totalTabs)
                  ? undefined
                  : "Open a second document to use split view."
              }
            >
              <Columns2 className="mr-2 h-4 w-4" aria-hidden="true" />
              {splitToggleLabel(layout)}
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={() => onClosePane("right")}>
              <Square className="mr-2 h-4 w-4" aria-hidden="true" />
              {splitToggleLabel(layout)}
            </Button>
          )}

          {switchTarget !== null && (
            <Button type="button" variant="secondary" onClick={() => onFocusPane(switchTarget)}>
              {paneSwitchLabel(switchTarget)}
            </Button>
          )}
        </div>

        {canSynchronize(layout) && (
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-navy-soft" aria-hidden="true" />
            <label htmlFor={syncId} className="text-sm font-medium text-navy-soft">
              Panes
            </label>
            <select
              id={syncId}
              value={syncMode}
              onChange={(event) => onSyncModeChange(event.target.value as SyncMode)}
              className="rounded-button border border-softborder px-3 py-2 text-sm text-navy focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {syncOptions().map((option) => (
                <option key={option.value} value={option.value} title={option.description}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div id={statusId} aria-live="polite" className="sr-only">
        {error ?? announcement}
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-button bg-red-50 p-3 text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {collapsed && (
        <p className="text-xs text-navy-soft">
          Showing one pane. Both panes return on a wider screen — your layout is unchanged.
        </p>
      )}

      {/* Panes */}
      <div
        className={
          shown.length === 2
            ? "grid grid-cols-1 gap-3 md:grid-cols-2"
            : "grid grid-cols-1 gap-3"
        }
      >
        {shown.map((paneId) => {
          const pane = panes.find((p) => p.id === paneId);
          if (!pane) return null;
          const controls = historyControls(histories[paneId] ?? { entries: [], cursor: -1 });

          return (
            <section
              key={paneId}
              aria-label={paneLabel(paneId, layout)}
              onFocus={() => onFocusPane(paneId)}
              className={
                pane.active && layout === "split"
                  ? "rounded-card border-2 border-primary bg-white"
                  : "rounded-card border border-softborder bg-white"
              }
            >
              {/* Pane header: tabs and per-pane history */}
              <div className="flex items-center justify-between gap-2 border-b border-softborder p-2">
                <div role="tablist" aria-label={`${paneLabel(paneId, layout)} documents`} className="flex flex-wrap gap-1">
                  {pane.tabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={pane.activeTabId === tab.id}
                      aria-label={paneTabLabel(tab)}
                      onClick={() => onSelectTab(paneId, tab.id)}
                      className={
                        pane.activeTabId === tab.id
                          ? "rounded-button bg-primary-soft px-3 py-1 text-xs font-semibold text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                          : "rounded-button px-3 py-1 text-xs font-medium text-navy-soft hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      }
                    >
                      {tab.title || "Untitled document"}
                      {tab.dirty && <span aria-hidden="true"> •</span>}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={controls.backLabel}
                    disabled={!controls.canGoBack}
                    onClick={() => onBack(paneId)}
                    className="rounded-button p-1 text-navy-soft disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={controls.forwardLabel}
                    disabled={!controls.canGoForward}
                    onClick={() => onForward(paneId)}
                    className="rounded-button p-1 text-navy-soft disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </button>
                  {layout === "split" && (
                    <button
                      type="button"
                      aria-label={`Close ${paneLabel(paneId, layout).toLowerCase()}`}
                      onClick={() => onClosePane(paneId)}
                      className="rounded-button p-1 text-navy-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              <div className="min-h-[12rem] p-3">
                {pane.tabs.length === 0 ? (
                  <p className="text-sm text-navy-soft">
                    No document in this pane. Move a tab here to compare side by side.
                  </p>
                ) : (
                  (renderPane?.(pane) ?? (
                    <p className="text-sm text-navy-soft">
                      {pane.tabs.find((t) => t.id === pane.activeTabId)?.title ??
                        "Untitled document"}
                    </p>
                  ))
                )}
              </div>

              {/* Moving a tab across panes, available without a pointer drag. */}
              {layout === "split" && pane.activeTabId !== null && (
                <div className="border-t border-softborder p-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      onMoveTabToPane(pane.activeTabId!, paneId === "left" ? "right" : "left")
                    }
                  >
                    Move to {paneId === "left" ? "right" : "left"} pane
                  </Button>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
