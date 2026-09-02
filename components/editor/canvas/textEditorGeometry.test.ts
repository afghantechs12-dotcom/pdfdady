import { describe, expect, it } from "vitest";
import {
  BASELINE_SHIFT_LIMIT_EM,
  TEXT_EDITOR_MIN_WIDTH,
  baselineShift,
  caretOnEntry,
  firstBaselineTarget,
  textEditorBox,
  textEditorLineCount,
} from "@/components/editor/canvas/textEditorGeometry";
import { base14Ascent } from "@/src/domain/editor/textMetrics";

/**
 * The regression suite for the inline text editor's placement.
 *
 * The numbers come from a Chrome measurement of the old overlay on a 16px
 * Helvetica object at 100% zoom: entering editing moved the glyphs +1.0px
 * horizontally (a `border` insetting the content box) and +3.8px vertically (CSS
 * first baseline 15.14px vs the exporter's ascent 11.49px), and the surface was
 * 40.38px tall over a 20px object because a `<textarea>` defaults to two rows.
 */

const HELVETICA_MEASURED_CSS_BASELINE = 15.14; // Chrome, 16px, line-height 1.2
const RECT = { x: 386, y: 370, width: 249.9, height: 20 };

describe("textEditorGeometry — the first baseline matches the exporter", () => {
  it("targets the same ascent the renderer and exporter use", () => {
    // Not a private constant: the same per-em ratio `textMetrics` hands the SVG
    // renderer and pdf-lib, so the three cannot drift apart again.
    expect(firstBaselineTarget("Helvetica", 16)).toBeCloseTo(base14Ascent("Helvetica", 16), 6);
    expect(firstBaselineTarget("Helvetica", 16)).toBeCloseTo(11.488, 3);
    expect(firstBaselineTarget("Times-Roman", 16)).toBeCloseTo(10.928, 3);
    expect(firstBaselineTarget("Courier New", 16)).toBeCloseTo(10.064, 3);
  });

  it("scales linearly with the rendered size, so zoom needs no separate rule", () => {
    const at16 = firstBaselineTarget("Helvetica", 16);
    expect(firstBaselineTarget("Helvetica", 32)).toBeCloseTo(at16 * 2, 6);
    expect(firstBaselineTarget("Helvetica", 16 * 2.5)).toBeCloseTo(at16 * 2.5, 6);
  });

  it("treats a degenerate font size as no baseline rather than NaN", () => {
    for (const bad of [0, -12, NaN, Infinity]) {
      expect(firstBaselineTarget("Helvetica", bad), String(bad)).toBe(0);
    }
  });

  it("reproduces the measured 3.8px drop and cancels it", () => {
    const target = firstBaselineTarget("Helvetica", 16);
    const shift = baselineShift(target, HELVETICA_MEASURED_CSS_BASELINE, 16);
    // The measured defect, to the tenth of a pixel, with the sign that fixes it.
    expect(shift).toBeCloseTo(-3.65, 2);
    expect(target - (HELVETICA_MEASURED_CSS_BASELINE + shift)).toBeCloseTo(0, 10);
  });

  it("grows the correction with the font size, because the defect does", () => {
    // The measured offset is proportional to the size, so a 48px heading suffers
    // three times the 16px shift — the reason a fixed pixel nudge would be wrong.
    const shift16 = baselineShift(firstBaselineTarget("Helvetica", 16), 15.14, 16);
    const shift48 = baselineShift(firstBaselineTarget("Helvetica", 48), 15.14 * 3, 48);
    expect(shift48).toBeCloseTo(shift16 * 3, 6);
  });

  it("falls back to no correction when the probe failed", () => {
    const target = firstBaselineTarget("Helvetica", 16);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(baselineShift(target, bad, 16), String(bad)).toBe(0);
    }
    expect(baselineShift(NaN, 15.14, 16)).toBe(0);
    expect(baselineShift(target, 15.14, 0)).toBe(0);
  });

  it("clamps a nonsense measurement instead of flinging the surface off screen", () => {
    const limit = BASELINE_SHIFT_LIMIT_EM * 16;
    expect(baselineShift(firstBaselineTarget("Helvetica", 16), 9000, 16)).toBe(-limit);
    expect(baselineShift(9000, 15.14, 16)).toBe(limit);
  });
});

describe("textEditorGeometry — the surface covers the run it replaces", () => {
  const box = (over: Partial<Parameters<typeof textEditorBox>[1]> = {}) =>
    textEditorBox(RECT, { fontSizePx: 16, lineHeight: 1.2, value: "Hamburgefonstiv", shift: -3.65, ...over });

  it("is one line tall for one line of text, not the two-row default", () => {
    // Measured before: 40.38px of white over a 20px object.
    const b = box();
    expect(b.height).toBeCloseTo(20 + 3.65, 2);
    expect(b.height).toBeLessThan(40);
  });

  it("moves up by the shift and keeps its bottom edge on the object's", () => {
    const b = box();
    expect(b.top).toBeCloseTo(RECT.y - 3.65, 2);
    // The committed run's ascenders sit ~3px above the box top; the surface now
    // starts above them, so no sliver of the old text stays visible.
    expect(b.top).toBeLessThan(RECT.y);
    expect(b.top + b.height).toBeCloseTo(RECT.y + RECT.height, 6);
  });

  it("grows with the value so a new line is not typed into a clipped box", () => {
    const one = box({ value: "one" });
    const two = box({ value: "one\ntwo" });
    const three = box({ value: "one\ntwo\nthree" });
    // One line is FLOORED by the object's own box (20px > a 19.2px line), so the
    // first step is short; every line past the floor costs exactly one line box.
    expect(one.height).toBeCloseTo(RECT.height + 3.65, 2);
    expect(three.height - two.height).toBeCloseTo(16 * 1.2, 6);
    expect(three.height).toBeGreaterThan(one.height);
  });

  it("never shrinks below the object's own box", () => {
    const tall = textEditorBox({ ...RECT, height: 200 }, { fontSizePx: 16, lineHeight: 1.2, value: "x", shift: 0 });
    expect(tall.height).toBe(200);
  });

  it("keeps a minimum width so an empty box stays targetable", () => {
    const narrow = textEditorBox({ ...RECT, width: 4 }, { fontSizePx: 16, lineHeight: 1.2, value: "", shift: 0 });
    expect(narrow.width).toBe(TEXT_EDITOR_MIN_WIDTH);
    expect(narrow.left).toBe(RECT.x);
  });

  it("still covers the run when the shift points the other way", () => {
    // A face whose CSS baseline sits ABOVE the exporter's ascent would shift down;
    // the surface must grow, never shrink, or it would uncover the old glyphs.
    const b = box({ shift: 2.5 });
    expect(b.top).toBeCloseTo(RECT.y + 2.5, 6);
    expect(b.height).toBeCloseTo(20 + 2.5, 6);
  });

  it("survives degenerate inputs without producing a NaN box", () => {
    const b = textEditorBox(RECT, { fontSizePx: NaN, lineHeight: 0, value: "x", shift: NaN });
    expect(Number.isFinite(b.top)).toBe(true);
    expect(Number.isFinite(b.height)).toBe(true);
    expect(b.height).toBeGreaterThanOrEqual(RECT.height);
  });

  it("counts lines from newlines only, since soft wrap is off", () => {
    expect(textEditorLineCount("")).toBe(1);
    expect(textEditorLineCount("a single but rather long line that would soft-wrap")).toBe(1);
    expect(textEditorLineCount("a\nb")).toBe(2);
    expect(textEditorLineCount("a\n")).toBe(2); // a trailing newline is a line to type on
  });
});

describe("textEditorGeometry — what is selected on entry", () => {
  it("selects a freshly created object's seeded text so typing replaces it", () => {
    // The text tool seeds an empty box today, so this rule is what protects a
    // future placeholder-seeding tool from needing its own entry behaviour.
    expect(caretOnEntry("Note", "fresh")).toEqual({ start: 0, end: 4 });
    expect(caretOnEntry("", "fresh")).toEqual({ start: 0, end: 0 });
  });

  it("puts a CARET at the end of text the user already wrote", () => {
    // The old overlay called el.select() unconditionally, so one keystroke in an
    // established paragraph deleted the paragraph.
    expect(caretOnEntry("An established paragraph.", "existing")).toEqual({ start: 25, end: 25 });
  });

  it("is a no-op distinction for empty text", () => {
    expect(caretOnEntry("", "existing")).toEqual({ start: 0, end: 0 });
  });

  it("never returns a range outside the text", () => {
    for (const entry of ["fresh", "existing"] as const) {
      for (const text of ["", "a", "multi\nline\ntext"]) {
        const { start, end } = caretOnEntry(text, entry);
        expect(start, `${entry}:${JSON.stringify(text)}`).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(text.length);
        expect(start).toBeLessThanOrEqual(end);
      }
    }
  });
});
