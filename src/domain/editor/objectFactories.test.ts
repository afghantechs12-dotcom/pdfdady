import { describe, expect, it } from "vitest";
import { decompose } from "./geometry";
import { DEFAULT_LETTER_SPACING } from "./objects";
import {
  createAnnotation,
  createDrawing,
  createHighlight,
  createImageObject,
  createShapeObject,
  createSignature,
  createTextObject,
  shapeLabel,
} from "./objectFactories";

describe("objectFactories", () => {
  it("createTextObject places at the position with default text props + letterSpacing", () => {
    const t = createTextObject({ x: 100, y: 50 }, "layer-1");
    expect(t.kind).toBe("text");
    expect(t.layerId).toBe("layer-1");
    expect(t.text).toBe("Text");
    expect(t.fontFamily).toBe("Helvetica");
    expect(t.letterSpacing).toBe(DEFAULT_LETTER_SPACING);
    const { translate } = decompose(t.transform);
    expect(translate.x).toBe(100);
    expect(translate.y).toBe(50);
    expect(t.metadata).toEqual({});
  });

  it("createImageObject fits within the 240px box + has a null crop", () => {
    const img = createImageObject({ x: 0, y: 0 }, "layer-1", "data:image/png;base64,AAA", 800, 600);
    expect(img.kind).toBe("image");
    expect(img.naturalWidth).toBe(800);
    expect(img.crop).toBeNull();
    expect(img.localBounds.width).toBeLessThanOrEqual(240);
    expect(img.localBounds.height).toBeLessThanOrEqual(240);
  });

  it("createShapeObject builds the right shape + a violet default fill", () => {
    const s = createShapeObject({ x: 10, y: 10 }, "layer-1", "ellipse");
    expect(s.kind).toBe("shape");
    expect(s.shape).toBe("ellipse");
    expect(s.style.fill).not.toBeNull();
  });

  it("createHighlight has the default highlight color", () => {
    const h = createHighlight({ x: 5, y: 5 }, "layer-1");
    expect(h.kind).toBe("highlight");
    expect(h.color.a).toBeLessThan(1);
  });

  it("createDrawing derives local bounds from the polyline", () => {
    const d = createDrawing({ x: 0, y: 0 }, "layer-1", [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 30 },
    ]);
    expect(d.kind).toBe("drawing");
    expect(d.localBounds.width).toBe(40);
    expect(d.localBounds.height).toBe(30);
  });

  it("createAnnotation + createSignature carry their kind-specific fields", () => {
    const a = createAnnotation({ x: 0, y: 0 }, "layer-1");
    expect(a.kind).toBe("annotation");
    expect(a.pointerTarget).toBeNull();
    const sig = createSignature({ x: 0, y: 0 }, "layer-1", "data:image/png;base64,AAA", 300, 100, "Ada");
    expect(sig.kind).toBe("signature");
    expect(sig.signer).toBe("Ada");
  });

  it("shapeLabel maps each kind to a label", () => {
    expect(shapeLabel("rect")).toBe("Rectangle");
    expect(shapeLabel("ellipse")).toBe("Ellipse");
    expect(shapeLabel("line")).toBe("Line");
    expect(shapeLabel("polygon")).toBe("Polygon");
  });

  it("overrides win where they conflict with defaults", () => {
    const t = createTextObject({ x: 0, y: 0 }, "layer-1", { text: "Hi", fontSize: 40 });
    expect(t.text).toBe("Hi");
    expect(t.fontSize).toBe(40);
  });

  it("createTextObject defaults background + sourceText to null (v3 fields)", () => {
    const t = createTextObject({ x: 0, y: 0 }, "layer-1");
    expect(t.background).toBeNull();
    expect(t.sourceText).toBeNull();
  });

  it("createTextObject accepts a background + sourceText override (existing-text objects)", () => {
    const white = { r: 1, g: 1, b: 1, a: 1 };
    const t = createTextObject({ x: 0, y: 0 }, "layer-1", {
      text: "Existing",
      background: white,
      sourceText: { fontName: "Times-Bold", rotation: 0 },
    });
    expect(t.background).toEqual(white);
    expect(t.sourceText).toEqual({ fontName: "Times-Bold", rotation: 0 });
  });

  it("createTextObject initializes v4 content + frame and projects supplied rich content", () => {
    const t = createTextObject(
      { x: 0, y: 0 },
      "layer-1",
      {
        text: "Ignored legacy text",
        content: {
          paragraphs: [
            {
              runs: [
                { text: "Rich", style: { fontWeight: 700 } },
                { text: " text", style: { italic: true } },
              ],
              spacingBefore: 0,
              spacingAfter: 0,
              list: { kind: "none", level: 0 },
            },
          ],
        },
        frame: {
          padding: { top: 4, right: 6, bottom: 4, left: 6 },
          verticalAlign: "middle",
          wrapMode: "wrap",
          sizingMode: "fixed",
          columns: { count: 2, gap: 12 },
        },
      },
    );

    expect(t.text).toBe("Rich text");
    expect(t.content.paragraphs[0].runs).toHaveLength(2);
    expect(t.frame.columns).toEqual({ count: 2, gap: 12 });
  });
});
