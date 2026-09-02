import type { SerializedEditorState } from "../ports/ISerializer";
import {
  DraftError,
  DRAFT_SCHEMA_VERSION,
  assetHashFromReference,
  buildDraftSnapshot,
  checksumAsset,
  draftKeys,
  inlineSceneAssets,
  isAssetReference,
  migrateDraftManifest,
  parseSnapshotRecord,
  type BuildDraftInput,
  type DraftAssetBlob,
  type DraftIndexRecord,
  type DraftManifest,
  type DraftMigrationRegistry,
  type DraftPointerRecord,
} from "./draftEnvelope";
import { canRedrawFromSource, readRestoredPages } from "./editorCapture";
import type { DraftDescriptor } from "./events";
import type { KeyValueStore } from "./ports";

/**
 * Reads and writes drafts transactionally, so a crash mid-autosave cannot cost
 * the user the draft they already had.
 *
 * THE COMMIT SEQUENCE, and why each step is where it is:
 *
 *   1. Serialise revision N and externalise its assets.                (pure)
 *   2. Write any asset that is not already stored.                     (new keys)
 *   3. Write the snapshot under generation G+1 — a key nothing reads.   (new key)
 *   4. Read the snapshot back, verify its checksum, and verify that every asset
 *      it references is present.
 *   5. In ONE transaction, repoint the pointer at G+1 and refresh the index,
 *      keeping G as `previousGeneration`.
 *   6. Only now delete anything: generations older than G.
 *
 * Nothing before step 5 is observable, which is the entire safety property. An
 * in-place overwrite — the obvious implementation — has a window during which the
 * only copy of the draft is half of the old one and half of the new one, and a
 * browser that is killed in that window (tab crash, OOM, force quit, the user's
 * battery) leaves a draft that loads into a document the user never had.
 *
 * Step 4 exists because a write that "succeeded" is not the same as a write that
 * can be read. IndexedDB will report success for a transaction the browser later
 * evicts, and a snapshot that fails its own checksum on read-back is the only
 * evidence available at commit time.
 *
 * Step 6 is last, and is never fused into step 5. Deleting the prior snapshot
 * before its replacement is durable trades a good draft for a hoped-for one.
 */

export interface DraftCommitInput
  extends Omit<BuildDraftInput, "generation" | "createdAt" | "updatedAt"> {
  now: number;
  /**
   * The active generation this caller last observed, as a compare-and-swap.
   *
   * WHY THE POINTER NEEDS A GUARD. Two tabs on the same document write the same
   * pointer record. Without this, the sequence is: tab A reads generation 3, tab B
   * reads generation 3, both write generation 4, and the second pointer write
   * silently discards the first tab's snapshot. Last writer wins, and the tab that
   * lost never finds out — it saw a successful commit.
   *
   * A lock is the primary defence, and this is the one that still holds when the
   * lock is unavailable (Web Locks absent, a fallback lease that expired under a
   * suspended tab). Detecting the interleaving turns it into a conflict the user
   * can resolve instead of a loss nobody observed.
   *
   * `null` asserts "there was no draft when I looked", which another tab having
   * created one contradicts just as much as it having advanced one. `undefined`
   * makes no claim at all and skips the check — a caller that never read the
   * pointer must not be made to guess a value.
   */
  expectedActiveGeneration?: number | null;
}

export interface DraftCommitResult {
  draftId: string;
  generation: number;
  previousGeneration: number | null;
  revision: number;
  /** Assets written this commit (not those already present). */
  assetsWritten: number;
  /** Snapshot keys deleted after the pointer moved. */
  generationsPruned: number;
}

export interface LoadedDraft {
  descriptor: DraftDescriptor;
  manifest: DraftManifest;
  /** The scene graph with assets put back where they were found. */
  scene: SerializedEditorState;
  /** The original file's bytes, or null when the draft could not store them. */
  sourceBytes: Uint8Array | null;
  /** Which generation was actually usable. */
  generation: number;
}

/** How many generations of a draft are kept. */
export const RETAINED_GENERATIONS = 2;

export class DraftRepository {
  constructor(
    private readonly store: KeyValueStore,
    private readonly migrations?: DraftMigrationRegistry,
  ) {}

  get available(): boolean {
    return this.store.isAvailable();
  }

  /**
   * Writes a new generation of a draft and promotes it.
   *
   * On a quota failure the old generations are pruned and the commit is retried
   * ONCE. That ordering matters: pruning first and writing second would be the
   * destructive version of the same idea, and the retry is attempted only after a
   * prune that provably keeps a known-good snapshot.
   */
  async commit(input: DraftCommitInput): Promise<DraftCommitResult> {
    if (!this.store.isAvailable()) {
      throw new DraftError(
        "storage_unavailable",
        "This browser will not let PDFDadi store a local copy of your work.",
      );
    }
    try {
      return await this.commitOnce(input);
    } catch (error) {
      const failure = this.store.classifyError(error);
      const category = error instanceof DraftError ? error.category : failure.category;
      if (category !== "quota_exceeded") throw error;
      // Free what is safe to free, then try exactly once more. A loop here would
      // sit spinning against a full disk.
      await this.reclaimSpace(input.documentKey, input.draftId);
      try {
        return await this.commitOnce(input);
      } catch (retryError) {
        const retryCategory =
          retryError instanceof DraftError
            ? retryError.category
            : this.store.classifyError(retryError).category;
        throw new DraftError(
          retryCategory === "quota_exceeded" ? "quota_exceeded" : retryCategory,
          retryCategory === "quota_exceeded"
            ? "This browser is out of storage space, so your changes could not be saved on this device. Free up space, or export the file to keep it."
            : (retryError instanceof Error ? retryError.message : "The local save failed."),
        );
      }
    }
  }

  private async commitOnce(input: DraftCommitInput): Promise<DraftCommitResult> {
    const pointerKey = draftKeys.pointer(input.draftId);
    const existingPointer = await this.readPointer(pointerKey);
    const activeGeneration = existingPointer?.activeGeneration ?? 0;
    const generation = activeGeneration + 1;

    /*
     * The compare-and-swap, checked HERE — before any bytes are written. Failing
     * after the snapshot write would be equally safe but would leave a megabyte of
     * unreachable snapshot behind for the collector, on a path that fires whenever
     * two tabs are open.
     */
    if (input.expectedActiveGeneration !== undefined) {
      const observed = existingPointer?.activeGeneration ?? null;
      if (observed !== input.expectedActiveGeneration) {
        throw new DraftError(
          "conflict",
          "Another tab saved this document, so this tab's local copy was not written over it.",
        );
      }
    }

    const { record, assets } = buildDraftSnapshot({
      ...input,
      generation,
      createdAt: existingPointer ? (await this.createdAtOf(input.draftId, activeGeneration)) ?? input.now : input.now,
      updatedAt: input.now,
    });

    /* Step 2 — assets. Content-addressed, so an unchanged source PDF or image is
     * written once and every later generation just references it. */
    const assetKeys = assets.map((asset) => draftKeys.asset(asset.hash));
    const existing = assets.length > 0 ? await this.store.getMany(assetKeys) : [];
    const toWrite: DraftAssetBlob[] = assets.filter((_, index) => existing[index] === undefined);
    if (toWrite.length > 0) {
      await this.store.putAll(
        toWrite.map((asset) => ({
          key: draftKeys.asset(asset.hash),
          value: {
            hash: asset.hash,
            role: asset.role,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength,
            data: asset.data,
          },
        })),
      );
    }

    /* Step 3 — the snapshot, under a key nothing reads yet. */
    const snapshotKey = draftKeys.snapshot(input.draftId, generation);
    await this.store.putAll([{ key: snapshotKey, value: record }]);

    /* Step 4 — verify. A write that cannot be read back is a failed write, and
     * this is the last moment the caller can be told so. */
    const readBack = await this.store.get(snapshotKey);
    if (readBack === undefined) {
      throw new DraftError(
        "integrity_failed",
        "The local copy could not be read back after saving, so it was not made active.",
      );
    }
    parseSnapshotRecord(readBack);
    if (assetKeys.length > 0) {
      const verified = await this.store.getMany(assetKeys);
      const missingIndex = verified.findIndex((value) => value === undefined);
      if (missingIndex >= 0) {
        throw new DraftError(
          "missing_asset",
          "Part of the document's image data could not be stored, so the local copy was not made active.",
        );
      }
    }

    /* Step 5 — the atomic promotion. One transaction: pointer and index together. */
    const pointer: DraftPointerRecord = {
      draftId: input.draftId,
      documentKey: input.documentKey,
      activeGeneration: generation,
      previousGeneration: existingPointer?.activeGeneration ?? null,
      revision: input.revision,
      updatedAt: input.now,
    };
    const index: DraftIndexRecord = {
      documentKey: input.documentKey,
      draftId: input.draftId,
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      documentName: input.documentName,
      origin: input.origin,
      revision: input.revision,
      updatedAt: input.now,
      schemaVersion: DRAFT_SCHEMA_VERSION,
    };
    await this.store.putAll([
      { key: pointerKey, value: pointer },
      { key: draftKeys.index(input.documentKey), value: index },
    ]);

    /* Step 6 — and only now, prune. */
    const pruned = await this.pruneGenerations(input.draftId, pointer);

    return {
      draftId: input.draftId,
      generation,
      previousGeneration: pointer.previousGeneration,
      revision: input.revision,
      assetsWritten: toWrite.length,
      generationsPruned: pruned,
    };
  }

  /** The newest usable draft for a document, or null when there is none. */
  async loadBest(documentKey: string): Promise<LoadedDraft | null> {
    if (!this.store.isAvailable()) return null;
    const index = (await this.store.get(draftKeys.index(documentKey))) as
      | DraftIndexRecord
      | undefined;
    if (!index || typeof index.draftId !== "string") return null;
    const pointer = await this.readPointer(draftKeys.pointer(index.draftId));
    if (!pointer) return null;

    const candidates: number[] = [pointer.activeGeneration];
    if (pointer.previousGeneration !== null) candidates.push(pointer.previousGeneration);

    let firstError: DraftError | null = null;
    for (const [attempt, generation] of candidates.entries()) {
      try {
        const loaded = await this.loadGeneration(index, generation, attempt > 0);
        if (loaded) return loaded;
      } catch (error) {
        const draftError =
          error instanceof DraftError
            ? error
            : new DraftError(this.store.classifyError(error).category, "The draft could not be read.");
        firstError ??= draftError;
        /*
         * `unsupported_schema` stops the search. An older generation written by the
         * same newer build will be just as unreadable, and — more importantly —
         * silently loading an older revision because the newest is from a newer
         * app version would hand the user a document missing their last edits
         * while calling it recovered.
         */
        if (draftError.category === "unsupported_schema") throw draftError;
      }
    }
    if (firstError) throw firstError;
    return null;
  }

  private async loadGeneration(
    index: DraftIndexRecord,
    generation: number,
    fellBack: boolean,
  ): Promise<LoadedDraft | null> {
    const raw = await this.store.get(draftKeys.snapshot(index.draftId, generation));
    if (raw === undefined) return null;
    const record = parseSnapshotRecord(raw);
    const { manifest, migratedFrom } = migrateDraftManifest(
      record.manifest,
      DRAFT_SCHEMA_VERSION,
      this.migrations,
    );

    // Every asset the scene references, plus the source PDF.
    const referenced = collectAssetReferences(manifest.scene);
    const hashes = [...new Set(referenced)];
    const values = hashes.length > 0
      ? await this.store.getMany(hashes.map((hash) => draftKeys.asset(hash)))
      : [];
    const assetData = new Map<string, string | Uint8Array>();
    const missing: string[] = [];
    hashes.forEach((hash, i) => {
      const stored = values[i] as { data?: string | Uint8Array; hash?: string } | undefined;
      if (!stored || stored.data === undefined) {
        missing.push(`image:${hash}`);
        return;
      }
      /*
       * An asset is checksummed on read as well as on write. A store can return
       * a truncated value for a record it evicted mid-write, and an image whose
       * bytes are half-present renders as a corrupt smear rather than an error —
       * which the user would read as the editor having damaged their document.
       */
      if (checksumAsset(stored.data) !== hash) {
        missing.push(`image:${hash}`);
        return;
      }
      assetData.set(hash, stored.data);
    });

    const { scene, missing: sceneMissing } = inlineSceneAssets(manifest.scene, assetData);
    for (const hash of sceneMissing) {
      if (!missing.includes(`image:${hash}`)) missing.push(`image:${hash}`);
    }

    let sourceBytes: Uint8Array | null = null;
    if (manifest.sourcePdf) {
      const stored = (await this.store.get(draftKeys.asset(manifest.sourcePdf.hash))) as
        | { data?: unknown }
        | undefined;
      const data = stored?.data;
      if (data instanceof Uint8Array && checksumAsset(data) === manifest.sourcePdf.hash) {
        sourceBytes = data;
      } else {
        /*
         * The original pages are gone. Recovery can still restore every annotation
         * and edit, but it CANNOT claim to restore the document, so this is named
         * explicitly rather than folded in with the images.
         */
        missing.push("source-pdf");
      }
    } else if (!canRedrawFromSource({ pages: readRestoredPages(scene), sourceBytes: null })) {
      /*
       * A source PDF is missing only if the document NEEDS one.
       *
       * A draft created from a blank page has no original file by nature, and for
       * every such draft this branch used to report `source-pdf:...` as missing —
       * which is not a cosmetic wart. `missingAssets` is what the recovery dialog
       * turns into "partly recoverable / some content is missing" (next to a Delete
       * button), and what the coordinator turns into `complete: false`, which makes
       * it refuse to call the restored document durable. So a perfectly complete
       * draft was presented as damaged and then reported as unsaved.
       *
       * The rule the rest of the system already uses is
       * {@link canRedrawFromSource}: bytes are needed exactly when some page is
       * pinned to a source page. `planDraftRestore` has always agreed with it —
       * only this branch disagreed, and it is the one the user was shown.
       */
      missing.push(`source-pdf:${manifest.sourceReference ?? "not captured"}`);
    }

    const descriptor: DraftDescriptor = {
      draftId: manifest.draftId,
      documentKey: manifest.documentKey,
      documentId: manifest.documentId,
      documentName: manifest.documentName,
      revision: manifest.revision,
      updatedAt: manifest.updatedAt,
      schemaVersion: manifest.schemaVersion,
      fellBackToPreviousSnapshot: fellBack,
      missingAssets: missing,
      migratedFrom,
      serverVersion: manifest.serverVersion,
      lastRemoteAcknowledgedRevision: manifest.lastRemoteAcknowledgedRevision,
    };
    return { descriptor, manifest, scene, sourceBytes, generation };
  }

  /** Every document that has a draft, newest first. */
  async listDrafts(): Promise<DraftIndexRecord[]> {
    if (!this.store.isAvailable()) return [];
    const keys = await this.store.keysWithPrefix(draftKeys.indexPrefix);
    if (keys.length === 0) return [];
    const values = await this.store.getMany(keys);
    return values
      .filter((value): value is DraftIndexRecord => {
        if (value === null || typeof value !== "object") return false;
        const record = value as Partial<DraftIndexRecord>;
        return typeof record.draftId === "string" && typeof record.documentKey === "string";
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Removes a draft entirely, at the user's request.
   *
   * Order is the mirror of a commit: the index and pointer go FIRST, so the draft
   * stops being discoverable in one transaction, and the snapshots go afterwards.
   * A crash between the two leaves orphaned snapshots — recoverable garbage — and
   * never a visible pointer to snapshots that are gone.
   */
  async deleteDraft(draftId: string, documentKey: string): Promise<void> {
    if (!this.store.isAvailable()) return;
    await this.store.deleteAll([draftKeys.index(documentKey), draftKeys.pointer(draftId)]);
    const snapshots = await this.store.keysWithPrefix(draftKeys.snapshotPrefix(draftId));
    if (snapshots.length > 0) await this.store.deleteAll(snapshots);
    await this.collectGarbage();
  }

  /**
   * Deletes assets no live draft references any more.
   *
   * Assets are content-addressed and therefore SHARED — between generations of one
   * draft, and between two documents that happen to contain the same image. So an
   * asset may only be deleted once every reachable manifest has been consulted;
   * deleting per-commit, by looking only at the generation being dropped, would
   * eventually remove an image another open document still needs.
   *
   * Not on the autosave path. Called once when a document opens.
   */
  async collectGarbage(): Promise<{ assetsDeleted: number; snapshotsDeleted: number }> {
    if (!this.store.isAvailable()) return { assetsDeleted: 0, snapshotsDeleted: 0 };
    const indexKeys = await this.store.keysWithPrefix(draftKeys.indexPrefix);
    const indexes = (await this.store.getMany(indexKeys)).filter(
      (value): value is DraftIndexRecord =>
        value !== null && typeof value === "object" && typeof (value as DraftIndexRecord).draftId === "string",
    );

    const liveSnapshotKeys = new Set<string>();
    const liveAssetHashes = new Set<string>();
    for (const index of indexes) {
      const pointer = await this.readPointer(draftKeys.pointer(index.draftId));
      if (!pointer) continue;
      const generations = [pointer.activeGeneration, pointer.previousGeneration].filter(
        (value): value is number => value !== null,
      );
      for (const generation of generations) {
        const key = draftKeys.snapshot(index.draftId, generation);
        liveSnapshotKeys.add(key);
        const raw = await this.store.get(key);
        if (raw === null || typeof raw !== "object") continue;
        const manifest = (raw as { manifest?: DraftManifest }).manifest;
        if (!manifest) continue;
        if (manifest.sourcePdf) liveAssetHashes.add(manifest.sourcePdf.hash);
        for (const hash of collectAssetReferences(manifest.scene)) liveAssetHashes.add(hash);
        for (const asset of manifest.assets ?? []) liveAssetHashes.add(asset.hash);
      }
    }

    const allSnapshots = await this.store.keysWithPrefix("snapshot:");
    const staleSnapshots = allSnapshots.filter((key) => !liveSnapshotKeys.has(key));
    const allAssets = await this.store.keysWithPrefix("asset:");
    const staleAssets = allAssets.filter(
      (key) => !liveAssetHashes.has(key.slice("asset:".length)),
    );
    const doomed = [...staleSnapshots, ...staleAssets];
    if (doomed.length > 0) await this.store.deleteAll(doomed);
    return { assetsDeleted: staleAssets.length, snapshotsDeleted: staleSnapshots.length };
  }

  /**
   * Deletes generations of one draft that the pointer no longer references.
   *
   * The pointer is read from the store rather than trusted from the caller, so a
   * prune can never be talked into deleting the live generation.
   */
  private async pruneGenerations(draftId: string, pointer: DraftPointerRecord): Promise<number> {
    const keep = new Set<string>([draftKeys.snapshot(draftId, pointer.activeGeneration)]);
    if (pointer.previousGeneration !== null) {
      keep.add(draftKeys.snapshot(draftId, pointer.previousGeneration));
    }
    const keys = await this.store.keysWithPrefix(draftKeys.snapshotPrefix(draftId));
    const doomed = keys.filter((key) => !keep.has(key));
    if (doomed.length === 0) return 0;
    await this.store.deleteAll(doomed);
    return doomed.length;
  }

  /**
   * Frees space after a quota failure, without ever dropping below one known-good
   * snapshot per draft.
   *
   * Orphaned assets and superseded generations first — those are pure garbage.
   * The `previousGeneration` of OTHER drafts goes next, because another document's
   * second-newest backup is a genuinely lower priority than this document's
   * ability to save at all. The draft being written keeps both of its generations.
   */
  private async reclaimSpace(documentKey: string, draftId: string): Promise<void> {
    await this.collectGarbage();
    const indexKeys = await this.store.keysWithPrefix(draftKeys.indexPrefix);
    const indexes = (await this.store.getMany(indexKeys)).filter(
      (value): value is DraftIndexRecord =>
        value !== null && typeof value === "object" && typeof (value as DraftIndexRecord).draftId === "string",
    );
    for (const index of indexes) {
      if (index.documentKey === documentKey || index.draftId === draftId) continue;
      const pointerKey = draftKeys.pointer(index.draftId);
      const pointer = await this.readPointer(pointerKey);
      if (!pointer || pointer.previousGeneration === null) continue;
      // The pointer is updated FIRST, so the snapshot being deleted is already
      // unreachable when it goes. The reverse order would leave a pointer naming a
      // snapshot that no longer exists.
      const next: DraftPointerRecord = { ...pointer, previousGeneration: null };
      await this.store.putAll([{ key: pointerKey, value: next }]);
      await this.store.deleteAll([draftKeys.snapshot(index.draftId, pointer.previousGeneration)]);
    }
    await this.collectGarbage();
  }

  private async readPointer(key: string): Promise<DraftPointerRecord | null> {
    const value = await this.store.get(key);
    if (value === null || typeof value !== "object") return null;
    const pointer = value as Partial<DraftPointerRecord>;
    if (typeof pointer.draftId !== "string" || typeof pointer.activeGeneration !== "number") {
      return null;
    }
    return pointer as DraftPointerRecord;
  }

  /** Keeps `createdAt` stable across generations of the same draft. */
  private async createdAtOf(draftId: string, generation: number): Promise<number | null> {
    if (generation <= 0) return null;
    const raw = await this.store.get(draftKeys.snapshot(draftId, generation));
    if (raw === null || typeof raw !== "object") return null;
    const createdAt = (raw as { manifest?: { createdAt?: unknown } }).manifest?.createdAt;
    return typeof createdAt === "number" ? createdAt : null;
  }
}

/** Every `asset:` reference reachable from a serialized scene. */
function collectAssetReferences(scene: unknown): string[] {
  const hashes: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "src" && typeof child === "string" && isAssetReference(child)) {
        const hash = assetHashFromReference(child);
        if (hash) hashes.push(hash);
        continue;
      }
      visit(child);
    }
  };
  visit(scene);
  return hashes;
}
