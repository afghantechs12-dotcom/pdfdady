import { describe, expect, it } from "vitest";
import { applyChannel, channelFields } from "./colorPopoverState";
import { formatHex, rgbToHsl } from "@/src/domain/editor/colorModel";
import type { EditorColor } from "@/src/domain/editor/objects";

const BRAND: EditorColor = { r: 124 / 255, g: 58 / 255, b: 237 / 255, a: 1 };

describe("colorPopoverState: channelFields", () => {
  it("shows RGB as 0-255 integers, the units people type", () => {
    expect(channelFields(BRAND, "rgb").map((f) => [f.label, f.value])).toEqual([
      ["R", 124],
      ["G", 58],
      ["B", 237],
    ]);
  });

  it("shows HSL in degrees and percents with their units", () => {
    const fields = channelFields(BRAND, "hsl");
    expect(fields.map((f) => f.label)).toEqual(["H", "S", "L"]);
    expect(fields[0].unit).toBe("°");
    expect(fields[1].unit).toBe("%");
    expect(fields[2].unit).toBe("%");
  });

  it("gives every field a spoken name, since a bare 'R' is not a usable label", () => {
    for (const mode of ["rgb", "hsl"] as const) {
      for (const field of channelFields(BRAND, mode)) {
        expect(field.name.length).toBeGreaterThan(1);
        expect(field.name).not.toBe(field.label);
      }
    }
  });

  it("declares ranges matching each model's real domain", () => {
    const rgb = channelFields(BRAND, "rgb");
    expect(rgb.every((f) => f.min === 0 && f.max === 255)).toBe(true);
    const hsl = channelFields(BRAND, "hsl");
    expect(hsl.map((f) => f.max)).toEqual([360, 100, 100]);
  });
});

describe("colorPopoverState: applyChannel", () => {
  it("sets an RGB channel from its 0-255 value", () => {
    expect(formatHex(applyChannel(BRAND, "rgb", "r", 255))).toBe("#FF3AED");
    expect(formatHex(applyChannel(BRAND, "rgb", "g", 0))).toBe("#7C00ED");
  });

  it("leaves the other RGB channels and alpha untouched", () => {
    const next = applyChannel({ ...BRAND, a: 0.5 }, "rgb", "r", 10);
    expect(next.g).toBe(BRAND.g);
    expect(next.b).toBe(BRAND.b);
    expect(next.a).toBe(0.5);
  });

  it("sets an HSL channel and preserves the other two", () => {
    const before = rgbToHsl(BRAND);
    const after = rgbToHsl(applyChannel(BRAND, "hsl", "h", 200));
    expect(after.h).toBe(200);
    expect(after.s).toBe(before.s);
    expect(after.l).toBe(before.l);
  });

  it("preserves alpha through an HSL edit, which carries none of its own", () => {
    expect(applyChannel({ ...BRAND, a: 0.3 }, "hsl", "h", 90).a).toBe(0.3);
  });

  it("clamps an out-of-range channel rather than producing an impossible colour", () => {
    for (const v of [-50, 999]) {
      const next = applyChannel(BRAND, "rgb", "r", v);
      expect(next.r).toBeGreaterThanOrEqual(0);
      expect(next.r).toBeLessThanOrEqual(1);
    }
  });

  it("refuses a non-finite value instead of poisoning the colour", () => {
    // An empty or half-typed numeric field parses to NaN.
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(applyChannel(BRAND, "rgb", "r", v)).toEqual(BRAND);
      expect(applyChannel(BRAND, "hsl", "h", v)).toEqual(BRAND);
    }
  });

  it("ignores an unknown channel key rather than corrupting the colour", () => {
    expect(applyChannel(BRAND, "rgb", "z", 100)).toEqual(BRAND);
  });

  it("round-trips a field edit back to the same displayed value", () => {
    // What the user types must be what the field then reads back, or the control
    // fights them.
    for (const mode of ["rgb", "hsl"] as const) {
      for (const field of channelFields(BRAND, mode)) {
        const target = Math.round((field.min + field.max) / 3);
        const next = applyChannel(BRAND, mode, field.key, target);
        const shown = channelFields(next, mode).find((f) => f.key === field.key)!;
        expect(shown.value).toBe(target);
      }
    }
  });
});
