import { afterEach, describe, expect, it } from "vitest";
import { PDFPage, toRadians } from "pdf-lib";
import type { Rotation } from "pdf-lib";
import { vi } from "vitest";

import { addObjectToPage, createEditorState, getActivePage } from "@/src/domain/editor/document";
import type { EditorState } from "@/src/domain/editor/document";
import { makeImage, resetFactory } from "@/src/domain/editor/testFactories";
import type { ImageObject } from "@/src/domain/editor/objects";
import {
  compose,
  makeScale,
  makeTranslate,
  transformPoint,
} from "@/src/domain/editor/geometry";
import type { AffineTransform, Point } from "@/src/domain/editor/geometry";
import { flipObject, rotateObject } from "@/src/application/editor/transform/TransformService";
import { cropDrawSpec } from "@/src/application/editor/tools/cropMath";
import { fitContain } from "@/src/domain/editor/geometry";

import { PdfExportService } from "./PdfExportService";

/**
 * EXPORT ORIENTATION PARITY.
 *
 * The editor draws an image as SVG `<image x=0 y=0 width=W height=H>` inside
 * `<g transform="matrix(...)">`, so the image's first sample row sits on the
 * object's LOCAL TOP edge. pdf-lib draws into a unit square with the CTM
 * `translate(x,y)·rotate(θ)·scale(w,h)`, and PDF image space puts sample row 0
 * at unit y=1 — the unit square's TOP.
 *
 * These tests map the image's four corners to PDF page space twice: once from
 * the draw options the export service actually passed, and once from pure
 * editor semantics (`obj.transform` + the y-flip). Any disagreement is a
 * preview/export divergence.
 *
 * This is the guard for the shipped defect where the anchor was the object's
 * local TOP-left with a NEGATED height. That covers the identical box — so
 * bounds, hit-testing, selection, and smoke tests all stayed green — while
 * mirroring the sample rows, exporting every image and signature upside down.
 * `scripts/export-fidelity-probe.mts` rasterizes real output to prove the
 * pdf-lib CTM model asserted here matches the renderer.
 */

const PAGE_W = 595;
const PAGE_H = 842;
/** The four corners of a rect, named by the IMAGE's own orientation. */
interface Corners {
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
}

/** The subset of pdf-lib's drawImage options this parity check reads. */
interface DrawImageOptions {
  x: number;
  y: number;
  width: number;
  height: number;
  rotate?: Rotation;
}

/**
 * Where the image's corners land in PDF page space, derived ONLY from the draw
 * options — an independent model of pdf-lib's documented draw pipeline
 * (`translate · rotate · scale`, verified against pdf-lib's `api/operations.js`
 * and `api/operators.js`). Unit (0,1) is the image's top-left because PDF image
 * space places the first sample row at the top of the unit square.
 */
function cornersFromDrawOptions(opts: DrawImageOptions): Corners {
  const theta = opts.rotate ? toRadians(opts.rotate) : 0;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const at = (u: number, v: number): Point => {
    const sx = u * opts.width;
    const sy = v * opts.height;
    return {
      x: opts.x + cos * sx - sin * sy,
      y: opts.y + sin * sx + cos * sy,
    };
  };
  return {
    topLeft: at(0, 1),
    topRight: at(1, 1),
    bottomRight: at(1, 0),
    bottomLeft: at(0, 0),
  };
}

/**
 * Where the image's corners land in PDF page space according to pure editor
 * semantics: the drawn image occupies the LOCAL rect
 * `[x, x+width] x [y, y+height]` (y down, so `y` is its top edge), mapped
 * through the object transform, then flipped into pdf-lib's y-up page space.
 */
function cornersFromEditorSemantics(
  transform: AffineTransform,
  localRect: { x: number; y: number; width: number; height: number },
): Corners {
  const toPdf = (local: Point): Point => {
    const world = transformPoint(transform, local);
    return { x: world.x, y: PAGE_H - world.y };
  };
  const { x, y, width, height } = localRect;
  return {
    topLeft: toPdf({ x, y }),
    topRight: toPdf({ x: x + width, y }),
    bottomRight: toPdf({ x: x + width, y: y + height }),
    bottomLeft: toPdf({ x, y: y + height }),
  };
}

function expectCornersClose(actual: Corners, expected: Corners, label: string): void {
  for (const key of ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const) {
    expect(actual[key].x, `${label}: ${key}.x`).toBeCloseTo(expected[key].x, 6);
    expect(actual[key].y, `${label}: ${key}.y`).toBeCloseTo(expected[key].y, 6);
  }
}

/**
 * A real 2x2 RGBA PNG. Content is irrelevant to the geometry assertions, but it
 * must be a PNG pdf-lib can actually embed or the draw call never happens.
 */
const PNG_2X2_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8DAwMDAxMDAwAAABg0BA1kUiG0AAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_2X2_BASE64}`;

/** Runs a real export and returns every drawImage option object, in order. */
async function captureDrawImageCalls(state: EditorState): Promise<DrawImageOptions[]> {
  const calls: DrawImageOptions[] = [];
  const spy = vi
    .spyOn(PDFPage.prototype, "drawImage")
    .mockImplementation(function (this: PDFPage, _image, options) {
      calls.push(options as DrawImageOptions);
    });
  try {
    await new PdfExportService().exportPdf(state);
  } finally {
    spy.mockRestore();
  }
  return calls;
}

/** A single-page state of known size holding just `obj`. */
function stateWith(obj: ImageObject): EditorState {
  const base = createEditorState();
  const page = { ...getActivePage(base), width: PAGE_W, height: PAGE_H };
  return {
    ...base,
    document: { ...base.document, pages: [addObjectToPage(page, obj)] },
  };
}

function imageAt(transform: AffineTransform, overrides: Partial<ImageObject> = {}): ImageObject {
  return makeImage({
    src: PNG_DATA_URL,
    transform,
    naturalWidth: 400,
    naturalHeight: 200,
    ...overrides,
  } as Partial<ImageObject>);
}

/** Rotates about the object's own centre, the way the rotate handle does. */
function rotatedAboutCentre(obj: ImageObject, radians: number): AffineTransform {
  const centre = transformPoint(obj.transform, {
    x: obj.localBounds.width / 2,
    y: obj.localBounds.height / 2,
  });
  return rotateObject(obj, centre, radians);
}

afterEach(() => {
  resetFactory();
});

describe("exported image orientation matches the editor", () => {
  const QUARTER = Math.PI / 2;

  /**
   * Every case is a transform an actual gesture produces. `localBounds` is
   * 200x100 from the factory, so the image is asymmetric in both axes and a
   * transposed or mirrored placement cannot accidentally agree.
   */
  const cases: Array<{ name: string; build: () => ImageObject }> = [
    {
      name: "upright (translate only)",
      build: () => imageAt(makeTranslate(80, 120)),
    },
    {
      name: "rotated 90deg about its centre",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        return { ...obj, transform: rotatedAboutCentre(obj, QUARTER) };
      },
    },
    {
      name: "rotated 180deg about its centre",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        return { ...obj, transform: rotatedAboutCentre(obj, Math.PI) };
      },
    },
    {
      name: "rotated 270deg about its centre",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        return { ...obj, transform: rotatedAboutCentre(obj, 3 * QUARTER) };
      },
    },
    {
      name: "rotated 37deg (arbitrary angle)",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        return { ...obj, transform: rotatedAboutCentre(obj, (37 * Math.PI) / 180) };
      },
    },
    {
      name: "flipped horizontally",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        return { ...obj, transform: flipObject(obj, "x") };
      },
    },
    {
      name: "flipped vertically",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        return { ...obj, transform: flipObject(obj, "y") };
      },
    },
    {
      name: "flipped on both axes",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        const once = { ...obj, transform: flipObject(obj, "x") };
        return { ...once, transform: flipObject(once, "y") };
      },
    },
    {
      name: "flipped horizontally then rotated 90deg",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        const flipped = { ...obj, transform: flipObject(obj, "x") };
        return { ...flipped, transform: rotatedAboutCentre(flipped, QUARTER) };
      },
    },
    {
      name: "flipped vertically then rotated 45deg",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120));
        const flipped = { ...obj, transform: flipObject(obj, "y") };
        return { ...flipped, transform: rotatedAboutCentre(flipped, Math.PI / 4) };
      },
    },
    {
      name: "non-uniformly scaled",
      build: () =>
        imageAt(compose(makeTranslate(80, 120), makeScale(2.5, 0.75))),
    },
    {
      name: "scaled, flipped and rotated together",
      build: () => {
        const obj = imageAt(compose(makeTranslate(80, 120), makeScale(1.8, 0.6)));
        const flipped = { ...obj, transform: flipObject(obj, "x") };
        return { ...flipped, transform: rotatedAboutCentre(flipped, QUARTER) };
      },
    },
  ];

  for (const { name, build } of cases) {
    it(`places all four corners correctly when ${name}`, async () => {
      const obj = build();
      const calls = await captureDrawImageCalls(stateWith(obj));
      expect(calls).toHaveLength(1);

      // Uncropped: the drawn image fills the object's whole local box.
      const expected = cornersFromEditorSemantics(obj.transform, {
        x: 0,
        y: 0,
        width: obj.localBounds.width,
        height: obj.localBounds.height,
      });
      expectCornersClose(cornersFromDrawOptions(calls[0]), expected, name);
    });
  }

  it("keeps an upright image upright — the shipped regression, stated directly", async () => {
    const obj = imageAt(makeTranslate(80, 120));
    const [opts] = await captureDrawImageCalls(stateWith(obj));
    const { topLeft, bottomLeft, topRight } = cornersFromDrawOptions(opts);

    // The object sits at editor y 120..220 => pdf y 622..722.
    expect(topLeft.y).toBeCloseTo(PAGE_H - 120, 6);
    expect(bottomLeft.y).toBeCloseTo(PAGE_H - 220, 6);
    // Top edge ABOVE the bottom edge in pdf space, and not mirrored across x.
    expect(topLeft.y).toBeGreaterThan(bottomLeft.y);
    expect(topRight.x).toBeGreaterThan(topLeft.x);
  });

  it("mirrors an h-flipped image across x only, never across y", async () => {
    const base = imageAt(makeTranslate(80, 120));
    const flipped = { ...base, transform: flipObject(base, "x") };
    const [opts] = await captureDrawImageCalls(stateWith(flipped));
    const { topLeft, topRight, bottomLeft } = cornersFromDrawOptions(opts);

    // A horizontal flip swaps left/right, so the image's top-left corner now
    // sits on the RIGHT — but its top edge stays ABOVE its bottom edge.
    expect(topLeft.x).toBeGreaterThan(topRight.x);
    expect(topLeft.y).toBeCloseTo(PAGE_H - 120, 6);
    expect(topLeft.y).toBeGreaterThan(bottomLeft.y);
  });

  it("mirrors a v-flipped image across y only, never across x", async () => {
    const base = imageAt(makeTranslate(80, 120));
    const flipped = { ...base, transform: flipObject(base, "y") };
    const [opts] = await captureDrawImageCalls(stateWith(flipped));
    const { topLeft, topRight, bottomLeft } = cornersFromDrawOptions(opts);

    expect(topLeft.y).toBeLessThan(bottomLeft.y);
    expect(topRight.x).toBeGreaterThan(topLeft.x);
    // The box is unchanged by a centre flip: it still spans pdf y 622..722.
    expect(Math.min(topLeft.y, bottomLeft.y)).toBeCloseTo(PAGE_H - 220, 6);
    expect(Math.max(topLeft.y, bottomLeft.y)).toBeCloseTo(PAGE_H - 120, 6);
  });

  it("keeps the drawn box inside the object's bounds for every case", async () => {
    // Guards the other half of the contract: fixing orientation must not move
    // the box. The axis-aligned span of the drawn corners must equal the
    // object's own transformed bounds.
    for (const { name, build } of cases) {
      const obj = build();
      const [opts] = await captureDrawImageCalls(stateWith(obj));
      const drawn = cornersFromDrawOptions(opts);
      const expected = cornersFromEditorSemantics(obj.transform, {
        x: 0,
        y: 0,
        width: obj.localBounds.width,
        height: obj.localBounds.height,
      });
      const span = (c: Corners, axis: "x" | "y") => {
        const vs = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map((p) => p[axis]);
        return { min: Math.min(...vs), max: Math.max(...vs) };
      };
      for (const axis of ["x", "y"] as const) {
        expect(span(drawn, axis).min, `${name}: ${axis} min`).toBeCloseTo(span(expected, axis).min, 6);
        expect(span(drawn, axis).max, `${name}: ${axis} max`).toBeCloseTo(span(expected, axis).max, 6);
      }
    }
  });
});

describe("exported CROPPED image orientation matches the editor", () => {
  const cropCases: Array<{ name: string; build: () => ImageObject }> = [
    {
      name: "cropped to the top-left quarter",
      build: () =>
        imageAt(makeTranslate(80, 120), { crop: { x: 0, y: 0, width: 200, height: 100 } }),
    },
    {
      name: "cropped to an off-centre window",
      build: () =>
        imageAt(makeTranslate(80, 120), { crop: { x: 120, y: 40, width: 180, height: 90 } }),
    },
    {
      name: "cropped and rotated 90deg",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120), {
          crop: { x: 120, y: 40, width: 180, height: 90 },
        });
        return { ...obj, transform: rotatedAboutCentre(obj, Math.PI / 2) };
      },
    },
    {
      name: "cropped and flipped horizontally",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120), {
          crop: { x: 120, y: 40, width: 180, height: 90 },
        });
        return { ...obj, transform: flipObject(obj, "x") };
      },
    },
    {
      name: "cropped and flipped vertically",
      build: () => {
        const obj = imageAt(makeTranslate(80, 120), {
          crop: { x: 120, y: 40, width: 180, height: 90 },
        });
        return { ...obj, transform: flipObject(obj, "y") };
      },
    },
  ];

  for (const { name, build } of cropCases) {
    it(`places the full image correctly when ${name}`, async () => {
      const obj = build();
      const spec = cropDrawSpec(obj);
      // A crop equal to the whole image legitimately draws via the uncropped
      // path; those cases are covered above. Everything here must crop.
      expect(spec, `${name}: expected a crop draw spec`).not.toBeNull();
      if (!spec) return;

      const calls = await captureDrawImageCalls(stateWith(obj));
      expect(calls).toHaveLength(1);

      // The cropped path draws the FULL image, offset and scaled so the crop
      // window fills the object box, then clips. Parity is asserted against
      // that same local rect.
      const expected = cornersFromEditorSemantics(obj.transform, {
        x: spec.offset.x,
        y: spec.offset.y,
        width: spec.width,
        height: spec.height,
      });
      expectCornersClose(cornersFromDrawOptions(calls[0]), expected, name);
    });
  }

  it("keeps the crop window filling the object box after the orientation fix", async () => {
    // The visible result of a crop is the CLIP region, which must still be the
    // object's own four transformed corners.
    const obj = imageAt(makeTranslate(80, 120), {
      crop: { x: 120, y: 40, width: 180, height: 90 },
    });
    const spec = cropDrawSpec(obj);
    expect(spec).not.toBeNull();
    if (!spec) return;

    const box = cornersFromEditorSemantics(obj.transform, {
      x: 0,
      y: 0,
      width: obj.localBounds.width,
      height: obj.localBounds.height,
    });
    // clipCorners are world (y-down) TL, TR, BR, BL; compare in pdf space.
    const clipPdf = spec.clipCorners.map((p) => ({ x: p.x, y: PAGE_H - p.y }));
    expect(clipPdf[0].x).toBeCloseTo(box.topLeft.x, 6);
    expect(clipPdf[0].y).toBeCloseTo(box.topLeft.y, 6);
    expect(clipPdf[2].x).toBeCloseTo(box.bottomRight.x, 6);
    expect(clipPdf[2].y).toBeCloseTo(box.bottomRight.y, 6);
  });
});

describe("exported signature geometry matches the editor", () => {
  /**
   * A signature is LETTERBOXED inside its box, never stretched — the editor and
   * the exporter both call the shared `fitContain` helper. Before that, the
   * canvas letterboxed (via SVG preserveAspectRatio) while the export stretched
   * to fill the box, so a signature that had been resized non-uniformly came out
   * of the exporter a different shape than the one the user placed.
   */
  it("letterboxes a signature whose box aspect differs from the asset's", async () => {
    const base = createEditorState();
    const page = { ...getActivePage(base), width: PAGE_W, height: PAGE_H };
    const naturalWidth = 96;
    const naturalHeight = 96;
    const localBounds = { x: 0, y: 0, width: 280, height: 110 };
    const signature = {
      id: "sig-fit",
      kind: "signature" as const,
      layerId: "layer-1",
      name: "Signature",
      transform: makeTranslate(60, 200),
      localBounds,
      opacity: 1,
      visible: true,
      locked: false,
      metadata: {},
      src: PNG_DATA_URL,
      naturalWidth,
      naturalHeight,
      signer: "Ada Lovelace",
    };
    const state: EditorState = {
      ...base,
      document: {
        ...base.document,
        pages: [addObjectToPage(page, signature as Parameters<typeof addObjectToPage>[1])],
      },
    };

    const [opts] = await captureDrawImageCalls(state);

    // The asset is square in a 280x110 box, so it fits to 110x110 centred.
    const fitted = fitContain(naturalWidth, naturalHeight, localBounds);
    expect(fitted).toEqual({ x: 85, y: 0, width: 110, height: 110 });
    expectCornersClose(
      cornersFromDrawOptions(opts),
      cornersFromEditorSemantics(signature.transform, fitted),
      "signature letterbox",
    );

    // Stated directly: the drawn rect is SQUARE, not stretched to the box.
    expect(opts.width).toBeCloseTo(110, 6);
    expect(opts.height).toBeCloseTo(110, 6);
    expect(opts.width).not.toBeCloseTo(localBounds.width, 1);
  });

  it("draws a signature stamp upright and filling its box when the aspects match", async () => {
    // The INSERTION case: `createSignature` derives localBounds from the natural
    // size, so the box aspect equals the asset's and letterboxing is a no-op.
    // The natural size is declared truthfully here (3:1 asset in a 3:1 box) —
    // omitting it would silently exercise `fitContain`'s degenerate fallback
    // and the test would pass without covering anything.
    const base = createEditorState();
    const page = { ...getActivePage(base), width: PAGE_W, height: PAGE_H };
    const signature = {
      id: "sig-1",
      kind: "signature" as const,
      layerId: "layer-1",
      name: "Signature",
      transform: makeTranslate(60, 200),
      localBounds: { x: 0, y: 0, width: 180, height: 60 },
      opacity: 1,
      visible: true,
      locked: false,
      metadata: {},
      src: PNG_DATA_URL,
      naturalWidth: 360,
      naturalHeight: 120,
      signer: "Ada Lovelace",
    };
    const state: EditorState = {
      ...base,
      document: {
        ...base.document,
        pages: [addObjectToPage(page, signature as Parameters<typeof addObjectToPage>[1])],
      },
    };

    const [opts] = await captureDrawImageCalls(state);
    const corners = cornersFromDrawOptions(opts);
    const expected = cornersFromEditorSemantics(signature.transform, {
      x: 0,
      y: 0,
      width: signature.localBounds.width,
      height: signature.localBounds.height,
    });
    expectCornersClose(corners, expected, "signature");
    expect(corners.topLeft.y).toBeGreaterThan(corners.bottomLeft.y);
  });
});
