import type { SerializedEditorState } from "../ports/ISerializer";
import type { PersistenceFailureCategory } from "./events";

/**
 * The on-device draft format: what a recoverable draft contains, how it proves
 * itself intact, and how an older one is brought forward.
 *
 * WHY A MANIFEST PLUS SEPARATE ASSETS. A PDF editor draft is mostly binary — the
 * original file's bytes, and every imported image and signature, which arrive as
 * data URLs on the scene graph. Storing all of that as one JSON blob makes every
 * autosave re-serialise and re-write tens of megabytes that did not change, which
 * is both slow enough to stutter the canvas and the fastest route to a quota
 * failure. So large binaries are externalised by content hash and written once;
 * the manifest keeps a reference. A second, quieter benefit: two drafts of the
 * same file share the source-PDF asset instead of storing it twice.
 *
 * WHY THE CHECKSUM IS NOT A SIGNATURE. `checksum` here answers "did these bytes
 * come back the way they went in" — truncated writes, evicted pages, a snapshot
 * written by an aborted transaction. It is a non-cryptographic hash and is not
 * evidence of authorship or tamper-resistance, and nothing in this system treats
 * it as such. A draft is read back only into the browser that wrote it.
 *
 * WHAT AN HONEST DRAFT MAY CLAIM. If the original PDF bytes were not available at
 * save time, `sourcePdf` is null and `sourceReference` says why. Recovery then
 * reports itself as PARTIAL rather than restoring a document with blank pages
 * while calling it complete — a recovery that quietly loses the user's original
 * pages is worse than one that admits it cannot run.
 */

/**
 * The draft schema version.
 *
 * Distinct from `EDITOR_FORMAT_VERSION`: the scene graph's format and the draft
 * envelope's format change for different reasons and at different times. A draft
 * written today may hold a v6 scene; next month's build may read v7 scenes and v2
 * drafts, and needs to migrate them independently.
 */
export const DRAFT_SCHEMA_VERSION = 1;

/** The build that wrote a draft, for diagnostics and migration decisions. */
export const DRAFT_APP_VERSION = "0.1.0";

export const DRAFT_FORMAT = "pdfdadi-draft" as const;

/**
 * Above this many characters, an inline data URL is externalised into its own
 * asset record. Small values (a 200-byte placeholder SVG) stay inline, where they
 * cost less than an extra store round trip.
 */
export const ASSET_INLINE_THRESHOLD = 4096;

export type DraftAssetRole = "source-pdf" | "image" | "signature";

/** A reference from the manifest to a separately stored binary. */
export interface DraftAssetRef {
  /** Content hash. Also the key suffix, which is what makes assets shareable. */
  hash: string;
  role: DraftAssetRole;
  /** Length of the stored representation, for quota accounting. */
  byteLength: number;
  mimeType: string;
  /** The scene object whose `src` was externalised. Absent for the source PDF. */
  objectId?: string;
}

/** An asset's actual payload, written alongside the manifest. */
export interface DraftAssetBlob extends DraftAssetRef {
  /**
   * A data URL (for images and signatures) or raw bytes (for the source PDF).
   *
   * Image data URLs are stored AS STRINGS rather than decoded to bytes. Decoding
   * needs `atob` or `Buffer`, neither of which exists in both a browser and this
   * repo's Node test environment, and a base64 codec on the autosave path is a
   * correctness risk for a ~33% size saving. Structured clone stores both forms.
   */
  data: string | Uint8Array;
}

/** Small, cheap facts shown in the recovery prompt without loading the scene. */
export interface DraftMetadata {
  pageCount: number;
  objectCount: number;
  /** Bytes of the original file, when it was captured. */
  sourceByteLength: number | null;
  /** Total stored size of all externalised assets. */
  assetByteLength: number;
}

export interface DraftManifest {
  format: typeof DRAFT_FORMAT;
  schemaVersion: number;
  appVersion: string;
  /** Stable across every generation of this draft. */
  draftId: string;
  /** The store key that groups this draft with its document. */
  documentKey: string;
  /** The workspace document, or null for a guest document. */
  documentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  documentName: string;
  origin: "guest" | "workspace";
  /** Monotonic per draft. A new generation is a new snapshot key. */
  generation: number;
  createdAt: number;
  updatedAt: number;

  /** The revision this snapshot holds. */
  revision: number;
  /** The newest revision known durable when this snapshot was written. */
  lastLocallyDurableRevision: number;
  /** The newest revision the server had acknowledged. Null for a guest draft. */
  lastRemoteAcknowledgedRevision: number | null;
  serverVersion: number | null;
  etag: string | null;

  metadata: DraftMetadata;

  /**
   * The canonical scene graph, with large `src` values replaced by
   * `asset:<hash>` references.
   *
   * Everything requirement-listed as separate draft content lives inside it, by
   * construction rather than by duplication: page operations are the page array's
   * order, rotation and `sourcePageIndex`; crop data is `ImageObject.crop`;
   * drawing paths are `DrawingObject` points; font references are the text
   * objects' font fields. Copying them out into parallel fields would create two
   * sources of truth that could disagree — the scene graph IS the document.
   */
  scene: SerializedEditorState;
  assets: DraftAssetRef[];
  /** The original file's bytes, or null when they were unavailable. */
  sourcePdf: DraftAssetRef | null;
  /** Why `sourcePdf` is null, when it is. Shown to the user during recovery. */
  sourceReference: string | null;
}

/** The stored snapshot record: a manifest plus the checksum that validates it. */
export interface DraftSnapshotRecord {
  manifest: DraftManifest;
  /** Over the canonical JSON of `manifest`. */
  checksum: string;
}

/**
 * The pointer that says which generation is live.
 *
 * The single value swapped at the end of a commit, and the reason a crashed
 * autosave cannot corrupt a draft: until this record changes, the newly written
 * generation is invisible and the old one is still the draft.
 */
export interface DraftPointerRecord {
  draftId: string;
  documentKey: string;
  activeGeneration: number;
  /**
   * The generation to fall back to if the active one will not load.
   *
   * Retained deliberately, and never deleted in the same step that promotes its
   * replacement. One known-good snapshot at all times is the whole safety
   * property; a store that briefly has zero is a store that can lose everything
   * to one badly timed crash.
   */
  previousGeneration: number | null;
  revision: number;
  updatedAt: number;
}

/** The per-document index entry, so drafts can be listed without loading them. */
export interface DraftIndexRecord {
  documentKey: string;
  draftId: string;
  documentId: string | null;
  workspaceId: string | null;
  documentName: string;
  origin: "guest" | "workspace";
  revision: number;
  updatedAt: number;
  schemaVersion: number;
}

/** A draft-store fault, carrying the category the UI and diagnostics need. */
export class DraftError extends Error {
  readonly category: PersistenceFailureCategory;
  constructor(category: PersistenceFailureCategory, message: string) {
    super(message);
    this.name = "DraftError";
    this.category = category;
  }
}

/* ------------------------------------------------------------------ */
/* Integrity                                                           */
/* ------------------------------------------------------------------ */

/**
 * A fast non-cryptographic checksum: two independent FNV-1a passes with
 * different offsets, concatenated.
 *
 * Two passes rather than one because a single 32-bit hash collides at roughly one
 * in 65,000 pairs, which over a long editing session is not remote enough for a
 * check whose entire job is catching a corrupt snapshot. Chosen over WebCrypto's
 * SHA-256 because that API is async and absent in some contexts, and this runs on
 * the autosave path where a synchronous answer keeps the commit sequence simple.
 */
export function checksumString(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    a ^= code;
    a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + code) >>> 0;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  // Length is mixed in so a truncated snapshot cannot collide with its own prefix.
  const len = value.length >>> 0;
  a = (a ^ len) >>> 0;
  b = (b ^ Math.imul(len, 0x27d4eb2d)) >>> 0;
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function checksumBytes(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    a ^= byte;
    a = Math.imul(a, 0x01000193) >>> 0;
    b = (b + byte) >>> 0;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  const len = bytes.length >>> 0;
  a = (a ^ len) >>> 0;
  b = (b ^ Math.imul(len, 0x27d4eb2d)) >>> 0;
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

export function checksumAsset(data: string | Uint8Array): string {
  return typeof data === "string" ? checksumString(data) : checksumBytes(data);
}

/**
 * The bytes a checksum is computed over.
 *
 * `JSON.stringify` of an object literal is stable for a given build because
 * property insertion order is preserved, and this manifest is always built by
 * `buildDraftSnapshot` — so the round trip write→read→re-stringify agrees. It is
 * NOT a canonical JSON encoder, and a manifest hand-assembled with keys in a
 * different order would checksum differently; that is why nothing outside this
 * module constructs one.
 */
export function manifestChecksum(manifest: DraftManifest): string {
  return checksumString(JSON.stringify(manifest));
}

/* ------------------------------------------------------------------ */
/* Asset externalisation                                               */
/* ------------------------------------------------------------------ */

const ASSET_PREFIX = "asset:";

/** Whether a scene `src` value is an externalised reference rather than content. */
export function isAssetReference(src: string): boolean {
  return src.startsWith(ASSET_PREFIX);
}

export function assetReference(hash: string): string {
  return `${ASSET_PREFIX}${hash}`;
}

export function assetHashFromReference(src: string): string | null {
  return isAssetReference(src) ? src.slice(ASSET_PREFIX.length) : null;
}

interface SceneObjectLike {
  id?: unknown;
  kind?: unknown;
  src?: unknown;
}

/**
 * Walks the serialized scene and pulls large `src` payloads out into assets.
 *
 * Structural rather than typed on purpose: `SerializedEditorState.document` is
 * `unknown` at this boundary (plugin object kinds are opaque to the core), so
 * this treats it as data and touches only `kind`/`src`. Anything it does not
 * recognise is copied through untouched, which is the behaviour a plugin payload
 * needs.
 */
export function externaliseSceneAssets(scene: SerializedEditorState): {
  scene: SerializedEditorState;
  assets: DraftAssetBlob[];
} {
  const assets = new Map<string, DraftAssetBlob>();

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const candidate = record as SceneObjectLike;
    const role: DraftAssetRole | null =
      candidate.kind === "image" ? "image" : candidate.kind === "signature" ? "signature" : null;
    if (
      role !== null &&
      typeof candidate.src === "string" &&
      candidate.src.length > ASSET_INLINE_THRESHOLD &&
      !isAssetReference(candidate.src)
    ) {
      const src = candidate.src;
      const hash = checksumString(src);
      if (!assets.has(hash)) {
        assets.set(hash, {
          hash,
          role,
          byteLength: src.length,
          mimeType: dataUrlMimeType(src),
          objectId: typeof candidate.id === "string" ? candidate.id : undefined,
          data: src,
        });
      }
      const next: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(record)) {
        next[key] = key === "src" ? assetReference(hash) : visit(child);
      }
      return next;
    }
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) next[key] = visit(child);
    return next;
  };

  return {
    scene: visit(scene) as SerializedEditorState,
    assets: [...assets.values()],
  };
}

/**
 * Puts externalised `src` values back, reporting anything that could not be found.
 *
 * A missing asset does NOT throw. The rest of the document — page structure,
 * text, shapes, crops, every edit the user made — is still worth restoring, and
 * an image that fails to load is a visible, explainable gap. What must not happen
 * is restoring silently: the missing hashes come back so recovery can be reported
 * as partial and the user told which images did not survive.
 */
export function inlineSceneAssets(
  scene: SerializedEditorState,
  assets: ReadonlyMap<string, string | Uint8Array>,
): { scene: SerializedEditorState; missing: string[] } {
  const missing = new Set<string>();

  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === "src" && typeof child === "string" && isAssetReference(child)) {
        const hash = assetHashFromReference(child) as string;
        const data = assets.get(hash);
        if (typeof data === "string") {
          next.src = data;
        } else {
          // Left as the reference so the object keeps its identity, geometry and
          // crop; the recovery report names it as missing.
          missing.add(hash);
          next.src = child;
        }
        continue;
      }
      next[key] = visit(child);
    }
    return next;
  };

  return { scene: visit(scene) as SerializedEditorState, missing: [...missing] };
}

function dataUrlMimeType(src: string): string {
  const match = /^data:([^;,]+)/.exec(src);
  return match?.[1] ?? "application/octet-stream";
}

/* ------------------------------------------------------------------ */
/* Building                                                            */
/* ------------------------------------------------------------------ */

export interface BuildDraftInput {
  draftId: string;
  documentKey: string;
  documentId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  documentName: string;
  origin: "guest" | "workspace";
  generation: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  lastLocallyDurableRevision: number;
  lastRemoteAcknowledgedRevision: number | null;
  serverVersion: number | null;
  etag: string | null;
  scene: SerializedEditorState;
  /** The original file's bytes, or null when they are not available. */
  sourceBytes: Uint8Array | null;
  /** Required when `sourceBytes` is null: what the user should be told. */
  sourceReference: string | null;
  pageCount: number;
  objectCount: number;
}

/**
 * Assembles a snapshot record and the asset blobs it depends on.
 *
 * Pure: no store, no clock, no ids of its own. The commit sequence in the
 * repository decides the ORDER these are written in, which is where the
 * transactional guarantee lives; this only decides their content.
 */
export function buildDraftSnapshot(input: BuildDraftInput): {
  record: DraftSnapshotRecord;
  assets: DraftAssetBlob[];
} {
  const { scene, assets } = externaliseSceneAssets(input.scene);

  const sourceAssets: DraftAssetBlob[] = [];
  let sourcePdf: DraftAssetRef | null = null;
  if (input.sourceBytes && input.sourceBytes.length > 0) {
    /*
     * A defensive copy. `sourceBytes` in the editor is frequently a view over a
     * larger ArrayBuffer, and handing that view to a store would persist the
     * whole backing buffer — the same trap the export path documents for Blob.
     */
    const bytes = new Uint8Array(input.sourceBytes);
    const hash = checksumBytes(bytes);
    sourcePdf = {
      hash,
      role: "source-pdf",
      byteLength: bytes.byteLength,
      mimeType: "application/pdf",
    };
    sourceAssets.push({ ...sourcePdf, data: bytes });
  }

  const allAssets = [...sourceAssets, ...assets];
  const manifest: DraftManifest = {
    format: DRAFT_FORMAT,
    schemaVersion: DRAFT_SCHEMA_VERSION,
    appVersion: DRAFT_APP_VERSION,
    draftId: input.draftId,
    documentKey: input.documentKey,
    documentId: input.documentId,
    workspaceId: input.workspaceId,
    organizationId: input.organizationId,
    documentName: input.documentName,
    origin: input.origin,
    generation: input.generation,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    revision: input.revision,
    lastLocallyDurableRevision: input.lastLocallyDurableRevision,
    lastRemoteAcknowledgedRevision: input.lastRemoteAcknowledgedRevision,
    serverVersion: input.serverVersion,
    etag: input.etag,
    metadata: {
      pageCount: input.pageCount,
      objectCount: input.objectCount,
      sourceByteLength: sourcePdf?.byteLength ?? null,
      assetByteLength: allAssets.reduce((sum, asset) => sum + asset.byteLength, 0),
    },
    scene,
    assets,
    sourcePdf,
    sourceReference: sourcePdf === null ? (input.sourceReference ?? "unknown") : null,
  };

  return { record: { manifest, checksum: manifestChecksum(manifest) }, assets: allAssets };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validates a record read back out of the store.
 *
 * Throws a categorised {@link DraftError} rather than returning null, because the
 * category decides the outcome: `corrupt_snapshot` means fall back to the
 * previous generation, `unsupported_schema` means this build must not touch it at
 * all, and both are different from "there is no draft".
 */
export function parseSnapshotRecord(value: unknown): DraftSnapshotRecord {
  if (value === null || typeof value !== "object") {
    throw new DraftError("corrupt_snapshot", "The stored draft is not an object.");
  }
  const record = value as Partial<DraftSnapshotRecord>;
  if (typeof record.checksum !== "string" || record.manifest === undefined) {
    throw new DraftError("corrupt_snapshot", "The stored draft is missing its manifest or checksum.");
  }
  const manifest = record.manifest as Partial<DraftManifest>;
  if (manifest.format !== DRAFT_FORMAT) {
    throw new DraftError("corrupt_snapshot", "The stored draft is not a PDFDadi draft.");
  }
  if (typeof manifest.schemaVersion !== "number" || !Number.isFinite(manifest.schemaVersion)) {
    throw new DraftError("corrupt_snapshot", "The stored draft has no schema version.");
  }
  if (manifest.schemaVersion > DRAFT_SCHEMA_VERSION) {
    /*
     * Written by a NEWER build — the user has two versions of the app in two tabs,
     * or a deployment rolled back. Refusing is the only safe answer: this build
     * cannot know what fields it would be dropping, and a lossy "best effort"
     * read would silently discard whatever the newer format added.
     */
    throw new DraftError(
      "unsupported_schema",
      `This draft was saved by a newer version of PDFDadi (draft format ${manifest.schemaVersion}, this build reads ${DRAFT_SCHEMA_VERSION}). Reload the page to get the latest version.`,
    );
  }
  for (const field of ["draftId", "documentKey", "documentName"] as const) {
    if (typeof manifest[field] !== "string" || manifest[field] === "") {
      throw new DraftError("corrupt_snapshot", `The stored draft has no ${field}.`);
    }
  }
  if (typeof manifest.revision !== "number" || !Number.isFinite(manifest.revision)) {
    throw new DraftError("corrupt_snapshot", "The stored draft has no revision.");
  }
  if (manifest.scene === undefined || manifest.scene === null) {
    throw new DraftError("corrupt_snapshot", "The stored draft has no document content.");
  }
  const full = record as DraftSnapshotRecord;
  const expected = manifestChecksum(full.manifest);
  if (expected !== full.checksum) {
    throw new DraftError(
      "integrity_failed",
      "The stored draft did not match its checksum, so it may be incomplete.",
    );
  }
  return full;
}

/* ------------------------------------------------------------------ */
/* Migration                                                           */
/* ------------------------------------------------------------------ */

export type DraftMigration = (manifest: DraftManifest) => DraftManifest;

/**
 * Draft migrations, keyed by the version they migrate FROM.
 *
 * Mirrors `SerializationService`'s registry — the same one-step-at-a-time chain,
 * so a v1 draft reaches v4 through v2 and v3 rather than through a bespoke
 * v1→v4 path per version pair.
 *
 * Injectable, unlike the serializer's module-level map. A migration registered by
 * a test would otherwise leak into every later test in the file, and the failure
 * mode of that leak is a migration test that passes because an earlier test
 * registered what it needed.
 */
export type DraftMigrationRegistry = ReadonlyMap<number, DraftMigration>;

const draftMigrations = new Map<number, DraftMigration>();

export function registerDraftMigration(fromVersion: number, migration: DraftMigration): void {
  draftMigrations.set(fromVersion, migration);
}

export function draftMigrationRegistry(): DraftMigrationRegistry {
  return draftMigrations;
}

export interface MigrationOutcome {
  manifest: DraftManifest;
  /** The version the draft arrived at, or null when no migration was needed. */
  migratedFrom: number | null;
}

/**
 * Brings a draft manifest up to the current schema version.
 *
 * A migration that throws surfaces as `migration_failed` and NOT as a corrupt
 * draft: the distinction matters because the stored bytes are fine and must be
 * left exactly as they are. Overwriting a draft this build cannot migrate would
 * destroy the only copy a future build could have read.
 */
export function migrateDraftManifest(
  manifest: DraftManifest,
  target: number = DRAFT_SCHEMA_VERSION,
  registry: DraftMigrationRegistry = draftMigrations,
): MigrationOutcome {
  if (manifest.schemaVersion === target) return { manifest, migratedFrom: null };
  if (manifest.schemaVersion > target) {
    throw new DraftError(
      "unsupported_schema",
      `This draft was saved by a newer version of PDFDadi (draft format ${manifest.schemaVersion}).`,
    );
  }
  const from = manifest.schemaVersion;
  let current = manifest;
  // Bounded by the version distance, so a migration that returns the same version
  // cannot spin forever.
  const maxSteps = target - from + 1;
  for (let step = 0; step < maxSteps; step += 1) {
    if (current.schemaVersion === target) return { manifest: current, migratedFrom: from };
    const migration = registry.get(current.schemaVersion);
    if (!migration) {
      throw new DraftError(
        "unsupported_schema",
        `No migration path from draft format ${current.schemaVersion}; this build reads ${target}.`,
      );
    }
    let next: DraftManifest;
    try {
      next = migration(current);
    } catch (error) {
      throw new DraftError(
        "migration_failed",
        `Draft format ${current.schemaVersion} could not be upgraded: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    if (next.schemaVersion <= current.schemaVersion) {
      throw new DraftError(
        "migration_failed",
        `Draft migration from format ${current.schemaVersion} did not advance the version.`,
      );
    }
    current = next;
  }
  throw new DraftError(
    "migration_failed",
    `Draft migration from format ${from} did not reach format ${target}.`,
  );
}

/* ------------------------------------------------------------------ */
/* Keys                                                                */
/* ------------------------------------------------------------------ */

/**
 * The store key namespace.
 *
 * One flat object store with namespaced string keys, rather than four object
 * stores. IndexedDB schema changes require a version bump and an upgrade
 * transaction; adding a record TYPE should not. Range scans over a string prefix
 * are what `IDBKeyRange.bound` is for, so listing loses nothing.
 */
export const draftKeys = {
  snapshot: (draftId: string, generation: number) => `snapshot:${draftId}:${generation}`,
  asset: (hash: string) => `asset:${hash}`,
  pointer: (draftId: string) => `pointer:${draftId}`,
  index: (documentKey: string) => `index:${documentKey}`,
  /** The prefix that enumerates every index record. */
  indexPrefix: "index:",
  snapshotPrefix: (draftId: string) => `snapshot:${draftId}:`,
} as const;

/** The draft-store key for a document. Guest and workspace documents never collide. */
export function guestDocumentKey(guestDocumentId: string): string {
  return `guest:${guestDocumentId}`;
}

export function workspaceDocumentKey(workspaceId: string, documentId: string): string {
  return `ws:${workspaceId}:${documentId}`;
}
