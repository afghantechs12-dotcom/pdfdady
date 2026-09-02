"use client";

import { Minus, Plus } from "lucide-react";

import {
  ALL_BRUSHES,
  BRUSH_LABELS,
} from "@/src/application/editor/tools/drawingGeometry";
import {
  MAX_DRAW_WIDTH,
  MIN_DRAW_WIDTH,
  withBrush,
  withColor,
  withOpacity,
  withWidth,
  type DrawSettings,
} from "@/src/application/editor/tools/drawSettings";
import { ColorPicker } from "@/components/editor/color/ColorPicker";

/**
 * The Draw tool's contextual controls.
 *
 * Shown only while a drawing tool is active — this is the "I am in Draw mode"
 * signal the review asked for, and the reason a stroke's brush/color/width were
 * previously unreachable. Presentation only: every change is a pure transition
 * from `drawSettings.ts`, so the rules (per-brush defaults, clamping, alpha
 * preservation) are unit-tested away from the DOM.
 *
 * Deliberately NOT a popover. A drawing user changes width and color repeatedly
 * mid-task; burying them one click deep is what makes a drawing tool feel slow.
 */
export interface DrawControlsProps {
  settings: DrawSettings;
  onChange: (next: DrawSettings) => void;
  /** Presentational hint: hide the labels when horizontal room is scarce. */
  compact?: boolean;
}

const WIDTH_STEP = 1;

export function DrawControls({ settings, onChange, compact = false }: DrawControlsProps) {
  const opacityPercent = Math.round(settings.color.a * 100);

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 border-b border-editor-border bg-editor-surface px-3 py-2"
      role="group"
      aria-label="Drawing options"
    >
      {/* Brush */}
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Brush">
        {ALL_BRUSHES.map((brush) => {
          const active = settings.brush === brush;
          return (
            <button
              key={brush}
              type="button"
              role="radio"
              aria-checked={active}
              title={BRUSH_LABELS[brush]}
              onClick={() => onChange(withBrush(settings, brush))}
              className={[
                "inline-flex min-h-[32px] items-center gap-1.5 rounded-control border px-2 text-[11px] font-semibold transition-colors",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent",
                active
                  ? "border-editor-accent bg-editor-accentsoft text-editor-accent"
                  : "border-editor-border bg-editor-surface text-editor-text hover:bg-editor-subtle",
              ].join(" ")}
            >
              <BrushSwatch brush={brush} />
              {compact ? null : BRUSH_LABELS[brush]}
            </button>
          );
        })}
      </div>

      <Divider />

      {/* Color. The same popover the inspector uses — one colour experience in
          the product, not a native OS dialog here and a designed picker there.
          The drawing colour is always set (a stroke has to have a colour), so
          `allowNoFill` is off and the commit ignores a null. */}
      <div className="flex min-h-[32px] items-center gap-1.5 text-[11px] font-semibold text-editor-text">
        {compact ? null : <span>Color</span>}
        <ColorPicker
          label="Stroke colour"
          value={settings.color}
          onChange={(c) => c && onChange(withColor(settings, c))}
          triggerClassName="h-7 w-[76px] rounded-control border border-editor-border bg-editor-surface px-1.5 text-[11px] text-editor-text"
        />
      </div>

      <Divider />

      {/* Width — steppers plus a range, so it is usable by pointer and keyboard. */}
      <div className="flex min-h-[32px] items-center gap-1.5">
        {compact ? null : (
          <span className="text-[11px] font-semibold text-editor-text">Width</span>
        )}
        <IconStep
          label="Decrease stroke width"
          onClick={() => onChange(withWidth(settings, settings.width - WIDTH_STEP))}
          disabled={settings.width <= MIN_DRAW_WIDTH}
        >
          <Minus size={12} aria-hidden="true" />
        </IconStep>
        <input
          type="range"
          aria-label="Stroke width"
          min={MIN_DRAW_WIDTH}
          max={MAX_DRAW_WIDTH}
          step={WIDTH_STEP}
          value={settings.width}
          onChange={(e) => onChange(withWidth(settings, Number(e.target.value)))}
          className="h-1 w-20 cursor-pointer accent-editor-accent"
        />
        <IconStep
          label="Increase stroke width"
          onClick={() => onChange(withWidth(settings, settings.width + WIDTH_STEP))}
          disabled={settings.width >= MAX_DRAW_WIDTH}
        >
          <Plus size={12} aria-hidden="true" />
        </IconStep>
        <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-editor-muted">
          {settings.width}pt
        </span>
      </div>

      <Divider />

      {/* Opacity */}
      <div className="flex min-h-[32px] items-center gap-1.5">
        {compact ? null : (
          <span className="text-[11px] font-semibold text-editor-text">Opacity</span>
        )}
        <input
          type="range"
          aria-label="Stroke opacity"
          min={0}
          max={100}
          step={1}
          value={opacityPercent}
          onChange={(e) => onChange(withOpacity(settings, Number(e.target.value) / 100))}
          className="h-1 w-20 cursor-pointer accent-editor-accent"
        />
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-editor-muted">
          {opacityPercent}%
        </span>
      </div>
    </div>
  );
}

/** A width/character preview per brush, so the choice reads at a glance. */
function BrushSwatch({ brush }: { brush: (typeof ALL_BRUSHES)[number] }) {
  const height = brush === "pencil" ? 1 : brush === "pen" ? 2 : brush === "marker" ? 4 : 6;
  const opacity = brush === "highlighter" ? 0.35 : brush === "marker" ? 0.6 : 1;
  return (
    <span
      aria-hidden="true"
      className="inline-block w-3.5 rounded-full bg-current"
      style={{ height, opacity }}
    />
  );
}

function Divider() {
  return <span aria-hidden="true" className="h-5 w-px shrink-0 bg-editor-border" />;
}

function IconStep({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-6 w-6 items-center justify-center rounded border border-editor-border bg-editor-surface text-editor-text transition-colors hover:bg-editor-subtle disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent"
    >
      {children}
    </button>
  );
}
