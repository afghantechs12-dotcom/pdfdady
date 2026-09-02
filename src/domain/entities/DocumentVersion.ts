/**
 * M7.6 durable document version domain types.
 *
 * A version is an *immutable* checkpoint of a document. Autosave drafts (M7.5)
 * are mutable, coalesced, per-device recovery state; a version is the opposite —
 * once written it is never updated, and history is never overwritten. Restoring
 * an old version therefore creates a *new* version pointing back at the one it
 * restored, rather than rewinding the document in place
 * (docs/milestone-7-plan.md §6.3).
 *
 * Storage split (§6.1): this row is metadata plus a bounded *manifest*. The
 * source PDF bytes, the serialized editor state, any materialized output, and
 * thumbnails all live in object storage; the manifest records their keys,
 * checksums and sizes. No document bytes are stored in SQLite.
 */

/**
 * Why a version exists. Provenance is recorded rather than inferred so that a
 * restore or a conflict checkpoint is never mistaken for an ordinary save.
 *
 * `save` — an explicit user save.
 * `restore` — created by restoring an earlier version; carries `restoredFromVersionId`.
 * `import` — the first version, created when the document was uploaded.
 * `checkpoint` — a policy-created checkpoint (close, idle, conflict resolution).
 */
export type DocumentVersionOrigin = "save" | "restore" | "import" | "checkpoint";

export const DOCUMENT_VERSION_ORIGINS: readonly DocumentVersionOrigin[] = [
  "save",
  "restore",
  "import",
  "checkpoint",
];

export function isDocumentVersionOrigin(value: unknown): value is DocumentVersionOrigin {
  return typeof value === "string" && (DOCUMENT_VERSION_ORIGINS as readonly string[]).includes(value);
}

/**
 * Bounds shared by the service (rejects on write) and the adapters (clamp or
 * degrade on read), so a row written by an older or tampered client cannot
 * return unbounded data.
 */
export const DOCUMENT_VERSION_LIMITS = {
  /** Largest accepted serialized manifest, in bytes. */
  maxManifestBytes: 16 * 1024,
  /** Longest accepted object-storage key. */
  maxKeyLength: 512,
  /** Longest accepted checksum (hex sha256 is 64). */
  maxChecksumLength: 128,
  /** Most thumbnail keys a manifest may carry. */
  maxThumbnailKeys: 8,
  /** Longest user-supplied version label. */
  maxLabelLength: 200,
  /** Upper bound on version numbers and page counts a caller may claim. */
  maxCounter: 1_000_000_000,
  /** Largest source artifact accepted, in bytes. */
  maxArtifactBytes: 2 * 1024 * 1024 * 1024,
  /** Most versions returned in a single listing. */
  maxListLimit: 50,
  /** Default listing size when a caller does not ask for one. */
  defaultListLimit: 25,
  /**
   * Attempts to allocate a version number before giving up. Concurrent saves
   * contend for the same next number; each retry re-reads the authoritative
   * counter inside the transaction rather than reusing a stale one.
   */
  maxAllocationAttempts: 5,
} as const;

/** Current manifest schema. Persisted alongside the manifest so an older row stays readable. */
export const DOCUMENT_VERSION_MANIFEST_SCHEMA = 1;

/**
 * The artifacts that make up a version.
 *
 * Only `source*` is required: a version always has bytes it was cut from. The
 * editor state, the materialized output PDF and thumbnails are optional because
 * a rolling save must not be forced to materialize a permanent PDF (§7.4).
 */
export interface DocumentVersionManifest {
  schema: number;
  /** Object-storage key of the immutable source PDF bytes. */
  sourceKey: string;
  sourceChecksum: string;
  sourceByteSize: number;
  /** Serialized editor state, when the version was cut from an editing session. */
  editorStateKey: string | null;
  editorStateChecksum: string | null;
  /** Materialized output PDF, when one was produced. */
  outputKey: string | null;
  outputChecksum: string | null;
  /** Page count at the time of the version, when known. */
  pageCount: number | null;
  /** Bounded set of rendered page thumbnails. */
  thumbnailKeys: string[];
}

export interface DocumentVersion {
  id: string;
  workspaceId: string;
  organizationId: string;
  documentId: string;
  /** Monotonic per-document number, allocated transactionally. Never reused. */
  versionNumber: number;
  /** The document revision this version was cut at. */
  revision: number;
  origin: DocumentVersionOrigin;
  /** Set only when `origin` is "restore". */
  restoredFromVersionId: string | null;
  /** Optional user-supplied name for the checkpoint. */
  label: string | null;
  manifest: DocumentVersionManifest;
  /**
   * True when the stored manifest could not be read within bounds and was
   * degraded on the way out. The version still appears in history — silently
   * returning an empty manifest would misrepresent it as having no artifacts.
   */
  manifestDegraded: boolean;
  /** sha256 over the canonical manifest, computed server-side. */
  checksum: string;
  createdById: string;
  createdAt: Date;
}

/**
 * Resolves a caller-supplied listing limit. Shared by both adapters so a listing
 * cannot be wider in one than the other. `Infinity` means "no bound of my own",
 * which the domain cap answers; anything unusable falls back to a single row
 * rather than to everything, so a bad limit can never widen a read.
 */
export function documentVersionListLimit(limit: number): number {
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), DOCUMENT_VERSION_LIMITS.maxListLimit);
}

function boundedKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > DOCUMENT_VERSION_LIMITS.maxKeyLength) return null;
  // Control characters would let a key smuggle path or header structure.
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return trimmed;
}

function boundedChecksum(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > DOCUMENT_VERSION_LIMITS.maxChecksumLength) return null;
  return /^[a-f0-9]+$/i.test(trimmed) ? trimmed : null;
}

function boundedCount(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0 || value > max) return null;
  return value;
}

/** The manifest returned when a stored one cannot be trusted. */
function emptyManifest(): DocumentVersionManifest {
  return {
    schema: DOCUMENT_VERSION_MANIFEST_SCHEMA,
    sourceKey: "",
    sourceChecksum: "",
    sourceByteSize: 0,
    editorStateKey: null,
    editorStateChecksum: null,
    outputKey: null,
    outputChecksum: null,
    pageCount: null,
    thumbnailKeys: [],
  };
}

/**
 * Validates a manifest supplied by a caller. Throws nothing — returns null when
 * the input cannot be represented within bounds, so the service can reject with
 * its own error type.
 */
export function normalizeManifest(input: unknown): DocumentVersionManifest | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;

  const sourceKey = boundedKey(raw.sourceKey);
  const sourceChecksum = boundedChecksum(raw.sourceChecksum);
  const sourceByteSize = boundedCount(raw.sourceByteSize, DOCUMENT_VERSION_LIMITS.maxArtifactBytes);
  // A version with no source bytes is not a version.
  if (!sourceKey || !sourceChecksum || sourceByteSize === null) return null;

  const thumbnails: string[] = [];
  if (Array.isArray(raw.thumbnailKeys)) {
    if (raw.thumbnailKeys.length > DOCUMENT_VERSION_LIMITS.maxThumbnailKeys) return null;
    for (const entry of raw.thumbnailKeys) {
      const key = boundedKey(entry);
      if (!key) return null;
      thumbnails.push(key);
    }
  } else if (raw.thumbnailKeys !== undefined && raw.thumbnailKeys !== null) {
    return null;
  }

  // Optional artifacts must be absent or valid — never partially specified, so a
  // key can't end up recorded without the checksum that proves what it holds.
  const editorStateKey = raw.editorStateKey == null ? null : boundedKey(raw.editorStateKey);
  if (raw.editorStateKey != null && !editorStateKey) return null;
  const editorStateChecksum =
    raw.editorStateChecksum == null ? null : boundedChecksum(raw.editorStateChecksum);
  if (raw.editorStateChecksum != null && !editorStateChecksum) return null;
  if (Boolean(editorStateKey) !== Boolean(editorStateChecksum)) return null;

  const outputKey = raw.outputKey == null ? null : boundedKey(raw.outputKey);
  if (raw.outputKey != null && !outputKey) return null;
  const outputChecksum = raw.outputChecksum == null ? null : boundedChecksum(raw.outputChecksum);
  if (raw.outputChecksum != null && !outputChecksum) return null;
  if (Boolean(outputKey) !== Boolean(outputChecksum)) return null;

  const pageCount =
    raw.pageCount == null ? null : boundedCount(raw.pageCount, DOCUMENT_VERSION_LIMITS.maxCounter);
  if (raw.pageCount != null && pageCount === null) return null;

  return {
    schema: DOCUMENT_VERSION_MANIFEST_SCHEMA,
    sourceKey,
    sourceChecksum,
    sourceByteSize,
    editorStateKey,
    editorStateChecksum,
    outputKey,
    outputChecksum,
    pageCount,
    thumbnailKeys: thumbnails,
  };
}

/**
 * Reads a stored manifest on the way out of an adapter.
 *
 * A row that cannot be parsed within bounds is *degraded*, not dropped and not
 * fabricated: the version keeps its place in history and the caller is told its
 * artifacts are unreadable.
 */
export function readManifest(raw: string): { manifest: DocumentVersionManifest; degraded: boolean } {
  if (typeof raw !== "string" || raw.length > DOCUMENT_VERSION_LIMITS.maxManifestBytes) {
    return { manifest: emptyManifest(), degraded: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { manifest: emptyManifest(), degraded: true };
  }
  const manifest = normalizeManifest(parsed);
  return manifest ? { manifest, degraded: false } : { manifest: emptyManifest(), degraded: true };
}

/**
 * Serializes a manifest with a fixed key order.
 *
 * The order is fixed so the checksum is a function of the manifest's *content*
 * rather than of the order its properties happened to be built in — two equal
 * manifests must not produce two different checksums.
 */
export function canonicalManifestJson(manifest: DocumentVersionManifest): string {
  return JSON.stringify([
    manifest.schema,
    manifest.sourceKey,
    manifest.sourceChecksum,
    manifest.sourceByteSize,
    manifest.editorStateKey,
    manifest.editorStateChecksum,
    manifest.outputKey,
    manifest.outputChecksum,
    manifest.pageCount,
    manifest.thumbnailKeys,
  ]);
}

/** Serializes a manifest for storage. Returns null when it would exceed the row bound. */
export function serializeManifest(manifest: DocumentVersionManifest): string | null {
  const json = JSON.stringify(manifest);
  return Buffer.byteLength(json, "utf8") > DOCUMENT_VERSION_LIMITS.maxManifestBytes ? null : json;
}

/** Every distinct object-storage key a version references. */
export function manifestArtifactKeys(manifest: DocumentVersionManifest): string[] {
  const keys = [
    manifest.sourceKey,
    manifest.editorStateKey,
    manifest.outputKey,
    ...manifest.thumbnailKeys,
  ];
  return [...new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0))];
}
