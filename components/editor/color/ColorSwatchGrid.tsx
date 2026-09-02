"use client";

import { useEffect, useRef, useState } from "react";
import type { EditorColor } from "@/src/domain/editor/objects";
import { describeColor, formatHex, sameColor, swatchInkTone } from "@/src/domain/editor/colorModel";
import { asSwatchGridKey, nextSwatchIndex } from "./swatchGrid";

const COLUMNS = 6;

/**
 * One labelled row of colour swatches.
 *
 * It is a SINGLE tab stop with a roving `tabIndex`, navigated by arrow keys —
 * not N tab stops. Tabbing through 36 swatches to reach the hex field below
 * would read as a broken control, and the ARIA grid/listbox pattern exists
 * precisely for composite widgets like this.
 *
 * Selection is marked by a ring AND a check glyph, never by colour alone: on a
 * swatch, "the selected one is the highlighted one" is circular, because every
 * cell is already a different colour. The check's tone flips with the swatch's
 * luminance so it stays visible on white and on black.
 */
export function ColorSwatchGrid({
  label,
  colors,
  value,
  onPick,
  onRemove,
  removeHint,
}: {
  label: string;
  colors: readonly EditorColor[];
  value: EditorColor | null;
  onPick: (color: EditorColor) => void;
  /** When given, a swatch can be deleted with Delete/Backspace (saved palettes). */
  onRemove?: (color: EditorColor) => void;
  removeHint?: string;
}) {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // A palette that shrinks (a swatch removed, a document colour gone) must not
  // strand the roving index past the end, or the grid would have no focusable cell.
  useEffect(() => {
    setActive((i) => (colors.length === 0 ? 0 : Math.min(i, colors.length - 1)));
  }, [colors.length]);

  if (colors.length === 0) return null;

  function focusCell(index: number) {
    const cell = ref.current?.querySelectorAll<HTMLButtonElement>("[data-swatch]")[index];
    cell?.focus();
  }

  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-editor-muted">
        {label}
      </p>
      <div
        ref={ref}
        role="listbox"
        aria-label={label}
        aria-orientation="horizontal"
        className="grid grid-cols-6 gap-1.5"
        onKeyDown={(event) => {
          if (onRemove && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault();
            onRemove(colors[active]);
            return;
          }
          const key = asSwatchGridKey(event.key);
          if (!key) return;
          const next = nextSwatchIndex(active, key, colors.length, COLUMNS);
          // Only swallow the key when the grid actually moved, so an arrow at
          // the edge can still fall through rather than being silently eaten.
          if (next === active) return;
          event.preventDefault();
          setActive(next);
          focusCell(next);
        }}
      >
        {colors.map((color, index) => {
          const selected = sameColor(color, value);
          const tone = swatchInkTone(color);
          return (
            <button
              key={`${formatHex(color)}-${index}`}
              type="button"
              data-swatch
              role="option"
              aria-selected={selected}
              aria-label={onRemove ? `${describeColor(color)}. ${removeHint ?? "Press Delete to remove"}` : describeColor(color)}
              title={describeColor(color)}
              tabIndex={index === active ? 0 : -1}
              onFocus={() => setActive(index)}
              onClick={() => onPick(color)}
              style={{ backgroundColor: formatHex(color) }}
              className={[
                // A fixed 24px cell with a 2px inset ring. The ring is drawn
                // INSIDE via box-shadow so a selected swatch does not grow and
                // shift the row — layout must not move when selection changes.
                "relative h-6 w-full rounded-control border border-black/10",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection focus-visible:ring-offset-1",
                selected ? "ring-2 ring-editor-selection ring-offset-1" : "",
              ].join(" ")}
            >
              {selected ? (
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  className={[
                    "absolute inset-0 m-auto h-3.5 w-3.5",
                    tone === "dark" ? "text-black/75" : "text-white",
                  ].join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={3.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
