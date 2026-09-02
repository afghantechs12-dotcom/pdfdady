/**
 * M7.5 autosave draft domain types.
 *
 * A draft is server-side, durable, per-device working state for a document that
 * has not been committed as a version. It exists so an interrupted editing
 * session survives a crash, a tab close, or a device switch.
 *
 * Storage split (see docs/milestone-7-plan.md §4.3): this row is *metadata
 * only*. The serialized editor state lives in object storage under
 * `snapshotKey`; the database holds its key, checksum, and byte size. Editor
 * state is rewritten on every keystroke-batch, so keeping it out of SQLite is
 * what stops a rolling draft from bloating the database.
 *
 * Scope note: this model describes only what the server persists. Browser-side
 * concerns (IndexedDB staging, Web Locks, beforeunload flushes) belong to the
 * client and are deliberately not represented here — the server cannot observe
 * them, so it must not claim them.
 */

/**
 * Server-side draft lifecycle.
 *
 * `dirty` — the draft holds unsaved work ahead of the document's committed state.
 * `saved` — the draft was committed to a version and is retained only as history.
 * `conflict` — the document moved on beneath this draft, or another device held
 *   the write lease; the snapshot is retained untouched so the author can
 *   resolve it rather than silently lose work.
 * `stale` — the draft's lease expired without renewal; another device may claim it.
 */
export type AutosaveDraftStatus = "dirty" | "saved" | "conflict" | "stale";

export const AUTOSAVE_DRAFT_STATUSES: readonly AutosaveDraftStatus[] = [
  "dirty",
  "saved",
  "conflict",
  "stale",
];

/**
 * Bounds shared by the service (rejects on write) and the adapters (clamp or
 * reject on read), so a row written by an older client cannot return unbounded
 * values.
 */
export const AUTOSAVE_DRAFT_LIMITS = {
  /** Largest accepted serialized editor state, in bytes. */
  maxPayloadBytes: 1024 * 1024,
  /** Longest accepted device identifier. */
  maxDeviceIdLength: 128,
  /** Longest stored failure reason. */
  maxFailureReasonLength: 500,
  /** Longest stored object-storage key. */
  maxSnapshotKeyLength: 512,
  /** Upper bound on the version/revision counters a client may claim. */
  maxCounter: 1_000_000_000,
  /** Default lease duration, in milliseconds. */
  defaultLeaseMs: 30_000,
  /** Longest lease a caller may request, in milliseconds. */
  maxLeaseMs: 10 * 60_000,
  /** Most drafts returned for one document in a single listing. */
  maxDraftsPerDocument: 20,
  /** How long a draft is retained before it is eligible for purge. */
  retentionMs: 30 * 24 * 60 * 60_000,
} as const;

/** Content type the editor-state snapshot is stored under. */
export const AUTOSAVE_SNAPSHOT_CONTENT_TYPE = "application/json";

export interface AutosaveDraft {
  id: string;
  workspaceId: string;
  organizationId: string;
  documentId: string;
  /** Owner of the draft. Drafts are private to their author. */
  userId: string;
  /** Distinguishes concurrent sessions by the same user. */
  deviceId: string;
  /** Document version this draft was branched from. */
  baseVersion: number;
  /** Document revision the client believed current when it wrote. */
  expectedRevision: number;
  /**
   * Object-storage key of the serialized editor state. The bytes are opaque to
   * the server; only their key, checksum, and size are persisted here.
   */
  snapshotKey: string;
  /**
   * Monotonic per-draft counter embedded in `snapshotKey`. A new snapshot is
   * written under a fresh generation before the row is repointed, so a failed
   * write never corrupts the snapshot a draft still references.
   */
  snapshotGeneration: number;
  /** sha256 of the snapshot bytes, computed server-side — a client checksum is not trusted. */
  checksum: string;
  byteSize: number;
  status: AutosaveDraftStatus;
  /** Set only when `status` is "conflict". */
  failureReason: string | null;
  /** Device currently holding the write lease, if any. */
  leaseOwnerDeviceId: string | null;
  leaseExpiresAt: Date | null;
  /** Optimistic concurrency counter. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resolves a caller-supplied listing limit to one the adapters will honour.
 *
 * Shared by both adapters so a listing cannot be wider in one than the other.
 * `Infinity` means "no bound of my own", which the domain cap answers; anything
 * unusable (NaN, zero, negative) falls back to a single row rather than to
 * everything, so a bad limit can never widen a read.
 */
export function autosaveDraftListLimit(limit: number): number {
  if (Number.isNaN(limit) || limit <= 0) return 1;
  return Math.min(Math.trunc(limit), AUTOSAVE_DRAFT_LIMITS.maxDraftsPerDocument);
}

/**
 * When a draft becomes eligible for purge. Derived from `updatedAt` rather than
 * stored: a persisted copy would need rewriting on every save and could drift
 * from the retention policy it was written under.
 */
export function autosaveDraftExpiresAt(draft: Pick<AutosaveDraft, "updatedAt">): Date {
  return new Date(draft.updatedAt.getTime() + AUTOSAVE_DRAFT_LIMITS.retentionMs);
}

/**
 * Builds the object-storage key for a draft snapshot.
 *
 * The key is partitioned by tenant identity (workspace → document → user →
 * device) so one identity's snapshots can never be addressed under another's
 * prefix. The device id is hashed rather than interpolated: it is client-chosen,
 * so putting it in a path verbatim would let a caller shape the key. The
 * generation suffix makes each write land on a fresh key, which is what allows a
 * replacement to be staged before the old snapshot is dropped.
 */
export function autosaveSnapshotKey(input: {
  workspaceId: string;
  documentId: string;
  userId: string;
  deviceIdHash: string;
  generation: number;
}): string {
  return [
    "workspaces",
    input.workspaceId,
    "autosave",
    input.documentId,
    input.userId,
    input.deviceIdHash,
    `${input.generation}.json`,
  ].join("/");
}
