import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { createEditorInstance } from "@/lib/editor/createEditorInstance";
import { SetPropertyCommand } from "@/src/application/editor/commands/commands";
import { PdfExportService } from "@/src/application/editor/export/PdfExportService";
import { adjustCrop, cropDrawSpec, resolveCropCommit } from "./cropMath";
import { getActivePage } from "@/src/domain/editor/document";
import type { EditorDocumentService } from "@/src/application/editor/EditorDocumentService";
import {
  compose,
  makeBounds,
  makeRotate,
  makeScale,
  makeTranslate,
  type Bounds,
} from "@/src/domain/editor/geometry";
import { makeImage } from "@/src/domain/editor/testFactories";
import type { ImageObject } from "@/src/domain/editor/objects";

/**
 * Crop mode integration (M6.11).
 *
 * Commit runs the SAME code production runs: `resolveCropCommit` (the pure
 * decision the canvas's commitCrop delegates to) + a `SetPropertyCommand`
 * built exactly the way `useEditor`'s `actions.setProperty` builds it
 * (`before` = the current value of the patched key). Cancel issues nothing.
 * Export is verified against the DECODED page content stream — clip operators
 * (`W n`), graphics-state bracketing (`q`/`Q`), and the clip polygon's actual
 * coordinates — not just a `%PDF-` header sniff.
 */

// A real 1x1 PNG so pdf-lib's embedPng accepts the crop-export test image.
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** The image currently stored in the editor (typed). */
function storedImage(ed: EditorDocumentService, id: string): ImageObject {
  return getActivePage(ed.getState()).objects[id] as ImageObject;
}

/**
 * Commits a crop draft through the production path: `resolveCropCommit`
 * decides (sanitize, full→null, no-op suppression) and, when changed, a
 * `SetPropertyCommand` mirroring `actions.setProperty(id, { crop }, "Crop
 * image")` executes through the facade's history. Returns whether a command
 * was issued.
 */
function commitCropDraft(ed: EditorDocumentService, id: string, draft: Bounds): boolean {
  const obj = storedImage(ed, id);
  const { changed, next } = resolveCropCommit(
    draft,
    obj.crop ?? null,
    obj.naturalWidth,
    obj.naturalHeight,
  );
  if (changed) {
    ed.execute(new SetPropertyCommand("Crop image", id, { crop: obj.crop ?? null }, { crop: next }));
  }
  return changed;
}

describe("crop commit through the editor history", () => {
  it("commits as ONE undoable command; undo/redo restore each side exactly", () => {
    const ed = createEditorInstance();
    const img = makeImage({ id: "img", naturalWidth: 400, naturalHeight: 200, crop: null });
    ed.addObject(img, img.layerId);
    const depth = ed.undoDepth;

    const changed = commitCropDraft(ed, "img", makeBounds(50, 25, 100, 50));
    expect(changed).toBe(true);
    expect(ed.undoDepth).toBe(depth + 1);
    expect(ed.undoLabel).toBe("Crop image");
    expect(storedImage(ed, "img").crop).toEqual({ x: 50, y: 25, width: 100, height: 50 });

    ed.undo();
    expect(storedImage(ed, "img").crop).toBeNull();
    expect(ed.undoDepth).toBe(depth);

    ed.redo();
    expect(storedImage(ed, "img").crop).toEqual({ x: 50, y: 25, width: 100, height: 50 });
    expect(ed.undoDepth).toBe(depth + 1);
  });

  it("stores SANITIZED natural-pixel bounds (an out-of-image draft is clamped)", () => {
    const ed = createEditorInstance();
    const img = makeImage({ id: "img", naturalWidth: 400, naturalHeight: 200, crop: null });
    ed.addObject(img, img.layerId);

    // Draft hangs off the right/bottom edge; the committed value must be clamped.
    commitCropDraft(ed, "img", makeBounds(350, 180, 200, 100));
    const stored = storedImage(ed, "img").crop!;
    expect(stored.x + stored.width).toBeLessThanOrEqual(400);
    expect(stored.y + stored.height).toBeLessThanOrEqual(200);
    expect(stored.width).toBeGreaterThan(0);
    expect(stored.height).toBeGreaterThan(0);
  });

  it("editing an image that already has a crop: undo restores the OLD crop, not null", () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(10, 20, 150, 80),
    });
    ed.addObject(img, img.layerId);

    commitCropDraft(ed, "img", makeBounds(50, 25, 100, 50));
    expect(storedImage(ed, "img").crop).toEqual({ x: 50, y: 25, width: 100, height: 50 });

    ed.undo();
    expect(storedImage(ed, "img").crop).toEqual({ x: 10, y: 20, width: 150, height: 80 });

    ed.redo();
    expect(storedImage(ed, "img").crop).toEqual({ x: 50, y: 25, width: 100, height: 50 });
  });

  it("a full-image draft commits as null (the canonical no-crop value)", () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(10, 20, 150, 80),
    });
    ed.addObject(img, img.layerId);

    const changed = commitCropDraft(ed, "img", makeBounds(0, 0, 400, 200));
    expect(changed).toBe(true);
    expect(storedImage(ed, "img").crop).toBeNull();
    ed.undo();
    expect(storedImage(ed, "img").crop).toEqual({ x: 10, y: 20, width: 150, height: 80 });
  });

  it("a NO-OP commit (unchanged crop) issues no command and adds no history entry", () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(50, 25, 100, 50),
    });
    ed.addObject(img, img.layerId);
    const depth = ed.undoDepth;

    // Same rect as persisted → suppressed.
    expect(commitCropDraft(ed, "img", makeBounds(50, 25, 100, 50))).toBe(false);
    // Full-image draft on an uncropped image → also suppressed (null === null).
    const img2 = makeImage({ id: "img2", naturalWidth: 300, naturalHeight: 150, crop: null });
    ed.addObject(img2, img2.layerId);
    const depth2 = ed.undoDepth;
    expect(commitCropDraft(ed, "img2", makeBounds(0, 0, 300, 150))).toBe(false);

    expect(ed.undoDepth).toBe(depth2);
    expect(depth2).toBe(depth + 1); // only the addObject moved history
    expect(storedImage(ed, "img").crop).toEqual({ x: 50, y: 25, width: 100, height: 50 });
  });

  it("cancel: draft edits are pure local math — the document and history never move", () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(5, 5, 100, 60),
    });
    ed.addObject(img, img.layerId);
    const depth = ed.undoDepth;
    const stateBefore = ed.getState();

    // Simulate a crop session that drags handles around and then cancels:
    // draft edits go through the pure cropMath only (exactly what the overlay
    // does), and cancelCrop issues no command.
    let draft = makeBounds(5, 5, 100, 60);
    draft = adjustCrop(draft, "se", 40, 30, 400, 200);
    draft = adjustCrop(draft, "nw", -3, 2, 400, 200);
    expect(draft).not.toEqual(makeBounds(5, 5, 100, 60)); // the session really edited

    expect(ed.getState()).toBe(stateBefore); // same object — nothing mutated
    expect(ed.undoDepth).toBe(depth);
    expect(storedImage(ed, "img").crop).toEqual({ x: 5, y: 5, width: 100, height: 60 });
  });
});

describe("crop serialization (v6 round-trip)", () => {
  it("a committed crop serializes and deserializes exactly", () => {
    const ed = createEditorInstance();
    const img = makeImage({ id: "img", naturalWidth: 400, naturalHeight: 200, crop: null });
    ed.addObject(img, img.layerId);
    commitCropDraft(ed, "img", makeBounds(10.5, 20.25, 80, 40));

    const ed2 = createEditorInstance();
    ed2.deserialize(JSON.parse(JSON.stringify(ed.serialize())));
    expect(storedImage(ed2, "img").crop).toEqual({ x: 10.5, y: 20.25, width: 80, height: 40 });
  });

  it("a null crop round-trips as null", () => {
    const ed = createEditorInstance();
    const img = makeImage({ id: "img", crop: null });
    ed.addObject(img, img.layerId);
    const ed2 = createEditorInstance();
    ed2.deserialize(JSON.parse(JSON.stringify(ed.serialize())));
    expect(storedImage(ed2, "img").crop).toBeNull();
  });

  it("malformed crop values are REJECTED by the serializer (non-finite / non-object)", () => {
    const ed = createEditorInstance();
    const img = makeImage({ id: "img", crop: makeBounds(1, 2, 30, 40) });
    ed.addObject(img, img.layerId);
    const good = JSON.parse(JSON.stringify(ed.serialize())) as {
      document: { pages: Array<{ objects: Record<string, Record<string, unknown>> }> };
    };

    const withCrop = (crop: unknown) => {
      const copy = JSON.parse(JSON.stringify(good)) as typeof good;
      copy.document.pages[0].objects["img"].crop = crop;
      return copy;
    };

    const ed2 = createEditorInstance();
    expect(() => ed2.deserialize(withCrop({ x: "nope", y: 0, width: 10, height: 10 }))).toThrow(
      /not a finite number/,
    );
    expect(() => ed2.deserialize(withCrop(5))).toThrow(/not a bounds object/);
    // Absent crop is legal and reads back as null.
    const absent = withCrop(undefined);
    delete absent.document.pages[0].objects["img"].crop;
    ed2.deserialize(absent);
    expect(storedImage(ed2, "img").crop).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Export: decode the page's content stream and verify the actual operators.
// ---------------------------------------------------------------------------

/** Decoded content-stream text of page `pageIndex` (handles Flate + arrays). */
async function pageContent(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFRawStream) {
    streams.push(contents);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = page.node.context.lookup(contents.get(i));
      if (s instanceof PDFRawStream) streams.push(s);
    }
  }
  return streams
    .map((s) => new TextDecoder("latin1").decode(decodePDFRawStream(s).decode()))
    .join("\n");
}

/** True when the content stream contains a clip (`W` followed by `n`). */
function hasClip(content: string): boolean {
  return /(^|\s)W\s+n(\s|$)/.test(content);
}

/** Every `q` must have a matching `Q` — an imbalance means leaked clip state. */
function graphicsStateBalanced(content: string): boolean {
  const tokens = content.split(/\s+/);
  const q = tokens.filter((t) => t === "q").length;
  const Q = tokens.filter((t) => t === "Q").length;
  return q === Q;
}

/**
 * The clip polygon actually written to the stream: the first `x y m` and the
 * `x y l` points that follow it before the `W`.
 */
function parseClipPolygon(content: string): Array<{ x: number; y: number }> {
  const clipRegion = content.slice(0, content.search(/(^|\s)W\s+n(\s|$)/));
  const points: Array<{ x: number; y: number }> = [];
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+(m|l)(\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clipRegion)) !== null) {
    points.push({ x: parseFloat(match[1]), y: parseFloat(match[2]) });
  }
  return points;
}

function expectPointsClose(
  actual: Array<{ x: number; y: number }>,
  expected: Array<{ x: number; y: number }>,
): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i].x, 2);
    expect(p.y).toBeCloseTo(expected[i].y, 2);
  });
}

describe("crop PDF export (clip-based)", () => {
  const svc = new PdfExportService();

  it("a cropped image is clipped: q → clip polygon → W n → image → Q, corners exact", async () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      src: PNG_1x1,
      transform: makeTranslate(100, 50),
      localBounds: makeBounds(0, 0, 200, 100),
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(100, 50, 200, 100),
    });
    ed.addObject(img, img.layerId);
    const pageHeight = getActivePage(ed.getState()).height;

    const bytes = await svc.exportPdf(ed.getState());
    const content = await pageContent(bytes);

    expect(hasClip(content)).toBe(true);
    expect(graphicsStateBalanced(content)).toBe(true);
    // Clip polygon = the object's world box (translate(100,50), 200×100),
    // mapped to PDF space (y-up): TL, TR, BR, BL.
    expectPointsClose(parseClipPolygon(content), [
      { x: 100, y: pageHeight - 50 },
      { x: 300, y: pageHeight - 50 },
      { x: 300, y: pageHeight - 150 },
      { x: 100, y: pageHeight - 150 },
    ]);
    // The image is actually drawn inside the clip.
    expect(content).toMatch(/\/\S+\s+Do/);
  });

  it("the exported clip polygon equals the shared cropDrawSpec geometry (overlay = export)", async () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      src: PNG_1x1,
      transform: compose(makeTranslate(150, 120), makeScale(1.5, 0.75)),
      localBounds: makeBounds(0, 0, 200, 100),
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(40, 30, 120, 90),
    });
    ed.addObject(img, img.layerId);
    const pageHeight = getActivePage(ed.getState()).height;
    const spec = cropDrawSpec(img)!;

    const bytes = await svc.exportPdf(ed.getState());
    const content = await pageContent(bytes);
    expectPointsClose(
      parseClipPolygon(content),
      spec.clipCorners.map((c) => ({ x: c.x, y: pageHeight - c.y })),
    );
  });

  it("a ROTATED cropped image clips to the transformed (non-axis-aligned) corners", async () => {
    const ed = createEditorInstance();
    // translate(300,100) ∘ rotate(90° y-down): local (x,y) → world (300−y, 100+x).
    const img = makeImage({
      id: "img",
      src: PNG_1x1,
      transform: compose(makeTranslate(300, 100), makeRotate(Math.PI / 2)),
      localBounds: makeBounds(0, 0, 200, 100),
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(100, 50, 200, 100),
    });
    ed.addObject(img, img.layerId);
    const pageHeight = getActivePage(ed.getState()).height;

    const bytes = await svc.exportPdf(ed.getState());
    const content = await pageContent(bytes);
    expect(hasClip(content)).toBe(true);
    expect(graphicsStateBalanced(content)).toBe(true);
    expectPointsClose(parseClipPolygon(content), [
      { x: 300, y: pageHeight - 100 }, // local (0,0)
      { x: 300, y: pageHeight - 300 }, // local (200,0) → world (300,300)
      { x: 200, y: pageHeight - 300 }, // local (200,100) → world (200,300)
      { x: 200, y: pageHeight - 100 }, // local (0,100) → world (200,100)
    ]);
  });

  it("an UNCROPPED image emits no clip", async () => {
    const ed = createEditorInstance();
    const img = makeImage({ id: "img", src: PNG_1x1, crop: null });
    ed.addObject(img, img.layerId);
    const bytes = await svc.exportPdf(ed.getState());
    const content = await pageContent(bytes);
    expect(content).toMatch(/\/\S+\s+Do/); // the image IS drawn
    expect(hasClip(content)).toBe(false);
    expect(graphicsStateBalanced(content)).toBe(true);
  });

  it("a FULL-IMAGE crop follows the uncropped path (no clip)", async () => {
    const ed = createEditorInstance();
    const img = makeImage({
      id: "img",
      src: PNG_1x1,
      naturalWidth: 200,
      naturalHeight: 100,
      crop: makeBounds(0, 0, 200, 100),
    });
    ed.addObject(img, img.layerId);
    const bytes = await svc.exportPdf(ed.getState());
    const content = await pageContent(bytes);
    expect(content).toMatch(/\/\S+\s+Do/);
    expect(hasClip(content)).toBe(false);
  });

  it("one corrupt image neither aborts the export nor leaks clip state", async () => {
    const ed = createEditorInstance();
    // Un-embeddable bytes (embedPng throws) WITH a crop, drawn before a valid
    // cropped image — the valid one must still export, clipped and balanced.
    const corrupt = makeImage({
      id: "corrupt",
      src: "data:image/png;base64,AAAA",
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(10, 10, 100, 50),
    });
    const good = makeImage({
      id: "good",
      src: PNG_1x1,
      transform: makeTranslate(20, 30),
      naturalWidth: 400,
      naturalHeight: 200,
      crop: makeBounds(100, 50, 200, 100),
    });
    ed.addObject(corrupt, corrupt.layerId);
    ed.addObject(good, good.layerId);

    const bytes = await svc.exportPdf(ed.getState());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const content = await pageContent(bytes);
    expect(hasClip(content)).toBe(true); // the good image's clip
    expect(graphicsStateBalanced(content)).toBe(true); // nothing leaked
    expect(content).toMatch(/\/\S+\s+Do/);
  });
});
