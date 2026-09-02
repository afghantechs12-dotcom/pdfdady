"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorColor } from "@/src/domain/editor/objects";
import { describeColor, formatHex, pushRecentColor } from "@/src/domain/editor/colorModel";
import { placeAnchoredPopover, type PopoverPlacement } from "./colorPopoverLayout";
import { ColorPopoverPanel } from "./ColorPopoverPanel";
import {
  SAVED_SWATCHES_KEY,
  parseSavedSwatches,
  serializeSavedSwatches,
} from "./savedSwatches";

const PANEL_WIDTH = 268;
/**
 * The panel's height is measured after mount, but placement must be decided
 * BEFORE the first paint or the popover appears at the wrong end of the
 * inspector for a frame. This estimate is used for that first decision and
 * replaced by the measurement immediately after.
 */
const PANEL_HEIGHT_ESTIMATE = 380;

/**
 * The editor's colour control: a swatch trigger plus an anchored popover.
 *
 * It REPLACES two things that violated the product's own acceptance criteria:
 * a native `<input type="color">` (an unstyled OS dialog with no opacity, no
 * document palette, and no keyboard story we control) and a text field showing
 * raw `rgba(0.48,0.23,0.93,1)` (a developer representation presented as a
 * property value). The trigger now reads as a swatch plus a hex label, and the
 * popover owns every representation.
 *
 * Value contract: `EditorColor | null`, the document's own type. No CSS-string
 * round-trip, so nothing can be lost or thrown in translation.
 */
export function ColorPicker({
  label,
  value,
  onChange,
  documentColors = [],
  allowNoFill = false,
  disabled = false,
  emptyLabel = "No fill",
  triggerClassName,
}: {
  /** The property this colour belongs to ("Fill", "Stroke") — used in names. */
  label: string;
  value: EditorColor | null;
  onChange: (next: EditorColor | null) => void;
  /** Colours already used in the document, offered as swatches. */
  documentColors?: readonly EditorColor[];
  /** Whether `null` is a legal value for this property. */
  allowNoFill?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  /**
   * The host's shared control shell (height, border, radius, focus ring). Passed
   * in rather than re-declared here so a colour row is the same 32px box as a
   * number row — the inspector's one-shell invariant, checked by
   * `inspectorControls.test.ts`.
   */
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const [recents, setRecents] = useState<EditorColor[]>([]);
  const [saved, setSaved] = useState<EditorColor[]>([]);
  // The value at open time, so Reset has something to restore even after several
  // intermediate edits.
  const openedWith = useRef<EditorColor | null>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // Saved swatches are read once per mount rather than on every open: reading
  // localStorage synchronously inside a click handler is a layout-blocking call
  // on a control the user is actively driving.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      setSaved(parseSavedSwatches(window.localStorage.getItem(SAVED_SWATCHES_KEY)));
    } catch {
      // Private-mode / disabled storage. Saved swatches degrade to
      // session-only rather than breaking the picker.
    }
  }, []);

  const persistSaved = useCallback((next: EditorColor[]) => {
    setSaved(next);
    try {
      window.localStorage.setItem(SAVED_SWATCHES_KEY, serializeSavedSwatches(next));
    } catch {
      // As above: the in-memory palette still works for this session.
    }
  }, []);

  const measure = useCallback(() => {
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const height = panelRef.current?.offsetHeight ?? PANEL_HEIGHT_ESTIMATE;
    setPlacement(
      placeAnchoredPopover(
        { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height },
        { width: PANEL_WIDTH, height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, []);

  // Measure before paint so the panel never renders at a stale position.
  useLayoutEffect(() => {
    if (!open) return;
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    // Capture on scroll so an ancestor (the inspector's own scroll container)
    // moving the trigger is seen, not just window scroll.
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
    // Focus returns to the trigger, so a keyboard user is not dropped at the top
    // of the document after closing.
    triggerRef.current?.focus();
  }, []);

  // Escape closes; an outside pointerdown closes. Both are registered only while
  // open, so a closed picker costs nothing.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);

  // Move focus into the panel on open, so the keyboard path continues where the
  // user's attention went.
  useEffect(() => {
    if (!open || !placement) return;
    const first = panelRef.current?.querySelector<HTMLElement>(
      "[data-swatch], input, button",
    );
    first?.focus();
  }, [open, placement]);

  const handleChange = useCallback(
    (next: EditorColor | null) => {
      onChange(next);
      if (next) setRecents((list) => pushRecentColor(list, next));
    },
    [onChange],
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        // The name says the property, the state and the value: "Fill, #7C3AED".
        // A swatch with no name is unusable by a screen reader, and a name of
        // just "Fill" hides what it is currently set to.
        aria-label={`${label}: ${describeColor(value, emptyLabel)}`}
        onClick={() => {
          openedWith.current = value;
          setOpen((v) => !v);
        }}
        className={[
          triggerClassName ??
            "h-8 min-w-0 flex-1 rounded-control border border-editor-border bg-editor-surface px-2 text-xs text-editor-text",
          "flex items-center gap-1.5 text-left",
          disabled ? "cursor-not-allowed" : "hover:border-editor-borderstrong",
          // An OPEN picker is marked by a ring, not only by the panel being
          // visible: with the panel possibly flipped above and off to one side,
          // the ring is what ties it back to the row it belongs to.
          open ? "ring-2 ring-editor-selection" : "",
        ].join(" ")}
      >
        {/* The swatch. Checkerboarded so a translucent value reads as
            translucent and an empty one as empty — a plain white square would
            look identical to "no fill" and to "white". */}
        <span
          aria-hidden="true"
          className="h-5 w-5 shrink-0 rounded-[5px] border border-black/10"
          style={
            value === null
              ? { backgroundColor: "#F8FAFC" }
              : {
                  backgroundImage: `linear-gradient(${formatHex(value)}, ${formatHex(value)}), repeating-conic-gradient(#CBD5E1 0% 25%, #FFFFFF 0% 50%)`,
                  backgroundSize: "100% 100%, 8px 8px",
                  opacity: 1,
                }
          }
        >
          {value === null ? (
            <svg viewBox="0 0 20 20" className="h-full w-full text-slate-400" aria-hidden="true">
              <line x1="3" y1="17" x2="17" y2="3" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          ) : null}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono uppercase">
          {value === null ? emptyLabel : formatHex(value)}
        </span>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              id={panelId}
              role="dialog"
              aria-label={`${label} colour`}
              data-side={placement?.side ?? "below"}
              className={[
                "fixed z-[75] rounded-appmenu border border-editor-border bg-editor-surface p-3 shadow-appmenu",
                // 120–160ms fade+scale, from the popover tier of the motion
                // scale. `motion-reduce` drops the scale and the translate but
                // keeps the opacity, so the popover still reads as arriving
                // without anything moving.
                "animate-[colorPopIn_140ms_ease-out] motion-reduce:animate-[colorPopFade_140ms_ease-out]",
              ].join(" ")}
              style={{
                left: placement?.x ?? -9999,
                top: placement?.y ?? -9999,
                width: PANEL_WIDTH,
                // The transform origin follows the flip, so the panel scales out
                // of the trigger rather than away from it.
                transformOrigin: placement?.side === "above" ? "bottom left" : "top left",
                // Hidden until measured, so it cannot flash at the wrong place.
                visibility: placement ? "visible" : "hidden",
              }}
              onKeyDown={(event) => {
                // Focus containment: Tab cycles within the panel. Without this,
                // Tab escapes into the page behind an open dialog.
                if (event.key !== "Tab") return;
                const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
                );
                if (!focusables || focusables.length === 0) return;
                const list = Array.from(focusables);
                const first = list[0];
                const last = list[list.length - 1];
                if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                } else if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                }
              }}
            >
              <ColorPopoverPanel
                value={value}
                initialValue={openedWith.current}
                documentColors={documentColors}
                recentColors={recents}
                savedColors={saved}
                allowNoFill={allowNoFill}
                onChange={handleChange}
                onSaveSwatch={persistSaved}
                onRemoveSwatch={persistSaved}
                onClose={close}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
