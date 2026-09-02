import { describe, expect, it } from "vitest";
import {
  groupTextItemsIntoLines,
  MAX_ITEMS_PER_LINE,
  MAX_LINE_TEXT_LENGTH,
  type RawTextItem,
} from "./TextExtraction";

/**
 * Security & resource-bound tests for M5 Part 1 text extraction.
 *
 * These verify the DoS/resource-exhaustion mitigations added during the
 * Security review (F3/F5): bucket-size caps, line-text-length caps, and
 * loop-based maxima (not spread-based) to prevent call-stack overflow on
 * pathologically large text-content streams. Each cap is asserted via an
 * observable that DISTINGUISHES a capped run from an uncapped one.
 */

const PAGE_H = 842;

function hItem(str: string, pdfX: number, pdfY: number, size: number, width: number): RawTextItem {
  return { str, transform: [size, 0, 0, size, pdfX, pdfY], width };
}

describe("TextExtraction security bounds", () => {
  it("caps items per line (MAX_ITEMS_PER_LINE) so a huge same-baseline stream can't grow unbounded", () => {
    // Generate MAX_ITEMS_PER_LINE + 1000 abutting items on the same baseline.
    // Only the first MAX_ITEMS_PER_LINE are kept during bucketing; the rest are
    // dropped. We assert ADVANCE (sum of kept item widths), which distinguishes a
    // capped bucket (MAX_ITEMS_PER_LINE * width) from an uncapped one
    // ((MAX_ITEMS_PER_LINE + 1000) * width) — unlike text.length, which is also
    // bound by MAX_LINE_TEXT_LENGTH and so can't tell the two apart.
    const items: RawTextItem[] = [];
    const count = MAX_ITEMS_PER_LINE + 1000;
    for (let i = 0; i < count; i++) {
      items.push(hItem("x", 50 + i * 5, 800, 12, 5));
    }
    const lines = groupTextItemsIntoLines(items, PAGE_H);
    expect(lines).toHaveLength(1);
    // advance = (kept items) * width = MAX_ITEMS_PER_LINE * 5, NOT count * 5.
    expect(lines[0].advance).toBe(MAX_ITEMS_PER_LINE * 5);
    // The line text is independently capped at MAX_LINE_TEXT_LENGTH.
    expect(lines[0].text.length).toBeLessThanOrEqual(MAX_LINE_TEXT_LENGTH);
  });

  it("caps line text length (MAX_LINE_TEXT_LENGTH) so one huge line can't produce a multi-MB string", () => {
    // Generate items that would produce a line longer than MAX_LINE_TEXT_LENGTH.
    // Each item is "abc" (3 chars), placed tightly. The line-building loop breaks
    // once text.length reaches MAX_LINE_TEXT_LENGTH.
    const items: RawTextItem[] = [];
    const count = Math.ceil(MAX_LINE_TEXT_LENGTH / 3) + 500;
    for (let i = 0; i < count; i++) {
      items.push(hItem("abc", 50 + i * 10, 800, 12, 10));
    }
    const lines = groupTextItemsIntoLines(items, PAGE_H);
    expect(lines).toHaveLength(1);
    expect(lines[0].text.length).toBeLessThanOrEqual(MAX_LINE_TEXT_LENGTH);
  });

  it("handles a huge item list without hanging (loop-based max, not spread) and yields every line", () => {
    // 10,000 items on DISTINCT baselines → 10,000 lines. The fontSize maximum
    // uses loop-based logic instead of Math.max(...spread), so this completes
    // without a RangeError. Asserting the EXACT count (not just > 0) proves no
    // lines were silently dropped.
    const items: RawTextItem[] = [];
    for (let i = 0; i < 10_000; i++) {
      items.push(hItem("line", 50, 800 - i * 2, 12, 30));
    }
    const lines = groupTextItemsIntoLines(items, PAGE_H);
    expect(lines).toHaveLength(10_000);
    expect(lines[0].fontSize).toBeGreaterThan(0);
  });

  it("truncates the final item fragment to respect MAX_LINE_TEXT_LENGTH exactly", () => {
    // Build a line where the final item would push text.length beyond the cap.
    // The cap logic slices the final item's str so the total length = cap exactly.
    const items: RawTextItem[] = [];
    const almost = MAX_LINE_TEXT_LENGTH - 10;
    items.push(hItem("x".repeat(almost), 50, 800, 12, 100));
    items.push(hItem("y".repeat(50), 150, 800, 12, 100)); // only 10 "y"s should fit
    const lines = groupTextItemsIntoLines(items, PAGE_H);
    expect(lines).toHaveLength(1);
    expect(lines[0].text.length).toBe(MAX_LINE_TEXT_LENGTH);
    expect(lines[0].text).toMatch(/^x+y+$/);
    expect(lines[0].text.match(/y/g)?.length).toBe(10);
  });

  it("filters out degenerate items before applying caps (no divide-by-zero)", () => {
    // Zero-size items are filtered out before bucketing, so they don't trigger
    // edge cases in the baseline-projection or font-size logic.
    const items: RawTextItem[] = [
      hItem("zero", 50, 800, 0, 0),
      hItem("real", 50, 780, 12, 30),
    ];
    const lines = groupTextItemsIntoLines(items, PAGE_H);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("real");
  });
});
