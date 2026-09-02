/**
 * T12 — the LOCAL round trip, compared as a document rather than as a receipt.
 *
 * "Saved on this device" is a claim about a document, and the draft tests next
 * door prove the claim's DURABILITY: nothing observable until a pointer moves,
 * nothing deleted until its replacement reads back. They do not prove its
 * CONTENT — every one of them would pass if the snapshot held a document with
 * the objects' styles stripped, because they compare generations, revisions and
 * checksums, and a checksum agrees with whatever was written.
 *
 * So this file drives the REAL {@link DraftRepository} — real commit sequence,
 * real envelope codec, real asset externalisation — and then asks the only
 * question those tests cannot: is the document that comes back OUT the document
 * that went IN, property for property? The comparison is
 * {@link diffDocuments}/{@link diffStates}, never `revision === revision` and
 * never an object count.
 *
 * WHAT IS REAL AND WHAT IS SUBSTITUTED. Everything above the storage adapter is
 * production code. `MemoryKeyValueStore` stands in for
 * `IndexedDbKeyValueStore` because vitest runs `environment: "node"` and this
 * repo has no `fake-indexeddb`; it implements the same `KeyValueStore` port and
 * the same transaction/quota semantics, which is what the repository depends on.
 * The real IndexedDB path is covered by browser probe Scenario C
 * (`scripts/editor-roundtrip-fidelity-probe.mjs`), where a genuine reload
 * recovers a genuine draft. That split is deliberate and is stated in the Phase
 * 3 report rather than left for a reader to discover.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { addObjectToPage, createEditorState, createPage } from "@/src/domain/editor/document";
import type { EditorPage, EditorState } from "@/src/domain/editor/document";
import { makeBounds, makeTranslate } from "@/src/domain/editor/geometry";
import { paintOrder } from "@/src/domain/editor/layers";
import type { AnnotationObject, EditorObject } from "@/src/domain/editor/objects";
import {
  makeAnnotation,
  makeDrawing,
  makeHighlight,
  makeImage,
  makeRect,
  makeSignature,
  makeTextObject,
} from "@/src/domain/editor/testFactories";
import { createPlainTextContent } from "@/src/domain/editor/textContent";
import { SerializationService } from "../serialization/SerializationService";
import { diffDocuments, diffStates } from "../serialization/testing/semanticCompare";
import { ASSET_INLINE_THRESHOLD, guestDocumentKey } from "./draftEnvelope";
import { DraftRepository, type DraftCommitInput } from "./draftRepository";
import { MemoryKeyValueStore } from "./testing/memoryKeyValueStore";

const codec = new SerializationService();
const DOCUMENT_KEY = guestDocumentKey("fidelity");

let store: MemoryKeyValueStore;
let repo: DraftRepository;

beforeEach(() => {
  store = new MemoryKeyValueStore();
  repo = new DraftRepository(store);
});

/**
 * An image whose data URL is over the inline threshold, so the commit
 * EXTERNALISES it as a content-addressed asset and recovery has to put it back.
 *
 * This is the part of the local path with somewhere to lose data: an inline
 * string that survives JSON trivially is replaced by a reference, written
 * separately, and re-inlined on load. An image that came back with its `src`
 * still reading `asset:…` would render as nothing.
 */
function bigPngDataUrl(seed: string): string {
  return `data:image/png;base64,${seed.repeat(ASSET_INLINE_THRESHOLD)}`;
}

function pageOf(id: string, objects: EditorObject[], overrides: Partial<EditorPage> = {}): EditorPage {
  let page: EditorPage = { ...createPage(id), ...overrides };
  for (const object of objects) page = addObjectToPage(page, object);
  return page;
}

/** The fixture: one of every kind, nothing left at its default. */
function liveState(): EditorState {
  const pages = [
    pageOf(
      "page-1",
      [
        makeTextObject({
          id: "text-1",
          content: createPlainTextContent("first line\nsecond line"),
          fontSize: 15.5,
          fontFamily: "Times",
          fontWeight: 600,
          color: { r: 0.1, g: 0.15, b: 0.4, a: 1 },
          align: "right",
          lineHeight: 1.4,
          letterSpacing: 0.75,
          wordSpacing: 2.5,
          paragraphSpacing: 6,
          background: { r: 1, g: 1, b: 0.92, a: 1 },
          sourceText: null,
          opacity: 0.9,
          transform: makeTranslate(30, 40),
          localBounds: makeBounds(0, 0, 220, 70),
        }),
        makeImage({
          id: "image-1",
          src: bigPngDataUrl("A"),
          crop: makeBounds(11, 23, 88, 41),
          opacity: 0.55,
          transform: makeTranslate(60, 200),
          localBounds: makeBounds(0, 0, 180, 120),
          naturalWidth: 180,
          naturalHeight: 120,
        }),
        makeAnnotation({
          id: "note-1",
          text: "this is note",
          fontSize: 13,
          opacity: 0.85,
          background: { r: 1, g: 0.85, b: 0.2, a: 0.9 },
          border: { r: 0.6, g: 0.45, b: 0, a: 1 },
          borderWidth: 2,
          cornerRadius: 6,
          pointerTarget: { x: 240, y: 30 },
          transform: makeTranslate(72, 120),
          localBounds: makeBounds(0, 0, 180, 52),
        }),
        makeSignature({ id: "sig-1", src: bigPngDataUrl("B"), signer: "Ada", opacity: 0.95 }),
        makeRect({ id: "star-1", shape: "star", starPoints: 7, innerRatio: 0.4, opacity: 0.7 }),
        makeDrawing({
          id: "draw-1",
          brush: "highlighter",
          widths: [2, 4.5, 3],
          points: [
            { x: 0, y: 0 },
            { x: 30.25, y: 12.5 },
            { x: 61, y: 4 },
          ],
          opacity: 0.6,
        }),
        makeHighlight({ id: "hl-1", opacity: 0.45, color: { r: 1, g: 0.95, b: 0.2, a: 0.4 } }),
      ],
      { sourcePageIndex: 0, rotation: 90 },
    ),
    pageOf("page-2", [makeRect({ id: "bubble-2", shape: "speechBubble", tailPosition: 0.65 })], {
      sourcePageIndex: 1,
      width: 420,
      height: 595,
      rotation: 270,
    }),
  ];
  const base = createEditorState("doc-local", "page-2");
  return {
    ...base,
    document: { ...base.document, pages },
    activePageId: "page-2",
    selection: { ids: ["note-1"], primaryId: "note-1" },
  };
}

function commitInput(state: EditorState, overrides: Partial<DraftCommitInput> = {}): DraftCommitInput {
  return {
    draftId: "draft-fidelity",
    documentKey: DOCUMENT_KEY,
    documentId: null,
    workspaceId: null,
    organizationId: null,
    documentName: "Contract.pdf",
    origin: "guest",
    revision: 1,
    lastLocallyDurableRevision: 0,
    lastRemoteAcknowledgedRevision: null,
    serverVersion: null,
    etag: null,
    scene: codec.serialize(state),
    sourceBytes: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]),
    sourceReference: null,
    pageCount: state.document.pages.length,
    objectCount: state.document.pages.reduce((n, p) => n + Object.keys(p.objects).length, 0),
    now: 1_000,
    ...overrides,
  };
}

/** Commit, recover, and put the recovered scene back through the codec. */
async function commitAndRecover(state: EditorState, overrides: Partial<DraftCommitInput> = {}) {
  await repo.commit(commitInput(state, overrides));
  const loaded = await repo.loadBest(DOCUMENT_KEY);
  if (!loaded) throw new Error("the draft that was just committed did not load back");
  return { loaded, recovered: codec.deserialize(loaded.scene) };
}

describe("T12 local draft round trip", () => {
  it("recovers the same document, property for property", async () => {
    const before = liveState();
    const { recovered } = await commitAndRecover(before);
    // The whole assertion. Not the revision, not the object count: the document.
    expect(diffStates(before, recovered)).toEqual([]);
  });

  it("re-inlines externalised image and signature bytes, not the asset reference", async () => {
    const before = liveState();
    const { recovered, loaded } = await commitAndRecover(before);

    // The commit really did externalise them — otherwise this test proves
    // nothing about the re-inlining path it claims to cover. Read from the STORE,
    // not from the loaded draft: `loaded.scene` is the re-inlined one by design.
    const snapshotKey = store.keys().find((key) => key.includes("snapshot"))!;
    const stored = JSON.stringify(await store.get(snapshotKey));
    expect(stored).toContain('"src":"asset:');
    expect(loaded.generation).toBe(1);

    const image = recovered.document.pages[0].objects["image-1"] as { src: string };
    const signature = recovered.document.pages[0].objects["sig-1"] as { src: string };
    expect(image.src).toBe(bigPngDataUrl("A"));
    expect(signature.src).toBe(bigPngDataUrl("B"));
    expect(image.src.startsWith("asset:")).toBe(false);
    expect(signature.src.startsWith("asset:")).toBe(false);
  });

  it("stores one copy of an image used twice", async () => {
    // A performance guardrail with a fidelity consequence: duplicating the bytes
    // per object is how a draft outgrows its quota and stops being written at
    // all. Same `src` → same content hash → one asset record.
    const shared = bigPngDataUrl("C");
    const base = createEditorState("doc-dup", "page-1");
    const state: EditorState = {
      ...base,
      document: {
        ...base.document,
        pages: [
          pageOf("page-1", [
            makeImage({ id: "img-a", src: shared }),
            makeImage({ id: "img-b", src: shared }),
          ]),
        ],
      },
    };
    const result = await repo.commit(commitInput(state));
    // One image asset plus the source PDF.
    expect(result.assetsWritten).toBe(2);

    const loaded = await repo.loadBest(DOCUMENT_KEY);
    const recovered = codec.deserialize(loaded!.scene);
    expect((recovered.document.pages[0].objects["img-a"] as { src: string }).src).toBe(shared);
    expect((recovered.document.pages[0].objects["img-b"] as { src: string }).src).toBe(shared);
  });

  it("preserves the annotation panel through the local path", async () => {
    // Spelled out separately from the diff because this is the regression the
    // phase exists for, and the local path is where "Saved on this device"
    // promised a complete snapshot.
    const { recovered } = await commitAndRecover(liveState());
    const note = recovered.document.pages[0].objects["note-1"] as AnnotationObject;
    expect(note.kind).toBe("annotation");
    expect(note.text).toBe("this is note");
    expect(note.background).toEqual({ r: 1, g: 0.85, b: 0.2, a: 0.9 });
    expect(note.borderWidth).toBe(2);
    expect(note.cornerRadius).toBe(6);
  });

  it("preserves z-order, page order, rotation and source page index", async () => {
    const before = liveState();
    const { recovered } = await commitAndRecover(before);

    expect(paintOrder(recovered.document.pages[0].layerStack).map((e) => e.objectId)).toEqual(
      paintOrder(before.document.pages[0].layerStack).map((e) => e.objectId),
    );
    expect(recovered.document.pages.map((p) => p.id)).toEqual(["page-1", "page-2"]);
    expect(recovered.document.pages.map((p) => p.rotation)).toEqual([90, 270]);
    expect(recovered.document.pages.map((p) => p.sourcePageIndex)).toEqual([0, 1]);
    expect(recovered.activePageId).toBe("page-2");
  });

  it("recovers the same document after three commit generations", async () => {
    // Successive autosaves must not degrade the snapshot. Each generation is a
    // fresh serialize of a state that itself came out of the previous recovery,
    // which is what an editing session actually does.
    const original = liveState();
    let current = original;
    for (let revision = 1; revision <= 3; revision++) {
      const { recovered } = await commitAndRecover(current, {
        revision,
        lastLocallyDurableRevision: revision - 1,
        now: 1_000 * revision,
      });
      expect(diffStates(original, recovered), `drift at generation ${revision}`).toEqual([]);
      current = recovered;
    }
  });

  it("recovers the previous generation as the same document when the newest is corrupt", async () => {
    // The fallback path exists so a torn write costs one revision instead of the
    // draft. What it must not cost is fidelity: the older snapshot has to come
    // back as a whole document too, not as a partially-read one.
    const before = liveState();
    await repo.commit(commitInput(before, { revision: 1 }));
    await repo.commit(commitInput(before, { revision: 2, lastLocallyDurableRevision: 1, now: 2_000 }));

    const newest = store
      .keys()
      .filter((key) => key.includes("snapshot"))
      .sort()
      .at(-1)!;
    store.corrupt(newest, { schemaVersion: 1, torn: true });

    const loaded = await repo.loadBest(DOCUMENT_KEY);
    expect(loaded).not.toBeNull();
    expect(diffDocuments(before.document, codec.deserialize(loaded!.scene).document)).toEqual([]);
  });
});
