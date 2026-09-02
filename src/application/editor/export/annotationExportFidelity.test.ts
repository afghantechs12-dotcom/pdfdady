/**
 * T2, T14, T17 — what the EXPORTED PDF actually draws.
 *
 * The export suite next door was green throughout the entire period in which a
 * yellow sticky note exported as bare floating text: its assertions are "did not
 * throw" and "the bytes start with %PDF-", and both were true while the exporter
 * drew no panel at all. This file asserts on the page's CONTENT STREAM — the fill
 * colors set, the paths painted, the strings shown — via
 * {@link readPdfPageContent}, so "the yellow container is in the PDF" is a claim
 * a test can fail.
 *
 * The two stages the spec asks for are kept separate on purpose:
 *
 *   stage 1  the canonical model before the save equals the canonical model after
 *            the Workspace/local round trip  (T13 and T12 own this)
 *   stage 2  the PDF exported FROM that reopened model draws those properties
 *            (this file)
 *
 * T14 therefore exports twice — once from the live state, once from the state
 * that came back through the codec — and compares what the two PDFs draw. A
 * reopened document that exports differently is the recorded regression, whatever
 * the model looked like in between.
 */

import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  addObjectToPage,
  createEditorState,
  type EditorPage,
  type EditorState,
} from "@/src/domain/editor/document";
import { makeBounds, makeTranslate } from "@/src/domain/editor/geometry";
import type { AnnotationObject, EditorObject } from "@/src/domain/editor/objects";
import { makeAnnotation, makeRect, makeTextObject } from "@/src/domain/editor/testFactories";
import { createPlainTextContent } from "@/src/domain/editor/textContent";
import { SerializationService } from "../serialization/SerializationService";
import { PdfExportService } from "./PdfExportService";
import { colorMatches, readPdfPageContent, readPdfPageContents } from "./testing/pdfContent";

const codec = new SerializationService();

/** The exact colors the fixture uses, so an assertion names a color, not a hope. */
const PANEL_FILL = { r: 1, g: 0.85, b: 0.2 };
const PANEL_BORDER = { r: 0.6, g: 0.45, b: 0 };
const NOTE_TEXT = "this is note";

function pageOf(id: string, objects: EditorObject[], overrides: Partial<EditorPage> = {}): EditorPage {
  let page: EditorPage = { ...createEditorState(id, id).document.pages[0], id, ...overrides };
  for (const object of objects) page = addObjectToPage(page, object);
  return page;
}

function stateOf(pages: EditorPage[]): EditorState {
  const base = createEditorState("doc-export", pages[0].id);
  return { ...base, document: { ...base.document, pages }, activePageId: pages[0].id };
}

function yellowNote(overrides: Partial<AnnotationObject> = {}): AnnotationObject {
  return makeAnnotation({
    id: "note-1",
    text: NOTE_TEXT,
    fontSize: 13,
    color: { r: 0.12, g: 0.1, b: 0.08, a: 1 },
    transform: makeTranslate(72, 120),
    localBounds: makeBounds(0, 0, 180, 52),
    opacity: 1,
    background: { ...PANEL_FILL, a: 1 },
    border: { ...PANEL_BORDER, a: 1 },
    borderWidth: 2,
    cornerRadius: 6,
    pointerTarget: null,
    ...overrides,
  });
}

/** A source PDF whose own page already draws something recognisable. */
async function sourcePdfWithContent(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("ORIGINAL PAGE TEXT", { x: 60, y: 700, size: 18, font });
  page.drawRectangle({
    x: 60,
    y: 60,
    width: 200,
    height: 80,
    color: rgb(0.15, 0.35, 0.85),
  });
  return doc.save();
}

const exporter = new PdfExportService();

// ---------------------------------------------------------------------------
// T2 — the annotation export regression.
// ---------------------------------------------------------------------------

describe("T2 annotation export", () => {
  it("draws the yellow container AND the text, not the text alone", async () => {
    const bytes = await exporter.exportPdf(stateOf([pageOf("page-1", [yellowNote()])]));
    const page = await readPdfPageContent(bytes);

    // The container: a fill color set to the note's background, and a path
    // actually painted with it. Setting the color and painting nothing is the
    // failure mode a color-only assertion would miss, so both are asserted.
    expect(page.fills.some((fill) => colorMatches(fill, PANEL_FILL))).toBe(true);
    expect(page.strokes.some((stroke) => colorMatches(stroke, PANEL_BORDER))).toBe(true);
    // `B` = fill and stroke in one operation, which is what a bordered panel emits.
    expect(page.paints).toContain("B");
    // The text, still there — the half that never regressed.
    expect(page.texts.join(" ")).toContain(NOTE_TEXT);
  });

  it("draws nothing yellow when the note has no background", async () => {
    // The companion that makes the assertion above non-vacuous: if the exporter
    // painted a panel unconditionally, or ignored `background` and used a
    // hard-coded yellow, this test fails.
    const bytes = await exporter.exportPdf(
      stateOf([pageOf("page-1", [yellowNote({ background: null, border: null })])]),
    );
    const page = await readPdfPageContent(bytes);
    expect(page.fills.some((fill) => colorMatches(fill, PANEL_FILL))).toBe(false);
    expect(page.strokes.some((stroke) => colorMatches(stroke, PANEL_BORDER))).toBe(false);
    // …and the text is still exported, so "no panel" is not "no note".
    expect(page.texts.join(" ")).toContain(NOTE_TEXT);
  });

  it("draws the panel in the note's own color, not a default", async () => {
    const blue = { r: 0.2, g: 0.55, b: 0.95 };
    const bytes = await exporter.exportPdf(
      stateOf([pageOf("page-1", [yellowNote({ background: { ...blue, a: 1 } })])]),
    );
    const page = await readPdfPageContent(bytes);
    expect(page.fills.some((fill) => colorMatches(fill, blue))).toBe(true);
    expect(page.fills.some((fill) => colorMatches(fill, PANEL_FILL))).toBe(false);
  });

  it("draws the panel before the text, so the text is not hidden behind it", async () => {
    // Paint order inside one object. A panel drawn after its text would produce a
    // PDF in which the note looks empty — the same visible symptom as no panel,
    // from the opposite cause.
    const bytes = await exporter.exportPdf(stateOf([pageOf("page-1", [yellowNote()])]));
    const { operators } = await readPdfPageContent(bytes);
    const panelAt = operators.indexOf(`${PANEL_FILL.r} ${PANEL_FILL.g} ${PANEL_FILL.b} rg`);
    const textAt = operators.search(/BT|Tj|TJ/);
    expect(panelAt).toBeGreaterThanOrEqual(0);
    expect(textAt).toBeGreaterThan(panelAt);
  });
});

// ---------------------------------------------------------------------------
// T14 — export after a round trip.
// ---------------------------------------------------------------------------

describe("T14 export after a canonical round trip", () => {
  /** One of every kind that has its own export branch. */
  function complexState(): EditorState {
    return stateOf([
      pageOf("page-1", [
        makeTextObject({
          id: "text-1",
          content: createPlainTextContent("clause one\nclause two"),
          fontSize: 14,
          color: { r: 0.05, g: 0.05, b: 0.35, a: 1 },
          background: { r: 0.95, g: 0.95, b: 0.8, a: 1 },
          sourceText: null,
          transform: makeTranslate(40, 60),
          localBounds: makeBounds(0, 0, 240, 80),
        }),
        yellowNote(),
        makeRect({
          id: "star-1",
          shape: "star",
          starPoints: 6,
          innerRatio: 0.4,
          transform: makeTranslate(320, 400),
          style: {
            fill: { r: 0.1, g: 0.7, b: 0.4, a: 1 },
            stroke: { r: 0, g: 0.3, b: 0.15, a: 1 },
            strokeWidth: 2,
            cornerRadius: 0,
          },
        }),
      ]),
    ]);
  }

  it("the reopened document exports the same drawing as the live one", async () => {
    const live = complexState();
    const reopened = codec.deserialize(codec.serialize(live));

    const [liveContent, reopenedContent] = await Promise.all([
      exporter.exportPdf(live).then((bytes) => readPdfPageContent(bytes)),
      exporter.exportPdf(reopened).then((bytes) => readPdfPageContent(bytes)),
    ]);

    // Compared as WHAT WAS DRAWN, not as bytes: two exports of the same document
    // differ in object ids and timestamps, and comparing bytes would force this
    // test to be deleted the first time pdf-lib changed its output.
    expect(reopenedContent.fills).toEqual(liveContent.fills);
    expect(reopenedContent.strokes).toEqual(liveContent.strokes);
    expect(reopenedContent.paints).toEqual(liveContent.paints);
    expect(reopenedContent.texts).toEqual(liveContent.texts);
  });

  it("the note exported from the reopened document still has its container", async () => {
    // The end-to-end claim of the phase, at the far end: live → serialize →
    // deserialize → export, and the yellow is still in the PDF.
    const reopened = codec.deserialize(codec.serialize(complexState()));
    const page = await readPdfPageContent(await exporter.exportPdf(reopened));
    expect(page.fills.some((fill) => colorMatches(fill, PANEL_FILL))).toBe(true);
    expect(page.paints).toContain("B");
    expect(page.texts.join(" ")).toContain(NOTE_TEXT);
  });

  it("three round trips do not change what the export draws", async () => {
    let current = complexState();
    const first = await readPdfPageContent(await exporter.exportPdf(current));
    for (let cycle = 1; cycle <= 3; cycle++) {
      current = codec.deserialize(codec.serialize(current));
      const drawn = await readPdfPageContent(await exporter.exportPdf(current));
      expect(drawn.fills, `fills changed at cycle ${cycle}`).toEqual(first.fills);
      expect(drawn.texts, `texts changed at cycle ${cycle}`).toEqual(first.texts);
      expect(drawn.paints, `paints changed at cycle ${cycle}`).toEqual(first.paints);
    }
  });
});

// ---------------------------------------------------------------------------
// T17 — the original page's own content.
// ---------------------------------------------------------------------------

describe("T17 original page content", () => {
  it("keeps the source page's text and graphics under the overlay", async () => {
    const source = await sourcePdfWithContent();
    const state = stateOf([{ ...pageOf("page-1", [yellowNote()]), sourcePageIndex: 0 }]);

    const bytes = await exporter.exportPdf(state, { sourcePdfBytes: source });
    const page = await readPdfPageContent(bytes);

    // The original's own drawing: its text and its blue rectangle.
    expect(page.texts.join(" ")).toContain("ORIGINAL PAGE TEXT");
    expect(page.fills.some((fill) => colorMatches(fill, { r: 0.15, g: 0.35, b: 0.85 }))).toBe(true);
    // …and the overlay on top of it.
    expect(page.fills.some((fill) => colorMatches(fill, PANEL_FILL))).toBe(true);
    expect(page.texts.join(" ")).toContain(NOTE_TEXT);
  });

  it("keeps page rotation and size from the editor model, not from the source", async () => {
    const source = await sourcePdfWithContent();
    const state = stateOf([
      { ...pageOf("page-1", [yellowNote()]), sourcePageIndex: 0, rotation: 90 },
    ]);
    const out = await PDFDocument.load(await exporter.exportPdf(state, { sourcePdfBytes: source }));
    expect(out.getPage(0).getRotation().angle).toBe(90);
    expect(out.getPage(0).getSize()).toEqual({ width: 595, height: 842 });
  });

  it("keeps each page's objects on its own page when pages are reordered", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const label of ["SOURCE ONE", "SOURCE TWO"]) {
      const page = doc.addPage([595, 842]);
      page.drawText(label, { x: 60, y: 700, size: 18, font });
    }
    const source = await doc.save();

    // Page order reversed relative to the source: the note travels with the
    // logical page, and each exported page carries its own source content.
    const state = stateOf([
      { ...pageOf("page-b", [yellowNote({ id: "note-b" })]), sourcePageIndex: 1 },
      {
        ...pageOf("page-a", [makeRect({ id: "rect-a", style: { fill: { r: 0.9, g: 0.1, b: 0.1, a: 1 }, stroke: null, strokeWidth: 0, cornerRadius: 0 } })]),
        sourcePageIndex: 0,
      },
    ]);

    const pages = await readPdfPageContents(await exporter.exportPdf(state, { sourcePdfBytes: source }));
    expect(pages).toHaveLength(2);
    expect(pages[0].texts.join(" ")).toContain("SOURCE TWO");
    expect(pages[0].texts.join(" ")).toContain(NOTE_TEXT);
    expect(pages[1].texts.join(" ")).toContain("SOURCE ONE");
    // The note is on the first exported page ONLY — an exporter that drew every
    // object on every page would satisfy the assertions above.
    expect(pages[1].texts.join(" ")).not.toContain(NOTE_TEXT);
    expect(pages[1].fills.some((fill) => colorMatches(fill, { r: 0.9, g: 0.1, b: 0.1 }))).toBe(true);
    expect(pages[0].fills.some((fill) => colorMatches(fill, { r: 0.9, g: 0.1, b: 0.1 }))).toBe(false);
  });
});
