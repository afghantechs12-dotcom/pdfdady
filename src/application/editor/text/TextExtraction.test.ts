import { describe, expect, it } from "vitest";
import {
  fontSizeFromTransform,
  groupTextItemsIntoLines,
  mapFontToBaseFamily,
  rotationFromTransform,
  type RawTextItem,
} from "./TextExtraction";
import { base14Ascent, base14Descent } from "@/src/domain/editor/textMetrics";

/** Builds a horizontal text item at (pdfX, pdfY) with the given size + width. */
function hItem(str: string, pdfX: number, pdfY: number, size: number, width: number, fontName = "Helvetica"): RawTextItem {
  return { str, transform: [size, 0, 0, size, pdfX, pdfY], width, fontName };
}

/** Builds a 90°-rotated (vertical) text item; baseline direction is (0, size). */
function vItem(str: string, pdfX: number, pdfY: number, size: number, width: number): RawTextItem {
  return { str, transform: [0, size, -size, 0, pdfX, pdfY], width };
}

const PAGE_H = 842;

describe("fontSizeFromTransform", () => {
  it("is |a| for unrotated text (b = 0)", () => {
    expect(fontSizeFromTransform([12, 0, 0, 12, 10, 20])).toBe(12);
  });
  it("is |b| for 90° text (a = 0)", () => {
    expect(fontSizeFromTransform([0, 14, -14, 0, 10, 20])).toBe(14);
  });
  it("is the column-vector magnitude for arbitrary rotation", () => {
    // 30° rotation, size 10: a = 10*cos30, b = 10*sin30.
    const a = 10 * Math.cos((30 * Math.PI) / 180);
    const b = 10 * Math.sin((30 * Math.PI) / 180);
    expect(fontSizeFromTransform([a, b, -b, a, 5, 5])).toBeCloseTo(10, 5);
  });
});

describe("rotationFromTransform", () => {
  it("is 0 for unrotated text", () => {
    expect(rotationFromTransform([12, 0, 0, 12, 0, 0])).toBe(0);
  });
  it("is 90 for vertical text", () => {
    expect(rotationFromTransform([0, 12, -12, 0, 0, 0])).toBe(90);
  });
  it("is normalized to [0, 360)", () => {
    // atan2(0, -12) = 180°.
    expect(rotationFromTransform([-12, 0, 0, -12, 0, 0])).toBe(180);
  });
});

describe("groupTextItemsIntoLines", () => {
  it("groups items on the same baseline into one line", () => {
    // Two fragments of "Hello" on the same baseline (pdfY = 800 → screen y = 42).
    const lines = groupTextItemsIntoLines(
      [hItem("Hel", 50, 800, 12, 20), hItem("lo", 70, 800, 12, 20)],
      PAGE_H,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Hello");
    expect(lines[0].fontSize).toBe(12);
    expect(lines[0].rotation).toBe(0);
  });

  it("inserts a space when the gap between items exceeds the threshold", () => {
    // "Hel" ends at pdfX 70; "lo" starts at pdfX 110 → gap 40 >> 0.18*12 ≈ 2.2.
    const lines = groupTextItemsIntoLines(
      [hItem("Hel", 50, 800, 12, 20), hItem("lo", 110, 800, 12, 20)],
      PAGE_H,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Hel lo");
  });

  it("concatenates tightly when fragments abut (no spurious space)", () => {
    // "Hel" ends at 70; "lo" starts at 70 → gap 0, no space.
    const lines = groupTextItemsIntoLines(
      [hItem("Hel", 50, 800, 12, 20), hItem("lo", 70, 800, 12, 20)],
      PAGE_H,
    );
    expect(lines[0].text).toBe("Hello");
  });

  it("separates items on different baselines into different lines", () => {
    const lines = groupTextItemsIntoLines(
      [hItem("Line one", 50, 800, 12, 50), hItem("Line two", 50, 780, 12, 50)],
      PAGE_H,
    );
    expect(lines).toHaveLength(2);
    // Reading order: top line first (smaller screen baseline y). pdfY 800 →
    // baselineY 42; pdfY 780 → baselineY 62. So the 800-baseline line is above.
    expect(lines[0].baselineY).toBeLessThan(lines[1].baselineY);
    expect(lines[0].text).toBe("Line one");
    expect(lines[1].text).toBe("Line two");
  });

  it("filters out empty and whitespace-only items", () => {
    const lines = groupTextItemsIntoLines(
      [hItem("", 50, 800, 12, 0), hItem("   ", 60, 800, 12, 10), hItem("Keep", 70, 800, 12, 30)],
      PAGE_H,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Keep");
  });

  it("filters out degenerate (sub-min-size) items", () => {
    const lines = groupTextItemsIntoLines(
      [hItem("tiny", 50, 800, 0.5, 5), hItem("Real", 50, 780, 12, 30)],
      PAGE_H,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Real");
  });

  it("computes the placement primitives (baseline origin, advance, ascent, descent)", () => {
    // One item at pdfX 50, width 40, size 12, pdfY 800, font Helvetica.
    const lines = groupTextItemsIntoLines([hItem("Word", 50, 800, 12, 40)], PAGE_H);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    // Baseline origin = (pdfX, pageHeight - pdfY) = (50, 42).
    expect(line.baselineX).toBe(50);
    expect(line.baselineY).toBe(842 - 800);
    // Advance = the item's width along the baseline = 40.
    expect(line.advance).toBeCloseTo(40, 5);
    // Ascent/descent = the MAPPED base-14 font's metrics (Helvetica: 0.718/0.207
    // per em × 12), NOT PDF.js's item height (which is the font size). These are
    // the values the adapter's T(0, −ascent) shift and the render/export baseline
    // anchor must share so the redrawn text lands on the original baseline.
    expect(line.ascent).toBeCloseTo(base14Ascent("Helvetica", 12), 5);
    expect(line.descent).toBeCloseTo(base14Descent("Helvetica", 12), 5);
    expect(line.ascent).toBeCloseTo(12 * 0.718, 5);
    expect(line.descent).toBeCloseTo(12 * 0.207, 5);
  });

  it("groups vertical (90°) text along the x cross-axis", () => {
    // Two vertical items on the same pdfX baseline (cross-axis = screen x = pdfX).
    // AB at pdfY 800 extends up to 820 (screen 42→22); CD at pdfY 770 extends up
    // to 790 (screen 72→52) → a 10-unit gap (screen 62 vs 72) inserts a space.
    const lines = groupTextItemsIntoLines(
      [vItem("AB", 100, 800, 12, 20), vItem("CD", 100, 770, 12, 20)],
      PAGE_H,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("AB CD");
    expect(lines[0].rotation).toBe(90);
  });

  it("emits non-cardinal-rotation items as their own lines (no fragile merging)", () => {
    // 30° rotation: not cardinal → each item is its own line, even on the same
    // baseline (arbitrary-angle grouping is deliberately not attempted).
    const a = 10 * Math.cos((30 * Math.PI) / 180);
    const b = 10 * Math.sin((30 * Math.PI) / 180);
    const items: RawTextItem[] = [
      { str: "tilted", transform: [a, b, -b, a, 50, 800], width: 30 },
      { str: "tilted2", transform: [a, b, -b, a, 50, 800], width: 30 },
    ];
    const lines = groupTextItemsIntoLines(items, PAGE_H);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.text).sort()).toEqual(["tilted", "tilted2"]);
  });

  it("returns lines in reading order (top-to-bottom, left-to-right)", () => {
    // Three separate baselines → three lines; verify top-to-bottom ordering by
    // baseline (smaller screen baselineY = higher on the page = first).
    const lines = groupTextItemsIntoLines(
      [
        hItem("B", 200, 780, 12, 10), // baselineY = 62 (lower)
        hItem("A", 50, 800, 12, 10), // baselineY = 42 (upper)
        hItem("C", 50, 820, 12, 10), // baselineY = 22 (topmost)
      ],
      PAGE_H,
    );
    expect(lines.map((l) => l.text)).toEqual(["C", "A", "B"]);
  });

  it("preserves the font name on the line for provenance", () => {
    const lines = groupTextItemsIntoLines([hItem("Word", 50, 800, 12, 40, "Times-Bold")], PAGE_H);
    expect(lines[0].fontName).toBe("Times-Bold");
  });
});

describe("mapFontToBaseFamily", () => {
  it("maps a bold name to Helvetica-Bold + weight 700", () => {
    expect(mapFontToBaseFamily("Arial-BoldMT")).toEqual({ fontFamily: "Helvetica-Bold", fontWeight: 700 });
  });
  it("maps a serif name to Times-Roman", () => {
    expect(mapFontToBaseFamily("TimesNewRomanPSMT")).toEqual({ fontFamily: "Times-Roman", fontWeight: 400 });
  });
  it("maps a mono name to Courier", () => {
    expect(mapFontToBaseFamily("CourierNewPSMT")).toEqual({ fontFamily: "Courier", fontWeight: 400 });
  });
  it("falls back to Helvetica for an opaque PDF.js font id", () => {
    expect(mapFontToBaseFamily("g_d0_f1")).toEqual({ fontFamily: "Helvetica", fontWeight: 400 });
  });
  it("falls back to Helvetica for an undefined name", () => {
    expect(mapFontToBaseFamily(undefined)).toEqual({ fontFamily: "Helvetica", fontWeight: 400 });
  });
});
