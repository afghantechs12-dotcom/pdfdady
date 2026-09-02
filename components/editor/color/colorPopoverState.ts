import type { EditorColor } from "@/src/domain/editor/objects";
import { from255, hslToRgb, rgbToHsl, to255 } from "@/src/domain/editor/colorModel";

/** Which numeric model the channel fields are showing. */
export type ChannelMode = "rgb" | "hsl";

export interface ChannelField {
  key: string;
  label: string;
  /** Accessible name — "R" alone is not a usable label for a screen reader. */
  name: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
}

/**
 * The channel fields for the current mode. Derived, never stored: RGB is the
 * document's representation, so HSL is computed for display and converted back
 * on edit. Storing HSL would make an S=0 colour forget its hue and a round-trip
 * quantise the colour on every keystroke.
 */
export function channelFields(color: EditorColor, mode: ChannelMode): ChannelField[] {
  if (mode === "rgb") {
    return [
      { key: "r", label: "R", name: "Red", value: to255(color.r), min: 0, max: 255 },
      { key: "g", label: "G", name: "Green", value: to255(color.g), min: 0, max: 255 },
      { key: "b", label: "B", name: "Blue", value: to255(color.b), min: 0, max: 255 },
    ];
  }
  const hsl = rgbToHsl(color);
  return [
    { key: "h", label: "H", name: "Hue", value: hsl.h, min: 0, max: 360, unit: "°" },
    { key: "s", label: "S", name: "Saturation", value: hsl.s, min: 0, max: 100, unit: "%" },
    { key: "l", label: "L", name: "Lightness", value: hsl.l, min: 0, max: 100, unit: "%" },
  ];
}

/**
 * Apply an edit to one channel field and return the resulting colour.
 *
 * In HSL mode the OTHER two channels come from the current colour's derived HSL,
 * which is the subtle part: editing H must not silently re-quantise S and L. It
 * still can drift by a rounding step, which is inherent to editing a derived
 * representation and is why RGB is the stored truth.
 */
export function applyChannel(
  color: EditorColor,
  mode: ChannelMode,
  key: string,
  raw: number,
): EditorColor {
  if (!Number.isFinite(raw)) return color;
  if (mode === "rgb") {
    const v = from255(raw);
    if (key === "r") return { ...color, r: v };
    if (key === "g") return { ...color, g: v };
    if (key === "b") return { ...color, b: v };
    return color;
  }
  const hsl = rgbToHsl(color);
  const next = { ...hsl, [key]: raw } as typeof hsl;
  return hslToRgb(next, color.a);
}
