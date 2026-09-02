import { describe, expect, it } from "vitest";
import { availableFonts, resolveFont, type ResolvedFont } from "./fontSubstitution";

describe("resolveFont: exact base-14 match", () => {
  it("returns Helvetica unchanged, not substituted", () => {
    const r = resolveFont("Helvetica");
    expect(r).toEqual({ family: "Helvetica", label: "Helvetica", standard: true, substituted: false });
  });

  it("matches case-insensitively and trims whitespace", () => {
    const r = resolveFont("  HELVETICA  ");
    expect(r.family).toBe("Helvetica");
    expect(r.substituted).toBe(false);
  });

  it("matches base-14 variants like Helvetica-Bold", () => {
    const r = resolveFont("Helvetica-Bold");
    expect(r).toEqual({ family: "Helvetica-Bold", label: "Helvetica Bold", standard: true, substituted: false });
  });
});

describe("resolveFont: aliases (substituted with reason)", () => {
  it("Arial → Helvetica, substituted with reason", () => {
    const r: ResolvedFont = resolveFont("Arial");
    expect(r.family).toBe("Helvetica");
    expect(r.label).toBe("Helvetica");
    expect(r.standard).toBe(true);
    expect(r.substituted).toBe(true);
    expect(r.reason).toBe("Arial is not embedded; using Helvetica");
  });

  it("Times New Roman → Times-Roman, substituted", () => {
    const r = resolveFont("Times New Roman");
    expect(r.family).toBe("Times-Roman");
    expect(r.label).toBe("Times Roman");
    expect(r.substituted).toBe(true);
    expect(r.reason).toBe("Times New Roman is not embedded; using Times-Roman");
  });

  it("Courier New → Courier, substituted", () => {
    const r = resolveFont("Courier New");
    expect(r.family).toBe("Courier");
    expect(r.substituted).toBe(true);
    expect(r.reason).toBe("Courier New is not embedded; using Courier");
  });
});

describe("resolveFont: category fallback (substituted)", () => {
  it("Comic Sans → Helvetica (fallback)", () => {
    const r = resolveFont("Comic Sans");
    expect(r.family).toBe("Helvetica");
    expect(r.substituted).toBe(true);
    expect(r.reason).toBe("Comic Sans is not embedded; using Helvetica");
  });

  it("Something Mono → Courier", () => {
    const r = resolveFont("Something Mono");
    expect(r.family).toBe("Courier");
    expect(r.substituted).toBe(true);
    expect(r.reason).toBe("Something Mono is not embedded; using Courier");
  });

  it("a serif family → Times-Roman", () => {
    const r = resolveFont("Cochin Serif");
    expect(r.family).toBe("Times-Roman");
    expect(r.substituted).toBe(true);
  });
});

describe("availableFonts", () => {
  it("returns the 14 base-14 fonts, all standard", () => {
    const fonts = availableFonts();
    expect(fonts).toHaveLength(14);
    for (const f of fonts) expect(f.standard).toBe(true);
  });
});
