"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Pipette, Plus, RotateCcw, Slash } from "lucide-react";
import type { EditorColor } from "@/src/domain/editor/objects";
import {
  brandSwatches,
  describeColor,
  formatHex,
  parseHex,
  sameColor,
} from "@/src/domain/editor/colorModel";
import { ColorSwatchGrid } from "./ColorSwatchGrid";
import { applyChannel, channelFields, type ChannelMode } from "./colorPopoverState";
import { addSavedSwatch, removeSavedSwatch, savedSwatchesFull } from "./savedSwatches";

const BRAND = brandSwatches();

/**
 * The body of the colour popover: swatch rows, hex, RGB/HSL channels, opacity,
 * eyedropper, no-fill and reset.
 *
 * Split from the floating shell so the panel's controls can be reasoned about
 * without the positioning/portal/focus machinery in the same file.
 *
 * Two commit rules matter and are not obvious:
 *
 *  - The HEX field commits on blur/Enter, never per keystroke. "#7C3A" is a
 *    legal 4-digit colour AND the fourth character of "#7C3AED", so a
 *    parse-as-you-type field would flash the object lime on the way to purple
 *    and leave an undo entry for each flash. (`colorModel.test.ts` pins this.)
 *  - Channels and opacity commit on change, because their input is already
 *    constrained to a valid number — there is no half-typed intermediate that
 *    means a different colour.
 */
export function ColorPopoverPanel({
  value,
  initialValue,
  documentColors,
  recentColors,
  savedColors,
  allowNoFill,
  onChange,
  onSaveSwatch,
  onRemoveSwatch,
  onClose,
}: {
  value: EditorColor | null;
  /** The value when the popover opened — what Reset restores. */
  initialValue: EditorColor | null;
  documentColors: readonly EditorColor[];
  recentColors: readonly EditorColor[];
  savedColors: readonly EditorColor[];
  /** Only true where `null` is a meaningful value (a fill or stroke, not text ink). */
  allowNoFill: boolean;
  onChange: (next: EditorColor | null) => void;
  onSaveSwatch: (next: EditorColor[]) => void;
  onRemoveSwatch: (next: EditorColor[]) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ChannelMode>("rgb");
  // The colour the editors operate on. `null` (no fill) has no channels, so the
  // editors fall back to black — picking a channel then means "stop being empty
  // and start from black", which is what a user reaching for R/G/B intends.
  const color: EditorColor = value ?? { r: 0, g: 0, b: 0, a: 1 };
  const fields = useMemo(() => channelFields(color, mode), [color, mode]);

  // The hex field keeps the user's DRAFT text while typing so a partially-typed
  // value is not overwritten by a re-render, and shows the committed value again
  // whenever the colour changes from elsewhere (a swatch click, the eyedropper).
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const committedHex = value === null ? "" : formatHex(color);
  useEffect(() => setHexDraft(null), [committedHex]);
  const hexInvalid = hexDraft !== null && parseHex(hexDraft) === null && hexDraft.trim() !== "";

  function commitHex(text: string) {
    const parsed = parseHex(text);
    // Alpha is owned by the opacity slider, so a 6-digit hex must not silently
    // reset a 40%-opacity fill to fully opaque.
    if (parsed) onChange({ ...parsed, a: text.trim().replace(/^#/, "").length === 8 || text.trim().replace(/^#/, "").length === 4 ? parsed.a : color.a });
    setHexDraft(null);
  }

  const eyedropperAvailable =
    typeof window !== "undefined" && "EyeDropper" in window;

  return (
    <div className="flex flex-col gap-3">
      <ColorSwatchGrid label="Brand" colors={BRAND} value={value} onPick={(c) => onChange({ ...c, a: color.a })} />
      {documentColors.length > 0 ? (
        <ColorSwatchGrid
          label="In this document"
          colors={documentColors}
          value={value}
          onPick={(c) => onChange({ ...c, a: color.a })}
        />
      ) : null}
      {recentColors.length > 0 ? (
        <ColorSwatchGrid
          label="Recent"
          colors={recentColors}
          value={value}
          onPick={(c) => onChange({ ...c, a: color.a })}
        />
      ) : null}
      <ColorSwatchGrid
        label="Saved"
        colors={savedColors}
        value={value}
        onPick={(c) => onChange({ ...c, a: color.a })}
        onRemove={(c) => onRemoveSwatch(removeSavedSwatch(savedColors, c))}
        removeHint="Press Delete to remove this saved swatch"
      />

      <div className="h-px bg-editor-border" />

      {/* Hex + the current-value preview. The preview is checkerboarded so a
          translucent or white colour is distinguishable from an empty one. */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-8 w-8 shrink-0 rounded-control border border-black/10"
          style={{
            backgroundImage:
              value === null
                ? undefined
                : `linear-gradient(${formatHex(color)}, ${formatHex(color)}), repeating-conic-gradient(#CBD5E1 0% 25%, #FFFFFF 0% 50%)`,
            backgroundSize: "100% 100%, 10px 10px",
            backgroundColor: value === null ? "#F8FAFC" : undefined,
          }}
        />
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-editor-muted">Hex</span>
          <input
            type="text"
            inputMode="text"
            spellCheck={false}
            value={hexDraft ?? committedHex}
            placeholder={value === null ? "None" : undefined}
            aria-label="Hex colour value"
            aria-invalid={hexInvalid || undefined}
            aria-describedby={hexInvalid ? "color-hex-error" : undefined}
            data-editor-text-input="true"
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitHex((e.target as HTMLInputElement).value);
              } else if (e.key === "Escape" && hexDraft !== null) {
                // Escape abandons the draft first; a second Escape closes the
                // popover. Closing on the first press would discard the edit
                // AND the popover in one keystroke.
                e.stopPropagation();
                setHexDraft(null);
              }
            }}
            className={[
              "min-w-0 flex-1 rounded-control border bg-editor-surface px-2 py-1 font-mono text-[11px] uppercase text-editor-text",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection",
              hexInvalid ? "border-red-400" : "border-editor-border",
            ].join(" ")}
          />
        </label>
        {eyedropperAvailable ? (
          <button
            type="button"
            aria-label="Pick a colour from the screen"
            title="Pick a colour from the screen"
            onClick={async () => {
              try {
                const Picker = (window as unknown as {
                  EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> };
                }).EyeDropper;
                const result = await new Picker().open();
                const picked = parseHex(result.sRGBHex);
                if (picked) onChange({ ...picked, a: color.a });
              } catch {
                // The user cancelled the eyedropper (Escape / click-away). That
                // is a normal outcome, not an error worth surfacing.
              }
            }}
            className="shrink-0 rounded-control border border-editor-border p-1.5 text-editor-muted hover:bg-editor-subtle hover:text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection"
          >
            <Pipette className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {hexInvalid ? (
        <p id="color-hex-error" role="alert" className="-mt-1.5 text-[11px] text-red-600">
          Not a colour. Try a hex value like #7C3AED.
        </p>
      ) : null}

      {/* RGB / HSL switch. A segmented control, not a select: two options with a
          visible current state is clearer than a collapsed menu. */}
      <div className="flex items-center gap-2">
        <div role="group" aria-label="Colour model" className="flex rounded-control border border-editor-border p-0.5">
          {(["rgb", "hsl"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={[
                "rounded-[6px] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection",
                mode === m
                  ? "bg-editor-selectionsoft text-editor-selection"
                  : "text-editor-muted hover:text-editor-text",
              ].join(" ")}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 gap-1.5">
          {fields.map((field) => (
            <label key={field.key} className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[9px] font-semibold uppercase tracking-wide text-editor-muted">
                {field.label}
                {field.unit ?? ""}
              </span>
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={1}
                value={field.value}
                aria-label={`${field.name}${field.unit ? ` in ${field.unit === "°" ? "degrees" : "percent"}` : ""}`}
                data-editor-text-input="true"
                onChange={(e) => {
                  const raw = Number.parseFloat(e.target.value);
                  // An emptied field means "mid-edit", not "zero" — leaving the
                  // colour alone avoids a black flash while retyping.
                  if (e.target.value === "") return;
                  onChange(applyChannel(color, mode, field.key, raw));
                }}
                className="w-full min-w-0 rounded-control border border-editor-border bg-editor-surface px-1.5 py-1 text-[11px] text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection"
              />
            </label>
          ))}
        </div>
      </div>

      {/* Opacity. A range plus a number, so it is usable by pointer and keyboard
          and its exact value is both visible and typeable. */}
      <div className="flex items-center gap-2">
        <label htmlFor="color-opacity" className="text-[10px] font-semibold uppercase tracking-wide text-editor-muted">
          Opacity
        </label>
        <input
          id="color-opacity"
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(color.a * 100)}
          aria-label="Opacity in percent"
          onChange={(e) => onChange({ ...color, a: Number.parseInt(e.target.value, 10) / 100 })}
          className="min-w-0 flex-1 accent-editor-selection"
        />
        <div className="flex items-center gap-0.5">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={Math.round(color.a * 100)}
            aria-label="Opacity percent"
            data-editor-text-input="true"
            onChange={(e) => {
              if (e.target.value === "") return;
              const pct = Number.parseFloat(e.target.value);
              if (!Number.isFinite(pct)) return;
              onChange({ ...color, a: Math.max(0, Math.min(100, pct)) / 100 });
            }}
            className="w-11 rounded-control border border-editor-border bg-editor-surface px-1.5 py-1 text-[11px] text-editor-text focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection"
          />
          <span aria-hidden="true" className="text-[11px] text-editor-muted">%</span>
        </div>
      </div>

      <div className="h-px bg-editor-border" />

      {/* Actions. Each carries an icon AND a word: an icon-only row of four
          small buttons is a guessing game. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {allowNoFill ? (
          <ActionButton
            icon={<Slash className="h-3 w-3" aria-hidden="true" />}
            label="No fill"
            pressed={value === null}
            onClick={() => onChange(null)}
          />
        ) : null}
        <ActionButton
          icon={savedColors.some((c) => sameColor(c, { ...color, a: 1 })) ? <Check className="h-3 w-3" aria-hidden="true" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
          label="Save swatch"
          disabled={value === null || savedSwatchesFull(savedColors)}
          disabledReason={
            value === null
              ? "There is no colour to save"
              : "The saved palette is full — remove a swatch first"
          }
          onClick={() => onSaveSwatch(addSavedSwatch(savedColors, color))}
        />
        <ActionButton
          icon={<RotateCcw className="h-3 w-3" aria-hidden="true" />}
          label="Reset"
          disabled={sameColor(value, initialValue)}
          disabledReason="The colour has not changed"
          onClick={() => onChange(initialValue)}
        />
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-control bg-editor-selection px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection focus-visible:ring-offset-1"
        >
          Done
        </button>
      </div>
      {/* The applied value in words, for a screen reader and for anyone who
          wants to confirm what is set without decoding a swatch. */}
      <p aria-live="polite" className="sr-only">
        {describeColor(value)}
      </p>
    </div>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  pressed,
  disabled,
  disabledReason,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // A disabled control explains itself rather than just refusing: the
      // reason is the useful part.
      title={disabled ? disabledReason : label}
      aria-pressed={pressed}
      className={[
        "inline-flex items-center gap-1 rounded-control border px-2 py-1 text-[11px] font-medium",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-selection",
        disabled ? "cursor-not-allowed border-editor-border text-editor-muted opacity-50" : "",
        !disabled && pressed
          ? "border-editor-selection bg-editor-selectionsoft text-editor-selection"
          : "",
        !disabled && !pressed ? "border-editor-border text-editor-text hover:bg-editor-subtle" : "",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}
