import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { familyIsItalic, withItalic } from "@/lib/editor/fontSubstitution";
import { resolveStandardFont } from "@/src/application/editor/export/PdfExportService";

/**
 * The canvas, the live editing overlay and the PDF export must agree on text
 * POSTURE.
 *
 * The defect this pins: base-14 carries posture in the family name
 * ("Helvetica-Oblique"), the exporter honoured it via `/italic|oblique/`, but
 * neither `ObjectRenderer` nor `TextEditor` ever set `fontStyle` — a browser
 * cannot infer a slant from a PostScript family it does not have installed. So
 * an italic run rendered UPRIGHT on screen and exported SLANTED: the document
 * did not look like the thing the user was editing.
 *
 * Two of these assertions read the component source, because the renderer emits
 * SVG from live editor state and this project's vitest environment is Node with
 * no DOM (see `inspectorControls.test.ts` for the same constraint). What is
 * asserted is the specific structural fact that fixes the bug — the attribute is
 * set, and it is derived from the SHARED predicate rather than a local copy of
 * the regex, which is how the renderer drifted from the exporter originally.
 */
const ROOT = join(__dirname, "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

describe("posture is consistent across canvas, overlay and export", () => {
  const renderer = read("components", "editor", "canvas", "ObjectRenderer.tsx");
  const overlay = read("components", "editor", "canvas", "TextEditor.tsx");

  it("the committed canvas render sets fontStyle from the resolved family", () => {
    expect(renderer).toMatch(/fontStyle=\{familyIsItalic\(resolved\.family\) \? "italic" : undefined\}/);
  });

  it("the live editing overlay sets the same fontStyle", () => {
    // Otherwise text visibly straightens the moment you double-click into it.
    expect(overlay).toMatch(/fontStyle: familyIsItalic\(resolved\.family\) \? "italic" : undefined/);
  });

  it("both derive posture from the shared helper, not a local regex", () => {
    for (const source of [renderer, overlay]) {
      expect(source).toMatch(/familyIsItalic/);
      // A second, drifting copy of the exporter's test is the original sin here.
      expect(source).not.toMatch(/\/italic\|oblique\//);
    }
  });

  it("agrees with the exporter for every family the Italic toggle can produce", () => {
    // The real cross-surface contract: whatever `withItalic` yields, the canvas
    // predicate and the exporter's `italic` flag must return the same verdict.
    const families = [
      "Helvetica",
      "Helvetica-Bold",
      "Times-Roman",
      "Times-Bold",
      "Courier",
      "Courier-Bold",
      "Symbol",
      "ZapfDingbats",
    ];
    for (const family of families) {
      for (const on of [true, false]) {
        const next = withItalic(family, on);
        expect(familyIsItalic(next), `${next} (canvas)`).toBe(
          resolveStandardFont(next, 400).italic,
        );
      }
    }
  });

  it("italicizing never changes which weight the exporter picks", () => {
    // Independence, stated as a cross-surface property rather than a mapping:
    // toggling posture must not alter boldness in the exported font.
    for (const family of ["Helvetica", "Helvetica-Bold", "Times-Bold", "Courier"]) {
      const upright = resolveStandardFont(withItalic(family, false), 400).font as string;
      const italic = resolveStandardFont(withItalic(family, true), 400).font as string;
      expect(italic.toLowerCase().includes("bold")).toBe(upright.toLowerCase().includes("bold"));
    }
  });
});
