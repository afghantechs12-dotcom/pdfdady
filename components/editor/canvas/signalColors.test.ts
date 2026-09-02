import { describe, expect, it } from "vitest";
import {
  ACCENT,
  DRAFT,
  DRAFT_EDGE,
  DRAFT_TINT,
  DRAFT_TINT_STRONG,
  DRAFT_TINT_WEAK,
  GUIDE,
  SELECTION,
  SELECTION_HALO,
  SELECTION_RGB,
  SELECTION_SOFT,
} from "./signalColors";
import { editorColors } from "@/styles/editor";
import { parseHex, relativeLuminance, rgbToHsl } from "@/src/domain/editor/colorModel";

function hue(hex: string): number {
  const color = parseHex(hex);
  expect(color).not.toBeNull();
  return rgbToHsl(color!).h;
}

/** Shortest distance between two hues on the 360° wheel. */
function hueDistance(a: string, b: string): number {
  const diff = Math.abs(hue(a) - hue(b)) % 360;
  return Math.min(diff, 360 - diff);
}

describe("signalColors: the three signals stay distinct", () => {
  it("gives selection a different hue from the brand accent", () => {
    // The acceptance criterion: the brand, the selection outline, the active
    // tool and the alignment guides must not all be the same purple.
    expect(SELECTION).not.toBe(ACCENT);
  });

  it("gives guides a different hue from both the accent and the selection", () => {
    expect(GUIDE).not.toBe(ACCENT);
    expect(GUIDE).not.toBe(SELECTION);
  });

  it("separates all three by a hue distance a person can actually tell apart", () => {
    // 40° is roughly the point where two saturated colours stop reading as
    // "shades of the same thing". Equality alone is not enough: #7C3AED and
    // #7D3AED are different strings and the same colour.
    expect(hueDistance(SELECTION, ACCENT)).toBeGreaterThan(40);
    expect(hueDistance(GUIDE, ACCENT)).toBeGreaterThan(40);
    expect(hueDistance(GUIDE, SELECTION)).toBeGreaterThan(40);
  });

  it("keeps every signal dark enough to be visible on a white page", () => {
    // The canvas is a white PDF page; a pale signal on it is no signal.
    for (const signal of [ACCENT, SELECTION, GUIDE]) {
      const color = parseHex(signal);
      expect(color).not.toBeNull();
      expect(relativeLuminance(color!)).toBeLessThan(0.4);
    }
  });

  it("keeps the halo light, since its job is contrast under a dark stroke", () => {
    expect(SELECTION_HALO).toContain("255,255,255");
  });

  it("keeps the soft selection tint light enough to sit under text", () => {
    const color = parseHex(SELECTION_SOFT);
    expect(color).not.toBeNull();
    expect(relativeLuminance(color!)).toBeGreaterThan(0.6);
  });
});

describe("signalColors: single source of truth", () => {
  it("re-exports the token module rather than restating the hexes", () => {
    // If these drift, the SVG canvas and the CSS chrome disagree about what
    // "selected" looks like.
    expect(ACCENT).toBe(editorColors.accent);
    expect(SELECTION).toBe(editorColors.selection);
    expect(SELECTION_SOFT).toBe(editorColors.selectionsoft);
    expect(SELECTION_HALO).toBe(editorColors.selectionhalo);
    expect(GUIDE).toBe(editorColors.guide);
  });

  it("states every signal as a parseable colour, so the canvas cannot render 'undefined'", () => {
    for (const signal of [ACCENT, SELECTION, SELECTION_SOFT, GUIDE]) {
      expect(parseHex(signal)).not.toBeNull();
    }
  });
});

describe("signalColors: drafts and tints", () => {
  it("draws in-progress previews in the selection colour, not a fourth hue", () => {
    // A draft is "what your pointer has hold of", which selection already means.
    // Drafts are distinguished by a DASHED stroke, not by a different colour.
    expect(DRAFT).toBe(SELECTION);
  });

  it("keeps every translucent tint on the selection hue", () => {
    // The tints are hand-written rgba() because SVG `fill` takes no separate
    // opacity. If SELECTION changes and these do not, a draft's interior ends up
    // a different colour from its own outline.
    const color = parseHex(SELECTION);
    expect(color).not.toBeNull();
    const channels = [color!.r, color!.g, color!.b].map((c) => Math.round(c * 255)).join(",");
    expect(SELECTION_RGB).toBe(channels);
    for (const tint of [DRAFT_TINT_STRONG, DRAFT_TINT, DRAFT_TINT_WEAK, DRAFT_EDGE]) {
      expect(tint).toContain(SELECTION_RGB);
    }
  });

  it("orders the tints from lightest wash to strongest", () => {
    // The weak wash is for the largest area (a text-box drag); a heavier tint
    // over that much of the page would obscure the text underneath.
    const alpha = (rgba: string) => Number.parseFloat(rgba.split(",")[3]);
    expect(alpha(DRAFT_TINT_WEAK)).toBeLessThan(alpha(DRAFT_TINT));
    expect(alpha(DRAFT_TINT)).toBeLessThan(alpha(DRAFT_TINT_STRONG));
    expect(alpha(DRAFT_TINT_STRONG)).toBeLessThan(alpha(DRAFT_EDGE));
  });

  it("keeps every tint translucent, so it washes content rather than hiding it", () => {
    const alpha = (rgba: string) => Number.parseFloat(rgba.split(",")[3]);
    for (const tint of [DRAFT_TINT_STRONG, DRAFT_TINT, DRAFT_TINT_WEAK, DRAFT_EDGE]) {
      expect(alpha(tint)).toBeGreaterThan(0);
      expect(alpha(tint)).toBeLessThan(1);
    }
  });
});
