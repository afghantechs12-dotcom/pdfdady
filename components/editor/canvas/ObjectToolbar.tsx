"use client";

import { useRef } from "react";
import {
  Copy,
  Crop,
  Droplet,
  Highlighter,
  MessageSquarePlus,
  MoreHorizontal,
  Minus,
  Palette,
  Pencil,
  Replace,
  Square,
  Trash2,
} from "lucide-react";
import {
  placeObjectToolbar,
  type ObjectToolbarAction,
  type ObjectToolbarActionId,
} from "@/components/editor/canvas/objectToolbarActions";

/**
 * The floating contextual object toolbar (P1 Phase G).
 *
 * PURE PRESENTATION over `resolveObjectToolbar`'s verdict: this component holds
 * no policy about which actions exist for which object, so the read-only
 * source-text rule cannot be re-decided here. It renders the resolved list,
 * positions it with `placeObjectToolbar`, and calls back with an action id.
 *
 * Positioning is in the CANVAS CONTAINER's coordinate space (the caller passes a
 * container-relative selection box), so the bar tracks the object through pan and
 * zoom without a second coordinate model.
 *
 * A11y: `role="toolbar"` with a roving tabindex, matching the main tool row's
 * model. It is deliberately NOT focus-trapping — the user is working on the
 * canvas, and stealing focus on every selection change would make click-then-type
 * impossible. Escape hands focus back to the canvas.
 */
const ICONS: Record<ObjectToolbarActionId, typeof Copy> = {
  edit: Pencil,
  duplicate: Copy,
  delete: Trash2,
  replace: Replace,
  crop: Crop,
  fill: Square,
  stroke: Minus,
  color: Palette,
  width: Minus,
  opacity: Droplet,
  copyText: Copy,
  highlight: Highlighter,
  comment: MessageSquarePlus,
  more: MoreHorizontal,
};

export interface ObjectToolbarProps {
  actions: readonly ObjectToolbarAction[];
  /** Selection box in canvas-container coordinates. */
  box: { x: number; y: number; width: number; height: number };
  /** The canvas container's size, for clamping. */
  container: { width: number; height: number };
  onAction: (id: ObjectToolbarActionId) => void;
  /** Returns focus to the canvas on Escape. */
  onDismiss?: () => void;
  /** Describes what the bar is acting on, for the accessible name. */
  subjectLabel?: string;
}

/** Measured width of one action button + gap, for the placement estimate. */
const BUTTON_WIDTH = 34;
const BAR_PADDING = 10;

export function ObjectToolbar({
  actions,
  box,
  container,
  onAction,
  onDismiss,
  subjectLabel,
}: ObjectToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<ObjectToolbarActionId, HTMLButtonElement>());

  // Width is estimated from the action count rather than measured-then-corrected:
  // a measure/reposition pass makes the bar visibly jump on every selection.
  const width = actions.length * BUTTON_WIDTH + BAR_PADDING * 2;
  const placement = placeObjectToolbar(box, container, { width, height: 40 });

  const enabled = actions.filter((a) => a.enabled);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onDismiss?.();
      return;
    }
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key) || enabled.length === 0) return;
    e.preventDefault();
    const current = enabled.findIndex((a) => buttonRefs.current.get(a.id) === document.activeElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? enabled.length - 1
          : e.key === "ArrowRight"
            ? (current + 1 + enabled.length) % enabled.length
            : (current - 1 + enabled.length) % enabled.length;
    buttonRefs.current.get(enabled[next].id)?.focus();
  };

  // Keep the DOM order stable so a roving tabindex has a first stop even before
  // any button has been focused.
  const firstEnabled = enabled[0]?.id;

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={subjectLabel ? `Actions for ${subjectLabel}` : "Object actions"}
      onKeyDown={onKeyDown}
      // `pointer-events-auto` because the overlay layer above the canvas is
      // pass-through; without it the bar would be visible and unclickable.
      className="pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-controllg border border-editor-border bg-editor-surface/97 p-1 shadow-editorfloating backdrop-blur transition-[opacity,transform] duration-150 motion-reduce:transition-none"
      style={{ left: placement.left, top: placement.top }}
      data-side={placement.side}
    >
      {actions.map((a) => {
        const Icon = ICONS[a.id];
        const isFirst = a.id === firstEnabled;
        return (
          <button
            key={a.id}
            type="button"
            ref={(el) => {
              if (el) buttonRefs.current.set(a.id, el);
              else buttonRefs.current.delete(a.id);
            }}
            // 32px visual, 34px slot: this bar sits ON the document, so the
            // toolbar's 38-42px control height would cover the object it acts on.
            className={`flex h-8 min-w-8 items-center justify-center gap-1 rounded-control px-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent ${
              !a.enabled
                ? "cursor-not-allowed text-editor-muted opacity-40"
                : a.danger
                  ? "text-editor-text hover:bg-red-50 hover:text-red-600"
                  : "text-editor-text hover:bg-editor-accentsoft hover:text-editor-accent"
            }`}
            onClick={() => a.enabled && onAction(a.id)}
            disabled={!a.enabled}
            aria-disabled={!a.enabled || undefined}
            title={a.enabled ? a.label : `${a.label} — ${a.reason ?? "Unavailable"}`}
            aria-label={a.label}
            tabIndex={isFirst ? 0 : -1}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
