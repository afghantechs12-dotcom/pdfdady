/**
 * EXPORT FIDELITY PROBE — rasterized preview-vs-export comparison.
 *
 * The unit suite (`src/application/editor/export/imageOrientation.test.ts`)
 * proves the export service hands pdf-lib draw options whose corner mapping
 * matches editor semantics. It does so against a MODEL of pdf-lib's draw
 * pipeline. This probe validates that model against reality: it renders the
 * same document twice — once through the editor's own SVG renderer
 * (`ObjectRenderer` + `objectToSvgMatrix`, i.e. exactly what the canvas paints)
 * and once by exporting a real PDF and rasterizing it with pdf.js — then diffs
 * the two bitmaps.
 *
 * This is the check that catches the class of defect where both sides agree on
 * an object's BOX but disagree about its CONTENT (a mirrored image draws into
 * the correct rectangle, so every geometry assertion stays green).
 *
 * Usage:
 *   npx tsx scripts/export-fidelity-probe.mts [--keep] [--only <substring>]
 *
 *   --keep   leave the rendered PNGs on disk and print the directory
 *   --only   run just the fixtures whose name contains the substring
 *
 * Requires Chrome (CHROME_PATH overrides the macOS default). No dev server
 * needed — the probe serves its own page.
 */
/* global process, console, Buffer, fetch, WebSocket, setTimeout, URL */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { ObjectRenderer } from "@/components/editor/canvas/ObjectRenderer";
import { objectToSvgMatrix } from "@/src/application/editor/coordinates/CoordinateSpace";
import { PdfExportService } from "@/src/application/editor/export/PdfExportService";
import {
  addObjectToPage,
  createEditorState,
  createPage,
  getActivePage,
} from "@/src/domain/editor/document";
import type { EditorPage, EditorState } from "@/src/domain/editor/document";
import type { EditorObject, ImageObject } from "@/src/domain/editor/objects";
import { pageObjects } from "@/src/domain/editor/document";
import {
  compose,
  makeScale,
  makeTranslate,
  transformPoint,
} from "@/src/domain/editor/geometry";
import type { AffineTransform } from "@/src/domain/editor/geometry";
import { flipObject, rotateObject } from "@/src/application/editor/transform/TransformService";
import {
  makeAnnotation,
  makeDrawing,
  makeHighlight,
  makeImage,
  makeRect,
  makeSignature,
  makeTextObject,
} from "@/src/domain/editor/testFactories";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Every fixture must paint at least this share of the page on BOTH sides. */
const DEFAULT_MIN_INK = 0.01;
/**
 * How far the two sides' ink coverage may differ, as a share of the page.
 * Antialiasing moves this by hundredths of a percent; a wrong size, placement,
 * or fit rule moves it by whole percent.
 */
const MAX_INK_DELTA = 0.01;
const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;

// ---------------------------------------------------------------------------
// A deterministic, strongly ASYMMETRIC test image.
//
// Symmetric fixtures are the reason orientation bugs survive: a centred circle
// looks identical mirrored. This one differs across BOTH axes (four distinct
// quadrant colours) and adds a corner notch so even a 180-degree rotation is
// visibly wrong.
// ---------------------------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function makePng(
  width: number,
  height: number,
  rgba: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgba(x, y);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const ASYM_SIZE = 96;
const ASYM_PNG = makePng(ASYM_SIZE, ASYM_SIZE, (x, y) => {
  const top = y < ASYM_SIZE / 2;
  const left = x < ASYM_SIZE / 2;
  // A notch in the top-left eighth breaks the remaining rotational symmetry.
  if (x < ASYM_SIZE / 8 && y < ASYM_SIZE / 8) return [20, 20, 20, 255];
  if (top && left) return [220, 40, 40, 255];
  if (top && !left) return [30, 160, 60, 255];
  if (!top && left) return [40, 70, 210, 255];
  return [240, 200, 30, 255];
});
const ASYM_DATA_URL = `data:image/png;base64,${ASYM_PNG.toString("base64")}`;

/** A 4x4 asset for the upscaling case; still asymmetric in both axes. */
const LOWRES_PNG = makePng(4, 4, (x, y) =>
  y < 2 ? (x < 2 ? [220, 40, 40, 255] : [30, 160, 60, 255]) : x < 2 ? [40, 70, 210, 255] : [240, 200, 30, 255],
);
const LOWRES_DATA_URL = `data:image/png;base64,${LOWRES_PNG.toString("base64")}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  state: EditorState;
  /**
   * Maximum share of pixels allowed to differ, as a fraction of the page.
   * Geometry-only fixtures are held near zero. Text and freehand strokes are
   * rasterized by two different engines (Chrome's SVG renderer vs pdf.js) with
   * different antialiasing and hinting, so they carry a documented allowance.
   */
  threshold: number;
  why?: string;
  /**
   * Minimum share of the page each side must actually paint. Without this a
   * fixture that renders nothing on BOTH sides scores a perfect 0% diff — the
   * vacuous green that hides a broken renderer. Defaults to 1% of the page.
   */
  minInk?: number;
}

function pageOf(state: EditorState, width: number, height: number): EditorPage {
  return { ...getActivePage(state), width, height };
}

function withObjects(
  objects: EditorObject[],
  width = 420,
  height = 320,
): EditorState {
  const base = createEditorState();
  let page = pageOf(base, width, height);
  for (const obj of objects) page = addObjectToPage(page, obj);
  return { ...base, document: { ...base.document, pages: [page] } };
}

/** A solid (undashed, unshadowed) style base for fixture shapes. */
const SOLID = { fill: null, stroke: null, strokeWidth: 0, cornerRadius: 0 } as const;

const rgb = (r: number, g: number, b: number, a = 1) => ({ r, g, b, a });

/** A many-segment stroke that fills its box — a real freehand path, not a tick. */
function wavePoints(width: number, height: number, count: number) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    pts.push({
      x: t * width,
      y: height / 2 + Math.sin(t * Math.PI * 3) * (height / 2 - 4),
    });
  }
  return pts;
}

/** Text large enough that a rendering failure cannot hide under the ink floor. */
function bigText(text: string, overrides: Record<string, unknown>) {
  const fontSize = (overrides.fontSize as number) ?? 24;
  return makeTextObject({
    text,
    localBounds: { x: 0, y: 0, width: 380, height: fontSize * 1.6 },
    ...overrides,
  } as Parameters<typeof makeTextObject>[0]);
}

/** A multi-page state: one entry per page, each with its own size and objects. */
function withPages(
  specs: Array<{ width: number; height: number; objects: EditorObject[] }>,
): EditorState {
  const base = createEditorState();
  const pages = specs.map((spec, i) => {
    let page = createPage(`page-${i + 1}`, spec.width, spec.height);
    for (const obj of spec.objects) page = addObjectToPage(page, obj);
    return page;
  });
  return {
    ...base,
    document: { ...base.document, pages },
    activePageId: pages[0].id,
  };
}

function img(transform: AffineTransform, overrides: Partial<ImageObject> = {}): ImageObject {
  return makeImage({
    src: ASYM_DATA_URL,
    transform,
    localBounds: { x: 0, y: 0, width: 180, height: 120 },
    naturalWidth: ASYM_SIZE,
    naturalHeight: ASYM_SIZE,
    ...overrides,
  } as Partial<ImageObject>);
}

function spun(obj: ImageObject, radians: number): ImageObject {
  const centre = transformPoint(obj.transform, {
    x: obj.localBounds.width / 2,
    y: obj.localBounds.height / 2,
  });
  return { ...obj, transform: rotateObject(obj, centre, radians) };
}

const Q = Math.PI / 2;
const AT = makeTranslate(120, 100);

function buildFixtures(): Fixture[] {
  const out: Fixture[] = [
    { name: "image-upright", state: withObjects([img(AT)]), threshold: 0.004 },
    { name: "image-rot-90", state: withObjects([spun(img(AT), Q)]), threshold: 0.004 },
    { name: "image-rot-180", state: withObjects([spun(img(AT), Math.PI)]), threshold: 0.004 },
    { name: "image-rot-270", state: withObjects([spun(img(AT), 3 * Q)]), threshold: 0.004 },
    { name: "image-rot-37", state: withObjects([spun(img(AT), (37 * Math.PI) / 180)]), threshold: 0.02,
      why: "an off-axis edge is antialiased differently by the two rasterizers" },
    {
      name: "image-flip-h",
      state: withObjects([(() => { const o = img(AT); return { ...o, transform: flipObject(o, "x") }; })()]),
      threshold: 0.004,
    },
    {
      name: "image-flip-v",
      state: withObjects([(() => { const o = img(AT); return { ...o, transform: flipObject(o, "y") }; })()]),
      threshold: 0.004,
    },
    {
      name: "image-flip-both",
      state: withObjects([(() => {
        const o = img(AT);
        const h = { ...o, transform: flipObject(o, "x") };
        return { ...h, transform: flipObject(h, "y") };
      })()]),
      threshold: 0.004,
    },
    {
      name: "image-flip-h-rot-90",
      state: withObjects([(() => {
        const o = img(AT);
        const h = { ...o, transform: flipObject(o, "x") };
        return spun(h, Q);
      })()]),
      threshold: 0.004,
    },
    {
      name: "image-crop",
      state: withObjects([img(AT, { crop: { x: 12, y: 20, width: 60, height: 48 } })]),
      threshold: 0.006,
    },
    {
      name: "image-crop-rot-90",
      state: withObjects([spun(img(AT, { crop: { x: 12, y: 20, width: 60, height: 48 } }), Q)]),
      threshold: 0.006,
    },
    {
      name: "image-crop-flip-v",
      state: withObjects([(() => {
        const o = img(AT, { crop: { x: 12, y: 20, width: 60, height: 48 } });
        return { ...o, transform: flipObject(o, "y") };
      })()]),
      threshold: 0.006,
    },
    {
      name: "image-opacity-40",
      state: withObjects([img(AT, { opacity: 0.4 })]),
      threshold: 0.006,
    },
    {
      name: "image-scaled-nonuniform",
      state: withObjects([img(compose(makeTranslate(60, 60), makeScale(1.6, 0.7)))]),
      threshold: 0.006,
    },
    {
      name: "overlapping-z-order",
      // Painted back-to-front: the image must sit UNDER the first shape and
      // OVER nothing. A z-order inversion moves large blocks of solid colour.
      state: withObjects([
        makeRect({
          transform: makeTranslate(40, 40),
          localBounds: { x: 0, y: 0, width: 220, height: 160 },
          style: { ...SOLID, fill: rgb(0.85, 0.2, 0.2) },
        }),
        img(makeTranslate(110, 90)),
        makeRect({
          transform: makeTranslate(200, 170),
          localBounds: { x: 0, y: 0, width: 160, height: 110 },
          style: { ...SOLID, fill: rgb(0.15, 0.3, 0.75) },
        }),
      ]),
      threshold: 0.01,
    },
    {
      name: "shapes-and-stroke-width",
      state: withObjects([
        makeRect({
          transform: makeTranslate(30, 30),
          localBounds: { x: 0, y: 0, width: 150, height: 90 },
          style: { ...SOLID, fill: rgb(0.95, 0.75, 0.2), stroke: rgb(0.1, 0.1, 0.1), strokeWidth: 1 },
        }),
        makeRect({
          transform: makeTranslate(220, 30),
          localBounds: { x: 0, y: 0, width: 150, height: 90 },
          style: { ...SOLID, fill: rgb(0.3, 0.7, 0.5), stroke: rgb(0.1, 0.1, 0.1), strokeWidth: 8 },
        }),
        makeRect({
          transform: makeTranslate(30, 170),
          localBounds: { x: 0, y: 0, width: 340, height: 110 },
          style: { ...SOLID, fill: rgb(0.55, 0.35, 0.85), stroke: rgb(0.05, 0.05, 0.05), strokeWidth: 3 },
        }),
      ]),
      threshold: 0.02,
      why: "stroke antialiasing differs between the two rasterizers",
    },
    {
      name: "transparency-stack",
      // Overlapping semi-transparent fills: exercises alpha compositing order.
      state: withObjects([
        makeRect({
          transform: makeTranslate(40, 50),
          localBounds: { x: 0, y: 0, width: 200, height: 200 },
          style: { ...SOLID, fill: rgb(0.9, 0.2, 0.2) },
          opacity: 0.6,
        } as Partial<Parameters<typeof makeRect>[0]>),
        makeRect({
          transform: makeTranslate(150, 100),
          localBounds: { x: 0, y: 0, width: 200, height: 180 },
          style: { ...SOLID, fill: rgb(0.15, 0.35, 0.85) },
          opacity: 0.5,
        } as Partial<Parameters<typeof makeRect>[0]>),
      ]),
      threshold: 0.02,
      why: "alpha blending rounds differently in the two compositors",
    },
    {
      name: "highlight",
      state: withObjects([
        makeHighlight({
          transform: makeTranslate(40, 60),
          localBounds: { x: 0, y: 0, width: 330, height: 60 },
        }),
        makeHighlight({
          transform: makeTranslate(40, 170),
          localBounds: { x: 0, y: 0, width: 240, height: 60 },
        }),
      ]),
      threshold: 0.02,
      why: "multiply blend is composited differently by the two engines",
    },
    /*
     * ANNOTATIONS. There was no annotation fixture here at all, which is why this
     * probe reported 32/32 throughout the entire period in which a sticky note
     * exported as bare floating text: the panel the exporter never drew was never
     * rendered by either side. A note is the one object whose canvas appearance is
     * mostly CONTAINER — panel fill, border, corner radius, pointer arrow — so a
     * missing container is a large ink difference, not a subtle one.
     */
    {
      name: "annotation-note",
      state: withObjects([
        makeAnnotation({
          text: "this is note",
          fontSize: 13,
          color: rgb(0.12, 0.1, 0.08),
          background: rgb(1, 0.85, 0.2),
          border: rgb(0.6, 0.45, 0),
          borderWidth: 2,
          cornerRadius: 6,
          pointerTarget: null,
          transform: makeTranslate(72, 120),
          localBounds: { x: 0, y: 0, width: 220, height: 64 },
        }),
      ]),
      threshold: 0.02,
      why: "rounded corners and small text are antialiased differently by the two rasterizers",
    },
    {
      name: "annotation-transparent",
      state: withObjects([
        makeAnnotation({
          text: "no panel here",
          fontSize: 13,
          color: rgb(0.1, 0.1, 0.1),
          background: null,
          border: null,
          borderWidth: 0,
          cornerRadius: 6,
          pointerTarget: null,
          transform: makeTranslate(72, 120),
          localBounds: { x: 0, y: 0, width: 220, height: 64 },
        }),
      ]),
      threshold: 0.02,
      minInk: 0.002,
      why: "a text-only note paints little ink, and glyph antialiasing differs",
    },
    {
      name: "annotation-pointer",
      state: withObjects([
        makeAnnotation({
          text: "points at something",
          fontSize: 12,
          color: rgb(0.1, 0.1, 0.1),
          background: rgb(0.85, 0.95, 1),
          border: rgb(0.1, 0.4, 0.7),
          borderWidth: 1.5,
          cornerRadius: 8,
          pointerTarget: { x: 300, y: 180 },
          transform: makeTranslate(60, 90),
          localBounds: { x: 0, y: 0, width: 200, height: 56 },
        }),
      ]),
      threshold: 0.02,
      why: "an off-axis pointer line is antialiased differently by the two rasterizers",
    },
    {
      name: "freehand-drawing",
      state: withObjects([
        makeDrawing({
          transform: makeTranslate(30, 30),
          localBounds: { x: 0, y: 0, width: 360, height: 260 },
          points: wavePoints(360, 260, 64),
          style: { ...SOLID, stroke: rgb(0.1, 0.1, 0.1), strokeWidth: 6 },
        }),
      ]),
      threshold: 0.03,
      why: "stroke joins and caps are antialiased differently",
    },
    {
      name: "text-block",
      state: withObjects([
        bigText("Fidelity check: preview and export must agree.", {
          transform: makeTranslate(24, 40),
          fontSize: 24,
        }),
        bigText("Second line, same metrics.", {
          transform: makeTranslate(24, 100),
          fontSize: 24,
        }),
      ]),
      threshold: 0.08,
      why: "glyph rasterization and hinting differ between Chrome and pdf.js",
    },
    {
      name: "text-alignment",
      state: withObjects([
        bigText("left aligned text", { transform: makeTranslate(20, 30), fontSize: 22, align: "left" }),
        bigText("centre aligned text", { transform: makeTranslate(20, 110), fontSize: 22, align: "center" }),
        bigText("right aligned text", { transform: makeTranslate(20, 190), fontSize: 22, align: "right" }),
      ]),
      threshold: 0.08,
      why: "glyph rasterization plus alignment rounding to the nearest pixel",
    },
    {
      name: "text-metrics",
      // Line height and letter spacing are the two metrics most likely to
      // diverge between a CSS/SVG layout and a PDF text run.
      state: withObjects([
        bigText("tight tracking", { transform: makeTranslate(20, 34), fontSize: 26, letterSpacing: 0 }),
        bigText("wide tracking", { transform: makeTranslate(20, 104), fontSize: 26, letterSpacing: 4 }),
        bigText("tall leading", { transform: makeTranslate(20, 174), fontSize: 26, lineHeight: 2 }),
        bigText("heavy weight", { transform: makeTranslate(20, 244), fontSize: 26, fontWeight: 700 }),
      ]),
      threshold: 0.08,
      why: "glyph rasterization and hinting differ between Chrome and pdf.js",
    },
    {
      name: "text-colour",
      state: withObjects([
        bigText("crimson", { transform: makeTranslate(20, 40), fontSize: 34, color: rgb(0.8, 0.1, 0.2) }),
        bigText("forest", { transform: makeTranslate(20, 110), fontSize: 34, color: rgb(0.1, 0.5, 0.2) }),
        bigText("indigo", { transform: makeTranslate(20, 180), fontSize: 34, color: rgb(0.25, 0.2, 0.7) }),
      ]),
      threshold: 0.08,
      why: "glyph rasterization; the fill colours themselves must match",
    },
    {
      name: "mixed-content",
      // Everything at once: the composition case that catches an object kind
      // being drawn in the wrong order or the wrong space.
      state: withObjects([
        makeRect({
          transform: makeTranslate(20, 20),
          localBounds: { x: 0, y: 0, width: 380, height: 120 },
          style: { ...SOLID, fill: rgb(0.93, 0.93, 0.97), stroke: rgb(0.6, 0.6, 0.7), strokeWidth: 2 },
        }),
        img(makeTranslate(30, 150)),
        makeHighlight({ transform: makeTranslate(230, 160), localBounds: { x: 0, y: 0, width: 160, height: 40 } }),
        bigText("mixed", { transform: makeTranslate(230, 220), fontSize: 30 }),
        makeDrawing({
          transform: makeTranslate(230, 250),
          localBounds: { x: 0, y: 0, width: 160, height: 50 },
          points: wavePoints(160, 50, 24),
          style: { ...SOLID, stroke: rgb(0.2, 0.2, 0.2), strokeWidth: 4 },
        }),
      ]),
      threshold: 0.04,
      why: "combines glyph and stroke antialiasing allowances",
    },
    {
      name: "signature-aspect",
      // A signature whose box aspect differs from the asset's. The preview and
      // the export must agree on how the asset fills that box.
      state: withObjects([
        makeSignature({
          src: ASYM_DATA_URL,
          transform: makeTranslate(60, 90),
          // A box whose aspect (280:110) differs from the asset's (96:96) — the
          // state a non-uniform resize produces, and the only way the
          // letterbox-vs-stretch divergence becomes visible.
          localBounds: { x: 0, y: 0, width: 280, height: 110 },
          naturalWidth: ASYM_SIZE,
          naturalHeight: ASYM_SIZE,
        } as Parameters<typeof makeSignature>[0]),
      ]),
      threshold: 0.01,
    },
    {
      name: "image-low-resolution",
      // A tiny asset blown up: both sides must scale the same sample grid, and
      // neither may silently substitute a different filtering origin.
      state: withObjects([
        makeImage({
          src: LOWRES_DATA_URL,
          transform: makeTranslate(60, 60),
          localBounds: { x: 0, y: 0, width: 300, height: 200 },
          naturalWidth: 4,
          naturalHeight: 4,
        } as Parameters<typeof makeImage>[0]),
      ]),
      // DOCUMENTED ALLOWANCE. A 4x4 asset drawn 75x larger: PDF's /Interpolate
      // defaults to false, so pdf.js paints hard nearest-neighbour blocks,
      // while Chrome smooths the SVG upscale into wide gradient bands. The
      // interiors legitimately differ; what must hold is that both sides cover
      // the same area (the ink-parity check, held to 1%) and place the same
      // edges. This is a rasterizer difference, not a transform defect.
      threshold: 0.12,
      why: "PDF /Interpolate defaults off (nearest-neighbour) while Chrome smooths the upscale",
    },
    {
      name: "multi-page-mixed-sizes",
      state: withPages([
        { width: 420, height: 320, objects: [img(makeTranslate(100, 90))] },
        {
          width: 320,
          height: 420,
          objects: [
            spun(img(makeTranslate(60, 140)), Q),
            makeRect({
              transform: makeTranslate(30, 30),
              localBounds: { x: 0, y: 0, width: 260, height: 80 },
              style: { ...SOLID, fill: rgb(0.2, 0.6, 0.4) },
            }),
          ],
        },
        {
          width: 500,
          height: 260,
          objects: [(() => { const o = img(makeTranslate(160, 70)); return { ...o, transform: flipObject(o, "y") }; })()],
        },
      ]),
      threshold: 0.01,
    },
    // Page-geometry coverage: portrait, landscape, and a deliberately odd size.
    {
      name: "page-portrait-a4",
      state: withObjects([img(makeTranslate(80, 200))], 595, 842),
      threshold: 0.004,
    },
    {
      name: "page-landscape-a4",
      state: withObjects([img(makeTranslate(300, 120))], 842, 595),
      threshold: 0.004,
    },
    {
      name: "page-unusual-size",
      state: withObjects([img(makeTranslate(30, 40))], 313, 227),
      threshold: 0.006,
    },
  ];
  return ONLY ? out.filter((f) => f.name.includes(ONLY)) : out;
}

// ---------------------------------------------------------------------------
// The editor-side rendering: the REAL canvas renderer, at zoom 1, no pan.
// ---------------------------------------------------------------------------

function editorSvg(state: EditorState, pageIndex: number): string {
  const page = state.document.pages[pageIndex];
  const objects = pageObjects(page);
  const viewport = { zoom: 1, pan: { x: 0, y: 0 } };
  const origin = { x: 0, y: 0 };
  const body = objects
    .map((obj) =>
      renderToStaticMarkup(
        createElement(
          "g",
          { transform: objectToSvgMatrix(obj, viewport, origin), key: obj.id },
          createElement(ObjectRenderer, { obj }),
        ),
      ),
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" ` +
    `viewBox="0 0 ${page.width} ${page.height}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`
  );
}

// ---------------------------------------------------------------------------
// Browser harness
// ---------------------------------------------------------------------------

interface CaseBundle {
  name: string;
  /** 1-based PDF page number this bundle rasterizes. */
  pageNumber: number;
  width: number;
  height: number;
  svg: string;
  pdfBase64: string;
  threshold: number;
  why?: string;
  minInk: number;
}

interface CaseResult {
  name: string;
  diff: number;
  differing: number;
  total: number;
  inkPreview: number;
  inkExport: number;
  error?: string;
}

async function main(): Promise<void> {
  const fixtures = buildFixtures();
  if (fixtures.length === 0) {
    console.error(`No fixtures matched --only "${ONLY}"`);
    process.exit(1);
  }

  const service = new PdfExportService();
  const bundles: CaseBundle[] = [];
  for (const f of fixtures) {
    const bytes = await service.exportPdf(f.state);
    const pdfBase64 = Buffer.from(bytes).toString("base64");
    const multi = f.state.document.pages.length > 1;
    f.state.document.pages.forEach((page, i) => {
      bundles.push({
        name: multi ? `${f.name}#p${i + 1}` : f.name,
        pageNumber: i + 1,
        width: page.width,
        height: page.height,
        svg: editorSvg(f.state, i),
        pdfBase64,
        threshold: f.threshold,
        why: f.why,
        minInk: f.minInk ?? DEFAULT_MIN_INK,
      });
    });
  }

  const dir = mkdtempSync(join(tmpdir(), "pdfdadi-fidelity-"));
  writeFileSync(join(dir, "cases.json"), JSON.stringify(bundles));

  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222">
<script type="module">
import * as pdfjs from "/pdfjs/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.mjs";

const SCALE = 2; // supersample so a one-pixel edge shift can't dominate a diff

function decode(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function rasterSvg(svg, w, h) {
  const url = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
  const im = new Image();
  await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error("svg load failed")); im.src = url; });
  const c = document.createElement("canvas");
  c.width = Math.round(w * SCALE); c.height = Math.round(h * SCALE);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(im, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function rasterPdf(b64, w, h, pageNumber) {
  const pdf = await pdfjs.getDocument({ data: decode(b64) }).promise;
  const pg = await pdf.getPage(pageNumber);
  const vp = pg.getViewport({ scale: SCALE });
  const c = document.createElement("canvas");
  c.width = Math.round(w * SCALE); c.height = Math.round(h * SCALE);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
  return ctx.getImageData(0, 0, c.width, c.height);
}

/**
 * Fraction of pixels whose colour differs beyond a per-channel tolerance,
 * PLUS the ink coverage of each side.
 *
 * The diff alone is not a sufficient test: two blank pages agree perfectly.
 * "ink" is the share of non-white pixels, reported per side so a fixture that
 * silently renders nothing fails loudly instead of scoring a perfect 0.000%.
 * The tolerance absorbs antialiasing and colour-management drift; a mirrored,
 * rotated or displaced object moves whole regions of solid colour and shows up
 * far above any fixture threshold.
 */
function diff(a, b) {
  const TOL = 48;
  const WHITE = 250;
  let differing = 0, inkA = 0, inkB = 0;
  const n = a.data.length / 4;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (Math.abs(a.data[o] - b.data[o]) > TOL ||
        Math.abs(a.data[o+1] - b.data[o+1]) > TOL ||
        Math.abs(a.data[o+2] - b.data[o+2]) > TOL) differing++;
    if (a.data[o] < WHITE || a.data[o+1] < WHITE || a.data[o+2] < WHITE) inkA++;
    if (b.data[o] < WHITE || b.data[o+1] < WHITE || b.data[o+2] < WHITE) inkB++;
  }
  return { differing, total: n, diff: differing / n, inkPreview: inkA / n, inkExport: inkB / n };
}

const cases = await (await fetch("/cases.json")).json();
const results = [];
for (const c of cases) {
  try {
    const [svgPx, pdfPx] = await Promise.all([
      rasterSvg(c.svg, c.width, c.height),
      rasterPdf(c.pdfBase64, c.width, c.height, c.pageNumber),
    ]);
    results.push({ name: c.name, ...diff(svgPx, pdfPx) });
  } catch (err) {
    results.push({ name: c.name, diff: 1, differing: 0, total: 0, inkPreview: 0, inkExport: 0, error: String(err) });
  }
}
window.__results = results;
document.title = "done";
</script></body>`;
  writeFileSync(join(dir, "index.html"), html);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname.startsWith("/pdfjs/")) {
        const body = readFileSync(
          join(process.cwd(), "node_modules/pdfjs-dist/build", url.pathname.slice(7)),
        );
        res.writeHead(200, { "content-type": "text/javascript" });
        return res.end(body);
      }
      if (url.pathname === "/cases.json") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(readFileSync(join(dir, "cases.json")));
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(readFileSync(join(dir, "index.html")));
    } catch (err) {
      res.writeHead(404);
      res.end(String(err));
    }
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const CHROME =
    process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const profile = mkdtempSync(join(tmpdir(), "pdfdadi-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let wsUrl: string | null = null;
  chrome.stderr.on("data", (d: Buffer) => {
    const m = /ws:\/\/[^\s]+/.exec(String(d));
    if (m && !wsUrl) wsUrl = m[0];
  });
  for (let i = 0; i < 150 && !wsUrl; i++) await sleep(100);
  if (!wsUrl) {
    console.error("FAIL: no Chrome CDP endpoint. Set CHROME_PATH to a Chrome binary.");
    process.exit(1);
  }

  const list = await (await fetch(`http://${new URL(wsUrl).host}/json/list`)).json();
  const target = (list as Array<{ type: string; webSocketDebuggerUrl: string }>).find(
    (t) => t.type === "page",
  );
  if (!target) {
    console.error("FAIL: no page target");
    process.exit(1);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const send = (method: string, params?: unknown): Promise<{ result?: { value?: string } }> =>
    new Promise((resolve) => {
      const mid = ++id;
      const onMsg = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === mid) {
          ws.removeEventListener("message", onMsg);
          resolve(msg.result);
        }
      };
      ws.addEventListener("message", onMsg);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send("Runtime.enable");
  let results: CaseResult[] | null = null;
  for (let i = 0; i < 400; i++) {
    const r = await send("Runtime.evaluate", {
      expression: "JSON.stringify(window.__results || null)",
      returnByValue: true,
    });
    const value = r?.result?.value;
    if (value && value !== "null") {
      results = JSON.parse(value);
      break;
    }
    await sleep(200);
  }
  ws.close();
  server.close();
  chrome.kill();

  if (!results) {
    console.error("FAIL: the browser produced no results (render timed out).");
    process.exit(1);
  }

  const byName = new Map(bundles.map((b) => [b.name, b]));
  let failed = 0;
  console.log("\n  preview-vs-export raster diff  (diff = share of differing pixels;");
  console.log("  ink = share the side actually painted, so a blank-vs-blank match cannot pass)\n");
  for (const r of results) {
    const b = byName.get(r.name);
    const threshold = b?.threshold ?? 0;
    const minInk = b?.minInk ?? DEFAULT_MIN_INK;
    const reasons: string[] = [];
    if (r.error) reasons.push(r.error);
    if (r.diff > threshold) reasons.push(`diff over limit ${(threshold * 100).toFixed(1)}%`);
    if (r.inkPreview < minInk) reasons.push(`preview drew almost nothing (needs >= ${(minInk * 100).toFixed(1)}%)`);
    if (r.inkExport < minInk) reasons.push(`export drew almost nothing (needs >= ${(minInk * 100).toFixed(1)}%)`);
    // An independent signal from the pixel diff: the two sides must cover the
    // same AMOUNT of page. This is how the signature letterbox-vs-stretch
    // divergence announced itself (9.0% preview vs 22.9% export) and it catches
    // a wrong size or placement even where interior pixels may legitimately
    // differ between the two rasterizers.
    const inkDelta = Math.abs(r.inkPreview - r.inkExport);
    if (inkDelta > MAX_INK_DELTA) {
      reasons.push(
        `ink coverage differs by ${(inkDelta * 100).toFixed(1)}% ` +
          `(limit ${(MAX_INK_DELTA * 100).toFixed(1)}%) — the two sides cover different areas`,
      );
    }
    const ok = reasons.length === 0;
    if (!ok) failed++;
    const pct = (r.diff * 100).toFixed(3).padStart(7);
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${r.name.padEnd(28)} diff ${pct}%  ` +
        `ink ${(r.inkPreview * 100).toFixed(1)}%/${(r.inkExport * 100).toFixed(1)}%  ` +
        `(limit ${(threshold * 100).toFixed(1)}%)` +
        (reasons.length ? `\n            ${reasons.join("; ")}` : ""),
    );
  }
  if (KEEP) console.log(`\n  artifacts: ${dir}`);
  console.log(
    `\n  ${results.length - failed}/${results.length} fixtures within threshold\n`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
