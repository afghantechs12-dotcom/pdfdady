import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addObjectToPage,
  createEditorState,
  createPage,
  getActivePage,
} from "@/src/domain/editor/document";
import { makeDrawing, makeImage, makeRect, makeTextObject, resetFactory } from "@/src/domain/editor/testFactories";
import { EDITOR_FORMAT_VERSION } from "@/src/domain/editor/document";
import { isObjectKind, type EditorObject, type TextObject } from "@/src/domain/editor/objects";
import { READONLY_REASON } from "@/src/domain/editor/sourceText";
import { ObjectTypeRegistry, type ObjectTypeDefinition } from "../registry";
import { migrate, registerMigration, SerializationService } from "./SerializationService";

describe("SerializationService: round-trip", () => {
  beforeEach(() => resetFactory());

  it("round-trips a document with mixed object kinds", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    page = addObjectToPage(page, makeRect());
    page = addObjectToPage(page, makeDrawing());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    expect(serialized.format).toBe("pdfdadi-editor");
    expect(serialized.version).toBe(EDITOR_FORMAT_VERSION);

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const restoredPage = restored.document.pages[0];
    expect(restoredPage.width).toBe(595);
    expect(Object.keys(restoredPage.objects)).toHaveLength(3);
    // Each object keeps its kind + key fields.
    const kinds = Object.values(restoredPage.objects).map((o) => o.kind);
    expect(kinds.sort()).toEqual(["drawing", "shape", "text"]);
    const text = Object.values(restoredPage.objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.text).toBe("Hello");
  });

  it("preserves transforms, layer order, and selection", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const r1 = makeRect();
    const r2 = makeRect();
    page = addObjectToPage(page, r1);
    page = addObjectToPage(page, r2);
    const sel = { ids: [r1.id, r2.id], primaryId: r2.id };
    const withObjects = {
      ...state,
      document: { ...state.document, pages: [page] },
      selection: sel,
    };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    expect(restored.selection).toEqual(sel);
    expect(restored.document.pages[0].layerStack.layers[0].objectIds).toEqual([r1.id, r2.id]);
  });

  it("deserialize rejects a malformed envelope", () => {
    const svc = new SerializationService();
    expect(() => svc.deserialize({ format: "other", version: 1 })).toThrow();
    expect(() => svc.deserialize({ format: "pdfdadi-editor", version: "x" })).toThrow();
    expect(() => svc.deserialize(null)).toThrow();
  });

  it("deserialize rejects a newer-than-supported version", () => {
    const svc = new SerializationService();
    const serialized = svc.serialize(createEditorState());
    serialized.version = EDITOR_FORMAT_VERSION + 1;
    expect(() => svc.deserialize(serialized)).toThrow(/newer than the supported version/);
  });

  it("deserialize rejects an object missing a required field", () => {
    const svc = new SerializationService();
    const serialized = svc.serialize(createEditorState());
    const doc = serialized.document as Record<string, unknown>;
    const pages = doc.pages as Array<Record<string, unknown>>;
    pages[0].width = "not-a-number";
    expect(() => svc.deserialize(serialized)).toThrow(/not a finite number/);
  });

  it("rejects unsafe image sources and invalid decoded dimensions", () => {
    const state = createEditorState();
    const page = addObjectToPage(getActivePage(state), makeImage());
    const svc = new SerializationService();
    const serialized = svc.serialize({ ...state, document: { ...state.document, pages: [page] } });
    const rawPage = (serialized.document as { pages: Array<{ objects: Record<string, Record<string, unknown>> }> }).pages[0];
    const rawImage = Object.values(rawPage.objects)[0];

    rawImage.src = "javascript:alert(1)";
    expect(() => svc.deserialize(serialized)).toThrow(/PNG|JPEG|image source/i);

    rawImage.src = "data:image/png;base64,AA==";
    rawImage.naturalWidth = 0;
    expect(() => svc.deserialize(serialized)).toThrow(/dimensions/i);
  });

  it("canonicalizes malformed/full crops and rejects orphan layer references", () => {
    const state = createEditorState();
    const page = addObjectToPage(getActivePage(state), makeImage());
    const svc = new SerializationService();
    const serialized = svc.serialize({ ...state, document: { ...state.document, pages: [page] } });
    const rawPage = (serialized.document as { pages: Array<{ objects: Record<string, Record<string, unknown>>; layerStack: { layers: Array<{ objectIds: string[] }> } }> }).pages[0];
    const rawImage = Object.values(rawPage.objects)[0];

    rawImage.crop = { x: 0, y: 0, width: 200, height: 100 };
    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    expect(Object.values(restored.document.pages[0].objects)[0]).toMatchObject({ crop: null });

    rawPage.layerStack.layers[0].objectIds.push("missing-object");
    expect(() => svc.deserialize(serialized)).toThrow(/missing object/i);
  });

  it("rejects prototype-sensitive object identifiers", () => {
    const state = createEditorState();
    const page = addObjectToPage(getActivePage(state), makeImage({ id: "constructor" }));
    const svc = new SerializationService();
    const serialized = svc.serialize({ ...state, document: { ...state.document, pages: [page] } });
    expect(() => svc.deserialize(serialized)).toThrow(/forbidden object id|unsafe object identifier/i);
  });

  it("truncates an oversized string field instead of throwing or OOMing (F6 hardening)", () => {
    // A malicious/corrupted save could carry an arbitrarily huge rich-text run.
    // v4 caps canonical run text at MAX_STRING_LENGTH (200_000 chars) rather than
    // allocating/holding whatever size the attacker chose. The legacy `text`
    // projection is deliberately not authoritative after the v3→v4 migration.
    resetFactory();
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    const huge = "a".repeat(300_000);
    for (const obj of Object.values(pageObjs)) {
      if (obj.kind === "text") {
        const content = obj.content as { paragraphs: Array<{ runs: Array<{ text: string }> }> };
        content.paragraphs[0].runs[0].text = huge;
      }
    }

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.text.length).toBe(200_000);
  });
});

describe("SerializationService: migrations", () => {
  afterEach(() => {
    // The migrations map is module-level with no unregister API. The real 1->2
    // migration is registered at module load; these tests use synthetic versions
    // (100+) so they never collide with it.
  });

  it("registerMigration rejects a duplicate fromVersion", () => {
    // Register 1→2 once; a second registration must throw.
    registerMigration(100, (d) => ({ ...d, version: 101 }));
    expect(() => registerMigration(100, (d) => ({ ...d, version: 101 }))).toThrow(/already registered/);
  });

  it("migrate applies registered steps up to the target version", () => {
    registerMigration(101, (d) => ({
      ...d,
      version: 102,
      document: { ...(d.document as Record<string, unknown>), migratedTo: 102 },
    }));
    const svc = new SerializationService();
    const v100 = { ...svc.serialize(createEditorState()), version: 100 };
    const v102 = migrate(v100, 102);
    expect(v102.version).toBe(102);
    expect((v102.document as Record<string, unknown>).migratedTo).toBe(102);
  });

  it("migrate throws when no step is registered for an intermediate version", () => {
    const svc = new SerializationService();
    const v100 = { ...svc.serialize(createEditorState()), version: 100 };
    // 100->101 and 101->102 are registered above, but 102->103 is not.
    expect(() => migrate(v100, 103)).toThrow(/No migration path/);
  });

  it("the real v1->v2 migration backfills letterSpacing and crop with defaults", () => {
    resetFactory();
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    page = addObjectToPage(page, makeImage());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    // Simulate a v1 save: drop the version to 1 and strip the v2-only fields.
    serialized.version = 1;
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    for (const obj of Object.values(pageObjs)) {
      if (obj.kind === "text") delete obj.letterSpacing;
      if (obj.kind === "image") delete obj.crop;
    }

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    expect(restored.document.version).toBe(EDITOR_FORMAT_VERSION);
    const objects = Object.values(restored.document.pages[0].objects);
    const text = objects.find((o): o is TextObject => isObjectKind(o, "text"));
    const image = objects.find((o) => o.kind === "image");
    expect(text?.letterSpacing).toBe(0);
    expect((image as { crop: unknown } | undefined)?.crop).toBeNull();
    // A v1 save migrates through v2 -> v3, so the v3 fields backfill to null too
    // (transparent background / editor-authored text). This is the v1 -> v3 leg
    // of the backward-compat claim — previously executed but not asserted.
    expect(text?.background).toBeNull();
    expect(text?.sourceText).toBeNull();
  });

  it("the real v2->v3 migration backfills background + sourceText with null defaults", () => {
    resetFactory();
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    // Simulate a v2 save: drop the version to 2 and strip the v3-only fields.
    serialized.version = 2;
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    for (const obj of Object.values(pageObjs)) {
      if (obj.kind === "text") {
        delete obj.background;
        delete obj.sourceText;
      }
    }

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    expect(restored.document.version).toBe(EDITOR_FORMAT_VERSION);
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    // Missing v3 fields upgrade to the null default (transparent / not existing-text).
    expect(text?.background).toBeNull();
    expect(text?.sourceText).toBeNull();
  });

  it("the real v4->v5 migration backfills sourcePageIndex with each page's array index", () => {
    resetFactory();
    // Build a 3-page v5 state, then simulate a v4 save: drop the version to 4
    // and strip sourcePageIndex from every page (v4 had no such field).
    const base = createEditorState("doc", "page-0");
    const pages = [0, 1, 2].map((i) => ({ ...createPage(`page-${i}`), sourcePageIndex: i }));
    const state = { ...base, document: { ...base.document, pages }, activePageId: "page-0" };

    const svc = new SerializationService();
    const serialized = svc.serialize(state);
    serialized.version = 4;
    const doc = serialized.document as Record<string, unknown>;
    for (const page of doc.pages as Array<Record<string, unknown>>) delete page.sourcePageIndex;

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    expect(restored.document.version).toBe(EDITOR_FORMAT_VERSION);
    expect(restored.document.pages.map((p) => p.sourcePageIndex)).toEqual([0, 1, 2]);
  });

  it("the real v3->v4 migration creates normalized content and a default frame", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject({ text: "Legacy\ntext" }));
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    serialized.version = 3;
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    for (const obj of Object.values(pageObjs)) {
      if (obj.kind === "text") {
        delete obj.content;
        delete obj.frame;
      }
    }

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.content).toEqual({
      paragraphs: [
        {
          runs: [{ text: "Legacy\ntext", style: {} }],
          spacingBefore: 0,
          spacingAfter: 0,
          list: { kind: "none", level: 0 },
        },
      ],
    });
    expect(text?.frame).toEqual({
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      verticalAlign: "top",
      wrapMode: "wrap",
      sizingMode: "auto-height",
      columns: { count: 1, gap: 0 },
    });
  });
});

describe("SerializationService: M5 Part 2 text model (v4 fields)", () => {
  beforeEach(() => resetFactory());

  function serializeText(text = makeTextObject()): {
    svc: SerializationService;
    serialized: ReturnType<SerializationService["serialize"]>;
    object: Record<string, unknown>;
  } {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, text);
    const svc = new SerializationService();
    const serialized = svc.serialize({ ...state, document: { ...state.document, pages: [page] } });
    const document = serialized.document as Record<string, unknown>;
    const objects = (document.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    return { svc, serialized, object: Object.values(objects)[0] };
  }

  it("round-trips rich runs and frame intent while regenerating the legacy text projection", () => {
    const { svc, serialized } = serializeText(
      makeTextObject({
        content: {
          paragraphs: [
            {
              runs: [
                { text: "Bold", style: { fontWeight: 700, decoration: "underline" } },
                { text: " + shifted", style: { baselineShift: 3, letterSpacing: 1.5 } },
              ],
              spacingBefore: 2,
              spacingAfter: 4,
              list: { kind: "numbered", level: 1 },
            },
            {
              runs: [{ text: "Second paragraph", style: { italic: true, opacity: 0.8 } }],
              spacingBefore: 0,
              spacingAfter: 0,
              list: { kind: "none", level: 0 },
            },
          ],
        },
        frame: {
          padding: { top: 4, right: 6, bottom: 8, left: 10 },
          verticalAlign: "middle",
          wrapMode: "wrap",
          sizingMode: "fixed",
          columns: { count: 2, gap: 12 },
        },
      }),
    );
    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const text = Object.values(restored.document.pages[0].objects).find(
      (object): object is TextObject => isObjectKind(object, "text"),
    );

    expect(text?.text).toBe("Bold + shifted\nSecond paragraph");
    expect(text?.content.paragraphs[0].runs[0].style).toEqual({
      fontWeight: 700,
      decoration: "underline",
    });
    expect(text?.frame).toEqual({
      padding: { top: 4, right: 6, bottom: 8, left: 10 },
      verticalAlign: "middle",
      wrapMode: "wrap",
      sizingMode: "fixed",
      columns: { count: 2, gap: 12 },
    });
  });

  it("uses canonical content instead of a contradictory serialized text projection", () => {
    const { svc, serialized, object } = serializeText();
    object.text = "untrusted legacy projection";
    const content = object.content as { paragraphs: Array<{ runs: Array<{ text: string }> }> };
    content.paragraphs[0].runs[0].text = "Canonical text";

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const text = Object.values(restored.document.pages[0].objects).find(
      (candidate): candidate is TextObject => isObjectKind(candidate, "text"),
    );
    expect(text?.text).toBe("Canonical text");
  });

  it("rejects malformed or resource-exhausting rich text and frame payloads", () => {
    const { svc, serialized } = serializeText();
    const restoreWith = (mutate: (target: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
      const document = copy.document as Record<string, unknown>;
      const objects = (document.pages as Array<Record<string, unknown>>)[0].objects as Record<
        string,
        Record<string, unknown>
      >;
      mutate(Object.values(objects)[0]);
      return () => svc.deserialize(copy);
    };

    expect(restoreWith((target) => { target.content = { paragraphs: [] }; })).toThrow(/paragraphs/);
    expect(restoreWith((target) => {
      (target.content as { paragraphs: unknown[] }).paragraphs = Array.from({ length: 10_001 }, () => ({ runs: [] }));
    })).toThrow(/paragraphs/);
    expect(restoreWith((target) => {
      const content = target.content as { paragraphs: Array<{ runs: unknown[] }> };
      content.paragraphs[0].runs = Array.from({ length: 20_001 }, () => ({ text: "x", style: {} }));
    })).toThrow(/run limit/);
    expect(restoreWith((target) => {
      const frame = target.frame as { columns: { count: number } };
      frame.columns.count = 13;
    })).toThrow(/frame.columns.count/);
    expect(restoreWith((target) => {
      const content = target.content as { paragraphs: Array<{ runs: Array<{ style: { opacity: number } }> }> };
      content.paragraphs[0].runs[0].style.opacity = 2;
    })).toThrow(/opacity/);
  });
});

describe("SerializationService: imported source text (v3 fields)", () => {
  beforeEach(() => resetFactory());

  it("round-trips a readonly imported run's provenance and capability", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(
      page,
      makeTextObject({
        text: "Original line",
        background: null,
        sourceText: {
          fontName: "Times-Bold",
          rotation: 90,
          mode: "readonly",
          reason: READONLY_REASON,
          originalText: "Original line",
        },
      }),
    );
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    // An explicit mode survives untouched — normalization only rewrites LEGACY
    // markers (those with no mode at all).
    expect(text?.background).toBeNull();
    expect(text?.sourceText).toEqual({
      fontName: "Times-Bold",
      rotation: 90,
      mode: "readonly",
      reason: READONLY_REASON,
      originalText: "Original line",
    });
  });

  it("round-trips a replacement run's removal fill", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(
      page,
      makeTextObject({
        text: "My replacement",
        background: { r: 1, g: 1, b: 1, a: 1 },
        sourceText: {
          fontName: "Times-Bold",
          rotation: 90,
          mode: "replace",
          reason: "The original text has been permanently removed from the replacement region.",
          originalText: "Original line",
        },
      }),
    );
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.background).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(text?.sourceText?.mode).toBe("replace");
    // The original run's text is preserved even though the user replaced it.
    expect(text?.sourceText?.originalText).toBe("Original line");
  });

  it("a transparent background (null) round-trips as null, not undefined", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject({ background: null }));
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.background).toBeNull();
  });

  it("a malformed sourceText is dropped, not thrown (lenient provenance restore)", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    // Inject a structurally-wrong sourceText (a number, not an object).
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    for (const obj of Object.values(pageObjs)) {
      if (obj.kind === "text") obj.sourceText = 42;
    }
    // Must NOT throw — a corrupt provenance marker never blocks loading a doc.
    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.sourceText).toBeNull();
  });

  it("caps an oversized sourceText.fontName and drops a non-finite rotation (T5)", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    for (const obj of Object.values(pageObjs)) {
      if (obj.kind === "text") obj.sourceText = { fontName: "a".repeat(300_000), rotation: NaN };
    }
    // Must NOT throw — the fontName is capped and the NaN rotation is dropped.
    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const text = Object.values(restored.document.pages[0].objects).find(
      (o): o is TextObject => isObjectKind(o, "text"),
    );
    expect(text?.sourceText).not.toBeNull();
    expect(text?.sourceText?.fontName?.length).toBe(200_000);
    // A non-finite rotation is dropped (no rotation key), not stored as NaN.
    expect(text?.sourceText?.rotation).toBeUndefined();
  });

  it("throws on a present-but-malformed background (optColor strictness, T6)", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeTextObject());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const base = svc.serialize(withObjects);

    // Inject a background value onto the text object, then deserialize.
    const inject = (value: unknown) => {
      const copy = JSON.parse(JSON.stringify(base));
      const pageObjs = (copy.document.pages as Array<Record<string, unknown>>)[0].objects as Record<
        string,
        Record<string, unknown>
      >;
      for (const obj of Object.values(pageObjs)) {
        if (obj.kind === "text") obj.background = value;
      }
      return copy;
    };

    // A non-color, non-null background (a number) throws — optColor is strict.
    expect(() => svc.deserialize(inject(42))).toThrow();
    // A partial color (missing g/b/a channels) throws.
    expect(() => svc.deserialize(inject({ r: 1 }))).toThrow();
  });
});

describe("SerializationService: page sourcePageIndex (v5)", () => {
  beforeEach(() => resetFactory());

  it("round-trips both a pinned index and a null (blank page) sourcePageIndex", () => {
    const base = createEditorState("doc", "page-0");
    const pages = [
      { ...createPage("page-0"), sourcePageIndex: 4 },
      { ...createPage("page-blank"), sourcePageIndex: null },
    ];
    const state = { ...base, document: { ...base.document, pages }, activePageId: "page-0" };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(state))));
    expect(restored.document.pages[0].sourcePageIndex).toBe(4);
    expect(restored.document.pages[1].sourcePageIndex).toBeNull();
  });

  it("restores a malformed sourcePageIndex as null (lenient, like rotation)", () => {
    const svc = new SerializationService();
    const serialized = svc.serialize(createEditorState());
    const inject = (value: unknown) => {
      const copy = JSON.parse(JSON.stringify(serialized)) as typeof serialized;
      const pages = (copy.document as Record<string, unknown>).pages as Array<Record<string, unknown>>;
      pages[0].sourcePageIndex = value;
      return svc.deserialize(copy).document.pages[0].sourcePageIndex;
    };
    expect(inject("3")).toBeNull();
    expect(inject(1.5)).toBeNull();
    expect(inject(-1)).toBeNull();
    expect(inject({})).toBeNull();
  });
});

describe("SerializationService: plugin object kinds", () => {
  beforeEach(() => resetFactory());

  it("round-trips a plugin-defined kind through the registry", () => {
    const registry = new ObjectTypeRegistry();
    const stampDef: ObjectTypeDefinition = {
      kind: "stamp",
      displayName: "Stamp",
      serialize: (obj) => (obj as unknown as { data: { emoji: string } }).data,
      deserialize: (base, data) =>
        ({ ...base, kind: "stamp", data: data as { emoji: string } }) as unknown as EditorObject,
    };
    registry.register(stampDef);

    const state = createEditorState();
    const page = getActivePage(state);
    // Hand-build a plugin object and add it to the page's object map.
    const pluginObj = {
      id: "stamp-1",
      kind: "stamp",
      layerId: "layer-1",
      name: "Stamp",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 },
      localBounds: { x: 0, y: 0, width: 40, height: 40 },
      opacity: 1,
      visible: true,
      locked: false,
      metadata: {},
      data: { emoji: "✅" },
    };
    const withStamp = {
      ...state,
      document: {
        ...state.document,
        pages: [{ ...page, objects: { ...page.objects, "stamp-1": pluginObj } }],
      },
    };

    const svc = new SerializationService(registry);
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withStamp))));
    const obj = restored.document.pages[0].objects["stamp-1"];
    expect(obj?.kind).toBe("stamp");
    // The plugin's deserialize restored the data payload.
    expect((obj as unknown as { data: { emoji: string } }).data.emoji).toBe("✅");
  });

  it("falls back to a generic restore for an unregistered plugin kind", () => {
    const state = createEditorState();
    const page = getActivePage(state);
    const pluginObj = {
      id: "x-1",
      kind: "unknownKind",
      layerId: "layer-1",
      name: "X",
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      localBounds: { x: 0, y: 0, width: 10, height: 10 },
      opacity: 1,
      visible: true,
      locked: false,
      metadata: {},
      data: { foo: 42 },
    };
    const withPlugin = {
      ...state,
      document: {
        ...state.document,
        pages: [{ ...page, objects: { ...page.objects, "x-1": pluginObj } }],
      },
    };
    const svc = new SerializationService(); // no registry
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withPlugin))));
    const obj = restored.document.pages[0].objects["x-1"];
    expect(obj?.kind).toBe("unknownKind");
    expect((obj as unknown as { data: { foo: number } }).data.foo).toBe(42);
  });
});

describe("SerializationService: M6 shape library + drawing upgrade (v6)", () => {
  beforeEach(() => resetFactory());

  it("the real v5->v6 migration backfills shadow, brush, and smoothing defaults", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    page = addObjectToPage(page, makeRect());
    page = addObjectToPage(page, makeDrawing());
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    // Simulate a v5 save: drop the version and strip the v6-only fields.
    serialized.version = 5;
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    for (const obj of Object.values(pageObjs)) {
      const style = obj.style as Record<string, unknown> | undefined;
      if (style) delete style.shadow;
      if (obj.kind === "drawing") {
        delete obj.brush;
        delete obj.smoothing;
      }
    }

    // Assert on the migrated RAW data (the explicit on-disk backfill), then on
    // the reconstructed state (the live defaults).
    const migrated = migrate(JSON.parse(JSON.stringify(serialized)));
    const migratedObjs = ((migrated.document as Record<string, unknown>).pages as Array<
      Record<string, unknown>
    >)[0].objects as Record<string, Record<string, unknown>>;
    for (const obj of Object.values(migratedObjs)) {
      expect((obj.style as Record<string, unknown>).shadow).toBeNull();
      if (obj.kind === "drawing") {
        expect(obj.brush).toBe("pen");
        expect(obj.smoothing).toBe(false);
      }
    }

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    expect(restored.document.version).toBe(EDITOR_FORMAT_VERSION);
    const objects = Object.values(restored.document.pages[0].objects);
    const drawing = objects.find((o) => o.kind === "drawing") as unknown as {
      brush: string;
      smoothing: boolean;
    };
    expect(drawing.brush).toBe("pen");
    expect(drawing.smoothing).toBe(false);
  });

  it("round-trips a star shape with per-kind parameters, dash, and shadow", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const star = makeRect({
      shape: "star",
      starPoints: 7,
      innerRatio: 0.4,
      style: {
        fill: { r: 1, g: 0, b: 0, a: 1 },
        stroke: { r: 0, g: 0, b: 1, a: 1 },
        strokeWidth: 3,
        cornerRadius: 0,
        dash: [4, 3],
        shadow: { offsetX: 2, offsetY: 3, blur: 4, color: { r: 0, g: 0, b: 0, a: 0.5 } },
      },
    });
    page = addObjectToPage(page, star);
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    const obj = restored.document.pages[0].objects[star.id] as unknown as {
      shape: string;
      starPoints: number;
      innerRatio: number;
      style: { dash?: number[]; shadow?: { offsetX: number; blur: number } | null };
    };
    expect(obj.shape).toBe("star");
    expect(obj.starPoints).toBe(7);
    expect(obj.innerRatio).toBe(0.4);
    expect(obj.style.dash).toEqual([4, 3]);
    expect(obj.style.shadow?.offsetX).toBe(2);
    expect(obj.style.shadow?.blur).toBe(4);
  });

  it("round-trips a bezier shape's normalized pathData and a connector's routing", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const bezier = makeRect({
      shape: "bezier",
      pathData: "M 0 0 C 10 0 20 10 30 30",
      style: { fill: null, stroke: { r: 0, g: 0, b: 0, a: 1 }, strokeWidth: 2, cornerRadius: 0 },
    });
    const connector = makeRect({
      shape: "connector",
      connectorKind: "elbow",
      startArrow: true,
      endArrow: false,
      points: [
        { x: 0, y: 0 },
        { x: 80, y: 40 },
      ],
    });
    page = addObjectToPage(page, bezier);
    page = addObjectToPage(page, connector);
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    const b = restored.document.pages[0].objects[bezier.id] as unknown as { pathData: string };
    expect(b.pathData).toBe("M 0 0 C 10 0 20 10 30 30");
    const c = restored.document.pages[0].objects[connector.id] as unknown as {
      connectorKind: string;
      startArrow: boolean;
      endArrow: boolean;
    };
    expect(c.connectorKind).toBe("elbow");
    expect(c.startArrow).toBe(true);
    expect(c.endArrow).toBe(false);
  });

  it("round-trips a drawing's brush, smoothing, and pressure widths", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const stroke = makeDrawing({
      brush: "highlighter",
      smoothing: true,
      widths: [2, 2.5, 3],
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
      ],
    });
    page = addObjectToPage(page, stroke);
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const restored = svc.deserialize(JSON.parse(JSON.stringify(svc.serialize(withObjects))));
    const d = restored.document.pages[0].objects[stroke.id] as unknown as {
      brush: string;
      smoothing: boolean;
      widths: number[];
    };
    expect(d.brush).toBe("highlighter");
    expect(d.smoothing).toBe(true);
    expect(d.widths).toEqual([2, 2.5, 3]);
  });

  it("sanitizes crafted v6 fields: unknown kinds/brushes fall back, params clamp, garbage drops", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const shape = makeRect();
    const stroke = makeDrawing();
    page = addObjectToPage(page, shape);
    page = addObjectToPage(page, stroke);
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    const rawShape = pageObjs[shape.id];
    rawShape.shape = "hexagram"; // unknown kind
    rawShape.sides = 99; // out of range -> clamps to 12
    rawShape.innerRatio = -5; // out of range -> clamps to 0.1
    rawShape.headType = "banana"; // unknown -> "triangle"
    (rawShape.style as Record<string, unknown>).dash = ["x", -1, 4, 2]; // partial garbage
    (rawShape.style as Record<string, unknown>).shadow = "not-an-object"; // garbage -> dropped
    const rawStroke = pageObjs[stroke.id];
    rawStroke.brush = "crayon"; // unknown -> "pen"
    rawStroke.widths = [1, "x", -2, 3]; // partial garbage -> [1, 3]

    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const s = restored.document.pages[0].objects[shape.id] as unknown as {
      shape: string;
      sides: number;
      innerRatio: number;
      headType: string;
      style: { dash?: number[]; shadow?: unknown };
    };
    expect(s.shape).toBe("rect");
    expect(s.sides).toBe(12);
    expect(s.innerRatio).toBe(0.1);
    expect(s.headType).toBe("triangle");
    expect(s.style.dash).toEqual([4, 2]);
    expect(s.style.shadow).toBeUndefined();
    const d = restored.document.pages[0].objects[stroke.id] as unknown as {
      brush: string;
      widths: number[];
    };
    expect(d.brush).toBe("pen");
    expect(d.widths).toEqual([1, 3]);
  });

  it("normalizes crafted (non-normalized) pathData so its tight bounds start at (0,0)", () => {
    const state = createEditorState();
    let page = getActivePage(state);
    const bezier = makeRect({ shape: "path" });
    page = addObjectToPage(page, bezier);
    const withObjects = { ...state, document: { ...state.document, pages: [page] } };

    const svc = new SerializationService();
    const serialized = svc.serialize(withObjects);
    const doc = serialized.document as Record<string, unknown>;
    const pageObjs = (doc.pages as Array<Record<string, unknown>>)[0].objects as Record<
      string,
      Record<string, unknown>
    >;
    pageObjs[bezier.id].pathData = "M 10 20 L 40 60"; // offset from the origin
    const restored = svc.deserialize(JSON.parse(JSON.stringify(serialized)));
    const b = restored.document.pages[0].objects[bezier.id] as unknown as { pathData: string };
    expect(b.pathData).toBe("M 0 0 L 30 40");
  });
});
