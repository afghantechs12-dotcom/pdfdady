import { describe, expect, it } from "vitest";
import { ocrCommandArgs, sanitizeOcrLang } from "./toolProcessing";
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

/*
 * The OCR flag list, which shipped broken for a whole phase.
 *
 * `--psm 3` is not an ocrmypdf option — ocrmypdf answered a usage error, and every
 * OCR run in every environment reported "The file may be unsupported or damaged"
 * about a valid PDF. The suite was green throughout: it tested `sanitizeOcrLang`
 * and nothing else, so the one part that was correct was the only part covered.
 *
 * No test here can know ocrmypdf's real option set — the runtime matrix probe runs
 * the binary for that. These pin the regression and the option wiring.
 */
describe("ocrCommandArgs", () => {
  it("passes the page-segmentation mode under the name ocrmypdf accepts", () => {
    const args = ocrCommandArgs({});
    expect(args).not.toContain("--psm");
    expect(args).toContain("--tesseract-pagesegmode");
    expect(args[args.indexOf("--tesseract-pagesegmode") + 1]).toBe("3");
  });

  it("names only flags ocrmypdf recognises", () => {
    // Harvested from `ocrmypdf --help` (16.x, and each has existed for years).
    // Deliberately short: it exists to catch an invented flag, not to mirror the CLI.
    const known = new Set([
      "-l",
      "--skip-text",
      "--tesseract-oem",
      "--tesseract-pagesegmode",
      "--deskew",
      "--oversample",
    ]);
    const flags = ocrCommandArgs({ deskew: "on", oversample: "300" }).filter((a) =>
      a.startsWith("-"),
    );
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) expect(known).toContain(flag);
  });

  it("sanitizes the requested language rather than passing it through", () => {
    expect(ocrCommandArgs({ language: "deu" })).toContain("deu");
    // An uninstalled pack would make ocrmypdf fail; it becomes eng instead.
    expect(ocrCommandArgs({ language: "ita" })).toContain("eng");
    expect(ocrCommandArgs({ language: "; rm -rf /" })).toContain("eng");
  });

  it("keeps the Pillow-dependent flags off unless asked", () => {
    expect(ocrCommandArgs({})).not.toContain("--deskew");
    expect(ocrCommandArgs({})).not.toContain("--oversample");
    expect(ocrCommandArgs({ deskew: "on" })).toContain("--deskew");
    expect(ocrCommandArgs({ deskew: "yes" })).not.toContain("--deskew");
  });

  it("accepts an oversample DPI only inside the range tesseract can use", () => {
    const dpi = (v: string) => {
      const args = ocrCommandArgs({ oversample: v });
      const i = args.indexOf("--oversample");
      return i < 0 ? null : args[i + 1];
    };
    expect(dpi("300")).toBe("300");
    expect(dpi("72")).toBe("72");
    expect(dpi("600")).toBe("600");
    expect(dpi("71")).toBeNull();
    expect(dpi("601")).toBeNull();
    expect(dpi("300.5")).toBeNull();
    expect(dpi("abc")).toBeNull();
    expect(dpi("")).toBeNull();
  });
});
