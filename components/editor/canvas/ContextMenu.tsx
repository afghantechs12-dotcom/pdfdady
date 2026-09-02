"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EditorActionHandlers } from "@/hooks/editor/useEditorActions";
import { useEditorContext } from "@/components/editor/EditorContext";
import { getGroupId } from "@/src/domain/editor/objects";
import { getActivePage } from "@/src/domain/editor/document";
import {
  clampMenuPosition,
  resolveContextMenu,
  type ContextMenuActionId,
} from "@/components/editor/canvas/contextMenuLogic";

/**
 * The right-click context menu (Part 9, expanded in M6.15). What renders and
 * what's enabled comes ENTIRELY from the pure `resolveContextMenu` — this
 * component only maps action ids to handlers and manages menu behavior:
 * viewport-edge clamping, focus-on-open with arrow-key navigation, focus
 * return on close, Escape/outside-click dismissal, and menu semantics
 * (role=menu/menuitem). The `contextmenu` DOM event also fires from the
 * keyboard menu key / Shift+F10 and from long-press on most touch browsers,
 * so those open it too.
 */
export interface ContextMenuProps {
  position: { x: number; y: number };
  handlers: EditorActionHandlers;
  onClose: () => void;
  /** Enters crop mode for the selected image (M6.15). */
  onCropImage?: () => void;
}

export function ContextMenu({ position, handlers, onClose, onCropImage }: ContextMenuProps) {
  const { state, selection } = useEditorContext();
  const ref = useRef<HTMLDivElement>(null);
  const page = getActivePage(state);
  const selectedObjs = selection.ids
    .map((id) => page.objects[id])
    .filter((o): o is NonNullable<typeof o> => Boolean(o));

  const items = resolveContextMenu({
    selectionCount: selectedObjs.length,
    selectedKinds: selectedObjs.map((o) => o.kind),
    anyLocked: selectedObjs.some((o) => o.locked),
    anyVisible: selectedObjs.some((o) => o.visible),
    anyGrouped: selectedObjs.some((o) => getGroupId(o) !== null),
    selectedObjects: selectedObjs,
  });

  const dispatch = (id: ContextMenuActionId) => {
    switch (id) {
      case "cut": handlers.cut(); break;
      case "copy": handlers.copy(); break;
      case "paste": handlers.paste(); break;
      case "duplicate": handlers.duplicate(); break;
      case "delete": handlers.delete(); break;
      case "bringForward": handlers.bringForward(); break;
      case "sendBackward": handlers.sendBackward(); break;
      case "bringToFront": handlers.bringToFront(); break;
      case "sendToBack": handlers.sendToBack(); break;
      case "lock": handlers.toggleLock(); break;
      case "hide": handlers.toggleHide(); break;
      case "group": handlers.group(); break;
      case "ungroup": handlers.ungroup(); break;
      case "cropImage": onCropImage?.(); break;
    }
    onClose();
  };

  // Viewport-edge collision (M6.15): measure after first paint and clamp.
  const [clamped, setClamped] = useState(position);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setClamped(
      clampMenuPosition(
        position,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [position]);

  // Focus management: remember the opener, focus the first enabled item, and
  // return focus on unmount (close).
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Arrow-key navigation between enabled items (menu semantics).
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const buttons = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (buttons.length === 0) return;
    e.preventDefault();
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % buttons.length;
    else next = idx < 0 ? buttons.length - 1 : (idx - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Object actions"
      className="fixed z-50 min-w-44 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg"
      style={{ left: clamped.x, top: clamped.y }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onMenuKeyDown}
    >
      {items.map((item) => (
        <span key={item.id} className="block">
          {item.sectionStart ? <Divider /> : null}
          <Item
            label={item.label}
            shortcut={item.shortcut}
            disabled={!item.enabled}
            onClick={() => dispatch(item.id)}
          />
        </span>
      ))}
    </div>
  );
}

function Item({ label, shortcut, disabled, onClick }: { label: string; shortcut?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      role="menuitem"
      className={`flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left ${
        disabled ? "cursor-not-allowed text-slate-300" : "text-slate-700 hover:bg-violet-50 focus-visible:bg-violet-50 focus-visible:outline-none"
      }`}
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
    >
      <span>{label}</span>
      {shortcut ? <span className="text-xs text-slate-400">{shortcut}</span> : null}
    </button>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-slate-100" role="separator" />;
}
