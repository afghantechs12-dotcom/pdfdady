/**
 * The object-type fidelity matrix: does a document survive the canonical codec
 * PROPERTY FOR PROPERTY, per object type, across pages, z-order and repeats.
 *
 * Phase 2 could answer "did we persist this revision?". These tests answer the
 * question a revision watermark cannot: "did we persist the complete document
 * that revision names?" The distinction is not academic — a yellow sticky note
 * saved and reopened as bare text produced a perfectly good revision watermark
 * every time.
 *
 * HOW THESE TESTS ARE BUILT TO FAIL FOR THE RIGHT REASON:
 *
 *  - every assertion is a SEMANTIC diff from {@link diffDocuments}, which walks
 *    every own property of every object and reports the PATH that changed. There
 *    is no `expect(objects.length).toBe(8)` here: that assertion passes while
 *    every one of the eight objects is a rectangle.
 *  - fixtures set every optional field EXPLICITLY, including the ones whose
 *    default is `null` or `0`. A field left to its default cannot distinguish
 *    "preserved" from "re-defaulted", which is exactly the confusion that let
 *    `wordSpacing` be dropped on load for two format versions.
 *  - the z-order test carries a companion assertion that the ORDER IT CHECKS is
 *    not the order a type-grouping reconstruction would produce, so the test
 *    cannot pass by accident (mutation C).
 *
 * Groups: T1 (annotation), T3 (text), T4 (image), T5 (signature), T6 (shapes),
 * T7 (drawing), T8 (marker/highlighter), T9 (z-order), T10 (page association),
 * T11 (idempotence), T15 (zoom independence), T16 (unknown/malformed input).
 * T2/T14/T17 are export-side and live in
 * `src/application/editor/export/annotationExportFidelity.test.ts`; T12 is
 * `../persistence/localDraftFidelity.test.ts`; T13 is
 * `@/src/application/services/workspaceSceneRoundTrip.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  addObjectToPage,
  createEditorState,
  createPage,
  EDITOR_FORMAT_VERSION,
  type EditorPage,
  type EditorState,
} from "@/src/domain/editor/document";
import {
  IDENTITY_TRANSFORM,
  compose,
  makeBounds,
  makeRotate,
  makeScale,
  makeTranslate,
} from "@/src/domain/editor/geometry";
import { paintOrder } from "@/src/domain/editor/layers";
import type { AnnotationObject, EditorObject, ShapeKind } from "@/src/domain/editor/objects";
import {
  makeAnnotation,
  makeDrawing,
  makeHighlight,
  makeImage,
  makeRect,
  makeSignature,
  makeTextObject,
} from "@/src/domain/editor/testFactories";
import { createPlainTextContent, createDefaultTextFrame } from "@/src/domain/editor/textContent";
import { pageToScreen, screenToPage } from "@/src/application/editor/coordinates/CoordinateSpace";

import { SerializationService } from "./SerializationService";
import { diffDocuments, diffStates } from "./testing/semanticCompare";

const codec = new SerializationService();

/** One canonical cycle: live state → envelope → live state. */
function roundTrip(state: EditorState): EditorState {
  return codec.deserialize(codec.serialize(state));
}

/** A page carrying `objects` in the order given (which becomes the z-order). */
function pageOf(id: string, objects: EditorObject[], overrides: Partial<EditorPage> = {}): EditorPage {
  let page: EditorPage = { ...createPage(id), ...overrides };
  for (const object of objects) page = addObjectToPage(page, object);
  return page;
}

function stateOf(pages: EditorPage[], activePageId = pages[0].id): EditorState {
  const base = createEditorState("doc-fidelity", activePageId);
  return { ...base, document: { ...base.document, pages }, activePageId };
}

/**
 * The assertion every test in this file ends with.
 *
 * Reported as the diff ARRAY, not as a boolean: a failure then names the property
 * that moved instead of saying `false !== true`.
 */
function expectNoSemanticDrift(before: EditorState, after: EditorState): void {
  expect(diffStates(before, after)).toEqual([]);
}

/**
 * A plain text object with the two optional fields the factory omits set
 * explicitly.
 *
 * `background` and `sourceText` are declared optional but deserialize to an
 * explicit `null`, so a fixture that leaves them out reports absent → null on
 * every round trip. Setting them here rather than loosening the comparator keeps
 * "an omitted field came back as something" a difference the comparator can still
 * report — which is how the dropped `wordSpacing` was caught.
 */
function plainText(id: string, overrides: Parameters<typeof makeTextObject>[0] = {}) {
  return makeTextObject({ id, background: null, sourceText: null, ...overrides });
}

/**
 * A text object with every optional field set, so nothing can be re-defaulted
 * back into place. `wordSpacing`/`paragraphSpacing` are here because they were
 * serialized and never read back — the defect this fixture shape is what found.
 */
function fullTextObject(id: string, text: string) {
  return makeTextObject({
    id,
    content: createPlainTextContent(text),
    transform: compose(makeTranslate(40, 60), makeRotate(0.15)),
    localBounds: makeBounds(0, 0, 240, 96),
    opacity: 0.83,
    fontSize: 13.5,
    fontFamily: "Times",
    fontWeight: 700,
    color: { r: 0.1, g: 0.2, b: 0.7, a: 0.9 },
    align: "center",
    lineHeight: 1.45,
    letterSpacing: 1.25,
    wordSpacing: 3.5,
    paragraphSpacing: 7,
    background: { r: 1, g: 0.98, b: 0.9, a: 1 },
    sourceText: null,
    frame: createDefaultTextFrame(),
    name: "Paragraph",
    metadata: { note: "fixture" },
  });
}

/** The Phase 3 regression fixture: the yellow note the recording lost. */
function yellowNote(id = "note-1"): AnnotationObject {
  return makeAnnotation({
    id,
    name: "Sticky note",
    text: "this is note",
    fontSize: 13,
    color: { r: 0.12, g: 0.1, b: 0.08, a: 1 },
    transform: makeTranslate(72, 120),
    localBounds: makeBounds(0, 0, 180, 52),
    opacity: 0.85,
    background: { r: 1, g: 0.85, b: 0.2, a: 0.9 },
    border: { r: 0.6, g: 0.45, b: 0, a: 1 },
    borderWidth: 2,
    cornerRadius: 6,
    pointerTarget: { x: 220, y: 40 },
    metadata: {},
  });
}

// ---------------------------------------------------------------------------
// T1 — the annotation regression, property by property.
// ---------------------------------------------------------------------------

describe("T1 annotation round-trip (the yellow-note regression)", () => {
  it("preserves kind, text, panel fill, border, geometry, opacity, page and z-order", () => {
    const note = yellowNote();
    const before = stateOf([
      pageOf("page-1", [makeRect({ id: "rect-1" })], { sourcePageIndex: 0 }),
      pageOf("page-2", [makeRect({ id: "rect-2" }), note, plainText("text-1")], {
        sourcePageIndex: 1,
      }),
    ]);

    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);

    // The diff above already covers all of this. It is spelled out anyway
    // because this is the ONE regression the phase exists for, and a future
    // change to the comparator must not be able to quietly stop checking it.
    const page = after.document.pages[1];
    const restored = page.objects["note-1"];
    expect(restored.kind).toBe("annotation");
    const annotation = restored as AnnotationObject;
    expect(annotation.text).toBe("this is note");
    expect(annotation.background).toEqual({ r: 1, g: 0.85, b: 0.2, a: 0.9 });
    expect(annotation.border).toEqual({ r: 0.6, g: 0.45, b: 0, a: 1 });
    expect(annotation.borderWidth).toBe(2);
    expect(annotation.cornerRadius).toBe(6);
    expect(annotation.fontSize).toBe(13);
    expect(annotation.opacity).toBe(0.85);
    expect(annotation.transform).toEqual(makeTranslate(72, 120));
    expect(annotation.localBounds).toEqual(makeBounds(0, 0, 180, 52));
    expect(annotation.pointerTarget).toEqual({ x: 220, y: 40 });
    // Page association and z-order, as data rather than as a re-derivation.
    expect(after.document.pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);
    expect(paintOrder(page.layerStack).map((e) => e.objectId)).toEqual([
      "rect-2",
      "note-1",
      "text-1",
    ]);
  });

  it("does not deserialize a note as a text object", () => {
    const before = stateOf([pageOf("page-1", [yellowNote()])]);
    const restored = roundTrip(before).document.pages[0].objects["note-1"];
    expect(restored.kind).toBe("annotation");
    expect(restored.kind).not.toBe("text");
    // A text object carries `content`; an annotation carries the panel fields.
    expect("content" in restored).toBe(false);
    expect("background" in restored).toBe(true);
  });

  it("keeps a deliberately transparent note transparent rather than backfilling yellow", () => {
    // `null` and "absent" are different claims: null is a note the user made
    // transparent, absent is a pre-v7 note that never had the field. Migration
    // backfills the second; nothing may backfill the first.
    const before = stateOf([
      pageOf("page-1", [yellowNote("clear")]),
    ]);
    const cleared = {
      ...before,
      document: {
        ...before.document,
        pages: [
          {
            ...before.document.pages[0],
            objects: {
              ...before.document.pages[0].objects,
              clear: { ...(before.document.pages[0].objects.clear as AnnotationObject), background: null, border: null },
            },
          },
        ],
      },
    };
    const restored = roundTrip(cleared).document.pages[0].objects.clear as AnnotationObject;
    expect(restored.background).toBeNull();
    expect(restored.border).toBeNull();
    expectNoSemanticDrift(cleared, roundTrip(cleared));
  });

  it("backfills the historical panel for a pre-v7 note that never had one", () => {
    // The v6→v7 migration, exercised through the public codec: a note saved
    // before the panel was modelled must reopen looking like it always did,
    // because the yellow WAS in every pre-v7 rendering.
    const legacy = {
      format: "pdfdadi-editor",
      version: 6,
      activePageId: "page-1",
      selection: { ids: [], primaryId: null },
      document: {
        id: "doc-legacy",
        version: 6,
        metadata: {},
        pages: [
          {
            id: "page-1",
            width: 595,
            height: 842,
            rotation: 0,
            sourcePageIndex: 0,
            background: { type: "white" },
            layerStack: { layers: [{ id: "layer-1", name: "Layer 1", visible: true, locked: false, opacity: 1, objectIds: ["old-note"] }] },
            objects: {
              "old-note": {
                id: "old-note",
                kind: "annotation",
                layerId: "layer-1",
                name: "Note",
                transform: IDENTITY_TRANSFORM,
                localBounds: makeBounds(0, 0, 160, 40),
                opacity: 1,
                visible: true,
                locked: false,
                metadata: {},
                text: "old note",
                fontSize: 12,
                color: { r: 0, g: 0, b: 0, a: 1 },
                pointerTarget: null,
              },
            },
          },
        ],
      },
    };
    const restored = codec.deserialize(legacy).document.pages[0].objects["old-note"] as AnnotationObject;
    expect(restored.kind).toBe("annotation");
    expect(restored.background).not.toBeNull();
    expect(restored.background?.a).toBeGreaterThan(0);
    expect(restored.borderWidth).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// T3–T8 — one group per object type.
// ---------------------------------------------------------------------------

describe("T3 text round-trip", () => {
  it("preserves multiline content and every style field", () => {
    const before = stateOf([
      pageOf("page-1", [fullTextObject("text-1", "line one\nline two\n\nline four")]),
    ]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);

    const restored = after.document.pages[0].objects["text-1"];
    expect(restored.kind).toBe("text");
    // Spelled out because these two were the fields the codec serialized and
    // never read back: a round trip silently reset both to 0.
    expect((restored as { wordSpacing?: number }).wordSpacing).toBe(3.5);
    expect((restored as { paragraphSpacing?: number }).paragraphSpacing).toBe(7);
    expect((restored as { text: string }).text).toBe("line one\nline two\n\nline four");
  });
});

describe("T4 image round-trip", () => {
  it("preserves an asymmetric crop, a non-100% opacity and a rotated, scaled transform", () => {
    const image = makeImage({
      id: "image-1",
      // Asymmetric on every edge, so a crop restored from the wrong corner or
      // with width/height swapped is a visible difference rather than a no-op.
      crop: makeBounds(13, 27, 91, 44),
      opacity: 0.42,
      transform: compose(compose(makeTranslate(31, 77), makeRotate(0.4)), makeScale(1.75, 0.6)),
      localBounds: makeBounds(0, 0, 200, 100),
      naturalWidth: 200,
      naturalHeight: 100,
      alt: "an asymmetric fixture",
      name: "Photo",
    });
    const before = stateOf([pageOf("page-1", [image])]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);
    expect(after.document.pages[0].objects["image-1"].kind).toBe("image");
    expect((after.document.pages[0].objects["image-1"] as { crop?: unknown }).crop).toEqual(
      makeBounds(13, 27, 91, 44),
    );
  });
});

describe("T5 signature round-trip", () => {
  it("keeps visual-signature semantics and geometry, not a generic image", () => {
    const signature = makeSignature({
      id: "sig-1",
      signer: "Ada Lovelace",
      naturalWidth: 480,
      naturalHeight: 160,
      transform: compose(makeTranslate(220, 640), makeScale(0.5, 0.5)),
      localBounds: makeBounds(0, 0, 480, 160),
      opacity: 0.95,
      name: "Signature",
    });
    const before = stateOf([pageOf("page-1", [signature])]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);
    const restored = after.document.pages[0].objects["sig-1"];
    // A signature that reopens as an image loses the audit label and the
    // "this is a signature" affordance, so the kind is asserted directly.
    expect(restored.kind).toBe("signature");
    expect((restored as { signer: string }).signer).toBe("Ada Lovelace");
  });
});

describe("T6 shape round-trip", () => {
  /** Every subtype with the parameters that only IT has. */
  const cases: Array<{ shape: ShapeKind; extra: Record<string, unknown> }> = [
    { shape: "rect", extra: {} },
    { shape: "roundedRect", extra: {} },
    { shape: "ellipse", extra: {} },
    { shape: "circle", extra: {} },
    { shape: "triangle", extra: {} },
    { shape: "line", extra: { points: [{ x: 0, y: 0 }, { x: 90, y: 30 }] } },
    { shape: "arrow", extra: { headSize: 22, headType: "open" } },
    { shape: "polygon", extra: { sides: 9 } },
    { shape: "star", extra: { starPoints: 7, innerRatio: 0.42 } },
    { shape: "speechBubble", extra: { tailPosition: 0.72 } },
    { shape: "connector", extra: { connectorKind: "elbow", startArrow: true, endArrow: false, headSize: 14 } },
    { shape: "bezier", extra: { pathData: "M 0 0 C 20 40 60 0 80 30" } },
    { shape: "path", extra: { pathData: "M 0 0 L 40 10 L 20 50 Z" } },
  ];

  it.each(cases)("preserves the $shape subtype and its own parameters", ({ shape, extra }) => {
    const object = makeRect({
      id: `shape-${shape}`,
      shape,
      name: shape,
      opacity: 0.77,
      transform: makeTranslate(15, 25),
      localBounds: makeBounds(0, 0, 120, 80),
      style: {
        fill: { r: 0.2, g: 0.6, b: 0.9, a: 0.8 },
        stroke: { r: 0.9, g: 0.1, b: 0.1, a: 1 },
        strokeWidth: 3.5,
        cornerRadius: 7,
        dash: [6, 4, 2, 4],
        shadow: { color: { r: 0, g: 0, b: 0, a: 0.4 }, blur: 5, offsetX: 2, offsetY: 3 },
      },
      ...extra,
    });
    const before = stateOf([pageOf("page-1", [object])]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);
    const restored = after.document.pages[0].objects[`shape-${shape}`] as { shape: ShapeKind };
    // The specific failure this guards: an unrecognised subtype falling back to
    // "rect", which is a silent geometry change rather than an error.
    expect(restored.shape).toBe(shape);
  });

  it("all thirteen subtypes survive together on one page, each keeping its own kind", () => {
    const objects = cases.map(({ shape, extra }) =>
      makeRect({ id: `s-${shape}`, shape, ...extra }),
    );
    const before = stateOf([pageOf("page-1", objects)]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);
    const shapes = cases.map(({ shape }) => (after.document.pages[0].objects[`s-${shape}`] as { shape: ShapeKind }).shape);
    expect(shapes).toEqual(cases.map((c) => c.shape));
    // Not vacuous: a fallback-to-rect codec would produce thirteen "rect"s, and
    // this asserts the set has as many distinct members as the fixture does.
    expect(new Set(shapes).size).toBe(cases.length);
  });
});

describe("T7 drawing round-trip", () => {
  it("preserves the path, per-point widths, style, opacity and brush", () => {
    const drawing = makeDrawing({
      id: "draw-1",
      brush: "pen",
      smoothing: true,
      points: [
        { x: 0, y: 0 },
        { x: 12.5, y: 30.25 },
        { x: 44, y: 18.125 },
        { x: 71.75, y: 62 },
      ],
      widths: [1, 2.5, 4, 1.75],
      opacity: 0.66,
      style: {
        fill: null,
        stroke: { r: 0.05, g: 0.05, b: 0.2, a: 0.9 },
        strokeWidth: 2.75,
        cornerRadius: 0,
        // `dash`/`shadow` are OMITTED rather than set to `[]`/`null`: the model
        // documents empty-or-absent as one state ("solid", "no shadow"), and the
        // codec normalizes to the absent form. The equivalence has its own test
        // below; a fixture that wrote `[]` here would be asserting a distinction
        // the model does not make.
      },
      localBounds: makeBounds(0, 0, 72, 62),
    });
    const before = stateOf([pageOf("page-1", [drawing])]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);
    const restored = after.document.pages[0].objects["draw-1"] as {
      kind: string;
      points: Array<{ x: number; y: number }>;
      widths?: number[];
    };
    expect(restored.kind).toBe("drawing");
    // Point COUNT is not the assertion — the diff above compares coordinates.
    // This one exists so a truncated path fails loudly here too.
    expect(restored.points).toHaveLength(4);
    expect(restored.widths).toEqual([1, 2.5, 4, 1.75]);
  });
});

describe("style normalization", () => {
  it("collapses an empty dash and a null shadow to the absent form, and only those", () => {
    // The single normalization the codec performs on style. `dash: []` means
    // solid and `shadow: null` means no shadow, which is what absent means, so
    // this is canonicalization rather than loss. It is asserted explicitly so
    // that a future codec change which started dropping a REAL dash or shadow
    // fails T6 rather than being mistaken for this.
    const before = stateOf([
      pageOf("page-1", [
        makeRect({ id: "solid", style: { fill: null, stroke: null, strokeWidth: 1, cornerRadius: 0, dash: [], shadow: null } }),
      ]),
    ]);
    const style = (roundTrip(before).document.pages[0].objects.solid as unknown as { style: Record<string, unknown> })
      .style;
    expect("dash" in style).toBe(false);
    expect("shadow" in style).toBe(false);
    // …and a real dash and shadow are NOT collapsed.
    const dashed = stateOf([
      pageOf("page-1", [
        makeRect({ id: "dashed", style: { fill: null, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 1, cornerRadius: 0, dash: [5, 2], shadow: { color: { r: 0, g: 0, b: 0, a: 0.3 }, blur: 2, offsetX: 1, offsetY: 1 } } }),
      ]),
    ]);
    expectNoSemanticDrift(dashed, roundTrip(dashed));
  });
});

describe("T8 marker and highlighter round-trip", () => {
  it("keeps each brush distinct instead of collapsing them to a pen stroke", () => {
    const brushes = ["pen", "marker", "highlighter", "pencil"] as const;
    const objects = brushes.map((brush, i) =>
      makeDrawing({
        id: `stroke-${brush}`,
        brush,
        opacity: 0.5 + i * 0.1,
        smoothing: brush !== "pencil",
        style: {
          fill: null,
          stroke: { r: 0.9, g: 0.7, b: 0.1, a: 0.6 },
          strokeWidth: 4 + i,
          cornerRadius: 0,
        },
      }),
    );
    const before = stateOf([pageOf("page-1", [...objects, makeHighlight({ id: "hl-1", color: { r: 1, g: 0.95, b: 0.2, a: 0.4 }, opacity: 0.8 })])]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);

    const restoredBrushes = brushes.map(
      (brush) => (after.document.pages[0].objects[`stroke-${brush}`] as { brush?: string }).brush,
    );
    expect(restoredBrushes).toEqual([...brushes]);
    // A highlight OBJECT and a highlighter STROKE are different types; a codec
    // that folded either into the other would pass an object-count assertion.
    expect(after.document.pages[0].objects["hl-1"].kind).toBe("highlight");
    expect(after.document.pages[0].objects["stroke-highlighter"].kind).toBe("drawing");
  });
});

// ---------------------------------------------------------------------------
// T9 — z-order.
// ---------------------------------------------------------------------------

describe("T9 z-order fidelity", () => {
  /** Interleaved kinds, so type-grouping and persisted order cannot coincide. */
  const objects: EditorObject[] = [
    plainText("z1-text"),
    makeRect({ id: "z2-rect" }),
    makeAnnotation({ id: "z3-note" }),
    makeRect({ id: "z4-rect" }),
    makeImage({ id: "z5-image" }),
    plainText("z6-text"),
    makeDrawing({ id: "z7-draw" }),
    makeHighlight({ id: "z8-highlight" }),
  ];
  const expectedOrder = objects.map((o) => o.id);

  it("preserves the persisted paint order across two layers", () => {
    let page = pageOf("page-1", objects);
    // Split across two layers so LAYER order is exercised too, not only the
    // order within one layer.
    page = {
      ...page,
      layerStack: {
        layers: [
          { id: "layer-1", name: "Layer 1", visible: true, locked: false, opacity: 0.9, objectIds: expectedOrder.slice(0, 5) },
          { id: "layer-top", name: "Top", visible: true, locked: false, opacity: 0.5, objectIds: expectedOrder.slice(5) },
        ],
      },
      objects: Object.fromEntries(
        objects.map((o, i) => [o.id, { ...o, layerId: i < 5 ? "layer-1" : "layer-top" }]),
      ),
    };
    const before = stateOf([page]);
    const after = roundTrip(before);

    expectNoSemanticDrift(before, after);
    expect(paintOrder(after.document.pages[0].layerStack).map((e) => e.objectId)).toEqual(
      expectedOrder,
    );
    expect(after.document.pages[0].layerStack.layers.map((l) => l.id)).toEqual([
      "layer-1",
      "layer-top",
    ]);
  });

  it("the order it asserts is NOT the order a type-grouping reconstruction produces", () => {
    // The anti-vacuity companion for mutation C. If a future change rebuilt the
    // stack by grouping objects by kind, the assertion above would still have to
    // fail — which is only true if the two orders genuinely differ.
    const grouped = [...objects]
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((o) => o.id);
    expect(grouped).not.toEqual(expectedOrder);
  });

  it("a reordered stack round-trips as the reordered stack, not the original", () => {
    const reordered = [...expectedOrder].reverse();
    let page = pageOf("page-1", objects);
    page = {
      ...page,
      layerStack: { layers: [{ ...page.layerStack.layers[0], objectIds: reordered }] },
    };
    const after = roundTrip(stateOf([page]));
    expect(paintOrder(after.document.pages[0].layerStack).map((e) => e.objectId)).toEqual(reordered);
  });
});

// ---------------------------------------------------------------------------
// T10 — page association.
// ---------------------------------------------------------------------------

describe("T10 page association", () => {
  it("keeps objects on their logical page across a reorder and a rotation", () => {
    const first = pageOf("page-a", [yellowNote("note-a"), makeRect({ id: "rect-a" })], {
      sourcePageIndex: 0,
      rotation: 90,
      width: 595,
      height: 842,
    });
    const second = pageOf("page-b", [plainText("text-b")], {
      sourcePageIndex: 1,
      rotation: 270,
      width: 420,
      height: 595,
    });

    // Reordered: the pinned source index travels with the page, which is what
    // makes "the note is still on the page it was on" a checkable claim after a
    // reorder rather than an index coincidence.
    const before = stateOf([second, first], "page-a");
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);

    expect(after.document.pages.map((p) => p.id)).toEqual(["page-b", "page-a"]);
    expect(after.document.pages.map((p) => p.sourcePageIndex)).toEqual([1, 0]);
    expect(after.document.pages.map((p) => p.rotation)).toEqual([270, 90]);
    expect(after.document.pages.map((p) => [p.width, p.height])).toEqual([
      [420, 595],
      [595, 842],
    ]);
    expect(Object.keys(after.document.pages[0].objects).sort()).toEqual(["text-b"]);
    expect(Object.keys(after.document.pages[1].objects).sort()).toEqual(["note-a", "rect-a"]);
    expect(after.activePageId).toBe("page-a");
  });

  it("keeps a duplicated page's objects distinct from the original's", () => {
    const original = pageOf("page-1", [yellowNote("note-1")], { sourcePageIndex: 0 });
    // A duplicate carries the same sourcePageIndex (it IS the same source page)
    // with fresh object ids, which is what the duplicate-page command produces.
    const duplicate: EditorPage = {
      ...original,
      id: "page-1-copy",
      objects: { "note-2": { ...(original.objects["note-1"] as AnnotationObject), id: "note-2" } },
      layerStack: { layers: [{ ...original.layerStack.layers[0], objectIds: ["note-2"] }] },
    };
    const before = stateOf([original, duplicate]);
    const after = roundTrip(before);
    expectNoSemanticDrift(before, after);
    expect(Object.keys(after.document.pages[0].objects)).toEqual(["note-1"]);
    expect(Object.keys(after.document.pages[1].objects)).toEqual(["note-2"]);
    expect(after.document.pages.map((p) => p.sourcePageIndex)).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------
// T11 — idempotence and stable identity.
// ---------------------------------------------------------------------------

describe("T11 idempotence", () => {
  /** One of every kind, with non-default values throughout. */
  function complexState(): EditorState {
    return stateOf([
      pageOf(
        "page-1",
        [
          fullTextObject("text-1", "alpha\nbeta"),
          makeImage({ id: "image-1", crop: makeBounds(3, 5, 90, 40), opacity: 0.6 }),
          yellowNote("note-1"),
          makeSignature({ id: "sig-1", opacity: 0.9, signer: "Ada" }),
          makeRect({ id: "star-1", shape: "star", starPoints: 8, innerRatio: 0.33 }),
          makeDrawing({ id: "draw-1", brush: "marker", widths: [1, 3, 2], opacity: 0.55 }),
          makeHighlight({ id: "hl-1", opacity: 0.44 }),
        ],
        { sourcePageIndex: 0, rotation: 180 },
      ),
      pageOf("page-2", [makeRect({ id: "rect-2", shape: "speechBubble", tailPosition: 0.8 })], {
        sourcePageIndex: 1,
      }),
    ]);
  }

  it("five cycles produce no progressive drift in any property", () => {
    const original = complexState();
    let current = original;
    for (let cycle = 1; cycle <= 5; cycle++) {
      current = roundTrip(current);
      // Compared against the ORIGINAL every time, not against the previous
      // cycle: comparing neighbours would accept a per-cycle drift of one
      // tolerance step, which is how "no degradation" claims go wrong.
      expect(diffStates(original, current), `drift appeared at cycle ${cycle}`).toEqual([]);
    }
  });

  it("the serialized envelope is byte-identical from the second cycle onward", () => {
    // Determinism: `serialize` must be a function of the document, so an unchanged
    // document produces an unchanged payload — which is what lets the
    // content-addressed store dedupe a save that changed nothing.
    const first = codec.serialize(complexState());
    const second = codec.serialize(codec.deserialize(first));
    const third = codec.serialize(codec.deserialize(second));
    expect(JSON.stringify(third)).toBe(JSON.stringify(second));
    expect(third.version).toBe(EDITOR_FORMAT_VERSION);
  });

  it("object ids are the same objects after five cycles, never regenerated", () => {
    const original = complexState();
    const ids = original.document.pages.map((p) => Object.keys(p.objects).sort());
    let current = original;
    for (let i = 0; i < 5; i++) current = roundTrip(current);
    expect(current.document.pages.map((p) => Object.keys(p.objects).sort())).toEqual(ids);
    expect(current.document.pages.map((p) => p.id)).toEqual(
      original.document.pages.map((p) => p.id),
    );
    expect(current.document.id).toBe(original.document.id);
    // The ids in the layer arrays are the same ids as the object-map keys — a
    // regenerated id would break the layer reference rather than just rename it.
    for (const page of current.document.pages) {
      for (const entry of paintOrder(page.layerStack)) {
        expect(page.objects[entry.objectId]).toBeDefined();
      }
    }
  });

  it("preserves the selection and the active page, which are part of the envelope", () => {
    const base = complexState();
    const before: EditorState = {
      ...base,
      activePageId: "page-2",
      selection: { ids: ["note-1", "image-1"], primaryId: "note-1" },
    };
    const after = roundTrip(before);
    expect(after.activePageId).toBe("page-2");
    expect(after.selection).toEqual({ ids: ["note-1", "image-1"], primaryId: "note-1" });
  });
});

// ---------------------------------------------------------------------------
// T15 — zoom independence.
// ---------------------------------------------------------------------------

describe("T15 zoom independence", () => {
  /** The page point the user is aiming at, in PDF points. */
  const target = { x: 400, y: 300 };

  it("the same aimed page point persists identically at four zooms", () => {
    // The rule being enforced: zoom lives in the VIEWPORT and geometry lives in
    // the DOCUMENT. A pointer aiming at the same spot on the page lands on a
    // DIFFERENT screen pixel at each zoom, so `screenToPage` is what makes the
    // stored transform zoom-independent. Storing the screen coordinate instead is
    // the defect this catches — and it is invisible at zoom 1, which is where a
    // test written without this loop would sit.
    const payloads = [0.5, 1, 1.75, 4].map((zoom) => {
      const viewport = { zoom, pan: { x: 37 * zoom, y: -19 * zoom } };
      const origin = { x: 120 + viewport.pan.x, y: 60 + viewport.pan.y };
      const screen = pageToScreen(viewport, origin, target);
      const placed = screenToPage(viewport, origin, screen);

      const state = stateOf([pageOf("page-1", [yellowNote("note-1")])]);
      const page = state.document.pages[0];
      const authored: EditorState = {
        ...state,
        document: {
          ...state.document,
          pages: [
            {
              ...page,
              objects: {
                "note-1": {
                  ...(page.objects["note-1"] as AnnotationObject),
                  transform: makeTranslate(placed.x, placed.y),
                },
              },
            },
          ],
        },
      };
      return JSON.stringify(codec.serialize(roundTrip(authored)));
    });

    // One distinct payload across all four zooms, byte for byte.
    expect(new Set(payloads).size).toBe(1);
    // And it holds the PAGE point, not a screen pixel at some zoom.
    const restored = codec.deserialize(JSON.parse(payloads[0]));
    expect((restored.document.pages[0].objects["note-1"] as AnnotationObject).transform).toEqual(
      makeTranslate(target.x, target.y),
    );
  });

  it("the serialized envelope carries no viewport, zoom or pan", () => {
    const payload = JSON.stringify(codec.serialize(stateOf([pageOf("page-1", [yellowNote()])])));
    expect(payload).not.toMatch(/"zoom"/);
    expect(payload).not.toMatch(/"pan"/);
    expect(payload).not.toMatch(/"viewport"/);
  });
});

// ---------------------------------------------------------------------------
// T16 — unknown and malformed input.
// ---------------------------------------------------------------------------

describe("T16 unknown and malformed objects", () => {
  it("an unknown object kind survives with its kind, identity, geometry and payload", () => {
    const unknown = {
      id: "stamp-1",
      kind: "stamp",
      layerId: "layer-1",
      name: "Approved stamp",
      transform: makeTranslate(60, 90),
      localBounds: makeBounds(0, 0, 120, 40),
      opacity: 0.7,
      visible: true,
      locked: false,
      metadata: { origin: "plugin" },
      data: { label: "APPROVED", rotationDeg: 12 },
    } as unknown as EditorObject;

    const before = stateOf([pageOf("page-1", [makeRect({ id: "rect-1" }), unknown])]);
    const after = roundTrip(before);

    const restored = after.document.pages[0].objects["stamp-1"] as {
      kind: string;
      opacity: number;
      data: unknown;
    };
    // Not coerced to text, not dropped, not renamed.
    expect(restored.kind).toBe("stamp");
    expect(restored.kind).not.toBe("text");
    expect(restored.opacity).toBe(0.7);
    expect(restored.data).toEqual({ label: "APPROVED", rotationDeg: 12 });
    // It also keeps its place in the z-stack rather than being appended last.
    expect(paintOrder(after.document.pages[0].layerStack).map((e) => e.objectId)).toEqual([
      "rect-1",
      "stamp-1",
    ]);
    expectNoSemanticDrift(before, after);
  });

  it("a malformed object fails the load with a bounded message that names the field", () => {
    const payload = {
      format: "pdfdadi-editor",
      version: EDITOR_FORMAT_VERSION,
      activePageId: "page-1",
      selection: { ids: [], primaryId: null },
      document: {
        id: "doc-broken",
        version: EDITOR_FORMAT_VERSION,
        metadata: {},
        pages: [
          {
            id: "page-1",
            width: 595,
            height: 842,
            rotation: 0,
            sourcePageIndex: 0,
            background: { type: "white" },
            layerStack: { layers: [{ id: "layer-1", name: "L", visible: true, locked: false, opacity: 1, objectIds: ["bad"] }] },
            objects: {
              bad: {
                id: "bad",
                kind: "text",
                layerId: "layer-1",
                name: "Text",
                transform: IDENTITY_TRANSFORM,
                // localBounds omitted: the object cannot be placed at all.
                opacity: 1,
                visible: true,
                locked: false,
                metadata: {},
                content: createPlainTextContent("patient name: confidential"),
                fontSize: 12,
                fontFamily: "Helvetica",
                fontWeight: 400,
                color: { r: 0, g: 0, b: 0, a: 1 },
                align: "left",
                lineHeight: 1.2,
              },
            },
          },
        ],
      },
    };

    let message;
    try {
      codec.deserialize(payload);
      throw new Error("deserialize accepted a malformed object");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // It names the failure, so a diagnostic can say WHERE the load stopped …
    expect(message).toMatch(/localBounds/);
    // … and it does not carry the document's contents into a log line.
    expect(message).not.toMatch(/confidential/);
    expect(message.length).toBeLessThan(300);
  });

  it("a scene from a newer format version is refused rather than partially read", () => {
    const payload = {
      format: "pdfdadi-editor",
      version: EDITOR_FORMAT_VERSION + 1,
      activePageId: "page-1",
      selection: { ids: [], primaryId: null },
      document: { id: "doc-future", version: EDITOR_FORMAT_VERSION + 1, metadata: {}, pages: [] },
    };
    expect(() => codec.deserialize(payload)).toThrow(/newer than the supported version/);
  });

  it("a layer referencing a missing object is refused, not silently pruned", () => {
    const payload = {
      format: "pdfdadi-editor",
      version: EDITOR_FORMAT_VERSION,
      activePageId: "page-1",
      selection: { ids: [], primaryId: null },
      document: {
        id: "doc-dangling",
        version: EDITOR_FORMAT_VERSION,
        metadata: {},
        pages: [
          {
            id: "page-1",
            width: 595,
            height: 842,
            rotation: 0,
            sourcePageIndex: 0,
            background: { type: "white" },
            layerStack: { layers: [{ id: "layer-1", name: "L", visible: true, locked: false, opacity: 1, objectIds: ["ghost"] }] },
            objects: {},
          },
        ],
      },
    };
    // Pruning would turn a corrupt save into a document that quietly lost an
    // object — the failure mode this whole phase is about.
    expect(() => codec.deserialize(payload)).toThrow(/ghost/);
  });
});

// ---------------------------------------------------------------------------
// The comparator itself. A comparator that cannot fail is worse than none.
// ---------------------------------------------------------------------------

describe("the semantic comparator", () => {
  const base = stateOf([pageOf("page-1", [yellowNote("note-1"), makeRect({ id: "rect-1" })])]);

  function mutate(change: (page: EditorPage) => EditorPage): EditorState {
    return { ...base, document: { ...base.document, pages: [change(base.document.pages[0])] } };
  }

  it("reports a dropped annotation background", () => {
    const changed = mutate((page) => ({
      ...page,
      objects: {
        ...page.objects,
        "note-1": { ...(page.objects["note-1"] as AnnotationObject), background: null },
      },
    }));
    expect(diffDocuments(base.document, changed.document)).toEqual([
      "document.pages[0].objects.note-1.background: object(4) → null",
    ]);
  });

  it("reports a reordered z-stack", () => {
    const changed = mutate((page) => ({
      ...page,
      layerStack: {
        layers: [{ ...page.layerStack.layers[0], objectIds: ["rect-1", "note-1"] }],
      },
    }));
    expect(diffDocuments(base.document, changed.document).length).toBeGreaterThan(0);
  });

  it("reports a regenerated object id", () => {
    const changed = mutate((page) => ({
      ...page,
      objects: { renamed: { ...(page.objects["note-1"] as AnnotationObject), id: "renamed" }, "rect-1": page.objects["rect-1"] },
      layerStack: { layers: [{ ...page.layerStack.layers[0], objectIds: ["renamed", "rect-1"] }] },
    }));
    expect(diffDocuments(base.document, changed.document).length).toBeGreaterThan(0);
  });

  it("tolerates float noise but not a moved object", () => {
    const noisy = mutate((page) => ({
      ...page,
      objects: {
        ...page.objects,
        "note-1": {
          ...(page.objects["note-1"] as AnnotationObject),
          transform: makeTranslate(72 + 1e-12, 120 - 1e-12),
        },
      },
    }));
    expect(diffDocuments(base.document, noisy.document)).toEqual([]);

    const moved = mutate((page) => ({
      ...page,
      objects: {
        ...page.objects,
        "note-1": {
          ...(page.objects["note-1"] as AnnotationObject),
          transform: makeTranslate(72.001, 120),
        },
      },
    }));
    expect(diffDocuments(base.document, moved.document)).toHaveLength(1);
  });

  it("ignores only the format version stamp", () => {
    const bumped: EditorState = {
      ...base,
      document: { ...base.document, version: base.document.version + 1 },
    };
    expect(diffDocuments(base.document, bumped.document)).toEqual([]);
  });
});
