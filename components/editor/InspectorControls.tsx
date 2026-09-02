"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { EditorColor } from "@/src/domain/editor/objects";
import { ColorPicker } from "@/components/editor/color/ColorPicker";
import { useDocumentColors } from "@/components/editor/color/useDocumentColors";

/**
 * The Inspector control system (P1 Phase H, H5/H6/H12/H24-H27).
 *
 * Every control commits on change/blur via a callback; number fields keep a
 * local string state so typing intermediate values (e.g. "12"→"120") doesn't
 * fight the controlled value.
 *
 * ONE control shell, one row shell, one section shell. The point is that
 * height, padding, border, radius, focus ring and disabled treatment are
 * declared exactly once (H5) — a per-field copy is how an inspector drifts into
 * six subtly different input sizes.
 *
 * Every row is `flex min-w-0` with a fixed-width label and a `min-w-0` control.
 * Both halves matter: a flex item's default `min-width: auto` refuses to shrink
 * below its content's intrinsic width, and native `<input>`/`<select>` carry a
 * sizeable intrinsic width of their own. Without `min-w-0` on both the row and
 * the control, a long option label pushed the whole inspector wider than its
 * dock and produced the horizontal scrollbar this panel should never have.
 */

/** Shared row shell: fixed label column, shrinkable control column. */
const ROW = "flex min-w-0 items-center gap-1.5 text-xs text-editor-muted";
/**
 * 58px, not 52px: "Rotation" and "Opacity" are the longest labels the panel
 * uses and H6 forbids cryptic abbreviations, so the column has to fit the word
 * rather than the word being shortened to fit the column.
 */
const LABEL = "w-[58px] shrink-0 text-editor-muted";
/**
 * 32px (`h-8`) — the low end of the brief's 32-36px range (H5). The high end
 * costs ~8px per field, which at ten fields is a whole section pushed below the
 * fold in a 320px dock, so density wins. Deliberately NOT a template literal or
 * a concatenation: `propertiesOverflow.test.ts` reads this constant out of the
 * source as a single quoted string to check the anti-overflow contract.
 */
const CONTROL =
  "h-8 min-w-0 flex-1 rounded-control border border-editor-border bg-editor-surface px-2 text-xs text-editor-text transition-colors hover:border-editor-borderstrong focus:border-editor-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/30 disabled:cursor-not-allowed disabled:border-editor-border disabled:bg-editor-subtle disabled:text-editor-muted";
/** Section header/body padding, shared by collapsible and static groups. */
const SECTION_TITLE =
  "truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-editor-muted";
const SECTION_BODY = "min-w-0 space-y-2 px-3 pb-2.5";

/**
 * Parse/clamp/commit for a numeric field, shared by `NumberField` and the
 * compact `NumberPairRow` cells so the two cannot drift on rounding, clamping
 * or the revert-on-garbage behaviour.
 */
function useNumberCommit({
  value,
  min,
  max,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  onCommit: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(
      max ?? Number.POSITIVE_INFINITY,
      Math.max(min ?? Number.NEGATIVE_INFINITY, parsed),
    );
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return { text, setText, commit };
}

export function NumberField({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  disabled = false,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  const { text, setText, commit } = useNumberCommit({ value, min, max, onCommit });
  return (
    <label className={ROW}>
      <span className={LABEL}>{label}</span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`${CONTROL} tabular-nums`}
        data-editor-text-input="true"
      />
      {suffix ? (
        <span className="w-4 shrink-0 text-[11px] text-editor-muted">{suffix}</span>
      ) : null}
    </label>
  );
}

/** One cell of a `NumberPairRow`: a single-character label plus its input. */
function NumberCell({
  label,
  name,
  value,
  onCommit,
  min,
  max,
  step = 1,
  unit,
  disabled = false,
}: {
  /** The compact visible label ("X", "W") — conventional in a coordinate grid (H6). */
  label: string;
  /** The spoken name ("X position"); must CONTAIN `label` (WCAG 2.5.3). */
  name: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
}) {
  const { text, setText, commit } = useNumberCommit({ value, min, max, onCommit });
  return (
    <label className="flex min-w-0 items-center gap-1 text-xs text-editor-muted">
      <span className="w-3.5 shrink-0 text-center text-editor-muted" aria-hidden="true">
        {label}
      </span>
      <input
        type="number"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={unit ? `${name} (${unit})` : name}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`${CONTROL} tabular-nums`}
        data-editor-text-input="true"
      />
      {unit ? (
        <span className="w-3.5 shrink-0 text-[10px] text-editor-muted" aria-hidden="true">
          {unit}
        </span>
      ) : null}
    </label>
  );
}

export interface NumberPairSpec {
  label: string;
  name: string;
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}

/**
 * The 2-up numeric grid for X/Y and W/H (H25). Four full-width stacked inputs
 * cost ~4 rows of inspector height for two logically-paired values; a design
 * tool pairs them.
 *
 * `trailing` is a slot for a per-row affordance that belongs to the pair rather
 * than to either field — the aspect-ratio lock beside W/H (H14).
 */
export function NumberPairRow({
  first,
  second,
  unit,
  trailing,
}: {
  first: NumberPairSpec;
  second: NumberPairSpec;
  /** Unit shown beside each field and spoken in its label (H26). */
  unit?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="grid min-w-0 flex-1 grid-cols-2 gap-1.5">
        <NumberCell {...first} unit={unit} />
        <NumberCell {...second} unit={unit} />
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </div>
  );
}

export interface SegmentedItem {
  id: string;
  /** Accessible name and tooltip ("Bold", "Align left"). */
  label: string;
  /** Short visible text ("B", "I") — omit when `icon` carries the meaning. */
  text?: string;
  icon?: React.ReactNode;
  pressed: boolean;
  disabled?: boolean;
  /** Why it is unavailable, surfaced in the tooltip (H24). */
  reason?: string;
  onPress: () => void;
}

/**
 * A segmented button group, shared by the B/I toggles (H10) and alignment
 * (H11).
 *
 * Each button carries its own `aria-pressed`, so the SAME component serves
 * independent toggles (bold and italic are both on) and mutually-exclusive
 * choices (exactly one alignment) without a mode flag — the caller decides what
 * `pressed` means by how it computes it.
 *
 * Active state is carried by background AND text colour AND a ring, never by
 * colour alone (H10).
 */
export function SegmentedControl({
  label,
  items,
}: {
  /** Group name for assistive tech (H44) — e.g. "Text style", "Text alignment". */
  label: string;
  items: readonly SegmentedItem[];
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex min-w-0 items-center gap-0.5 rounded-control border border-editor-border bg-editor-subtle p-0.5"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={item.pressed}
          aria-label={item.label}
          title={item.disabled ? `${item.label} — ${item.reason ?? "Unavailable"}` : item.label}
          disabled={item.disabled}
          onClick={item.onPress}
          className={`flex h-7 min-w-0 flex-1 items-center justify-center rounded-[6px] text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/40 disabled:cursor-not-allowed disabled:opacity-40 ${
            item.pressed
              ? "bg-editor-surface text-editor-accent ring-1 ring-editor-accent/40"
              : "text-editor-muted hover:bg-editor-surface hover:text-editor-text"
          }`}
        >
          {item.icon ?? null}
          {item.text ? <span className={item.icon ? "ml-1" : ""}>{item.text}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onCommit,
  disabled = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onCommit: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className={ROW}>
      <span className={LABEL}>{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value as T)}
        // `truncate` matters here: a long option label (a substituted PDF font
        // name) would otherwise widen the select past its dock.
        className={`${CONTROL} truncate`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ColorField({
  label,
  value,
  onCommit,
  documentColors,
  allowNoFill = false,
  emptyLabel,
  disabled = false,
}: {
  label: string;
  /**
   * The colour itself — the DOCUMENT's type, not a CSS string. `null` means the
   * property is unset ("no fill"), which is only offered when `allowNoFill` is
   * set.
   */
  value: EditorColor | null;
  onCommit: (color: EditorColor | null) => void;
  /** Colours already used in the document, offered as swatches in the popover. */
  documentColors?: readonly EditorColor[];
  allowNoFill?: boolean;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  // Every colour row offers the document's own palette without each of the
  // eight call sites having to thread it. The hook degrades to an empty palette
  // outside an editor provider rather than throwing.
  const fromDocument = useDocumentColors();
  return (
    <div className={ROW}>
      <span className={LABEL} id={`color-label-${label.replace(/\s+/g, "-").toLowerCase()}`}>
        {label}
      </span>
      <ColorPicker
        triggerClassName={CONTROL}
        label={label}
        value={value}
        onChange={onCommit}
        documentColors={documentColors ?? fromDocument}
        allowNoFill={allowNoFill}
        emptyLabel={emptyLabel}
        disabled={disabled}
      />
    </div>
  );
}

export function Slider({
  label,
  value,
  onCommit,
  min,
  max,
  step = 1,
  unit,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Shown after the numeric readout ("%") so the scale is unambiguous (H26). */
  unit?: string;
}) {
  // Local while dragging; commit ONCE per gesture (pointer release / blur /
  // key release) so a continuous drag is one undo entry, not dozens (M6.16).
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <label className={ROW}>
      <span className={LABEL}>{label}</span>
      <input
        type="range"
        value={local}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={(e) => {
          if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End" || e.key === "PageUp" || e.key === "PageDown") commit();
        }}
        onBlur={commit}
        // `h-8`: the shared 32px control height (H5), applied to the INPUT BOX,
        // not to the visible track. A native range renders its thin track
        // centred in whatever box height it is given, and the whole box is the
        // pointer hit region — so this buys a 32px target while the track stays
        // visually slim. Without it the input is 16px tall, which (a) fails WCAG
        // 2.5.8 Target Size (Minimum) = 24x24 CSS px and (b) left Opacity as a
        // 16px row among 32px rows, visibly breaking the Inspector's grid. Both
        // were measured in Chrome via CDP, not assumed.
        className="h-8 min-w-0 flex-1 accent-editor-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/30"
      />
      {/* Visible numeric value (H27), wide enough for "100" plus a unit. */}
      <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-editor-muted">
        {local}
        {unit ?? ""}
      </span>
    </label>
  );
}

/**
 * A labelled row wrapping an arbitrary control (a segmented group, a button
 * pair) so it lines up with the native fields above and below it. Exported
 * because the alternative — callers hand-rolling the label column — is how the
 * label width drifts from `LABEL` and the inspector loses its grid.
 *
 * Deliberately a `<div>`, not a `<label>`: the content is a group of buttons,
 * and a `<label>` wrapping multiple controls has no defined target. The group
 * carries its own `aria-label` instead (see {@link SegmentedControl}).
 */
export function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={ROW}>
      <span className={LABEL}>{label}</span>
      {children}
    </div>
  );
}

/**
 * One collapsible inspector section (H4). A real `<button aria-expanded>` — so
 * it is keyboard-operable for free rather than by re-implementing Enter/Space on
 * a div — plus a chevron that rotates with the state.
 *
 * The body is always RENDERED and hidden with `hidden` + `.hidden` when
 * collapsed, so `aria-controls` always resolves to a real element (an
 * `aria-controls` pointing at nothing is worse than none) and so a collapsed
 * section keeps its React state instead of remounting its fields.
 *
 * Open/closed state is session-only React state on purpose: H4 asks for "stable
 * state", not persistence, and the dock preference is the one thing the editor
 * persists — a second storage key invites the two to disagree.
 */
export function InspectorSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `${useId()}-section`;
  return (
    <section className="min-w-0 border-b border-editor-border">
      <h3 className="min-w-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full min-w-0 items-center justify-between gap-2 px-3 py-2 text-left transition-colors hover:bg-editor-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-editor-accent/40"
        >
          <span className={SECTION_TITLE}>{title}</span>
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-editor-muted transition-transform ${open ? "" : "-rotate-90"}`}
          />
        </button>
      </h3>
      <div id={bodyId} hidden={!open} className={open ? SECTION_BODY : "hidden"}>
        {children}
      </div>
    </section>
  );
}

/**
 * A secondary action button (H15): an outlined, low-emphasis control for a real
 * action that is not a value edit — Replace, Crop, Rotate, Duplicate, Delete.
 *
 * Shared rather than per-panel so the several places that each had their own
 * `border border-editor-border px-1 py-1` string cannot drift, and so disabled
 * styling is applied once. `title` is required, not optional: a disabled action
 * with no explanation is the exact failure H24 is about, and making the prop
 * mandatory means a caller has to decide what the reason is.
 *
 * `h-8` — the same 32px as {@link CONTROL} (P5). Measured before: `py-1.5` at
 * 11px text produced a **30.5px** button, so "Add shadow", "Flip H/V",
 * "Replace image" and the Rotate/Duplicate/Delete row each sat 1.5px short of
 * every field above them, on a FRACTIONAL height. A half-pixel row cannot land
 * on a device pixel, which is what made a panel of otherwise-aligned 32px rows
 * read as slightly soft. The text stays 11px: this is a secondary action and
 * should not compete with a value.
 */
export function SecondaryButton({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-8 min-w-0 items-center justify-center gap-1 rounded-control border border-editor-border px-2 text-[11px] font-medium text-editor-text transition-colors hover:border-editor-accent hover:bg-editor-accentsoft hover:text-editor-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-editor-accent/40 disabled:cursor-not-allowed disabled:border-editor-border disabled:bg-editor-subtle disabled:text-editor-muted disabled:hover:border-editor-border disabled:hover:bg-editor-subtle disabled:hover:text-editor-muted"
    >
      {children}
    </button>
  );
}

/**
 * A static (non-collapsible) group, for a section whose content is a single
 * short readout that a collapse control would only add chrome to. Shares
 * `InspectorSection`'s title style and body padding so the two cannot drift
 * apart visually (H4: one section pattern, not per-kind markup).
 */
export function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-b border-editor-border">
      <div className="px-3 pb-1 pt-2">
        <h3 className={SECTION_TITLE}>{title}</h3>
      </div>
      <div className={SECTION_BODY}>{children}</div>
    </div>
  );
}
