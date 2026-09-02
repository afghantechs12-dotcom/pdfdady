import { beforeEach, describe, expect, it } from "vitest";
import { TextLayoutEngine } from "@/src/application/editor/text/TextLayoutEngine";
import type { ResolvedTextLayout } from "@/src/application/editor/text/TextLayoutEngine";
import type { TextObject } from "@/src/domain/editor/objects";
import { makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import { createDefaultTextFrame } from "@/src/domain/editor/textContent";

// ---------------------------------------------------------------------------
// Deterministic mock font measurer: each character is `charWidth` units wide.
// ---------------------------------------------------------------------------

function makeMeasure(charWidth: number) {
  return (_text: string, _fontFamily: string, _fontWeight: number, _fontSize: number): number => {
    return _text.length * charWidth;
  };
}

// 14px font → 7 units per character (typical Helvetica width ≈ 0.5 em per char).
const MEASURE_14 = makeMeasure(7);

function makeSimpleObj(overrides: Partial<TextObject> = {}): TextObject {
  return makeTextObject({
    fontSize: 14,
    fontFamily: "Helvetica",
    fontWeight: 400,
    lineHeight: 1.2,
    letterSpacing: 0,
    align: "left",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function layout(obj: TextObject, availableWidth: number, availableHeight?: number, measure = MEASURE_14): ResolvedTextLayout {
  const engine = new TextLayoutEngine();
  return engine.layout(obj, { availableWidth, availableHeight, measure });
}

describe("TextLayoutEngine", () => {
  beforeEach(() => resetFactory());

  // ---------------------------------------------------------------------------
  // 1. Basic wrapping
  // ---------------------------------------------------------------------------

  describe("wrapping", () => {
    it("does not wrap short text that fits on one line", () => {
      const obj = makeSimpleObj({ text: "Hi" });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].fragments[0].text).toBe("Hi");
      expect(result.overflow).toBe("none");
    });

    it("wraps text that exceeds available width", () => {
      // "Hello world" = 11 chars * 7 = 77 units. With width=20, it wraps.
      const obj = makeSimpleObj({ text: "Hello world" });
      const result = layout(obj, 20);
      // At width 20 and 7u/char, each line fits ~2 chars + space.
      expect(result.lines.length).toBeGreaterThan(1);
      expect(result.overflow).toBe("none");
    });

    it("handles nowrap mode by producing a single overflowed line", () => {
      const obj = makeSimpleObj({
        text: "Hello world",
        frame: { ...createDefaultTextFrame(), wrapMode: "nowrap" },
      });
      const result = layout(obj, 20);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].width).toBeGreaterThan(20);
      expect(result.overflow).toBe("none"); // nowrap doesn't clip, it just overflows
    });

    it("applies wordSpacing to whitespace tokens (per space character)", () => {
      // "a b" in nowrap: fragments a(7) + " "(7 + wordSpacing·1) + b(7).
      const base = makeSimpleObj({
        text: "a b",
        frame: { ...createDefaultTextFrame(), wrapMode: "nowrap" },
      });
      const plain = layout(base, 200);
      const spaced = layout({ ...base, id: `${base.id}-ws`, wordSpacing: 5 }, 200);
      expect(spaced.lines[0].width).toBeCloseTo(plain.lines[0].width + 5, 5);
      // The trailing fragment shifts right by exactly the word-spacing.
      const lastPlain = plain.lines[0].fragments.at(-1);
      const lastSpaced = spaced.lines[0].fragments.at(-1);
      expect((lastSpaced?.x ?? 0) - (lastPlain?.x ?? 0)).toBeCloseTo(5, 5);
    });

    it("breaks at word boundaries", () => {
      // With width=14, "Hello" (35u) fits on its own line, "world" (35u) wraps.
      const obj = makeSimpleObj({ text: "Hello world" });
      const result = layout(obj, 14);
      // Each word should be on its own line since each is 35u > 14.
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0].fragments[0].text).toBe("Hello");
      expect(result.lines[1].fragments[0].text).toBe("world");
    });

    it("preserves whitespace tokens as separate fragments", () => {
      const obj = makeSimpleObj({ text: "Hello world" });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(1);
      // Should have "Hello", " ", "world" as separate fragments.
      expect(result.lines[0].fragments.map(f => f.text)).toEqual(["Hello", " ", "world"]);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Alignment
  // ---------------------------------------------------------------------------

  describe("alignment", () => {
    it("left-aligns fragments by default", () => {
      const obj = makeSimpleObj({ text: "Hi", align: "left" });
      const result = layout(obj, 200);
      expect(result.lines[0].fragments[0].x).toBe(0);
    });

    it("center-aligns fragments within content width", () => {
      const obj = makeSimpleObj({ text: "Hi", align: "center" });
      const result = layout(obj, 100);
      // "Hi" = 14u wide. Centered in 100u → starts at (100 - 14) / 2 = 43.
      expect(result.lines[0].fragments[0].x).toBeCloseTo(43, 0);
    });

    it("right-aligns fragments within content width", () => {
      const obj = makeSimpleObj({ text: "Hi", align: "right" });
      const result = layout(obj, 100);
      // "Hi" = 14u. Right-aligned → x = 100 - 14 = 86.
      expect(result.lines[0].fragments[0].x).toBeCloseTo(86, 0);
    });

    it("aligns all fragments on a wrapped line together", () => {
      const obj = makeSimpleObj({ text: "Hello world", align: "center" });
      const result = layout(obj, 45);
      // At width 45, "Hello " (42u) wraps, leaving "world" (35u) on the next line.
      // Both lines should have non-negative x after centering.
      for (const line of result.lines) {
        expect(line.fragments[0].x).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Padding
  // ---------------------------------------------------------------------------

  describe("padding", () => {
    it("reduces content width by horizontal padding", () => {
      const obj = makeSimpleObj({
        text: "Hello",
        frame: { ...createDefaultTextFrame(), padding: { top: 0, right: 10, bottom: 0, left: 10 } },
      });
      // availableWidth=100, padding=10+10 → contentWidth=80.
      // "Hello" = 35u < 80u → one line.
      const result = layout(obj, 100);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].width).toBe(35);
    });

    it("positions fragments within the padded content area", () => {
      const obj = makeSimpleObj({
        text: "Hi",
        frame: { ...createDefaultTextFrame(), padding: { top: 5, right: 10, bottom: 5, left: 15 } },
      });
      const result = layout(obj, 100);
      // Fragment x should be relative to content area origin (0), not absolute.
      expect(result.lines[0].fragments[0].x).toBe(0);
    });

    it("causes wrapping when content width is exhausted by padding", () => {
      const obj = makeSimpleObj({
        text: "Hello world",
        frame: { ...createDefaultTextFrame(), padding: { top: 0, right: 0, bottom: 0, left: 0 } },
      });
      const result = layout(obj, 14);
      expect(result.lines.length).toBeGreaterThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Overflow
  // ---------------------------------------------------------------------------

  describe("overflow", () => {
    it("reports no overflow when content fits", () => {
      const obj = makeSimpleObj({ text: "Hi" });
      const result = layout(obj, 200, 200);
      expect(result.overflow).toBe("none");
    });

    it("reports clip overflow when content exceeds available height", () => {
      // "Hello world" wraps to 2 lines at width=14. Each line is 16.8u tall.
      // 2 lines * 16.8 = 33.6u + padding(0) = 33.6u. Available height=20 → overflow.
      const obj = makeSimpleObj({ text: "Hello world" });
      const result = layout(obj, 14, 20);
      expect(result.overflow).toBe("clip");
    });

    it("does not clip when availableHeight is unlimited", () => {
      const obj = makeSimpleObj({ text: "Hello world" });
      const result = layout(obj, 14); // no availableHeight
      expect(result.overflow).toBe("none");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Auto-height
  // ---------------------------------------------------------------------------

  describe("auto-height", () => {
    it("returns autoHeight equal to content height + padding in auto-height mode", () => {
      const obj = makeSimpleObj({
        text: "Hello world",
        frame: { ...createDefaultTextFrame(), sizingMode: "auto-height" },
      });
      const result = layout(obj, 200);
      const padding = obj.frame.padding;
      expect(result.autoHeight).toBeCloseTo(result.contentHeight + padding.top + padding.bottom, 5);
    });

    it("returns availableHeight in fixed mode", () => {
      const obj = makeSimpleObj({
        text: "Hi",
        frame: { ...createDefaultTextFrame(), sizingMode: "fixed" },
      });
      const result = layout(obj, 200, 100);
      expect(result.autoHeight).toBe(100);
    });

    it("falls back to content height when fixed mode has no availableHeight", () => {
      const obj = makeSimpleObj({
        text: "Hi",
        frame: { ...createDefaultTextFrame(), sizingMode: "fixed" },
      });
      const result = layout(obj, 200);
      const padding = obj.frame.padding;
      expect(result.autoHeight).toBeCloseTo(result.contentHeight + padding.top + padding.bottom, 5);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Deterministic output
  // ---------------------------------------------------------------------------

  describe("deterministic output", () => {
    it("produces identical results for identical inputs", () => {
      const obj1 = makeSimpleObj({ text: "Hello world" });
      const obj2 = makeSimpleObj({ text: "Hello world" });
      const r1 = layout(obj1, 14);
      const r2 = layout(obj2, 14);
      expect(r1.lines).toEqual(r2.lines);
      expect(r1.contentHeight).toBe(r2.contentHeight);
      expect(r1.autoHeight).toBe(r2.autoHeight);
      expect(r1.overflow).toBe(r2.overflow);
    });

    it("produces different results for different widths", () => {
      const obj = makeSimpleObj({ text: "Hello world" });
      const r1 = layout(obj, 14);
      const r2 = layout(obj, 200);
      expect(r1.lines.length).toBeGreaterThan(r2.lines.length);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Cache correctness
  // ---------------------------------------------------------------------------

  describe("cache correctness", () => {
    it("caches layout results", () => {
      const engine = new TextLayoutEngine();
      const obj = makeSimpleObj({ text: "Hello" });
      const opts = { availableWidth: 200, measure: MEASURE_14 };
      const r1 = engine.layout(obj, opts);
      const r2 = engine.layout(obj, opts);
      expect(r1).toBe(r2); // same reference
      expect(engine.cacheSize).toBe(1);
    });

    it("caches different results for different inputs", () => {
      const engine = new TextLayoutEngine();
      const obj = makeSimpleObj({ text: "Hello" });
      engine.layout(obj, { availableWidth: 200, measure: MEASURE_14 });
      engine.layout(obj, { availableWidth: 100, measure: MEASURE_14 });
      expect(engine.cacheSize).toBe(2);
    });

    it("cache miss on different object ids", () => {
      const engine = new TextLayoutEngine();
      const obj1 = makeSimpleObj({ text: "Hello" });
      const obj2 = makeSimpleObj({ text: "Hello" });
      engine.layout(obj1, { availableWidth: 200, measure: MEASURE_14 });
      engine.layout(obj2, { availableWidth: 200, measure: MEASURE_14 });
      expect(engine.cacheSize).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Layout invalidation
  // ---------------------------------------------------------------------------

  describe("layout invalidation", () => {
    it("invalidates cached entries for a specific object id", () => {
      const engine = new TextLayoutEngine();
      const obj = makeSimpleObj({ text: "Hello" });
      engine.layout(obj, { availableWidth: 200, measure: MEASURE_14 });
      engine.layout(obj, { availableWidth: 100, measure: MEASURE_14 });
      expect(engine.cacheSize).toBe(2);
      engine.invalidate(obj.id);
      expect(engine.cacheSize).toBe(0);
    });

    it("does not affect other objects when invalidating one", () => {
      const engine = new TextLayoutEngine();
      const obj1 = makeSimpleObj({ text: "Hello" });
      const obj2 = makeSimpleObj({ text: "World" });
      engine.layout(obj1, { availableWidth: 200, measure: MEASURE_14 });
      engine.layout(obj2, { availableWidth: 200, measure: MEASURE_14 });
      engine.invalidate(obj1.id);
      expect(engine.cacheSize).toBe(1);
    });

    it("clearCache removes all entries", () => {
      const engine = new TextLayoutEngine();
      const obj1 = makeSimpleObj({ text: "Hello" });
      const obj2 = makeSimpleObj({ text: "World" });
      engine.layout(obj1, { availableWidth: 200, measure: MEASURE_14 });
      engine.layout(obj2, { availableWidth: 200, measure: MEASURE_14 });
      engine.clearCache();
      expect(engine.cacheSize).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Multiline / paragraph handling
  // ---------------------------------------------------------------------------

  describe("multiline handling", () => {
    it("preserves paragraph boundaries", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            { runs: [{ text: "First", style: {} }], spacingBefore: 0, spacingAfter: 0, list: { kind: "none", level: 0 } },
            { runs: [{ text: "Second", style: {} }], spacingBefore: 0, spacingAfter: 0, list: { kind: "none", level: 0 } },
          ],
        },
      });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0].paragraphIndex).toBe(0);
      expect(result.lines[1].paragraphIndex).toBe(1);
    });

    it("applies paragraph spacing before and after", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            { runs: [{ text: "A", style: {} }], spacingBefore: 5, spacingAfter: 3, list: { kind: "none", level: 0 } },
            { runs: [{ text: "B", style: {} }], spacingBefore: 5, spacingAfter: 3, list: { kind: "none", level: 0 } },
          ],
        },
      });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(2);
      // First line has spacingBefore from paragraph 0.
      expect(result.lines[0].paragraphSpacingBefore).toBe(5);
      // Second line has spacingBefore from paragraph 1.
      expect(result.lines[1].paragraphSpacingBefore).toBe(5);
    });

    it("handles multiple runs within a single paragraph", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            {
              runs: [
                { text: "Hello", style: {} },
                { text: " ", style: {} },
                { text: "world", style: {} },
              ],
              spacingBefore: 0,
              spacingAfter: 0,
              list: { kind: "none", level: 0 },
            },
          ],
        },
      });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].fragments.map(f => f.text)).toEqual(["Hello", " ", "world"]);
    });

    it("tracks runIndex across wrapped lines", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            {
              runs: [
                { text: "Hello", style: {} },
                { text: "world", style: {} },
              ],
              spacingBefore: 0,
              spacingAfter: 0,
              list: { kind: "none", level: 0 },
            },
          ],
        },
      });
      const result = layout(obj, 14);
      // Each word should be on its own line with correct run indices.
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0].fragments[0].runIndex).toBe(0);
      expect(result.lines[1].fragments[0].runIndex).toBe(1);
    });

    it("handles empty paragraphs", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            { runs: [], spacingBefore: 0, spacingAfter: 0, list: { kind: "none", level: 0 } },
            { runs: [{ text: "Text", style: {} }], spacingBefore: 0, spacingAfter: 0, list: { kind: "none", level: 0 } },
          ],
        },
      });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(2);
      expect(result.lines[0].fragments).toHaveLength(0);
      expect(result.lines[1].fragments[0].text).toBe("Text");
    });

    it("handles empty content (no paragraphs)", () => {
      const obj = makeSimpleObj({
        content: { paragraphs: [] },
        text: "",
      });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(0);
      expect(result.contentHeight).toBe(0);
      expect(result.overflow).toBe("none");
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Columns
  // ---------------------------------------------------------------------------

  describe("columns", () => {
    it("distributes lines across multiple columns", () => {
      const obj = makeSimpleObj({
        text: "One Two Three Four Five Six",
        frame: { ...createDefaultTextFrame(), columns: { count: 2, gap: 10 } },
      });
      const result = layout(obj, 14);
      // At width=14, each word wraps to its own line (35u > 14u).
      // With 2 columns, lines should flow into both columns.
      expect(result.lines.length).toBeGreaterThanOrEqual(3);
    });

    it("respects column gap", () => {
      // Column width = (contentWidth - (count-1)*gap) / count
      const obj = makeSimpleObj({
        text: "Hello world",
        frame: { ...createDefaultTextFrame(), columns: { count: 2, gap: 10 } },
      });
      // With width=30, padding=0: columnWidth = (30 - 10) / 2 = 10.
      // Each word (35u) > 10u → wraps to own line.
      const result = layout(obj, 30);
      expect(result.lines.length).toBeGreaterThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // 11. Fragment metadata
  // ---------------------------------------------------------------------------

  describe("fragment metadata", () => {
    it("records paragraph and run indices on fragments", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            {
              runs: [
                { text: "Hello", style: {} },
                { text: "world", style: {} },
              ],
              spacingBefore: 0,
              spacingAfter: 0,
              list: { kind: "none", level: 0 },
            },
          ],
        },
      });
      const result = layout(obj, 200);
      expect(result.lines[0].fragments[0].paragraphIndex).toBe(0);
      expect(result.lines[0].fragments[0].runIndex).toBe(0);
      expect(result.lines[0].fragments[1].runIndex).toBe(1);
    });

    it("records paragraph index on lines", () => {
      const obj = makeSimpleObj({
        content: {
          paragraphs: [
            { runs: [{ text: "A", style: {} }], spacingBefore: 0, spacingAfter: 0, list: { kind: "none", level: 0 } },
            { runs: [{ text: "B", style: {} }], spacingBefore: 0, spacingAfter: 0, list: { kind: "none", level: 0 } },
          ],
        },
      });
      const result = layout(obj, 200);
      expect(result.lines[0].paragraphIndex).toBe(0);
      expect(result.lines[1].paragraphIndex).toBe(1);
    });

    it("sets x relative to content area origin", () => {
      const obj = makeSimpleObj({
        text: "Hi",
        frame: { ...createDefaultTextFrame(), padding: { top: 10, right: 10, bottom: 10, left: 20 } },
      });
      const result = layout(obj, 100);
      // Fragment x is relative to content area (0), not absolute.
      expect(result.lines[0].fragments[0].x).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 12. contentWidth reporting
  // ---------------------------------------------------------------------------

  describe("contentWidth", () => {
    it("reports the maximum content width used", () => {
      const obj = makeSimpleObj({ text: "Hello world" });
      const result = layout(obj, 200);
      // Longest line width (one line since it fits).
      expect(result.contentWidth).toBeCloseTo(77, 0); // 11 chars * 7u
    });

    it("reports contentWidth exceeding frame width for nowrap", () => {
      const obj = makeSimpleObj({
        text: "Hello world",
        frame: { ...createDefaultTextFrame(), wrapMode: "nowrap" },
      });
      const result = layout(obj, 20);
      expect(result.contentWidth).toBeGreaterThan(20);
    });
  });

  // ---------------------------------------------------------------------------
  // 13. Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles zero available width gracefully", () => {
      const obj = makeSimpleObj({ text: "Hello" });
      const result = layout(obj, 0);
      // With zero content width, every token is a line.
      expect(result.lines.length).toBeGreaterThanOrEqual(1);
    });

    it("handles very narrow content width (single char)", () => {
      const obj = makeSimpleObj({ text: "AB" });
      const result = layout(obj, 7); // 1 char width
      // A single token wider than the content area cannot be broken, so it stays on one line.
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0].fragments[0].text).toBe("AB");
    });

    it("handles empty text string", () => {
      const obj = makeSimpleObj({ text: "" });
      const result = layout(obj, 200);
      expect(result.lines).toHaveLength(0);
    });

    it("handles whitespace-only text", () => {
      const obj = makeSimpleObj({ text: "   " });
      const result = layout(obj, 200);
      // Whitespace tokens produce lines (they are preserved).
      expect(result.lines.length).toBeGreaterThanOrEqual(1);
    });
  });
});
