"use client";

import { useEffect, useRef, useState } from "react";
import {
  INSPECTOR_DOCK_KEY,
  drawerAfterResize,
  resolveActiveInspectorTab,
  resolveInspectorTabs,
  resolvePanelLayout,
  resolvePanelMode,
  type InspectorTabId,
  type PanelLayout,
  type PanelMode,
} from "@/components/editor/editorPanelLayout";
import {
  isInspectorVisible,
  preserveInspectorVisibility,
} from "@/components/editor/canvasGeometry";

/**
 * Drives the editor's single right-hand Inspector from the real viewport width.
 *
 * The width is measured in an effect rather than during render: the server has
 * no viewport, and guessing one produces markup that disagrees with the client
 * and gets thrown away at hydration. `mode` is therefore null on the first
 * paint, and callers render the docked default until it resolves — one frame,
 * versus lying to the server renderer.
 */
export interface EditorPanelsState {
  /** Null until measured on the client. */
  mode: PanelMode | null;
  layout: PanelLayout;
  /** The tab actually being shown (never one that is unavailable). */
  activeTab: InspectorTabId;
  /** The tabs available right now — one entry when there is no workspace document. */
  tabs: readonly InspectorTabId[];
  /** Selects a tab, opening the Inspector if it is currently closed. */
  selectTab: (tab: InspectorTabId) => void;
  /** Toggles the Inspector: docks/undocks where it can dock, else drawer. */
  toggleInspector: () => void;
  closeDrawer: () => void;
  inspectorDocked: boolean;
}

/**
 * @param hasDocumentPanel Whether a workspace document backs this editor, which
 *   is what decides if Outline/Comments/Versions exist at all.
 */
export function useEditorPanels(hasDocumentPanel = false): EditorPanelsState {
  const [width, setWidth] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inspectorDocked, setInspectorDocked] = useState(true);
  // The tab the user last asked for. Session-only: which tab you were reading is
  // not a durable layout preference, and restoring `comments` into an editor
  // whose document has since closed is exactly the stale state the resolver
  // below has to defend against anyway.
  const [requestedTab, setRequestedTab] = useState<InspectorTabId>("properties");

  // Restore the durable dock preference. Only this one is persisted — a drawer
  // opened on a phone is transient and must not follow the user to a desktop.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(INSPECTOR_DOCK_KEY);
      if (stored !== null) setInspectorDocked(stored === "true");
    } catch {
      // Private mode / storage disabled: the default stands.
    }
  }, []);

  useEffect(() => {
    const measure = () => setWidth(window.innerWidth);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Before measurement, assume the docked desktop layout: it is what the
  // majority of sessions resolve to, so the corrective frame is rare.
  const mode: PanelMode | null = width === null ? null : resolvePanelMode(width);
  const layout = resolvePanelLayout({
    mode: mode ?? "docked",
    inspectorDocked,
    drawerOpen,
  });

  const tabs = resolveInspectorTabs(hasDocumentPanel);
  const activeTab = resolveActiveInspectorTab(requestedTab, tabs);

  // A resize that docks the Inspector retires its floating copy.
  useEffect(() => {
    setDrawerOpen((current) => drawerAfterResize(current, layout));
    // Keyed on the resolved presentation, which is what actually decides this.
  }, [layout.inspector]);

  /*
   * Canvas monotonicity: a resize may change HOW the Inspector is presented, but
   * never WHETHER it is presented.
   *
   * The measured defect this fixes — viewport 1199 -> 1200 took the canvas from
   * 1023px to 704px. Crossing the dock threshold let the persisted "keep it
   * docked" preference re-assert itself on a user who had the Inspector closed,
   * so one pixel of window growth cost 319 pixels of page. No threshold or rail
   * arithmetic can absorb that (see `canvasGeometry`); the only honest fix is to
   * stop the transition from changing visibility.
   *
   * The PREVIOUS frame's visibility is what matters, so it is captured in a ref
   * that this effect updates only after it has read it. Reading `layout` directly
   * inside the effect would sample the state the mode flip has ALREADY produced,
   * which is the thing being corrected.
   */
  const visibleRef = useRef(isInspectorVisible(layout.inspector));
  const lastModeRef = useRef<PanelMode | null>(mode);
  useEffect(() => {
    if (mode === null) return;
    const previous = lastModeRef.current;
    lastModeRef.current = mode;
    // Only a genuine mode CHANGE can invert the canvas; the first measurement
    // must not reinterpret the restored preference.
    if (previous === null || previous === mode) return;
    const next = preserveInspectorVisibility({
      wasVisible: visibleRef.current,
      nextMode: mode,
      persistedDock: inspectorDocked,
    });
    setInspectorDocked(next.inspectorDocked);
    setDrawerOpen(next.drawerOpen);
    // Deliberately keyed on `mode` alone: this is the resize response, not a
    // reaction to the user opening or closing the panel themselves. Re-running
    // it when `inspectorDocked` changes would make the user's own open/close a
    // second trigger for the visibility-preserving branch above.
    //
    // No `eslint-disable-next-line react-hooks/exhaustive-deps` here: this
    // config (see eslint.config.mjs) does not install the react-hooks plugin,
    // and a directive naming an unregistered rule is itself an ESLint error.
    // The omission is intentional and documented; re-add the directive in the
    // same commit that adds the plugin.
  }, [mode]);

  // Recorded AFTER the resize effect above, so that effect always reads the
  // visibility from before the width changed.
  useEffect(() => {
    visibleRef.current = isInspectorVisible(layout.inspector);
  }, [layout.inspector]);

  const persistDock = (next: boolean) => {
    try {
      window.localStorage.setItem(INSPECTOR_DOCK_KEY, String(next));
    } catch {
      // Preference is best-effort; the session still works.
    }
  };

  const toggleInspector = () => {
    // Where the Inspector can dock, the toggle IS the dock preference; elsewhere
    // it opens a transient drawer. Same control, honest behaviour per width.
    if (mode === "docked") {
      setInspectorDocked((prev) => {
        const next = !prev;
        persistDock(next);
        return next;
      });
      // Undocking must not leave a drawer copy behind (and re-docking closes it).
      setDrawerOpen(false);
      return;
    }
    setDrawerOpen((prev) => !prev);
  };

  const selectTab = (tab: InspectorTabId) => {
    setRequestedTab(tab);
    // Asking for a tab is asking to SEE it: a tab click that silently changed a
    // hidden panel's state would read as a dead control. Re-open whichever way
    // this width can show the panel.
    if (mode === "docked") {
      if (!inspectorDocked) {
        setInspectorDocked(true);
        persistDock(true);
        setDrawerOpen(false);
      }
      return;
    }
    setDrawerOpen(true);
  };

  return {
    mode,
    layout,
    activeTab,
    tabs,
    selectTab,
    toggleInspector,
    closeDrawer: () => setDrawerOpen(false),
    inspectorDocked,
  };
}
