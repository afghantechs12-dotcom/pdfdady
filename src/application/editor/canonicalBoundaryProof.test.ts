/**
 * THE BOUNDARY PROOF: one property table, inspected at every stage of the
 * canonical path, so a failure names the stage that lost the property.
 *
 * The recorded regression was "the yellow container was there before the save and
 * gone after the reopen". That sentence names a symptom and no boundary, and the
 * suites in this repo could not narrow it: each one tested a single hop. This file
 * is the instrument that narrows it. It carries the SMALLEST deterministic fixture
 * the spec asks for — one page, one annotation, every visual property set
 * explicitly — and inspects it at:
 *
 *   A  the live canonical model
 *   B  serialize(A)                    — the wire envelope, inspected as JSON
 *   C  deserialize(B)                  — the model a load produces
 *   D  the local draft round trip      — real DraftRepository, real commit path
 *   E  the Workspace round trip        — REAL upload + editor-state routes
 *   F  the reopened editor model       — E's scene through the real codec
 *   G  the exported PDF                — what the page's content stream draws
 *
 * E and F are proved in `src/application/services/workspaceSceneRoundTrip.test.ts`,
 * which drives the real route handlers, the real VersionService and a real
 * content-addressed store; duplicating that harness here would mean two copies of
 * the same mocks drifting apart. This file names the stages and asserts A→D and
 * A→G, which are the hops nothing else covers end to end.
 *
 * WHY A PROPERTY TABLE rather than `toEqual`. `expect(after).toEqual(before)`
 * fails with a two-document dump and no boundary. {@link PROBES} names each
 * property once; every stage runs the same list; a failure reads
 * `annotation.background.g at stage D`. That is the sentence the phase report has
 * to be able to write.
 */

import { describe, expect, it } from "vitest";

import { addObjectToPage, createEditorState, createPage } from "@/src/domain/editor/document";
import type { EditorPage, EditorState } from "@/src/domain/editor/document";
import { makeBounds, makeTranslate } from "@/src/domain/editor/geometry";
import { paintOrder } from "@/src/domain/editor/layers";
import { isObjectKind } from "@/src/domain/editor/objects";
import type { AnnotationObject } from "@/src/domain/editor/objects";
import { makeAnnotation } from "@/src/domain/editor/testFactories";
import { SerializationService } from "./serialization/SerializationService";
import { diffStates } from "./serialization/testing/semanticCompare";
import { guestDocumentKey } from "./persistence/draftEnvelope";
import { DraftRepository, type DraftCommitInput } from "./persistence/draftRepository";
import { MemoryKeyValueStore } from "./persistence/testing/memoryKeyValueStore";
import { PdfExportService } from "./export/PdfExportService";
import { colorMatches, readPdfPageContent } from "./export/testing/pdfContent";

const codec = new SerializationService();
const exporter = new PdfExportService();

/** The one object under the microscope. Nothing here is a default. */
const NOTE: AnnotationObject = makeAnnotation({
  id: "note-1",
  text: "this is note",
  fontSize: 13,
  color: { r: 0.12, g: 0.1, b: 0.08, a: 1 },
  background: { r: 1, g: 0.85, b: 0.2, a: 0.9 },
  border: { r: 0.6, g: 0.45, b: 0, a: 1 },
  borderWidth: 2,
  cornerRadius: 6,
  opacity: 0.85,
  transform: makeTranslate(72, 120),
  localBounds: makeBounds(0, 0, 180, 52),
  pointerTarget: { x: 240, y: 30 },
});

function fixture(): EditorState {
  const page: EditorPage = addObjectToPage({ ...createPage("page-1"), sourcePageIndex: 0 }, NOTE);
  const base = createEditorState("doc-1", page.id);
  return {
    ...base,
    document: { ...base.document, pages: [page] },
    activePageId: page.id,
    selection: { ids: [NOTE.id], primaryId: NOTE.id },
  };
}

/** The note as it exists in a given canonical model. Throws rather than guesses. */
function noteIn(state: EditorState): AnnotationObject {
  const object = state.document.pages[0]?.objects[NOTE.id];
  if (!object) throw new Error(`the note is not in this model at all (stage lost the object)`);
  // `isObjectKind` rather than a bare `kind !== "annotation"`: a plugin object's
  // `kind` is an open `string`, so excluding the literal does not narrow it away.
  if (!isObjectKind(object, "annotation")) {
    // The T1/T-B mutation surfaces here: an annotation reconstructed as a text
    // object still HAS text, which is exactly why "the text survived" was never
    // evidence of fidelity.
    throw new Error(`the note came back as kind "${object.kind}", not an annotation`);
  }
  return object;
}

/**
 * Every property whose loss the recorded regression could have been.
 *
 * Deliberately includes the ones that did NOT regress (text, geometry): a table
 * that only lists the broken property cannot show that the fix was narrow.
 */
const PROBES: ReadonlyArray<{ name: string; of: (state: EditorState) => unknown }> = [
  { name: "kind", of: (s) => noteIn(s).kind },
  { name: "id", of: (s) => noteIn(s).id },
  { name: "text", of: (s) => noteIn(s).text },
  { name: "background", of: (s) => noteIn(s).background },
  { name: "border", of: (s) => noteIn(s).border },
  { name: "borderWidth", of: (s) => noteIn(s).borderWidth },
  { name: "cornerRadius", of: (s) => noteIn(s).cornerRadius },
  { name: "color", of: (s) => noteIn(s).color },
  { name: "fontSize", of: (s) => noteIn(s).fontSize },
  { name: "opacity", of: (s) => noteIn(s).opacity },
  { name: "transform", of: (s) => noteIn(s).transform },
  { name: "localBounds", of: (s) => noteIn(s).localBounds },
  { name: "pointerTarget", of: (s) => noteIn(s).pointerTarget },
  { name: "page.sourcePageIndex", of: (s) => s.document.pages[0].sourcePageIndex },
  { name: "page.rotation", of: (s) => s.document.pages[0].rotation },
  { name: "z-order", of: (s) => paintOrder(s.document.pages[0].layerStack) },
  { name: "activePageId", of: (s) => s.activePageId },
  { name: "selection", of: (s) => s.selection },
];

/** Runs the whole table against stage A and reports the STAGE, not a diff dump. */
function expectStageMatches(stage: string, actual: EditorState): void {
  const expected = fixture();
  for (const probe of PROBES) {
    expect(probe.of(actual), `${probe.name} at stage ${stage}`).toEqual(probe.of(expected));
  }
  // The table names what the regression could have been; the comparator catches
  // anything the table forgot.
  expect(diffStates(expected, actual), `unlisted property drift at stage ${stage}`).toEqual([]);
}

describe("stage B — the serialized envelope", () => {
  it("carries the container as data, not as a renderer's literal", async () => {
    // The original defect: the yellow existed only as `fill="rgba(255,245,180,…)"`
    // inside the annotation's React content, so there was nothing in the envelope
    // to lose — the property was never in stage B in the first place. This asserts
    // the envelope holds it, which is what makes every later stage checkable.
    const raw = codec.serialize(fixture()) as unknown as Record<string, unknown>;
    const page = (raw.document as { pages: Record<string, unknown>[] }).pages[0];
    const note = (page.objects as Record<string, Record<string, unknown>>)[NOTE.id];
    expect(note.kind).toBe("annotation");
    expect(note.background).toEqual(NOTE.background);
    expect(note.border).toEqual(NOTE.border);
    expect(note.borderWidth).toBe(2);
    expect(note.cornerRadius).toBe(6);
  });

  it("names the format and the schema version, so a reader can refuse it", () => {
    const raw = codec.serialize(fixture()) as unknown as Record<string, unknown>;
    expect(raw.format).toBe("pdfdadi-editor");
    expect(typeof raw.version).toBe("number");
  });
});

describe("stage C — deserialize(serialize(A))", () => {
  it("preserves every probed property", () => {
    expectStageMatches("C", codec.deserialize(codec.serialize(fixture())));
  });
});

describe("stage D — the local draft round trip", () => {
  it("preserves every probed property through a real commit and recovery", async () => {
    const repo = new DraftRepository(new MemoryKeyValueStore());
    const documentKey = guestDocumentKey("boundary");
    const input: DraftCommitInput = {
      draftId: "draft-boundary",
      documentKey,
      documentId: null,
      workspaceId: null,
      organizationId: null,
      documentName: "Note.pdf",
      origin: "guest",
      revision: 1,
      lastLocallyDurableRevision: 0,
      lastRemoteAcknowledgedRevision: null,
      serverVersion: null,
      etag: null,
      scene: codec.serialize(fixture()),
      sourceBytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]),
      sourceReference: null,
      pageCount: 1,
      objectCount: 1,
      now: 1_000,
    };
    await repo.commit(input);
    const loaded = await repo.loadBest(documentKey);
    if (!loaded) throw new Error("the draft that was just committed did not load back");
    expectStageMatches("D", codec.deserialize(loaded.scene));
  });
});

describe("stage G — the exported PDF", () => {
  it("draws the container, the border and the text", async () => {
    // Asserted on the model that came back from stage C, not on the live one: the
    // reopened document is what the user exports after a reopen.
    const reopened = codec.deserialize(codec.serialize(fixture()));
    const page = await readPdfPageContent(await exporter.exportPdf(reopened));
    expect(
      page.fills.some((fill) => colorMatches(fill, NOTE.background!)),
      "the note's background fill is not set in the exported content stream",
    ).toBe(true);
    expect(
      page.strokes.some((stroke) => colorMatches(stroke, NOTE.border!)),
      "the note's border color is not set in the exported content stream",
    ).toBe(true);
    expect(page.paints, "no path was filled-and-stroked, so no panel was painted").toContain("B");
    expect(page.texts.join(" ")).toContain(NOTE.text);
  });

  it("draws it at the note's page position, at the note's size", async () => {
    // Geometry, not just presence: a panel drawn at the origin, or at the wrong
    // size, would satisfy the assertions above. The panel is a rounded-rect PATH
    // (cornerRadius 6 turns the corners into beziers, so there is no `re` to
    // match), emitted under a y-flip CTM in the page's own top-left space — so its
    // extent is compared against the model's bounds directly.
    const { operators } = await readPdfPageContent(await exporter.exportPdf(fixture()));
    const panel = operators.slice(
      operators.indexOf("1 0.85 0.2 rg"),
      operators.indexOf("B", operators.indexOf("1 0.85 0.2 rg")),
    );
    expect(panel, "the panel's fill color is not followed by a painted path").not.toBe("");
    const points = [...panel.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+[mlc]\b/g)].map(
      (match) => ({ x: Number(match[1]), y: Number(match[2]) }),
    );
    expect(points.length).toBeGreaterThan(3);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    expect(Math.min(...xs)).toBeCloseTo(72, 3);
    expect(Math.max(...xs)).toBeCloseTo(252, 3);
    expect(Math.min(...ys)).toBeCloseTo(120, 3);
    expect(Math.max(...ys)).toBeCloseTo(172, 3);
  });
});
