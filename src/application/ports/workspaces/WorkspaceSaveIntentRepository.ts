import type {
  SaveIntentSourceKind,
  WorkspaceSaveIntent,
} from "@/src/domain/entities/WorkspaceSaveIntent";

/**
 * WHO the intention belongs to. The uniqueness scope, and the reason a key is
 * never an existence oracle: a key presented by a different actor addresses a
 * different row, so it cannot reach — or reveal — another actor's operation.
 */
export interface SaveIntentIdentity {
  organizationId: string;
  userId: string;
  key: string;
}

/**
 * WHAT the intention means. All four fields together: the same key with a
 * different destination, a different source result or different bytes is a
 * different intention, and the service refuses it rather than guessing which of
 * the two the user meant.
 */
export interface SaveIntentMeaning {
  workspaceId: string;
  sourceKind: SaveIntentSourceKind;
  sourceIdentity: string;
  payloadChecksum: string;
}

/**
 * Persistence port for save-operation identity.
 *
 * Deliberately PRIMITIVE. The policy — what counts as the same intention, how long
 * a claim is honoured, how long a losing request waits — lives in
 * `WorkspaceAwareUploadService`, so it is stated once and cannot drift between the
 * Prisma adapter and the in-memory twin. What the adapters owe is atomicity:
 * `insertPending` must fail rather than duplicate, and `takeOverStale` must be a
 * compare-and-swap, because those are the two things a process-local lock cannot
 * provide across workers and restarts.
 */
export interface WorkspaceSaveIntentRepository {
  /**
   * Claims this identity by inserting a `pending` row.
   *
   * Returns null when the row already exists — the unique index
   * `(organizationId, userId, key)` is the mutual exclusion, so exactly one
   * concurrent request gets the claim and the rest are told to look.
   */
  insertPending(
    identity: SaveIntentIdentity,
    meaning: SaveIntentMeaning,
  ): Promise<WorkspaceSaveIntent | null>;

  /** The recorded intention for this identity, or null. Never cross-actor. */
  find(identity: SaveIntentIdentity): Promise<WorkspaceSaveIntent | null>;

  /**
   * Re-claims a row for a fresh attempt — one that `failed`, or one left
   * `pending` by a process that died mid-save — conditional on it not having
   * moved since it was read (`expectedUpdatedAt`). False means somebody else got
   * there first, and the caller must look again rather than proceed.
   *
   * A `completed` row is never re-claimable through this: its document exists,
   * and the answer to that identity is that document. `meaning` is rewritten
   * because the row must describe the attempt that now owns it.
   */
  reclaim(id: string, expectedUpdatedAt: Date, meaning: SaveIntentMeaning): Promise<boolean>;

  /**
   * Records the document this intention produced. Called only after the document
   * and its ingestion are durable — a row marked `completed` before the write
   * commits would hand a retry an id that does not exist.
   */
  complete(id: string, documentId: string, ingestionId: string): Promise<void>;

  /** Marks a claim released after a failed attempt, so the same key may retry. */
  fail(id: string): Promise<void>;
}
