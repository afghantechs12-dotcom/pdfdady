import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  base14Ascent,
  base14AscentRatio,
  base14Descent,
  base14DescentRatio,
  base14Family,
} from "./textMetrics";

/**
 * Tests for the shared base-14 vertical-metrics module (M5 Part 1, C2 fix).
 *
 * The module exists so the adapter's `T(0, −ascent)` transform shift, the
 * on-screen render baseline anchor, and the pdf-lib export baseline anchor all
 * use the SAME ascender. The ratios were measured from pdf-lib's
 * `font.heightAtSize`; the alignment test below re-measures pdf-lib and asserts
 * the ratios still match, so a pdf-lib / AFM-metric drift is caught at test
 * time rather than silently re-introducing the ~0.28×fontSize misalignment.
 */

describe("base14Family classification", () => {
  it("maps Helvetica and its variants to Helvetica", () => {
    expect(base14Family("Helvetica")).toBe("Helvetica");
    expect(base14Family("Helvetica-Bold")).toBe("Helvetica");
    expect(base14Family("Helvetica-Oblique")).toBe("Helvetica");
  });
  it("maps Times and serif names to Times-Roman", () => {
    expect(base14Family("Times-Roman")).toBe("Times-Roman");
    expect(base14Family("Times-Bold")).toBe("Times-Roman");
    expect(base14Family("serif")).toBe("Times-Roman");
  });
  it("maps Courier and mono names to Courier", () => {
    expect(base14Family("Courier")).toBe("Courier");
    expect(base14Family("Courier-Bold")).toBe("Courier");
    expect(base14Family("monospace")).toBe("Courier");
  });
  it("falls back to Helvetica for unknown/opaque names", () => {
    expect(base14Family("g_d0_f1")).toBe("Helvetica");
    expect(base14Family("")).toBe("Helvetica");
    expect(base14Family("Arial")).toBe("Helvetica");
  });
  it("treats sans-serif as Helvetica (not Times)", () => {
    // Mirrors resolveStandardFont: serif + sans → Helvetica, not Times.
    expect(base14Family("sans-serif")).toBe("Helvetica");
  });
});

describe("base14 vertical metrics align with pdf-lib", () => {
  // Re-measure pdf-lib's own ascender/descender and assert the module's ratios
  // match — the guard that keeps the single source of truth honest.
  const cases: Array<[string, StandardFonts]> = [
    ["Helvetica", StandardFonts.Helvetica],
    ["Helvetica-Bold", StandardFonts.HelveticaBold],
    ["Times-Roman", StandardFonts.TimesRoman],
    ["Times-Bold", StandardFonts.TimesRomanBold],
    ["Courier", StandardFonts.Courier],
    ["Courier-Bold", StandardFonts.CourierBold],
  ];

  it.each(cases)("%s: base14Ascent/Descent ratios match font.heightAtSize", async (_family, stdFont) => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(stdFont);
    const size = 1000;
    const pdfAscent = font.heightAtSize(size, { descender: false });
    const pdfFull = font.heightAtSize(size, { descender: true });
    const pdfDescent = pdfFull - pdfAscent;
    expect(base14AscentRatio(_family)).toBeCloseTo(pdfAscent / size, 5);
    expect(base14DescentRatio(_family)).toBeCloseTo(pdfDescent / size, 5);
  });

  it("scales linearly with font size", () => {
    expect(base14Ascent("Helvetica", 12)).toBeCloseTo(12 * 0.718, 5);
    expect(base14Descent("Helvetica", 12)).toBeCloseTo(12 * 0.207, 5);
    expect(base14Ascent("Times-Roman", 24)).toBeCloseTo(24 * 0.683, 5);
    expect(base14Descent("Courier", 10)).toBeCloseTo(10 * 0.157, 5);
  });

  it("base14Ascent(Helvetica) is NOT the font size (the C2 invariant)", () => {
    // The C2 bug was using PDF.js's item.height (= fontSize) as the ascent. The
    // fix uses the base-14 ascender, which is deliberately < fontSize.
    expect(base14Ascent("Helvetica", 12)).toBeLessThan(12);
    expect(base14Ascent("Helvetica", 12)).toBeCloseTo(8.616, 3);
  });
});
