import { describe, expect, it } from "vitest";
import {
  BRAND_SWATCH_HEXES,
  RECENT_COLOR_LIMIT,
  brandSwatches,
  describeColor,
  formatHex,
  from255,
  hslToRgb,
  parseHex,
  pushRecentColor,
  relativeLuminance,
  rgbToHsl,
  sameColor,
  swatchInkTone,
  to255,
  uniqueSwatches,
} from "./colorModel";
import type { EditorColor } from "./objects";

const BLACK: EditorColor = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: EditorColor = { r: 1, g: 1, b: 1, a: 1 };
const BRAND: EditorColor = { r: 124 / 255, g: 58 / 255, b: 237 / 255, a: 1 };

describe("colorModel: channel conversion", () => {
  it("maps the 0..1 float range onto 0..255 integers at both ends", () => {
    expect(to255(0)).toBe(0);
    expect(to255(1)).toBe(255);
    expect(to255(0.5)).toBe(128);
  });

  it("clamps out-of-range and non-finite channels instead of producing NaN", () => {
    // A NaN channel would format as "#NaNNaNNaN" and poison every downstream
    // comparison; a total function is the point.
    for (const bad of [-1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Number.isInteger(to255(bad))).toBe(true);
      expect(to255(bad)).toBeGreaterThanOrEqual(0);
      expect(to255(bad)).toBeLessThanOrEqual(255);
    }
  });

  it("round-trips every 8-bit value through from255/to255 exactly", () => {
    for (let v = 0; v <= 255; v += 1) {
      expect(to255(from255(v))).toBe(v);
    }
  });
});

describe("colorModel: formatHex", () => {
  it("formats a 6-digit uppercase hex by default", () => {
    expect(formatHex(BRAND)).toBe("#7C3AED");
    expect(formatHex(BLACK)).toBe("#000000");
    expect(formatHex(WHITE)).toBe("#FFFFFF");
  });

  it("keeps a stable 7-character width so the text field does not reflow", () => {
    for (const color of [BLACK, WHITE, BRAND, { r: 0.004, g: 0.5, b: 0.99, a: 1 }]) {
      expect(formatHex(color)).toHaveLength(7);
    }
  });

  it("omits alpha for an opaque colour even when alpha is requested", () => {
    // Appending "FF" to every opaque value is noise: the common case should read
    // as the short form a user recognises.
    expect(formatHex(BRAND, true)).toBe("#7C3AED");
  });

  it("appends alpha only when the colour is translucent and alpha is requested", () => {
    const half = { ...BRAND, a: 0.5 };
    expect(formatHex(half, true)).toBe("#7C3AED80");
    expect(formatHex(half, false)).toBe("#7C3AED");
  });
});

describe("colorModel: parseHex", () => {
  it("accepts the canonical 6-digit form with a hash", () => {
    expect(parseHex("#7C3AED")).toEqual(BRAND);
  });

  it("accepts what people actually type: no hash, lowercase, stray whitespace", () => {
    for (const input of ["7C3AED", "  #7c3aed  ", "7c3aed", "#7c3AeD"]) {
      const parsed = parseHex(input);
      expect(parsed).not.toBeNull();
      expect(sameColor(parsed, BRAND)).toBe(true);
    }
  });

  it("expands 3-digit shorthand by digit doubling, like CSS", () => {
    expect(parseHex("#7C3")).toEqual(parseHex("#77CC33"));
    expect(parseHex("#fff")).toEqual(WHITE);
    expect(parseHex("#000")).toEqual(BLACK);
  });

  it("reads 8-digit hex as RGB plus alpha", () => {
    const parsed = parseHex("#7C3AED80");
    expect(parsed).not.toBeNull();
    expect(to255(parsed!.a)).toBe(128);
  });

  it("expands 4-digit shorthand including its alpha nibble", () => {
    expect(parseHex("#F008")).toEqual(parseHex("#FF000088"));
  });

  it("defaults alpha to fully opaque when the input carries none", () => {
    expect(parseHex("#7C3AED")!.a).toBe(1);
    expect(parseHex("#7C3")!.a).toBe(1);
  });

  it("returns null rather than throwing for input a person has not finished typing", () => {
    // The field parses on every keystroke; a throw here would be an exception
    // per character.
    for (const input of ["", "#", "#7", "#7C", "#7C3AE", "#7C3AED0", "not a colour", "#GGGGGG", "rgba(1,2,3,4)"]) {
      expect(parseHex(input)).toBeNull();
    }
  });

  it("cannot distinguish a 4-digit colour from a half-typed 6-digit one", () => {
    // "#7C3A" is a LEGAL 4-digit shorthand (translucent lime) and also the
    // fourth keystroke of "#7C3AED" (brand purple). No parser can tell those
    // apart, which is precisely why the hex field must commit on blur/Enter
    // rather than on every keystroke: a parse-as-you-type field would flash the
    // object lime on the way to purple, and each flash would be an undo entry.
    // This test pins the ambiguity so nobody "fixes" it by rejecting 4 digits.
    const fourDigit = parseHex("#7C3A");
    expect(fourDigit).not.toBeNull();
    expect(fourDigit).toEqual(parseHex("#77CC33AA"));
    expect(sameColor(fourDigit, BRAND)).toBe(false);
  });

  it("round-trips formatHex output for every channel value", () => {
    for (let v = 0; v <= 255; v += 17) {
      const color: EditorColor = { r: from255(v), g: from255(255 - v), b: from255((v * 3) % 256), a: 1 };
      expect(sameColor(parseHex(formatHex(color)), color)).toBe(true);
    }
  });
});

describe("colorModel: HSL", () => {
  it("reports hue in degrees and saturation/lightness in percent", () => {
    expect(rgbToHsl({ r: 1, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 1, b: 0, a: 1 })).toEqual({ h: 120, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 0, b: 1, a: 1 })).toEqual({ h: 240, s: 100, l: 50 });
  });

  it("reports achromatic colours as zero-saturation with no arbitrary hue", () => {
    expect(rgbToHsl(BLACK)).toEqual({ h: 0, s: 0, l: 0 });
    expect(rgbToHsl(WHITE)).toEqual({ h: 0, s: 0, l: 100 });
    expect(rgbToHsl({ r: 0.5, g: 0.5, b: 0.5, a: 1 })).toEqual({ h: 0, s: 0, l: 50 });
  });

  it("never emits a hue of 360 (which would read as a second red at the far end)", () => {
    for (let v = 0; v <= 255; v += 1) {
      const hue = rgbToHsl({ r: 1, g: from255(v), b: from255(v), a: 1 }).h;
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("converts HSL back to the primaries exactly", () => {
    expect(hslToRgb({ h: 0, s: 100, l: 50 })).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(hslToRgb({ h: 120, s: 100, l: 50 })).toEqual({ r: 0, g: 1, b: 0, a: 1 });
    expect(hslToRgb({ h: 240, s: 100, l: 50 })).toEqual({ r: 0, g: 0, b: 1, a: 1 });
  });

  it("wraps hue rather than clamping it, so scrubbing past 360 comes round to red", () => {
    expect(hslToRgb({ h: 360, s: 100, l: 50 })).toEqual(hslToRgb({ h: 0, s: 100, l: 50 }));
    expect(hslToRgb({ h: 480, s: 100, l: 50 })).toEqual(hslToRgb({ h: 120, s: 100, l: 50 }));
    expect(hslToRgb({ h: -120, s: 100, l: 50 })).toEqual(hslToRgb({ h: 240, s: 100, l: 50 }));
  });

  it("preserves the alpha it is given, since HSL carries none", () => {
    expect(hslToRgb({ h: 200, s: 50, l: 50 }, 0.4).a).toBe(0.4);
  });

  it("round-trips to the same 8-bit colour for saturated values", () => {
    for (let h = 0; h < 360; h += 15) {
      const rgb = hslToRgb({ h, s: 100, l: 50 });
      expect(rgbToHsl(rgb)).toEqual({ h, s: 100, l: 50 });
    }
  });

  it("clamps out-of-range saturation and lightness to a real colour", () => {
    for (const hsl of [{ h: 0, s: -10, l: 50 }, { h: 0, s: 200, l: 50 }, { h: 0, s: 50, l: -5 }, { h: 0, s: 50, l: 300 }]) {
      const rgb = hslToRgb(hsl);
      for (const channel of [rgb.r, rgb.g, rgb.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("colorModel: sameColor", () => {
  it("treats colours equal at 8-bit precision as the same", () => {
    // A hex round-trip introduces sub-1/255 drift; raw float equality would
    // then fail to mark the swatch the user just picked as active.
    expect(sameColor(BRAND, parseHex("#7C3AED"))).toBe(true);
    expect(sameColor({ r: 0.5, g: 0, b: 0, a: 1 }, { r: 0.5001, g: 0, b: 0, a: 1 })).toBe(true);
  });

  it("distinguishes colours that differ by a visible step", () => {
    expect(sameColor(BLACK, WHITE)).toBe(false);
    expect(sameColor(BRAND, { ...BRAND, b: 0 })).toBe(false);
  });

  it("counts alpha as part of the colour", () => {
    expect(sameColor(BRAND, { ...BRAND, a: 0.5 })).toBe(false);
  });

  it("handles the null (no fill) value on either side", () => {
    expect(sameColor(null, null)).toBe(true);
    expect(sameColor(null, BLACK)).toBe(false);
    expect(sameColor(BLACK, null)).toBe(false);
  });
});

describe("colorModel: recent colours", () => {
  it("puts the newest colour first", () => {
    const list = pushRecentColor(pushRecentColor([], BLACK), WHITE);
    expect(formatHex(list[0])).toBe("#FFFFFF");
    expect(formatHex(list[1])).toBe("#000000");
  });

  it("moves a re-picked colour to the front instead of duplicating it", () => {
    let list: EditorColor[] = [];
    list = pushRecentColor(list, BLACK);
    list = pushRecentColor(list, WHITE);
    list = pushRecentColor(list, BLACK);
    expect(list).toHaveLength(2);
    expect(formatHex(list[0])).toBe("#000000");
  });

  it("de-duplicates ignoring alpha, so one hue cannot fill the row", () => {
    let list: EditorColor[] = [];
    list = pushRecentColor(list, { ...BRAND, a: 1 });
    list = pushRecentColor(list, { ...BRAND, a: 0.4 });
    list = pushRecentColor(list, { ...BRAND, a: 0.1 });
    expect(list).toHaveLength(1);
  });

  it("stores recents opaque, because a swatch row records hue choices", () => {
    const list = pushRecentColor([], { ...BRAND, a: 0.25 });
    expect(list[0].a).toBe(1);
  });

  it("caps the list at the documented limit, dropping the oldest", () => {
    let list: EditorColor[] = [];
    for (let v = 0; v < RECENT_COLOR_LIMIT + 5; v += 1) {
      list = pushRecentColor(list, { r: from255(v), g: 0, b: 0, a: 1 });
    }
    expect(list).toHaveLength(RECENT_COLOR_LIMIT);
    expect(formatHex(list[0])).toBe(formatHex({ r: from255(RECENT_COLOR_LIMIT + 4), g: 0, b: 0, a: 1 }));
  });

  it("does not mutate the list it is given", () => {
    const original: EditorColor[] = [BLACK];
    const copy = [...original];
    pushRecentColor(original, WHITE);
    expect(original).toEqual(copy);
  });
});

describe("colorModel: swatch palettes", () => {
  it("parses every brand swatch hex into a real colour", () => {
    const swatches = brandSwatches();
    expect(swatches).toHaveLength(BRAND_SWATCH_HEXES.length);
    swatches.forEach((color, i) => {
      expect(formatHex(color)).toBe(BRAND_SWATCH_HEXES[i].toUpperCase());
    });
  });

  it("leads the brand palette with the real brand primary token", () => {
    expect(formatHex(brandSwatches()[0])).toBe("#7C3AED");
  });

  it("de-duplicates document colours while preserving first-seen order", () => {
    const collected = [BRAND, BLACK, { ...BRAND, a: 0.5 }, WHITE, BLACK];
    const unique = uniqueSwatches(collected);
    expect(unique.map((c) => formatHex(c))).toEqual(["#7C3AED", "#000000", "#FFFFFF"]);
  });

  it("caps document colours so a busy document cannot flood the popover", () => {
    const many: EditorColor[] = [];
    for (let v = 0; v < 60; v += 1) many.push({ r: from255(v * 4), g: 0, b: 0, a: 1 });
    expect(uniqueSwatches(many, 8)).toHaveLength(8);
  });

  it("returns an empty palette for an empty document rather than a placeholder", () => {
    expect(uniqueSwatches([])).toEqual([]);
  });
});

describe("colorModel: contrast helpers", () => {
  it("computes the WCAG luminance extremes", () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 6);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 6);
  });

  it("chooses dark markings on light swatches and light markings on dark ones", () => {
    // A white check on a white swatch is an invisible selected state.
    expect(swatchInkTone(WHITE)).toBe("dark");
    expect(swatchInkTone({ r: 1, g: 1, b: 0, a: 1 })).toBe("dark");
    expect(swatchInkTone(BLACK)).toBe("light");
    expect(swatchInkTone(BRAND)).toBe("light");
  });
});

describe("colorModel: describeColor", () => {
  it("names an opaque swatch by its hex, which is precise and short", () => {
    expect(describeColor(BRAND)).toBe("#7C3AED");
  });

  it("mentions opacity only when it is not full", () => {
    expect(describeColor({ ...BRAND, a: 0.4 })).toBe("#7C3AED at 40% opacity");
    expect(describeColor({ ...BRAND, a: 1 })).toBe("#7C3AED");
  });

  it("names the no-fill state in words, since it has no hex", () => {
    expect(describeColor(null)).toBe("No fill");
    expect(describeColor(null, "No stroke")).toBe("No stroke");
  });
});
