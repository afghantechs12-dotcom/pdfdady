"use client";

import { useEffect, useRef } from "react";
import { useEditorContext } from "@/components/editor/EditorContext";
import {
  DEFAULT_NUDGE_BIG,
  DEFAULT_NUDGE_SMALL,
  resolveShortcut,
  type KeyDescriptor,
} from "@/src/application/editor/shortcuts/ShortcutResolver";
import type { EditorTool } from "@/components/editor/editorTypes";
import { resolveToolKey } from "@/components/editor/toolbarLayout";
import { isTextInput } from "@/components/editor/domFocus";
import { getActivePage } from "@/src/domain/editor/document";

/** Zoom/page-nav/save/export callbacks the workspace wires into the shortcut manager. */
export interface ShortcutCallbacks {
  onToolChange: (t: EditorTool) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Ctrl+0 — the workspace maps this to "fit page" (M6 zoom system). */
  onZoomReset: () => void;
  /** Ctrl+1 — jump to 100% zoom. */
  onZoom100: () => void;
  /** Ctrl+2 — jump to 200% zoom. */
  onZoom200: () => void;
  /** PageUp / PageDown — previous/next page. */
  onPagePrev: () => void;
  onPageNext: () => void;
  /** Ctrl+Home / Ctrl+End — first/last page. */
  onPageFirst: () => void;
  onPageLast: () => void;
  onSave: () => void;
  onExport: () => void;
  /** Ctrl+F — opens (and refocuses) the in-document find bar. */
  onFind: () => void;
}

/** The action-handler set the shortcut manager dispatches to. */
export interface ShortcutHandlers {
  copy: () => void;
  cut: () => void;
  paste: () => void;
  duplicate: () => void;
  delete: () => void;
  selectAll: () => void;
  group: () => void;
  ungroup: () => void;
  nudge: (dx: number, dy: number, gestureKey?: string) => void;
  bringForward: () => void;
  sendBackward: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  toggleLock: () => void;
  toggleHide: () => void;
}

/**
 * Installs the centralized keyboard-shortcut manager (Part 8, M6.13). Tool
 * letters resolve through the pure `resolveToolKey` (canonical table +
 * availability gating); everything else resolves via {@link resolveShortcut}.
 * Shortcuts are suppressed while typing in an input/textarea/contenteditable.
 *
 * The window listener is registered ONCE — all changing values (handlers,
 * callbacks, state, selection) are read through latest-value refs, so pan/drag
 * re-renders don't churn the global listener (and its ordering relative to the
 * canvas's capture-phase handlers stays deterministic).
 */
export function useShortcuts(handlers: ShortcutHandlers, callbacks: ShortcutCallbacks): void {
  const { actions, selection, state } = useEditorContext();

  const latest = useRef({ actions, selection, state, handlers, callbacks });
  latest.current = { actions, selection, state, handlers, callbacks };

  // A held arrow key is ONE gesture: the same coalesce key is reused for the
  // whole auto-repeat run so the nudges merge into a single undo entry.
  const nudgeGestureRef = useRef({ key: "", counter: 0 });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const { actions, selection, state, handlers, callbacks } = latest.current;
      const editing = isTextInput(e.target);
      const key: KeyDescriptor = {
        key: e.key,
        ctrl: e.ctrlKey || e.metaKey,
        shift: e.shiftKey,
        alt: e.altKey,
      };
      const hasSelection = selection.ids.length > 0;

      // Tool-switch shortcuts (single letters, no modifiers, not while
      // typing, availability-gated — all encoded in the pure resolver).
      if (!editing && !key.ctrl && !key.alt && !key.shift) {
        const page = getActivePage(state);
        const selected = selection.ids
          .map((id) => page.objects[id])
          .filter((o): o is NonNullable<typeof o> => Boolean(o));
        const tool = resolveToolKey(e.key, {
          editing,
          ctrl: key.ctrl,
          alt: key.alt,
          shift: key.shift,
          selectedKinds: selected.map((o) => o.kind),
          selectedObjects: selected,
          anyLocked: selected.some((o) => o.locked),
        });
        if (tool) {
          e.preventDefault();
          callbacks.onToolChange(tool);
          return;
        }
        // An unavailable tool letter is a deliberate no-op: bare letters have
        // no resolver bindings, so falling through cannot double-dispatch.
      }

      const action = resolveShortcut(key, { isEditingText: editing, hasSelection });
      if (!action) return;
      // While editing text, let the field handle its own keys.
      //
      // `find` is the one exception the resolver emits from an editing context
      // (see its `isEditingText` branch): Ctrl+F must open/refocus the find bar
      // even when the caret is in a text field, and it must still preventDefault
      // so the browser's own find bar — which can only see the rendered DOM of
      // the current page — does not open instead.
      if (editing && action !== "find") return;

      e.preventDefault();
      switch (action) {
        case "undo": actions.undo(); break;
        case "redo": actions.redo(); break;
        case "copy": handlers.copy(); break;
        case "cut": handlers.cut(); break;
        case "paste": handlers.paste(); break;
        case "duplicate": handlers.duplicate(); break;
        case "delete": handlers.delete(); break;
        case "selectAll": handlers.selectAll(); break;
        case "group": handlers.group(); break;
        case "ungroup": handlers.ungroup(); break;
        case "bringForward": handlers.bringForward(); break;
        case "sendBackward": handlers.sendBackward(); break;
        case "bringToFront": handlers.bringToFront(); break;
        case "sendToBack": handlers.sendToBack(); break;
        case "nudge":
        case "nudgeBig": {
          // First press of a run mints a fresh coalesce key; auto-repeats
          // reuse it so the held-arrow slide is one undo entry (M6 review).
          if (!e.repeat) {
            nudgeGestureRef.current = {
              key: `nudge-${++nudgeGestureRef.current.counter}`,
              counter: nudgeGestureRef.current.counter,
            };
          }
          const step = action === "nudge" ? DEFAULT_NUDGE_SMALL : DEFAULT_NUDGE_BIG;
          handlers.nudge(arrowDx(e.key) * step, arrowDy(e.key) * step, nudgeGestureRef.current.key);
          break;
        }
        case "escape": actions.clearSelection(); break;
        case "zoomIn": callbacks.onZoomIn(); break;
        case "zoomOut": callbacks.onZoomOut(); break;
        case "zoomReset": callbacks.onZoomReset(); break;
        case "zoom100": callbacks.onZoom100(); break;
        case "zoom200": callbacks.onZoom200(); break;
        case "pagePrev": callbacks.onPagePrev(); break;
        case "pageNext": callbacks.onPageNext(); break;
        case "pageFirst": callbacks.onPageFirst(); break;
        case "pageLast": callbacks.onPageLast(); break;
        case "save": callbacks.onSave(); break;
        case "export": callbacks.onExport(); break;
        case "find": callbacks.onFind(); break;
        default:
          // enter/tab are text-editing actions; no-op on the canvas.
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function arrowDx(key: string): number {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  return 0;
}
function arrowDy(key: string): number {
  if (key === "ArrowUp") return -1;
  if (key === "ArrowDown") return 1;
  return 0;
}
