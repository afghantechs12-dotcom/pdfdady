/**
 * The draft repository: whether one known-good snapshot survives every failure.
 *
 * The obvious implementation of "autosave locally" is to overwrite the draft in
 * place. It works until the write is interrupted — a tab crash, an OOM kill, a
 * closed laptop, storage eviction mid-transaction — and then the only copy of the
 * user's work is half old and half new, which loads into a document they never
 * had. Every assertion below is about the alternative: nothing is observable until
 * a pointer moves, and nothing is deleted until its replacement has been read back.
 *
 * The tests are ordered by what they protect: the commit sequence, then what a
 * commit is allowed to claim, then what happens when each step fails, then what
 * recovery is allowed to say about a draft it could only partly reconstruct.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { SerializedEditorState } from "../ports/ISerializer";
import {
  ASSET_INLINE_THRESHOLD,
  DRAFT_SCHEMA_VERSION,
  DraftError,
  assetReference,
  checksumString,
  draftKeys,
  guestDocumentKey,
  manifestChecksum,
  workspaceDocumentKey,
  type DraftManifest,
  type DraftMigration,
  type DraftPointerRecord,
} from "./draftEnvelope";
import { DraftRepository, type DraftCommitInput } from "./draftRepository";
import { persistenceFailure } from "./events";
import { MemoryKeyValueStore, quotaError } from "./testing/memoryKeyValueStore";

const KEY = guestDocumentKey("abc");

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

function commitInput(overrides: Partial<DraftCommitInput> = {}): DraftCommitInput {
  return {
    draftId: "draft-1",
    documentKey: KEY,
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
    scene: scene({ pages: [{ id: "page-1", objects: [] }] }),
    sourceBytes: new Uint8Array([37, 80, 68, 70]),
    sourceReference: null,
    pageCount: 1,
    objectCount: 0,
    now: 1_000,
    ...overrides,
  };
}

let store: MemoryKeyValueStore;
let repo: DraftRepository;

beforeEach(() => {
  store = new MemoryKeyValueStore();
  repo = new DraftRepository(store);
});

async function pointer(draftId = "draft-1"): Promise<DraftPointerRecord | undefined> {
  return (await store.get(draftKeys.pointer(draftId))) as DraftPointerRecord | undefined;
}

/** The operation log with the read-only noise removed, for sequence assertions. */
function writeSequence(): Array<{ op: string; keys: string[] }> {
  return store.log.filter((entry) => entry.op === "put" || entry.op === "delete");
}

/* ------------------------------------------------------------------ */

describe("the commit sequence", () => {
  it("writes assets, then the snapshot, then the pointer and index together", async () => {
    await repo.commit(
      commitInput({
        scene: scene({ pages: [{ objects: [{ id: "i", kind: "image", src: bigDataUrl("a") }] }] }),
      }),
    );

    const puts = writeSequence().filter((entry) => entry.op === "put");
    expect(puts).toHaveLength(3);
    expect(puts[0]!.keys.every((key) => key.startsWith("asset:"))).toBe(true);
    expect(puts[1]!.keys).toEqual([draftKeys.snapshot("draft-1", 1)]);
    // Pointer and index in ONE transaction. A pointer that advanced without its
    // index entry leaves a draft that loads but cannot be found; the reverse
    // advertises a draft that cannot be loaded.
    expect(puts[2]!.keys).toEqual([draftKeys.pointer("draft-1"), draftKeys.index(KEY)]);
  });

  it("reads the snapshot back before promoting it", async () => {
    await repo.commit(commitInput());

    const snapshotKey = draftKeys.snapshot("draft-1", 1);
    const ops = store.log.map((entry) => `${entry.op}:${entry.keys.join(",")}`);
    const written = ops.indexOf(`put:${snapshotKey}`);
    const readBack = ops.indexOf(`get:${snapshotKey}`, written);
    const promoted = ops.findIndex((op) => op.startsWith(`put:${draftKeys.pointer("draft-1")}`));

    expect(written).toBeGreaterThanOrEqual(0);
    // A write that "succeeded" is not a write that can be read: IndexedDB reports
    // success for transactions the browser later evicts.
    expect(readBack).toBeGreaterThan(written);
    expect(promoted).toBeGreaterThan(readBack);
  });

  it("writes each new generation under its own key, never over the live one", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));

    expect(store.has(draftKeys.snapshot("draft-1", 1))).toBe(true);
    expect(store.has(draftKeys.snapshot("draft-1", 2))).toBe(true);
    const p = await pointer();
    expect(p!.activeGeneration).toBe(2);
    expect(p!.previousGeneration).toBe(1);
  });

  it("prunes only after the pointer has moved", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    store.log.length = 0;
    const result = await repo.commit(commitInput({ revision: 3, now: 3_000 }));

    const sequence = writeSequence();
    const promoted = sequence.findIndex(
      (entry) => entry.op === "put" && entry.keys[0] === draftKeys.pointer("draft-1"),
    );
    const deleted = sequence.findIndex((entry) => entry.op === "delete");
    expect(promoted).toBeGreaterThanOrEqual(0);
    // Deleting the prior snapshot before its replacement is durable trades a good
    // draft for a hoped-for one.
    expect(deleted).toBeGreaterThan(promoted);
    expect(result.generationsPruned).toBe(1);
    expect(store.has(draftKeys.snapshot("draft-1", 1))).toBe(false);
  });

  it("keeps exactly two generations across a long editing session", async () => {
    for (let revision = 1; revision <= 6; revision += 1) {
      await repo.commit(commitInput({ revision, now: revision * 1_000 }));
    }
    const snapshots = await store.keysWithPrefix(draftKeys.snapshotPrefix("draft-1"));
    expect(snapshots).toEqual([draftKeys.snapshot("draft-1", 5), draftKeys.snapshot("draft-1", 6)]);
  });

  it("writes a shared asset once across generations", async () => {
    const src = bigDataUrl("b");
    const withImage = scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] });
    const first = await repo.commit(commitInput({ revision: 1, scene: withImage }));
    const second = await repo.commit(commitInput({ revision: 2, scene: withImage, now: 2_000 }));

    // Content-addressed assets are the reason a 40 MB scan does not get rewritten
    // on every keystroke.
    expect(first.assetsWritten).toBe(2);
    expect(second.assetsWritten).toBe(0);
  });

  it("keeps createdAt stable while updatedAt advances", async () => {
    await repo.commit(commitInput({ revision: 1, now: 1_000 }));
    await repo.commit(commitInput({ revision: 2, now: 5_000 }));
    const record = (await store.get(draftKeys.snapshot("draft-1", 2))) as { manifest: DraftManifest };
    expect(record.manifest.createdAt).toBe(1_000);
    expect(record.manifest.updatedAt).toBe(5_000);
  });
});

describe("what a commit is allowed to claim", () => {
  it("refuses outright when the store is unavailable", async () => {
    store.setAvailable(false);
    await expect(repo.commit(commitInput())).rejects.toThrow(DraftError);
    await expect(repo.commit(commitInput())).rejects.toThrow(/will not let PDFDadi store/i);
    expect(store.size).toBe(0);
  });

  it("categorises an unavailable store as storage_unavailable, not as a failed write", async () => {
    store.setAvailable(false);
    try {
      await repo.commit(commitInput());
      expect.unreachable("an unavailable store must not report a commit");
    } catch (error) {
      // Not retryable, and the difference decides whether the UI offers a Retry
      // button or tells the user to export.
      expect((error as DraftError).category).toBe("storage_unavailable");
    }
  });

  it("reports the revision and generation it actually wrote", async () => {
    const result = await repo.commit(commitInput({ revision: 9 }));
    expect(result).toMatchObject({
      draftId: "draft-1",
      generation: 1,
      previousGeneration: null,
      revision: 9,
    });
  });

  it("records the draft in the index so it can be found without loading it", async () => {
    await repo.commit(
      commitInput({
        origin: "workspace",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentKey: workspaceDocumentKey("ws-1", "doc-1"),
        revision: 4,
        now: 7_000,
      }),
    );
    const drafts = await repo.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      documentKey: "ws:ws-1:doc-1",
      draftId: "draft-1",
      documentId: "doc-1",
      origin: "workspace",
      revision: 4,
      updatedAt: 7_000,
      schemaVersion: DRAFT_SCHEMA_VERSION,
    });
  });

  it("lists drafts newest first", async () => {
    await repo.commit(commitInput({ draftId: "d1", documentKey: "guest:one", now: 1_000 }));
    await repo.commit(commitInput({ draftId: "d3", documentKey: "guest:three", now: 3_000 }));
    await repo.commit(commitInput({ draftId: "d2", documentKey: "guest:two", now: 2_000 }));
    expect((await repo.listDrafts()).map((d) => d.draftId)).toEqual(["d3", "d2", "d1"]);
  });

  it("lists nothing rather than throwing when the store is unavailable", async () => {
    store.setAvailable(false);
    expect(await repo.listDrafts()).toEqual([]);
    expect(await repo.loadBest(KEY)).toBeNull();
  });

  it("ignores an index entry that is not an index record", async () => {
    await repo.commit(commitInput());
    store.corrupt(draftKeys.index("guest:junk"), { nonsense: true });
    expect((await repo.listDrafts()).map((d) => d.draftId)).toEqual(["draft-1"]);
  });
});

describe("a commit that fails partway", () => {
  it("leaves the previous draft live when the snapshot write fails", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    store.injectFault({
      operation: "put",
      failure: persistenceFailure("transaction_aborted", "aborted"),
      times: Number.POSITIVE_INFINITY,
      match: (key) => key.startsWith("snapshot:"),
    });

    await expect(repo.commit(commitInput({ revision: 2, now: 2_000 }))).rejects.toThrow();

    const p = await pointer();
    expect(p!.activeGeneration).toBe(1);
    expect(p!.revision).toBe(1);
    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.revision).toBe(1);
    expect(loaded!.descriptor.fellBackToPreviousSnapshot).toBe(false);
  });

  it("does not promote a snapshot that will not read back", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    // Written, reported successful, then evicted — exactly what step 4 exists for.
    store.injectFault({
      operation: "get",
      failure: persistenceFailure("transaction_aborted", "read failed"),
      times: 1,
      match: (key) => key === draftKeys.snapshot("draft-1", 2),
    });

    await expect(repo.commit(commitInput({ revision: 2, now: 2_000 }))).rejects.toThrow();
    expect((await pointer())!.activeGeneration).toBe(1);
  });

  it("reports integrity_failed when the snapshot vanished between write and read", async () => {
    let evicted = false;
    const evicting = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "get") {
          return async (key: string) => {
            if (!evicted && key === draftKeys.snapshot("draft-1", 1)) {
              evicted = true;
              target.evict(key);
            }
            return target.get(key);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const evictingRepo = new DraftRepository(evicting as MemoryKeyValueStore);
    try {
      await evictingRepo.commit(commitInput());
      expect.unreachable("a snapshot that vanished must not be promoted");
    } catch (error) {
      expect((error as DraftError).category).toBe("integrity_failed");
      expect((error as DraftError).message).toMatch(/not made active/i);
    }
    expect(await pointer()).toBeUndefined();
  });

  it("does not promote a snapshot whose asset did not land", async () => {
    const src = bigDataUrl("c");
    const withImage = scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] });
    const hash = checksumString(src);

    let dropped = false;
    const dropping = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "getMany") {
          return async (keys: readonly string[]) => {
            if (!dropped && keys.includes(draftKeys.asset(hash)) && target.has(draftKeys.asset(hash))) {
              dropped = true;
              target.evict(draftKeys.asset(hash));
            }
            return target.getMany(keys);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const droppingRepo = new DraftRepository(dropping as MemoryKeyValueStore);
    try {
      await droppingRepo.commit(commitInput({ scene: withImage }));
      expect.unreachable("a snapshot missing its image data must not be promoted");
    } catch (error) {
      // A promoted snapshot whose image is absent is a document that recovers with
      // a hole in it while calling itself complete.
      expect((error as DraftError).category).toBe("missing_asset");
    }
    expect(await pointer()).toBeUndefined();
  });

  it("frees space and retries exactly once on a quota failure", async () => {
    await repo.commit(commitInput({ draftId: "other", documentKey: "guest:other", revision: 1 }));
    await repo.commit(
      commitInput({ draftId: "other", documentKey: "guest:other", revision: 2, now: 2_000 }),
    );
    expect((await pointer("other"))!.previousGeneration).toBe(1);

    let failed = false;
    const tight = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "putAll") {
          return async (entries: readonly { key: string; value: unknown }[]) => {
            if (!failed && entries.some((entry) => entry.key.startsWith("snapshot:draft-1:"))) {
              failed = true;
              throw quotaError();
            }
            return target.putAll(entries);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const result = await new DraftRepository(tight as MemoryKeyValueStore).commit(commitInput());

    expect(result.generation).toBe(1);
    // Another document's second-newest backup is a lower priority than this
    // document's ability to save at all — but its live generation is untouched.
    expect((await pointer("other"))!.previousGeneration).toBeNull();
    expect(store.has(draftKeys.snapshot("other", 2))).toBe(true);
    expect(store.has(draftKeys.snapshot("other", 1))).toBe(false);
  });

  it("gives an actionable message when the retry is also out of space", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    store.injectFault({
      operation: "put",
      failure: persistenceFailure("quota_exceeded", "full"),
      times: Number.POSITIVE_INFINITY,
      match: (key) => key.startsWith("snapshot:"),
    });

    try {
      await repo.commit(commitInput({ revision: 2, now: 2_000 }));
      expect.unreachable("a full store must not report a commit");
    } catch (error) {
      expect((error as DraftError).category).toBe("quota_exceeded");
      expect((error as DraftError).message).toMatch(/out of storage space/i);
      // The only two things the user can actually do.
      expect((error as DraftError).message).toMatch(/free up space/i);
      expect((error as DraftError).message).toMatch(/export/i);
    }
    // And the draft they already had is still there.
    expect((await pointer())!.revision).toBe(1);
  });

  it("does not retry a non-quota failure", async () => {
    store.injectFault({
      operation: "put",
      failure: persistenceFailure("transaction_aborted", "aborted"),
      times: 1,
      match: (key) => key.startsWith("snapshot:"),
    });
    // One fault, one attempt: a second attempt would consume it and succeed,
    // which would hide the failure the caller has to hear about.
    await expect(repo.commit(commitInput())).rejects.toThrow(/aborted/i);
    expect(await pointer()).toBeUndefined();
  });
});

describe("loading the best available draft", () => {
  it("finds nothing when nothing was ever committed", async () => {
    expect(await repo.loadBest(KEY)).toBeNull();
    expect(await repo.loadBest("guest:never-seen")).toBeNull();
  });

  it("restores the scene, the source bytes and the revision", async () => {
    const src = bigDataUrl("d");
    const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]);
    await repo.commit(
      commitInput({
        revision: 11,
        sourceBytes: bytes,
        scene: scene({
          pages: [{ id: "page-1", objects: [{ id: "i", kind: "image", src, x: 3 }] }],
        }),
        now: 4_000,
      }),
    );

    const loaded = await repo.loadBest(KEY);
    expect(loaded).not.toBeNull();
    expect(loaded!.descriptor.revision).toBe(11);
    expect(loaded!.descriptor.updatedAt).toBe(4_000);
    expect(loaded!.descriptor.missingAssets).toEqual([]);
    expect(loaded!.descriptor.migratedFrom).toBeNull();
    expect(loaded!.sourceBytes).toEqual(bytes);
    const object = (
      loaded!.scene.document as { pages: { objects: { src: string; x: number }[] }[] }
    ).pages[0]!.objects[0]!;
    expect(object.src).toBe(src);
    expect(object.x).toBe(3);
  });

  it("carries the remote bookkeeping a workspace draft was written with", async () => {
    await repo.commit(
      commitInput({
        origin: "workspace",
        documentId: "doc-1",
        workspaceId: "ws-1",
        documentKey: workspaceDocumentKey("ws-1", "doc-1"),
        revision: 5,
        lastRemoteAcknowledgedRevision: 3,
        serverVersion: 8,
        etag: "etag-8",
      }),
    );
    const loaded = await repo.loadBest(workspaceDocumentKey("ws-1", "doc-1"));
    expect(loaded!.descriptor.serverVersion).toBe(8);
    expect(loaded!.descriptor.lastRemoteAcknowledgedRevision).toBe(3);
    expect(loaded!.descriptor.documentId).toBe("doc-1");
  });

  it("falls back to the previous generation and says so", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    store.corrupt(draftKeys.snapshot("draft-1", 2), { garbage: true });

    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.revision).toBe(1);
    // The user is told they are one revision behind rather than being handed the
    // older document as if it were their latest.
    expect(loaded!.descriptor.fellBackToPreviousSnapshot).toBe(true);
    expect(loaded!.generation).toBe(1);
  });

  it("falls back when the newest snapshot was evicted entirely", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    store.evict(draftKeys.snapshot("draft-1", 2));

    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.revision).toBe(1);
    expect(loaded!.descriptor.fellBackToPreviousSnapshot).toBe(true);
  });

  it("surfaces the newest snapshot's fault when the previous one is gone too", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    store.corrupt(draftKeys.snapshot("draft-1", 1), { garbage: true });
    try {
      await repo.loadBest(KEY);
      expect.unreachable("an unreadable draft must not come back as no draft");
    } catch (error) {
      // "There is no draft" and "your draft is damaged" are different sentences.
      expect((error as DraftError).category).toBe("corrupt_snapshot");
    }
  });

  it("stops rather than silently loading an older revision when a newer build wrote the draft", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    const record = (await store.get(draftKeys.snapshot("draft-1", 2))) as {
      manifest: DraftManifest;
      checksum: string;
    };
    record.manifest.schemaVersion = DRAFT_SCHEMA_VERSION + 1;
    record.checksum = manifestChecksum(record.manifest);
    store.corrupt(draftKeys.snapshot("draft-1", 2), record);

    try {
      await repo.loadBest(KEY);
      expect.unreachable("a newer-format draft must not fall back silently");
    } catch (error) {
      // Falling back would hand the user a document missing their last edits while
      // calling it recovered — and generation 1 is from the same newer build anyway.
      expect((error as DraftError).category).toBe("unsupported_schema");
    }
  });

  it("migrates an older draft and reports where it came from", async () => {
    await repo.commit(commitInput({ revision: 3 }));
    const record = (await store.get(draftKeys.snapshot("draft-1", 1))) as {
      manifest: DraftManifest;
      checksum: string;
    };
    const downgraded: DraftManifest = {
      ...record.manifest,
      schemaVersion: DRAFT_SCHEMA_VERSION - 1,
      documentName: "old name.pdf",
    };
    store.corrupt(draftKeys.snapshot("draft-1", 1), {
      manifest: downgraded,
      checksum: manifestChecksum(downgraded),
    });

    const migrations = new Map<number, DraftMigration>([
      [
        DRAFT_SCHEMA_VERSION - 1,
        (m) => ({ ...m, schemaVersion: DRAFT_SCHEMA_VERSION, documentName: "new name.pdf" }),
      ],
    ]);
    const migrating = new DraftRepository(store, migrations);
    const loaded = await migrating.loadBest(KEY);

    expect(loaded!.descriptor.migratedFrom).toBe(DRAFT_SCHEMA_VERSION - 1);
    expect(loaded!.descriptor.documentName).toBe("new name.pdf");
  });
});

describe("a draft that could only partly be reconstructed", () => {
  it("names a missing image rather than restoring silently", async () => {
    const src = bigDataUrl("e");
    await repo.commit(
      commitInput({
        scene: scene({
          pages: [
            {
              objects: [
                { id: "i", kind: "image", src },
                { id: "t", kind: "text", text: "kept" },
              ],
            },
          ],
        }),
      }),
    );
    const hash = checksumString(src);
    store.evict(draftKeys.asset(hash));

    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.missingAssets).toContain(`image:${hash}`);
    const objects = (
      loaded!.scene.document as { pages: { objects: { id: string; src?: string; text?: string }[] }[] }
    ).pages[0]!.objects;
    // Every other edit is still restored: page structure, text, geometry.
    expect(objects[1]!.text).toBe("kept");
    expect(objects[0]!.src).toBe(assetReference(hash));
  });

  it("treats an asset that fails its own checksum as missing", async () => {
    const src = bigDataUrl("f");
    await repo.commit(
      commitInput({ scene: scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] }) }),
    );
    const hash = checksumString(src);
    store.corrupt(draftKeys.asset(draftKeys.asset(hash).slice("asset:".length)), {
      hash,
      role: "image",
      mimeType: "image/png",
      byteLength: 10,
      data: `${src.slice(0, 100)}TRUNCATED`,
    });

    const loaded = await repo.loadBest(KEY);
    // Half an image renders as a corrupt smear, which the user reads as the editor
    // having damaged their document.
    expect(loaded!.descriptor.missingAssets).toContain(`image:${hash}`);
  });

  it("names the source PDF separately when its bytes are gone", async () => {
    const bytes = new Uint8Array([37, 80, 68, 70]);
    await repo.commit(commitInput({ sourceBytes: bytes }));
    const record = (await store.get(draftKeys.snapshot("draft-1", 1))) as { manifest: DraftManifest };
    store.evict(draftKeys.asset(record.manifest.sourcePdf!.hash));

    const loaded = await repo.loadBest(KEY);
    expect(loaded!.sourceBytes).toBeNull();
    // Recovery can restore every annotation and edit but cannot claim to restore
    // the document, so this is named on its own.
    expect(loaded!.descriptor.missingAssets).toContain("source-pdf");
  });

  it("rejects source bytes that do not match their hash", async () => {
    await repo.commit(commitInput({ sourceBytes: new Uint8Array([37, 80, 68, 70]) }));
    const record = (await store.get(draftKeys.snapshot("draft-1", 1))) as { manifest: DraftManifest };
    const hash = record.manifest.sourcePdf!.hash;
    store.corrupt(draftKeys.asset(hash), {
      hash,
      role: "source-pdf",
      mimeType: "application/pdf",
      byteLength: 4,
      data: new Uint8Array([0, 0]),
    });

    const loaded = await repo.loadBest(KEY);
    expect(loaded!.sourceBytes).toBeNull();
    expect(loaded!.descriptor.missingAssets).toContain("source-pdf");
  });

  it("carries forward why a draft never had the original bytes", async () => {
    /*
     * The pinned `sourcePageIndex` is the point of the fixture, not decoration: it
     * is what makes this document one that NEEDS the original bytes. Without it the
     * scene is a document with no source pages at all, and nothing is missing.
     */
    await repo.commit(
      commitInput({
        scene: scene({ pages: [{ id: "page-1", sourcePageIndex: 0, objects: [] }] }),
        sourceBytes: null,
        sourceReference: "workspace document doc-1",
      }),
    );
    const loaded = await repo.loadBest(KEY);
    expect(loaded!.sourceBytes).toBeNull();
    expect(loaded!.descriptor.missingAssets).toContain("source-pdf:workspace document doc-1");
  });

  it("reports nothing missing for a document that never had an original PDF", async () => {
    /*
     * A draft of a blank page. Every page is editor-created (`sourcePageIndex`
     * null), so there are no original bytes to be missing — and reporting some
     * anyway is not cosmetic: `missingAssets` is what the recovery dialog turns
     * into "partly recoverable · some content is missing", one button away from
     * "Delete the draft", and what the coordinator turns into `complete: false`,
     * which then refuses to treat the restored document as durable. A complete
     * draft was shown as damaged and then reported as unsaved.
     */
    await repo.commit(
      commitInput({
        scene: scene({ pages: [{ id: "page-1", sourcePageIndex: null, objects: [] }] }),
        sourceBytes: null,
        sourceReference: null,
      }),
    );
    const loaded = await repo.loadBest(KEY);
    expect(loaded!.sourceBytes).toBeNull();
    expect(loaded!.descriptor.missingAssets).toEqual([]);
  });

  it("still reports the missing original when only SOME pages came from it", async () => {
    // One inserted blank page next to one PDF page. The PDF page still needs bytes.
    await repo.commit(
      commitInput({
        scene: scene({
          pages: [
            { id: "page-1", sourcePageIndex: null, objects: [] },
            { id: "page-2", sourcePageIndex: 3, objects: [] },
          ],
        }),
        sourceBytes: null,
        sourceReference: "too large to store",
      }),
    );
    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.missingAssets).toEqual(["source-pdf:too large to store"]);
  });

  it("reports nothing missing for a complete draft", async () => {
    await repo.commit(commitInput());
    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.missingAssets).toEqual([]);
  });
});

describe("deleting a draft", () => {
  it("stops it being discoverable before removing its snapshots", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    store.log.length = 0;

    await repo.deleteDraft("draft-1", KEY);

    const deletes = writeSequence().filter((entry) => entry.op === "delete");
    // The index and pointer go first and together: a crash between the steps
    // leaves orphaned garbage, never a visible pointer to snapshots that are gone.
    expect(deletes[0]!.keys).toEqual([draftKeys.index(KEY), draftKeys.pointer("draft-1")]);
    expect(await repo.loadBest(KEY)).toBeNull();
    expect(await repo.listDrafts()).toEqual([]);
    expect(await store.keysWithPrefix("snapshot:")).toEqual([]);
  });

  it("removes the assets nothing references any more", async () => {
    await repo.commit(
      commitInput({
        scene: scene({ pages: [{ objects: [{ id: "i", kind: "image", src: bigDataUrl("g") }] }] }),
      }),
    );
    await repo.deleteDraft("draft-1", KEY);
    expect(await store.keysWithPrefix("asset:")).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("does nothing when the store is unavailable", async () => {
    await repo.commit(commitInput());
    const before = store.size;
    store.setAvailable(false);
    await repo.deleteDraft("draft-1", KEY);
    expect(store.size).toBe(before);
  });
});

describe("garbage collection", () => {
  it("keeps every asset a live generation still references", async () => {
    const src = bigDataUrl("h");
    const withImage = scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] });
    await repo.commit(commitInput({ revision: 1, scene: withImage }));
    // Generation 2 drops the image, but generation 1 is still the fallback.
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));

    const result = await repo.collectGarbage();
    expect(result.assetsDeleted).toBe(0);
    expect(store.has(draftKeys.asset(checksumString(src)))).toBe(true);
  });

  it("does not remove an asset a different document shares", async () => {
    const src = bigDataUrl("i");
    const withImage = scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] });
    await repo.commit(commitInput({ draftId: "d1", documentKey: "guest:one", scene: withImage }));
    await repo.commit(commitInput({ draftId: "d2", documentKey: "guest:two", scene: withImage }));

    await repo.deleteDraft("d1", "guest:one");

    // Deleting per-commit, by looking only at the draft being dropped, eventually
    // removes an image another open document still needs.
    expect(store.has(draftKeys.asset(checksumString(src)))).toBe(true);
    expect((await repo.loadBest("guest:two"))!.descriptor.missingAssets).toEqual([]);
  });

  it("removes an orphaned snapshot no pointer names", async () => {
    await repo.commit(commitInput());
    store.corrupt(draftKeys.snapshot("draft-1", 99), { manifest: { format: "x" } });
    const result = await repo.collectGarbage();
    expect(result.snapshotsDeleted).toBe(1);
    expect(store.has(draftKeys.snapshot("draft-1", 99))).toBe(false);
    // And the live one is untouched.
    expect(store.has(draftKeys.snapshot("draft-1", 1))).toBe(true);
  });

  it("removes an asset left behind by a draft that is gone", async () => {
    store.corrupt(draftKeys.asset("orphan"), { hash: "orphan", data: "x" });
    const result = await repo.collectGarbage();
    expect(result.assetsDeleted).toBe(1);
  });

  it("does not touch anything when the store is unavailable", async () => {
    await repo.commit(commitInput());
    store.setAvailable(false);
    expect(await repo.collectGarbage()).toEqual({ assetsDeleted: 0, snapshotsDeleted: 0 });
    store.setAvailable(true);
    expect((await repo.loadBest(KEY))!.descriptor.revision).toBe(1);
  });

  it("leaves a draft loadable after a collection", async () => {
    const src = bigDataUrl("j");
    await repo.commit(
      commitInput({ scene: scene({ pages: [{ objects: [{ id: "i", kind: "image", src }] }] }) }),
    );
    await repo.collectGarbage();
    const loaded = await repo.loadBest(KEY);
    expect(loaded!.descriptor.missingAssets).toEqual([]);
    expect(loaded!.sourceBytes).not.toBeNull();
  });
});

describe("two tabs editing the same document", () => {
  /**
   * The pointer is the one record both tabs write, so it is the only place an
   * interleaving can be caught. Without a compare-and-swap the sequence is:
   * tab A reads generation 3, tab B reads generation 3, both write generation 4,
   * and the second pointer write silently discards the first tab's snapshot — the
   * last writer wins and the user is never told.
   */
  it("refuses a commit when another tab moved the pointer first", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    const observed = (await pointer())!.activeGeneration;

    // The other tab commits, taking the pointer to generation 2.
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));

    try {
      await repo.commit({
        ...commitInput({ revision: 3, now: 3_000 }),
        expectedActiveGeneration: observed,
      });
      expect.unreachable("a stale expected generation must not commit");
    } catch (error) {
      expect((error as DraftError).category).toBe("conflict");
      expect((error as DraftError).message).toMatch(/another tab/i);
    }
    // The other tab's work is exactly as it left it.
    expect((await pointer())!.activeGeneration).toBe(2);
    expect((await repo.loadBest(KEY))!.descriptor.revision).toBe(2);
  });

  it("does not write a snapshot it already knows it cannot promote", async () => {
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    store.log.length = 0;

    await expect(
      repo.commit({ ...commitInput({ revision: 3, now: 3_000 }), expectedActiveGeneration: 1 }),
    ).rejects.toThrow(DraftError);

    // The check is before the write, not after: a rejected commit should not leave
    // a megabyte of snapshot behind for the collector to find.
    expect(writeSequence()).toEqual([]);
  });

  it("commits when the expected generation still matches", async () => {
    const first = await repo.commit({ ...commitInput({ revision: 1 }), expectedActiveGeneration: null });
    const second = await repo.commit({
      ...commitInput({ revision: 2, now: 2_000 }),
      expectedActiveGeneration: first.generation,
    });
    expect(second.generation).toBe(2);
  });

  it("refuses a first commit when another tab created the draft in between", async () => {
    // `null` means "I saw no draft at all". Another tab having created one since is
    // exactly as much of a conflict as it having advanced one.
    await repo.commit(commitInput({ revision: 1 }));
    await expect(
      repo.commit({ ...commitInput({ revision: 1 }), expectedActiveGeneration: null }),
    ).rejects.toThrow(/another tab/i);
  });

  it("still allows a commit that does not claim to know the generation", async () => {
    // The parameter is opt-in: a single-tab coordinator that has not read the
    // pointer is not forced to guess a value, and omitting it is the pre-existing
    // last-write-wins behaviour rather than an error.
    await repo.commit(commitInput({ revision: 1 }));
    await repo.commit(commitInput({ revision: 2, now: 2_000 }));
    expect((await pointer())!.activeGeneration).toBe(2);
  });
});
