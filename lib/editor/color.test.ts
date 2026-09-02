import { describe, expect, it } from "vitest";
import type { EditorColor } from "@/src/domain/editor/objects";
import { cssToEditorColor, editorColorToCss, toHex, withAlpha } from "./color";

describe("editorColorToCss", () => {
  it("formats rgba with 0..255 ints and 0..1 alpha", () => {
    expect(editorColorToCss({ r: 1, g: 0, b: 0, a: 1 })).toBe("rgba(255,0,0,1)");
    expect(editorColorToCss({ r: 0.2, g: 0.4, b: 0.6, a: 0.75 })).toBe("rgba(51,102,153,0.75)");
    expect(editorColorToCss({ r: 0, g: 0, b: 0, a: 0 })).toBe("rgba(0,0,0,0)");
  });

  it("clamps out-of-range channels", () => {
    expect(editorColorToCss({ r: 1.5, g: -0.5, b: 0.5, a: 1 })).toBe("rgba(255,0,128,1)");
    expect(editorColorToCss({ r: 0, g: 0, b: 0, a: 2 })).toBe("rgba(0,0,0,1)");
  });
});

describe("cssToEditorColor", () => {
  it("round-trips rgba for a few colors", () => {
    const colors: EditorColor[] = [
      { r: 1, g: 0, b: 0, a: 1 },
      { r: 0.2, g: 0.4, b: 0.6, a: 0.75 },
      { r: 0, g: 0, b: 0, a: 0 },
    ];
    for (const c of colors) {
      const back = cssToEditorColor(editorColorToCss(c));
      expect(back.r).toBeCloseTo(c.r, 5);
      expect(back.g).toBeCloseTo(c.g, 5);
      expect(back.b).toBeCloseTo(c.b, 5);
      expect(back.a).toBeCloseTo(c.a, 5);
    }
  });

  it("parses #7C3AED to editor color (r≈0.486, g≈0.227, b≈0.929)", () => {
    const c = cssToEditorColor("#7C3AED");
    expect(c.r).toBeCloseTo(124 / 255, 6);
    expect(c.g).toBeCloseTo(58 / 255, 6);
    expect(c.b).toBeCloseTo(237 / 255, 6);
    expect(c.a).toBe(1);
  });

  it("expands #abc to #aabbcc", () => {
    const c = cssToEditorColor("#abc");
    expect(c.r).toBeCloseTo(170 / 255, 6); // 0xaa
    expect(c.g).toBeCloseTo(187 / 255, 6); // 0xbb
    expect(c.b).toBeCloseTo(204 / 255, 6); // 0xcc
    expect(c.a).toBe(1);
  });

  it("parses #rrggbbaa 8-digit hex with alpha", () => {
    expect(cssToEditorColor("#aabbccff").a).toBe(1);
    expect(cssToEditorColor("#aabbcc00").a).toBe(0);
    expect(cssToEditorColor("#11223344").a).toBeCloseTo(0x44 / 255, 6);
  });

  it("parses rgb() and rgba()", () => {
    expect(cssToEditorColor("rgb(255,0,0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(cssToEditorColor("rgba(1,2,3,0.5)").r).toBeCloseTo(1 / 255, 6);
    expect(cssToEditorColor("rgba(1,2,3,0.5)").a).toBe(0.5);
  });

  it("is case-insensitive and trims whitespace", () => {
    const upper = cssToEditorColor("#ABC");
    expect(upper.r).toBeCloseTo(170 / 255, 6);
    expect(upper.g).toBeCloseTo(187 / 255, 6);
    expect(upper.b).toBeCloseTo(204 / 255, 6);
    expect(cssToEditorColor("  rgba( 1 , 2 , 3 , 0.5 )  ").a).toBe(0.5);
  });

  it("clamps alpha and channels to [0,1]", () => {
    expect(cssToEditorColor("rgba(0,0,0,1.5)").a).toBe(1);
    expect(cssToEditorColor("rgba(0,0,0,-0.5)").a).toBe(0);
    const c = cssToEditorColor("rgba(300,-10,128,0.5)");
    expect(c.r).toBe(1);
    expect(c.g).toBe(0);
    expect(c.b).toBeCloseTo(128 / 255, 6);
  });

  it("throws on unparseable input", () => {
    expect(() => cssToEditorColor("notacolor")).toThrow();
    expect(() => cssToEditorColor("#gggggg")).toThrow();
    expect(() => cssToEditorColor("#12345")).toThrow();
    expect(() => cssToEditorColor("rgb(1,2)")).toThrow();
  });
});

describe("withAlpha", () => {
  it("sets alpha and clamps", () => {
    expect(withAlpha({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, 0.3)).toEqual({ r: 0.5, g: 0.5, b: 0.5, a: 0.3 });
    expect(withAlpha({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, 1.5).a).toBe(1);
    expect(withAlpha({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, -0.5).a).toBe(0);
  });
});

describe("toHex", () => {
  it("produces uppercase #RRGGBB with 6 digits (ignores alpha)", () => {
    expect(toHex({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("#FF0000");
    expect(toHex({ r: 124 / 255, g: 58 / 255, b: 237 / 255, a: 1 })).toBe("#7C3AED");
    expect(toHex({ r: 0, g: 0, b: 0, a: 1 })).toBe("#000000");
    expect(toHex({ r: 0.5, g: 0.25, b: 0.75, a: 1 })).toBe("#8040BF");
  });
});
