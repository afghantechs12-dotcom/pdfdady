/**
 * The draft envelope: what a stored draft claims, and what it must refuse to claim.
 *
 * Everything here is about one asymmetry. A draft that fails to load is a bad
 * afternoon; a draft that loads WRONG — silently missing an image, silently
 * dropping a field a newer build added, silently accepting half a snapshot an
 * aborted transaction left behind — is a document the user then keeps editing and
 * re-saving, and by the time anyone notices, the good copy is gone.
 *
 * So the assertions below are mostly negative: that a truncated manifest does not
 * validate, that a newer schema is refused rather than best-effort read, that a
 * missing asset comes back named instead of quietly nulled, and that a manifest
 * with no source bytes says so rather than presenting itself as complete.
 */

import { describe, expect, it } from "vitest";

import type { SerializedEditorState } from "../ports/ISerializer";
import {
  ASSET_INLINE_THRESHOLD,
  DRAFT_FORMAT,
  DRAFT_SCHEMA_VERSION,
  DraftError,
  assetHashFromReference,
  assetReference,
  buildDraftSnapshot,
  checksumBytes,
  checksumString,
  draftKeys,
  externaliseSceneAssets,
  guestDocumentKey,
  inlineSceneAssets,
  isAssetReference,
  manifestChecksum,
  migrateDraftManifest,
  parseSnapshotRecord,
  workspaceDocumentKey,
  type BuildDraftInput,
  type DraftManifest,
  type DraftMigration,
} from "./draftEnvelope";

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** A data URL long enough to be externalised, distinct per seed. */
function bigDataUrl(seed: string): string {
  return `data:image/png;base64,${seed.repeat(ASSET_INLINE_THRESHOLD)}`;
}

function scene(document: unknown): SerializedEditorState {
  return {
    format: "pdfdadi-editor",
    version: 6,
    document,
    activePageId: "page-1",
    selection: { objectIds: [] },
  };
}

function input(overrides: Partial<BuildDraftInput> = {}): BuildDraftInput {
  return {
    draftId: "draft-1",
    documentKey: guestDocumentKey("abc"),
    documentId: null,
    workspaceId: null,
    organizationId: null,
    documentName: "Quarterly report.pdf",
    origin: "guest",
    generation: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    revision: 7,
    lastLocallyDurableRevision: 7,
    lastRemoteAcknowledgedRevision: null,
    serverVersion: null,
    etag: null,
    scene: scene({ pages: [{ id: "page-1", objects: [] }] }),
    sourceBytes: new Uint8Array([37, 80, 68, 70]),
    sourceReference: null,
    pageCount: 1,
    objectCount: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */

describe("checksums", () => {
  it("is stable for identical input", () => {
    expect(checksumString("the quick brown fox")).toBe(checksumString("the quick brown fox"));
    expect(checksumBytes(new Uint8Array([1, 2, 3]))).toBe(checksumBytes(new Uint8Array([1, 2, 3])));
  });

  it("changes when a single character changes", () => {
    expect(checksumString("revision 10")).not.toBe(checksumString("revision 11"));
  });

  it("distinguishes a truncated value from its full form", () => {
    // The length mix-in exists for exactly this: an autosave interrupted halfway
    // leaves a prefix, and a prefix must not validate as the whole.
    const full = JSON.stringify({ a: 1, b: 2, c: 3 });
    expect(checksumString(full.slice(0, full.length - 4))).not.toBe(checksumString(full));
  });

  it("distinguishes transposed content of the same length", () => {
    expect(checksumString("ab")).not.toBe(checksumString("ba"));
    expect(checksumBytes(new Uint8Array([1, 2]))).not.toBe(checksumBytes(new Uint8Array([2, 1])));
  });

  it("produces a fixed-width hex digest", () => {
    expect(checksumString("")).toMatch(/^[0-9a-f]{16}$/);
    expect(checksumString("x".repeat(5_000))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("asset references", () => {
  it("round-trips a hash through a reference", () => {
    const ref = assetReference("deadbeefdeadbeef");
    expect(isAssetReference(ref)).toBe(true);
    expect(assetHashFromReference(ref)).toBe("deadbeefdeadbeef");
  });

  it("does not mistake a data URL for a reference", () => {
    expect(isAssetReference("data:image/png;base64,AAAA")).toBe(false);
    expect(assetHashFromReference("data:image/png;base64,AAAA")).toBeNull();
  });
});

describe("externalising assets", () => {
  it("pulls a large image src out and leaves a reference behind", () => {
    const src = bigDataUrl("a");
    const result = externaliseSceneAssets(
      scene({ pages: [{ id: "page-1", objects: [{ id: "img-1", kind: "image", src, x: 10 }] }] }),
    );

    expect(result.assets).toHaveLength(1);
    const asset = result.assets[0]!;
    expect(asset.role).toBe("image");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.objectId).toBe("img-1");
    expect(asset.data).toBe(src);

    const object = (result.scene.document as { pages: { objects: { src: string; x: number }[] }[] })
      .pages[0]!.objects[0]!;
    expect(object.src).toBe(assetReference(asset.hash));
    // Everything that is not the payload survives untouched.
    expect(object.x).toBe(10);
  });

  it("leaves a small src inline", () => {
    const src = "data:image/svg+xml,<svg/>";
    const result = externaliseSceneAssets(
      scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] }),
    );
    expect(result.assets).toHaveLength(0);
    expect(
      (result.scene.document as { pages: { objects: { src: string }[] }[] }).pages[0]!.objects[0]!
        .src,
    ).toBe(src);
  });

  it("stores one asset when two objects share the same bytes", () => {
    const src = bigDataUrl("b");
    const result = externaliseSceneAssets(
      scene({
        pages: [
          {
            objects: [
              { id: "i1", kind: "image", src },
              { id: "i2", kind: "signature", src },
            ],
          },
        ],
      }),
    );
    // Content-addressed: the same bytes are the same asset, which is the whole
    // reason a repeated logo does not multiply the draft's size.
    expect(result.assets).toHaveLength(1);
  });

  it("externalises a signature as a signature", () => {
    const result = externaliseSceneAssets(
      scene({ pages: [{ objects: [{ id: "s", kind: "signature", src: bigDataUrl("c") }] }] }),
    );
    expect(result.assets[0]!.role).toBe("signature");
  });

  it("does not touch a large src on a kind it does not recognise", () => {
    const src = bigDataUrl("d");
    const result = externaliseSceneAssets(
      scene({ pages: [{ objects: [{ id: "p", kind: "plugin:chart", src }] }] }),
    );
    // A plugin payload is data, not something this module is entitled to rewrite.
    expect(result.assets).toHaveLength(0);
    expect(
      (result.scene.document as { pages: { objects: { src: string }[] }[] }).pages[0]!.objects[0]!
        .src,
    ).toBe(src);
  });

  it("does not re-externalise an already externalised reference", () => {
    const already = assetReference("a".repeat(16)) + "x".repeat(ASSET_INLINE_THRESHOLD);
    const result = externaliseSceneAssets(
      scene({ pages: [{ objects: [{ id: "i", kind: "image", src: already }] }] }),
    );
    expect(result.assets).toHaveLength(0);
  });

  it("does not mutate the scene it was given", () => {
    const original = scene({
      pages: [{ objects: [{ id: "i", kind: "image", src: bigDataUrl("e") }] }],
    });
    const before = JSON.stringify(original);
    externaliseSceneAssets(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("round-trips through inlining", () => {
    const src = bigDataUrl("f");
    const out = externaliseSceneAssets(
      scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] }),
    );
    const back = inlineSceneAssets(
      out.scene,
      new Map(out.assets.map((a) => [a.hash, a.data])),
    );
    expect(back.missing).toEqual([]);
    expect(
      (back.scene.document as { pages: { objects: { src: string }[] }[] }).pages[0]!.objects[0]!.src,
    ).toBe(src);
  });
});

describe("inlining a draft whose assets did not all survive", () => {
  it("names the missing hash instead of restoring silently", () => {
    const src = bigDataUrl("g");
    const out = externaliseSceneAssets(
      scene({
        pages: [
          {
            objects: [
              { id: "i1", kind: "image", src },
              { id: "t1", kind: "text", text: "still here" },
            ],
          },
        ],
      }),
    );
    const hash = out.assets[0]!.hash;

    const back = inlineSceneAssets(out.scene, new Map());

    expect(back.missing).toEqual([hash]);
    const objects = (
      back.scene.document as { pages: { objects: { id: string; src?: string; text?: string }[] }[] }
    ).pages[0]!.objects;
    // The rest of the document is still worth restoring, and the image object
    // keeps its identity and geometry so the gap is visible and explainable.
    expect(objects[1]!.text).toBe("still here");
    expect(objects[0]!.id).toBe("i1");
    expect(objects[0]!.src).toBe(assetReference(hash));
  });

  it("reports each distinct missing hash once", () => {
    const a = bigDataUrl("h");
    const b = bigDataUrl("i");
    const out = externaliseSceneAssets(
      scene({
        pages: [
          {
            objects: [
              { id: "1", kind: "image", src: a },
              { id: "2", kind: "image", src: a },
              { id: "3", kind: "image", src: b },
            ],
          },
        ],
      }),
    );
    const back = inlineSceneAssets(out.scene, new Map());
    expect(back.missing).toHaveLength(2);
    expect(new Set(back.missing).size).toBe(2);
  });

  it("treats a byte-valued asset as unusable for an inline src rather than coercing it", () => {
    const out = externaliseSceneAssets(
      scene({ pages: [{ objects: [{ id: "i", kind: "image", src: bigDataUrl("j") }] }] }),
    );
    const hash = out.assets[0]!.hash;
    // A source-pdf-shaped binary stored under an image's hash is a store bug, and
    // "[object Uint8Array]" as an <img src> is worse than a reported gap.
    const back = inlineSceneAssets(out.scene, new Map([[hash, new Uint8Array([1, 2, 3])]]));
    expect(back.missing).toEqual([hash]);
  });
});

describe("building a snapshot", () => {
  it("captures the identity, revision and remote bookkeeping it was given", () => {
    const { record } = buildDraftSnapshot(
      input({
        origin: "workspace",
        documentId: "doc-9",
        workspaceId: "ws-1",
        organizationId: "org-1",
        documentKey: workspaceDocumentKey("ws-1", "doc-9"),
        revision: 12,
        lastLocallyDurableRevision: 11,
        lastRemoteAcknowledgedRevision: 9,
        serverVersion: 4,
        etag: "etag-4",
      }),
    );
    const m = record.manifest;
    expect(m.format).toBe(DRAFT_FORMAT);
    expect(m.schemaVersion).toBe(DRAFT_SCHEMA_VERSION);
    expect(m.documentKey).toBe("ws:ws-1:doc-9");
    expect(m.revision).toBe(12);
    expect(m.lastLocallyDurableRevision).toBe(11);
    expect(m.lastRemoteAcknowledgedRevision).toBe(9);
    expect(m.serverVersion).toBe(4);
    expect(m.etag).toBe("etag-4");
  });

  it("validates against its own checksum", () => {
    const { record } = buildDraftSnapshot(input());
    expect(parseSnapshotRecord(record)).toEqual(record);
  });

  it("returns the source PDF as an asset and references it from the manifest", () => {
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49]);
    const { record, assets } = buildDraftSnapshot(input({ sourceBytes: bytes }));
    expect(record.manifest.sourcePdf).not.toBeNull();
    expect(record.manifest.sourcePdf!.role).toBe("source-pdf");
    expect(record.manifest.sourcePdf!.byteLength).toBe(bytes.byteLength);
    expect(record.manifest.metadata.sourceByteLength).toBe(bytes.byteLength);
    expect(record.manifest.sourceReference).toBeNull();
    const stored = assets.find((a) => a.role === "source-pdf");
    expect(stored).toBeDefined();
    expect(checksumBytes(stored!.data as Uint8Array)).toBe(record.manifest.sourcePdf!.hash);
  });

  it("copies the source bytes rather than persisting a view over a larger buffer", () => {
    const backing = new Uint8Array(1024);
    backing.set([37, 80, 68, 70], 512);
    const view = backing.subarray(512, 516);

    const { assets } = buildDraftSnapshot(input({ sourceBytes: view }));
    const stored = assets.find((a) => a.role === "source-pdf")!.data as Uint8Array;

    expect(stored.byteLength).toBe(4);
    // A view would carry the whole 1 KiB backing buffer into the store, and a
    // later mutation of that buffer would rewrite an already-"durable" draft.
    expect(stored.buffer.byteLength).toBe(4);
    backing[512] = 0;
    expect(stored[0]).toBe(37);
  });

  it("admits when the original bytes were not available", () => {
    const { record, assets } = buildDraftSnapshot(
      input({ sourceBytes: null, sourceReference: "opened from a workspace document" }),
    );
    // The alternative — a manifest with no sourcePdf and no explanation — is a
    // draft that recovers into blank pages while calling itself complete.
    expect(record.manifest.sourcePdf).toBeNull();
    expect(record.manifest.sourceReference).toBe("opened from a workspace document");
    expect(record.manifest.metadata.sourceByteLength).toBeNull();
    expect(assets.some((a) => a.role === "source-pdf")).toBe(false);
  });

  it("never leaves the missing-source reason blank", () => {
    const { record } = buildDraftSnapshot(input({ sourceBytes: null, sourceReference: null }));
    expect(record.manifest.sourceReference).toBe("unknown");
  });

  it("treats zero-length source bytes as no source at all", () => {
    const { record } = buildDraftSnapshot(
      input({ sourceBytes: new Uint8Array(0), sourceReference: "empty" }),
    );
    expect(record.manifest.sourcePdf).toBeNull();
  });

  it("counts every asset's bytes, source PDF included, for quota accounting", () => {
    const src = bigDataUrl("k");
    const { record, assets } = buildDraftSnapshot(
      input({
        sourceBytes: new Uint8Array(64),
        scene: scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] }),
      }),
    );
    expect(record.manifest.metadata.assetByteLength).toBe(64 + src.length);
    expect(assets).toHaveLength(2);
  });

  it("stores the scene with references, not with the image payload", () => {
    const src = bigDataUrl("l");
    const { record } = buildDraftSnapshot(
      input({ scene: scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] }) }),
    );
    const serialized = JSON.stringify(record.manifest.scene);
    expect(serialized).not.toContain(src);
    expect(record.manifest.assets).toHaveLength(1);
  });

  it("carries page operations, crop, drawing paths and fonts inside the scene", () => {
    // These are requirement-listed as separate draft content, and they are stored
    // by construction rather than duplicated into parallel manifest fields —
    // two sources of truth for a crop rectangle is two rectangles that disagree.
    const document = {
      pages: [
        { id: "p2", sourcePageIndex: 1, rotation: 90 },
        { id: "p1", sourcePageIndex: 0, rotation: 0 },
      ],
      objects: [
        { id: "i", kind: "image", src: "data:,x", crop: { x: 1, y: 2, width: 3, height: 4 } },
        { id: "d", kind: "drawing", points: [[0, 0], [5, 5]] },
        { id: "t", kind: "text", fontFamily: "Helvetica", fontSize: 12 },
      ],
    };
    const { record } = buildDraftSnapshot(input({ scene: scene(document) }));
    expect(record.manifest.scene.document).toEqual(document);
  });

  it("does not invent a raster page background", () => {
    // Page rasters are regenerable from the source bytes, and storing them is how
    // a 2 MB draft becomes a 60 MB one and then a quota failure.
    const { record } = buildDraftSnapshot(input());
    const keys = Object.keys(record.manifest);
    expect(keys).not.toContain("pageImages");
    expect(keys).not.toContain("thumbnails");
    expect(record.manifest.assets.every((a) => a.role !== "source-pdf")).toBe(true);
  });
});

describe("parsing a record read back out of the store", () => {
  function stored(): DraftSnapshotShape {
    return JSON.parse(JSON.stringify(buildDraftSnapshot(input()).record)) as DraftSnapshotShape;
  }
  type DraftSnapshotShape = { manifest: DraftManifest; checksum: string };

  it("accepts a record that came back intact", () => {
    expect(() => parseSnapshotRecord(stored())).not.toThrow();
  });

  it("rejects a non-object", () => {
    for (const value of [null, undefined, 42, "draft", true]) {
      expect(() => parseSnapshotRecord(value)).toThrow(DraftError);
    }
    expect(() => parseSnapshotRecord(null)).toThrow(/not an object/i);
  });

  it("rejects a record with no manifest or no checksum", () => {
    expect(() => parseSnapshotRecord({ checksum: "abc" })).toThrow(/manifest or checksum/i);
    expect(() => parseSnapshotRecord({ manifest: stored().manifest })).toThrow(
      /manifest or checksum/i,
    );
  });

  it("rejects something that is not a PDFDadi draft", () => {
    const record = stored();
    (record.manifest as unknown as { format: string }).format = "some-other-app";
    expect(() => parseSnapshotRecord(record)).toThrow(/not a PDFDadi draft/i);
  });

  it("categorises a corrupt record as corrupt_snapshot, so the previous generation can be tried", () => {
    const record = stored();
    delete (record.manifest as Partial<DraftManifest>).schemaVersion;
    try {
      parseSnapshotRecord(record);
      expect.unreachable("a manifest with no schema version must not parse");
    } catch (error) {
      expect(error).toBeInstanceOf(DraftError);
      expect((error as DraftError).category).toBe("corrupt_snapshot");
    }
  });

  it("refuses a draft written by a newer build rather than reading it best-effort", () => {
    const record = stored();
    record.manifest.schemaVersion = DRAFT_SCHEMA_VERSION + 1;
    record.checksum = manifestChecksum(record.manifest);
    try {
      parseSnapshotRecord(record);
      expect.unreachable("a newer schema must not parse");
    } catch (error) {
      expect((error as DraftError).category).toBe("unsupported_schema");
      // Not `corrupt_snapshot`: the bytes are fine and must be left alone for the
      // build that can read them.
      expect((error as DraftError).message).toMatch(/newer version/i);
    }
  });

  it("rejects a manifest missing its identity", () => {
    for (const field of ["draftId", "documentKey", "documentName"] as const) {
      const record = stored();
      record.manifest[field] = "";
      record.checksum = manifestChecksum(record.manifest);
      expect(() => parseSnapshotRecord(record)).toThrow(new RegExp(`no ${field}`, "i"));
    }
  });

  it("rejects a manifest with no revision or no content", () => {
    const noRevision = stored();
    delete (noRevision.manifest as Partial<DraftManifest>).revision;
    expect(() => parseSnapshotRecord(noRevision)).toThrow(/no revision/i);

    const noScene = stored();
    (noScene.manifest as unknown as { scene: unknown }).scene = null;
    expect(() => parseSnapshotRecord(noScene)).toThrow(/no document content/i);
  });

  it("rejects a manifest whose content was altered after it was checksummed", () => {
    const record = stored();
    record.manifest.revision = 999;
    try {
      parseSnapshotRecord(record);
      expect.unreachable("an altered manifest must not parse");
    } catch (error) {
      expect((error as DraftError).category).toBe("integrity_failed");
      expect((error as DraftError).message).toMatch(/incomplete/i);
    }
  });

  it("rejects a record whose checksum did not survive the write", () => {
    const record = stored();
    record.checksum = "0000000000000000";
    expect(() => parseSnapshotRecord(record)).toThrow(/checksum/i);
  });

  it("survives the structured-clone round trip a real store performs", () => {
    const built = buildDraftSnapshot(input()).record;
    const cloned = structuredClone(built);
    expect(() => parseSnapshotRecord(cloned)).not.toThrow();
  });
});

describe("migration", () => {
  function manifestAt(version: number): DraftManifest {
    const m = buildDraftSnapshot(input()).record.manifest;
    return { ...m, schemaVersion: version };
  }

  it("does nothing when the draft is already current", () => {
    const m = manifestAt(3);
    const outcome = migrateDraftManifest(m, 3, new Map());
    expect(outcome.manifest).toBe(m);
    expect(outcome.migratedFrom).toBeNull();
  });

  it("runs one step at a time and reports where it started", () => {
    const seen: number[] = [];
    const step: DraftMigration = (m) => {
      seen.push(m.schemaVersion);
      return { ...m, schemaVersion: m.schemaVersion + 1 };
    };
    const registry = new Map([
      [1, step],
      [2, step],
      [3, step],
    ]);
    const outcome = migrateDraftManifest(manifestAt(1), 4, registry);
    expect(seen).toEqual([1, 2, 3]);
    expect(outcome.manifest.schemaVersion).toBe(4);
    expect(outcome.migratedFrom).toBe(1);
  });

  it("carries the migrated content forward", () => {
    const registry = new Map<number, DraftMigration>([
      [1, (m) => ({ ...m, schemaVersion: 2, documentName: `${m.documentName} (upgraded)` })],
    ]);
    const outcome = migrateDraftManifest(manifestAt(1), 2, registry);
    expect(outcome.manifest.documentName).toBe("Quarterly report.pdf (upgraded)");
  });

  it("refuses to downgrade a draft from a newer build", () => {
    try {
      migrateDraftManifest(manifestAt(5), 2, new Map());
      expect.unreachable("a newer draft must not be migrated backwards");
    } catch (error) {
      expect((error as DraftError).category).toBe("unsupported_schema");
    }
  });

  it("reports a missing step as unsupported rather than guessing", () => {
    try {
      migrateDraftManifest(manifestAt(1), 3, new Map());
      expect.unreachable("a gap in the chain must not be papered over");
    } catch (error) {
      expect((error as DraftError).category).toBe("unsupported_schema");
      expect((error as DraftError).message).toMatch(/no migration path/i);
    }
  });

  it("reports a throwing migration as migration_failed, not as a corrupt draft", () => {
    const registry = new Map<number, DraftMigration>([
      [
        1,
        () => {
          throw new Error("field moved");
        },
      ],
    ]);
    try {
      migrateDraftManifest(manifestAt(1), 2, registry);
      expect.unreachable("a throwing migration must surface");
    } catch (error) {
      // The distinction is what protects the stored bytes: `corrupt_snapshot`
      // invites overwriting the only copy a future build could have read.
      expect((error as DraftError).category).toBe("migration_failed");
      expect((error as DraftError).message).toMatch(/field moved/);
    }
  });

  it("does not spin forever on a migration that fails to advance", () => {
    const registry = new Map<number, DraftMigration>([[1, (m) => ({ ...m, schemaVersion: 1 })]]);
    try {
      migrateDraftManifest(manifestAt(1), 3, registry);
      expect.unreachable("a non-advancing migration must be caught");
    } catch (error) {
      expect((error as DraftError).category).toBe("migration_failed");
      expect((error as DraftError).message).toMatch(/did not advance/i);
    }
  });

  it("does not consult a registry the caller did not pass", () => {
    // Injectable for a reason: a module-level registry lets one test's migration
    // make a later test pass for the wrong reason.
    expect(() => migrateDraftManifest(manifestAt(1), 2, new Map())).toThrow(/no migration path/i);
  });
});

describe("keys", () => {
  it("separates guest and workspace documents", () => {
    expect(guestDocumentKey("abc")).toBe("guest:abc");
    expect(workspaceDocumentKey("ws-1", "doc-1")).toBe("ws:ws-1:doc-1");
    expect(guestDocumentKey("ws-1:doc-1")).not.toBe(workspaceDocumentKey("ws-1", "doc-1"));
  });

  it("gives every generation of a draft its own snapshot key", () => {
    expect(draftKeys.snapshot("d1", 1)).not.toBe(draftKeys.snapshot("d1", 2));
    // The newly written generation must be invisible until the pointer moves,
    // which is only true if it never lands on the live key.
    expect(draftKeys.snapshot("d1", 2).startsWith(draftKeys.snapshotPrefix("d1"))).toBe(true);
  });

  it("namespaces record types so one store can hold them all", () => {
    const keys = [
      draftKeys.snapshot("d1", 1),
      draftKeys.asset("h1"),
      draftKeys.pointer("d1"),
      draftKeys.index("guest:abc"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(draftKeys.index("guest:abc").startsWith(draftKeys.indexPrefix)).toBe(true);
    expect(draftKeys.pointer("d1").startsWith(draftKeys.indexPrefix)).toBe(false);
  });

  it("does not let one draft's snapshot prefix scan reach another's", () => {
    expect(draftKeys.snapshot("d10", 1).startsWith(draftKeys.snapshotPrefix("d1"))).toBe(false);
  });
});
