import { describe, expect, it } from "vitest";
import {
  availableFonts,
  familyIsItalic,
  italicSupport,
  resolveFont,
  withItalic,
} from "@/lib/editor/fontSubstitution";
import { resolveStandardFont } from "@/src/application/editor/export/PdfExportService";
import { base14AscentRatio } from "@/src/domain/editor/textMetrics";

/**
 * Italic is represented as a FAMILY choice (P1 Phase H, decision B2): no new
 * `italic` boolean on TextObject, so `EDITOR_FORMAT_VERSION` stays 6 and no
 * migration is needed.
 *
 * These tests pin the two properties that make that safe: the round-trip within
 * the base-14 matrix, and the INDEPENDENCE of bold and italic (the worry that
 * family-based italic degenerates into "family arithmetic" where toggling one
 * axis clobbers the other).
 */

describe("familyIsItalic", () => {
  it("recognizes both PostScript posture spellings", () => {
    // Base-14 is inconsistent on purpose: Helvetica/Courier say "Oblique",
    // Times says "Italic".
    expect(familyIsItalic("Helvetica-Oblique")).toBe(true);
    expect(familyIsItalic("Times-Italic")).toBe(true);
    expect(familyIsItalic("Courier-BoldOblique")).toBe(true);
    expect(familyIsItalic("Times-BoldItalic")).toBe(true);
  });

  it("is false for upright families", () => {
    expect(familyIsItalic("Helvetica")).toBe(false);
    expect(familyIsItalic("Helvetica-Bold")).toBe(false);
    expect(familyIsItalic("Times-Roman")).toBe(false);
    expect(familyIsItalic("Symbol")).toBe(false);
  });

  it("agrees with the exporter's own posture test", () => {
    // The whole design rests on these two predicates matching. If the exporter's
    // regex changes, this fails rather than silently exporting upright text that
    // the canvas slants.
    for (const { family } of availableFonts()) {
      expect(resolveStandardFont(family, 400).italic).toBe(familyIsItalic(family));
    }
  });

  it("tolerates junk input rather than throwing", () => {
    expect(familyIsItalic("")).toBe(false);
    expect(familyIsItalic(undefined as unknown as string)).toBe(false);
  });
});

describe("withItalic", () => {
  it("round-trips every family that has an italic counterpart", () => {
    const pairs: Array<[string, string]> = [
      ["Helvetica", "Helvetica-Oblique"],
      ["Helvetica-Bold", "Helvetica-BoldOblique"],
      ["Times-Roman", "Times-Italic"],
      ["Times-Bold", "Times-BoldItalic"],
      ["Courier", "Courier-Oblique"],
      ["Courier-Bold", "Courier-BoldOblique"],
    ];
    for (const [upright, italic] of pairs) {
      expect(withItalic(upright, true)).toBe(italic);
      expect(withItalic(italic, false)).toBe(upright);
      // Idempotent: toggling on twice must not double-suffix.
      expect(withItalic(italic, true)).toBe(italic);
      expect(withItalic(upright, false)).toBe(upright);
    }
  });

  it("preserves boldness across a posture change", () => {
    // The "family arithmetic" risk: switching posture must not silently drop the
    // weight half of the name.
    expect(withItalic("Helvetica-Bold", true)).toBe("Helvetica-BoldOblique");
    expect(withItalic("Helvetica-BoldOblique", false)).toBe("Helvetica-Bold");
    expect(withItalic("Times-BoldItalic", false)).toBe("Times-Bold");
  });

  it("leaves Symbol and ZapfDingbats untouched", () => {
    // No oblique variant exists; a no-op is honest, a fabricated name is not.
    for (const family of ["Symbol", "ZapfDingbats"]) {
      expect(withItalic(family, true)).toBe(family);
      expect(withItalic(family, false)).toBe(family);
    }
  });

  it("canonicalizes an unknown or imported family before switching", () => {
    // "Arial" and a PDF subset name are not drawable; they must land on the
    // base-14 family the editor actually renders.
    expect(withItalic("Arial", true)).toBe("Helvetica-Oblique");
    expect(withItalic("Times New Roman", true)).toBe("Times-Italic");
    expect(withItalic("ABCDEF+DejaVuSansCondensed", true)).toBe("Helvetica-Oblique");
  });

  it("only ever returns a real base-14 family", () => {
    const known = new Set(availableFonts().map((f) => f.family));
    for (const { family } of availableFonts()) {
      expect(known).toContain(withItalic(family, true));
      expect(known).toContain(withItalic(family, false));
    }
  });
});

describe("italicSupport", () => {
  it("reports support for the twelve text families", () => {
    for (const family of ["Helvetica", "Helvetica-BoldOblique", "Times-Italic", "Courier-Bold"]) {
      expect(italicSupport(family).supported).toBe(true);
    }
  });

  it("gives a reason the UI can show when italic is impossible (H24)", () => {
    const symbol = italicSupport("Symbol");
    expect(symbol.supported).toBe(false);
    expect(symbol.reason).toMatch(/no italic variant/i);
    expect(italicSupport("ZapfDingbats").supported).toBe(false);
  });
});

describe("bold and italic remain independent axes", () => {
  it("maps all four permutations to the right base-14 font", () => {
    // fontWeight drives bold, family drives italic; the exporter composes them.
    const cases: Array<[string, number, string]> = [
      ["Helvetica", 400, "Helvetica"],
      ["Helvetica", 700, "Helvetica-Bold"],
      ["Helvetica-Oblique", 400, "Helvetica-Oblique"],
      ["Helvetica-Oblique", 700, "Helvetica-BoldOblique"],
      ["Times-Roman", 400, "Times-Roman"],
      ["Times-Roman", 700, "Times-Bold"],
      ["Times-Italic", 400, "Times-Italic"],
      ["Times-Italic", 700, "Times-BoldItalic"],
    ];
    for (const [family, weight, expected] of cases) {
      expect(resolveStandardFont(family, weight).font, `${family} @ ${weight}`).toBe(expected);
    }
  });

  it("keeps italic on when only the weight changes", () => {
    // Toggling B on an italic object must not straighten it.
    const italicFamily = withItalic("Helvetica", true);
    expect(resolveStandardFont(italicFamily, 400).italic).toBe(true);
    expect(resolveStandardFont(italicFamily, 700).italic).toBe(true);
  });

  it("keeps bold on when only the posture changes", () => {
    expect(resolveStandardFont(withItalic("Helvetica-Bold", true), 400).font).toBe(
      "Helvetica-BoldOblique",
    );
  });
});

describe("posture cannot shift text layout", () => {
  it("shares one ascent ratio across every posture of a family", () => {
    // The C1/C2 invariant for imported runs: the transform carries T(0,-ascent),
    // so if an oblique face had a different ascender, italicizing imported text
    // would move its baseline. Verified against pdf-lib in
    // textMetrics.test.ts; here we pin that the mapping is posture-agnostic.
    expect(base14AscentRatio("Helvetica-Oblique")).toBe(base14AscentRatio("Helvetica"));
    expect(base14AscentRatio("Times-Italic")).toBe(base14AscentRatio("Times-Roman"));
    expect(base14AscentRatio("Courier-BoldOblique")).toBe(base14AscentRatio("Courier"));
  });

  it("resolves an italic family to the same metric family as its upright", () => {
    expect(resolveFont("Helvetica-Oblique").standard).toBe(true);
    expect(resolveFont("Times-Italic").substituted).toBe(false);
  });
});
