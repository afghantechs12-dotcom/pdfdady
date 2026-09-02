"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { editorColorToCss } from "@/lib/editor/color";
import { resolveFont, familyIsItalic } from "@/lib/editor/fontSubstitution";
import {
  baselineShift,
  caretOnEntry,
  firstBaselineTarget,
  textEditorBox,
  type TextEditEntry,
} from "@/components/editor/canvas/textEditorGeometry";
import type { TextObject } from "@/src/domain/editor/objects";
import { DRAFT_TINT_STRONG, SELECTION } from "@/components/editor/canvas/signalColors";

/**
 * The inline text editor. When a text object is double-clicked, the canvas swaps
 * its rendered <text> for this overlay: an absolutely-positioned <textarea>
 * matching the object's screen rect + font, so editing feels direct. The textarea
 * is controlled locally; it commits to the editor (via `onCommit`) on blur or
 * Ctrl/Cmd+Enter, and cancels on Escape. While it has focus, the shortcut manager
 * suppresses editor shortcuts (see useShortcuts).
 *
 * "Matching the object's rect" turned out to be the hard part, and P7 measured
 * three ways it did not:
 *
 *  - the ring was a `border`, which — with `box-sizing: border-box` and no
 *    padding — inset the CONTENT box and moved every glyph 1px right of the
 *    committed run. It is now an `outline`, which occupies no layout space, so the
 *    ring can also be made heavier than the selection frame without touching the
 *    text. Editing is a hotter state than selected and now looks like it.
 *  - CSS puts the first baseline lower than the ascent convention the SVG renderer
 *    and the PDF exporter share (measured +3.8px at 16px, and it scales with size
 *    and zoom). `textEditorGeometry` corrects that; the one number CSS will not
 *    tell us statically — where the substituted face's baseline actually falls —
 *    is measured here, once, with a strut.
 *  - a `<textarea>` with no `rows` is intrinsically TWO rows tall, so a 20px text
 *    object opened a 40px white surface over the page beneath it.
 *
 * The surface stays opaque because the committed <text> is still rendered
 * underneath (nothing in the canvas hides the object being edited), and it now
 * covers the run's ascenders, which used to peek out well above it — bar a quarter
 * pixel at 100% zoom, which `textEditorGeometry`'s header explains cannot be
 * hidden without moving the text again.
 */
export interface TextEditorProps {
  /** Screen-space rect (px, relative to the canvas container) to cover. */
  rect: { x: number; y: number; width: number; height: number };
  obj: TextObject;
  zoom: number;
  /**
   * How the editor was opened. `fresh` (a tool just created this object) selects
   * whatever the tool seeded, so typing replaces it — the text tool seeds an empty
   * box, which makes this a caret at the start. `existing` places a caret at the
   * end instead of selecting prose the user would then destroy with one keystroke.
   */
  entry?: TextEditEntry;
  onCommit: (text: string) => void;
  onCancel: () => void;
  /**
   * Reports whether this textarea currently holds characters the DOCUMENT does not.
   *
   * The reason persistence needs telling at all: the value lives in React state
   * until commit, so `CommandHistory.revision` does not move while the user types
   * and every watermark comparison says the document is untouched. That is why the
   * editor could report "No changes yet" over typed characters. Note it is
   * `value !== obj.text` rather than "the box is open" — opening a text box and
   * clicking away changes nothing and must not be called an edit.
   */
  onUncommittedChange?: (pending: boolean) => void;
}

/** The editing accent — the same violet as the selection chrome and `editor-accent`. */
/**
 * The editing-box outline and the caret use the SELECTION colour, not the brand
 * violet they used to use. A text box being edited is the object the user has
 * hold of, so it belongs to the selection signal — and a violet caret over
 * violet brand chrome was one more place the four signals collapsed into one.
 */
const ACCENT = SELECTION;

export function TextEditor({
  rect,
  obj,
  zoom,
  entry = "existing",
  onCommit,
  onCancel,
  onUncommittedChange,
}: TextEditorProps) {
  const [value, setValue] = useState(obj.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const resolved = resolveFont(obj.fontFamily);
  const fontSizePx = obj.fontSize * zoom;
  const lineHeight = obj.lineHeight || 1.2;
  const [shift, setShift] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const caret = caretOnEntry(el.value, entry);
    el.setSelectionRange(caret.start, caret.end);
    // Empty deps ON PURPOSE: this runs when the editor opens and never again.
    // Re-running it on a value change would drag the caret back on every
    // keystroke.
  }, []);

  /**
   * Measure where CSS actually puts the first baseline, once per font/size.
   *
   * No formula in this repo can derive it: it depends on the `hhea` ascent and
   * descent of whichever face the browser substituted for the PDF family, and the
   * half-leading that follows from them. An empty inline-block's bottom margin
   * edge sits ON the baseline by definition (CSS 2.1 §10.8.1), so one strut in a
   * throwaway div answers it exactly.
   *
   * A layout effect, so the correction is applied before the browser paints — a
   * `useEffect` here would show the text in the wrong place for one frame. It is
   * one measurement per editing session against a detached-then-removed node: no
   * polling, no ResizeObserver, nothing that survives the effect.
   */
  useLayoutEffect(() => {
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:absolute;top:0;left:-9999px;visibility:hidden;margin:0;padding:0;border:0;white-space:pre;";
    probe.style.fontFamily = resolved.family;
    probe.style.fontSize = `${fontSizePx}px`;
    probe.style.fontWeight = String(obj.fontWeight);
    if (familyIsItalic(resolved.family)) probe.style.fontStyle = "italic";
    probe.style.lineHeight = String(lineHeight);
    const strut = document.createElement("span");
    strut.style.cssText = "display:inline-block;width:0;height:0;";
    probe.append(document.createTextNode("X"), strut);
    document.body.appendChild(probe);
    const measured = strut.getBoundingClientRect().bottom - probe.getBoundingClientRect().top;
    probe.remove();
    setShift(baselineShift(firstBaselineTarget(obj.fontFamily, fontSizePx), measured, fontSizePx));
  }, [resolved.family, fontSizePx, obj.fontWeight, obj.fontFamily, lineHeight]);

  /*
   * Held in a ref so the report below is keyed on the FACT changing, not on the
   * parent handing down a new inline closure — which it does on every render.
   */
  const reportUncommitted = useRef(onUncommittedChange);
  reportUncommitted.current = onUncommittedChange;
  const uncommitted = value !== obj.text;
  useEffect(() => {
    reportUncommitted.current?.(uncommitted);
    // The cleanup is what makes commit, cancel, tool switch and unmount all
    // clear the flag without four call sites remembering to: whichever exit runs,
    // this editor stops existing and the characters are either in the document or
    // deliberately gone.
    return () => {
      if (uncommitted) reportUncommitted.current?.(false);
    };
  }, [uncommitted]);

  const box = textEditorBox(rect, { fontSizePx, lineHeight, value, shift });

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          onCommit(value);
        }
      }}
      style={{
        position: "absolute",
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        margin: 0,
        padding: 0,
        border: "none",
        // An `outline` (plus a soft accent halo) rather than a border: it does not
        // participate in layout, so the ring cannot move the text it surrounds,
        // and it can be heavier than the 1.5px selection frame — editing outranks
        // selected in the state hierarchy and should read that way.
        outline: `2px solid ${ACCENT}`,
        outlineOffset: 1,
        boxShadow: `0 0 0 5px ${DRAFT_TINT_STRONG}, 0 8px 18px -10px rgba(15,23,42,0.45)`,
        borderRadius: 2,
        background: "#ffffff",
        resize: "none",
        overflow: "hidden",
        fontFamily: resolved.family,
        fontSize: fontSizePx,
        fontWeight: obj.fontWeight,
        // The live editing overlay must slant exactly like the committed render
        // (ObjectRenderer) and the export, or text visibly jumps posture the
        // moment editing starts or ends.
        fontStyle: familyIsItalic(resolved.family) ? "italic" : undefined,
        color: editorColorToCss(obj.color),
        // The caret carries the state too: a violet insertion point says "live
        // text cursor" where a black one is indistinguishable from a glyph stem.
        caretColor: ACCENT,
        textAlign: obj.align,
        lineHeight,
        letterSpacing: obj.letterSpacing ? `${obj.letterSpacing * zoom}px` : undefined,
        whiteSpace: "pre",
        boxSizing: "border-box",
        zIndex: 50,
      }}
      aria-label="Edit text"
      data-editor-text-input="true"
    />
  );
}
