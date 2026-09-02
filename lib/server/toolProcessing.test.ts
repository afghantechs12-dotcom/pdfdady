import { describe, expect, it } from "vitest";
import { sanitizeOcrLang } from "./toolProcessing";
import { OCR_LANG_CODES, OCR_LANG_PACKS } from "@/data/serverToolConfig";

describe("sanitizeOcrLang", () => {
  it("accepts a single installed pack", () => {
    expect(sanitizeOcrLang("eng")).toBe("eng");
    expect(sanitizeOcrLang("deu")).toBe("deu");
  });

  it("falls back to eng for an uninstalled/unknown pack", () => {
    expect(sanitizeOcrLang("ita")).toBe("eng");
    expect(sanitizeOcrLang("nonsense")).toBe("eng");
  });

  it("falls back to eng for empty input", () => {
    expect(sanitizeOcrLang("")).toBe("eng");
    expect(sanitizeOcrLang("   ")).toBe("eng");
  });

  it("keeps valid packs and drops invalid ones from a +-combo", () => {
    // Defensive: the UI is a single-select, but a raw API caller could send a
    // multilingual combo. Valid packs are kept; unknown ones are dropped.
    expect(sanitizeOcrLang("eng+deu")).toBe("eng+deu");
    expect(sanitizeOcrLang("eng+ita+fra")).toBe("eng+fra");
  });

  it("falls back to eng when a combo has no valid packs", () => {
    expect(sanitizeOcrLang("ita+jpn")).toBe("eng");
  });

  it("trims whitespace around pack codes", () => {
    expect(sanitizeOcrLang("  eng  ")).toBe("eng");
    expect(sanitizeOcrLang("eng + deu")).toBe("eng+deu");
  });

  it("stays in sync with the shared OCR_LANG_CODES source", () => {
    // Every pack offered by the UI must be accepted by the sanitizer (the two
    // share OCR_LANG_CODES, so this guards against drift).
    for (const code of OCR_LANG_CODES) {
      expect(sanitizeOcrLang(code)).toBe(code);
    }
    // And the UI options count matches the pack count.
    expect(OCR_LANG_PACKS.length).toBe(OCR_LANG_CODES.length);
    expect(OCR_LANG_CODES).toEqual(["eng", "deu", "fra", "spa"]);
  });
});
