import { describe, expect, it } from "vitest";
import {
  assessImportedTextCapability,
  readonlyCapability,
  READONLY_REASON,
  UNKNOWN_SOURCE_TEXT_FACTS,
  type SourceTextFacts,
} from "./sourceText";

/**
 * Tests for the imported-text capability decision.
 *
 * The property under test throughout is: editing is unlocked ONLY by positive
 * evidence. Every case that removes a fact must fall back to readonly. These
 * tests exist because the previous design had the opposite default — it treated
 * "extraction returned a string and a box" as sufficient to offer editing, which
 * is what produced editable copies floating over unedited original text.
 */

/** Facts for a run that would be directly editable — every check satisfied. */
function directCapableFacts(): SourceTextFacts {
  return {
    hasOperatorMapping: true,
    writingMode: "horizontal",
    rotation: 0,
    horizontalScale: 1,
    fontEmbedded: true,
    fontType: "TrueType",
    encodingKnown: true,
    hasUnsupportedClipPath: false,
    hasTransparencyGroup: false,
    hasComplexLigatures: false,
    compositeFontMappingKnown: true,
    boundsTrustworthy: true,
    background: null,
  };
}

/** Facts for a run with no operator mapping but a clean, probed background. */
function replaceCapableFacts(): SourceTextFacts {
  return {
    ...directCapableFacts(),
    hasOperatorMapping: false,
    background: { uniform: true, color: { r: 1, g: 1, b: 1 }, reason: "flat fill" },
  };
}

describe("assessImportedTextCapability: the safe default", () => {
  it("returns readonly when nothing is known", () => {
    const capability = assessImportedTextCapability(UNKNOWN_SOURCE_TEXT_FACTS);
    expect(capability.mode).toBe("readonly");
    expect(capability.editable).toBe(false);
    // The reason names the FIRST unmet requirement (here: the writing mode was
    // never determined) rather than the generic fallback — a specific
    // explanation is more useful in the Properties panel than "cannot be
    // edited". Every branch still ends in "cannot be edited safely."
    expect(capability.reason).toMatch(/cannot be edited safely\.$/);
  });

  it("uses the generic reason when every individual check passes but nothing enables editing", () => {
    // All disqualifiers cleared, yet no operator mapping and no background probe
    // — so neither direct nor replace is reachable and the fallback applies.
    const capability = assessImportedTextCapability({
      ...UNKNOWN_SOURCE_TEXT_FACTS,
      writingMode: "horizontal",
      boundsTrustworthy: true,
    });
    expect(capability.reason).toBe(READONLY_REASON);
  });

  it("does NOT grant editing merely because text and bounds were extracted", () => {
    // This is the exact mistake the old design made: extraction produced a
    // string and a trustworthy box, and that was treated as "editable".
    const facts: SourceTextFacts = {
      ...UNKNOWN_SOURCE_TEXT_FACTS,
      writingMode: "horizontal",
      boundsTrustworthy: true,
    };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("readonlyCapability carries the default reason and is never editable", () => {
    expect(readonlyCapability()).toEqual({
      mode: "readonly",
      editable: false,
      reason: READONLY_REASON,
    });
  });
});

describe("assessImportedTextCapability: direct mode", () => {
  it("grants direct editing only with a real operator mapping", () => {
    const capability = assessImportedTextCapability(directCapableFacts());
    expect(capability.mode).toBe("direct");
    expect(capability.editable).toBe(true);
    expect(capability.reason).toBeNull();
  });

  it("falls back to readonly without an operator mapping and without a probed background", () => {
    // This is the CURRENT pipeline's situation: PDF.js getTextContent() reports
    // strings and transforms but no content-stream operator offsets, so nothing
    // extracted through it can be directly edited.
    const facts = { ...directCapableFacts(), hasOperatorMapping: false };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("refuses direct editing when the font is not embedded", () => {
    const facts = { ...directCapableFacts(), fontEmbedded: false };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("refuses direct editing when the encoding is unknown", () => {
    const facts = { ...directCapableFacts(), encodingKnown: false };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("refuses direct editing for a composite font with an unknown CID mapping", () => {
    const facts: SourceTextFacts = {
      ...directCapableFacts(),
      fontType: "Type0",
      compositeFontMappingKnown: false,
    };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("allows a composite font when its CID mapping IS known", () => {
    const facts: SourceTextFacts = {
      ...directCapableFacts(),
      fontType: "Type0",
      compositeFontMappingKnown: true,
    };
    expect(assessImportedTextCapability(facts).mode).toBe("direct");
  });
});

describe("assessImportedTextCapability: disqualifiers", () => {
  it("Type 3 fonts are readonly even with a full operator mapping", () => {
    const facts: SourceTextFacts = { ...directCapableFacts(), fontType: "Type3" };
    const capability = assessImportedTextCapability(facts);
    expect(capability.mode).toBe("readonly");
    expect(capability.reason).toMatch(/Type 3/);
  });

  it("non-cardinal rotation is readonly", () => {
    const facts = { ...directCapableFacts(), rotation: 37 };
    const capability = assessImportedTextCapability(facts);
    expect(capability.mode).toBe("readonly");
    expect(capability.reason).toMatch(/rotated/);
  });

  it.each([0, 90, 180, 270, 360])("cardinal rotation %i stays editable", (rotation) => {
    expect(assessImportedTextCapability({ ...directCapableFacts(), rotation }).mode).toBe("direct");
  });

  it("vertical and unknown writing modes are readonly", () => {
    for (const writingMode of ["vertical", "unknown"] as const) {
      expect(assessImportedTextCapability({ ...directCapableFacts(), writingMode }).mode).toBe("readonly");
    }
  });

  it("a non-unit horizontal scale is readonly", () => {
    const capability = assessImportedTextCapability({ ...directCapableFacts(), horizontalScale: 0.8 });
    expect(capability.mode).toBe("readonly");
    expect(capability.reason).toMatch(/scaled/);
  });

  it("an unsupported clipping path is readonly", () => {
    expect(
      assessImportedTextCapability({ ...directCapableFacts(), hasUnsupportedClipPath: true }).mode,
    ).toBe("readonly");
  });

  it("a transparency group is readonly", () => {
    expect(
      assessImportedTextCapability({ ...directCapableFacts(), hasTransparencyGroup: true }).mode,
    ).toBe("readonly");
  });

  it("complex ligatures are readonly", () => {
    expect(
      assessImportedTextCapability({ ...directCapableFacts(), hasComplexLigatures: true }).mode,
    ).toBe("readonly");
  });

  it("untrustworthy bounds are readonly", () => {
    const capability = assessImportedTextCapability({ ...directCapableFacts(), boundsTrustworthy: false });
    expect(capability.mode).toBe("readonly");
    expect(capability.reason).toMatch(/where this text sits/);
  });

  it("a disqualifier blocks replace mode too, not just direct", () => {
    // Type 3 with an otherwise-perfect background probe must still be readonly:
    // removing glyphs you cannot characterize is not safe.
    const facts: SourceTextFacts = { ...replaceCapableFacts(), fontType: "Type3" };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });
});

describe("assessImportedTextCapability: replace mode", () => {
  it("offers replace when the background was probed and found uniform", () => {
    const capability = assessImportedTextCapability(replaceCapableFacts());
    expect(capability.mode).toBe("replace");
    expect(capability.editable).toBe(true);
    expect(capability.reason).toMatch(/permanently removed/);
  });

  it("refuses replace when the background was probed and found NOT uniform", () => {
    // A table rule, an image, or a gradient behind the run. This is the case the
    // old universal-white-rectangle mask silently destroyed.
    const facts: SourceTextFacts = {
      ...replaceCapableFacts(),
      background: { uniform: false, color: null, reason: "a line crosses the region" },
    };
    const capability = assessImportedTextCapability(facts);
    expect(capability.mode).toBe("readonly");
    expect(capability.reason).toMatch(/not a flat color/);
  });

  it("refuses replace when the background was never probed", () => {
    // `null` means "unknown", and unknown is never a maybe. This is what stops
    // the old "assume the page is white" assumption from returning.
    const facts: SourceTextFacts = { ...replaceCapableFacts(), background: null };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("refuses replace when the probe claims uniform but produced no color", () => {
    // An inconsistent probe cannot be acted on: there is nothing to paint with.
    const facts: SourceTextFacts = {
      ...replaceCapableFacts(),
      background: { uniform: true, color: null, reason: "inconsistent" },
    };
    expect(assessImportedTextCapability(facts).mode).toBe("readonly");
  });

  it("prefers direct over replace when both are possible", () => {
    // Direct needs no mask and cannot leave a residue, so it always wins.
    const facts: SourceTextFacts = {
      ...directCapableFacts(),
      background: { uniform: true, color: { r: 1, g: 1, b: 1 }, reason: "flat fill" },
    };
    expect(assessImportedTextCapability(facts).mode).toBe("direct");
  });
});
