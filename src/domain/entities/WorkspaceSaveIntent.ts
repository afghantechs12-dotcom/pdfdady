/**
 * A user's INTENTION to save a result into a Workspace, as a persistent fact.
 *
 * Three identities are involved in "save this result", and the previous closeout
 * had one row for all three:
 *
 *   1. **the intention** — one press of Save, however many HTTP requests it takes;
 *   2. **the document** — the logical Workspace file that intention produced;
 *   3. **the content** — `sha256(bytes)` and the object it addresses.
 *
 * Content was doing all three jobs, through `DocumentIngestion @@unique([
 * workspaceId, checksum])`. That is a true statement about bytes and a false one
 * about operations, and it cost two behaviours: saving one file deliberately twice
 * produced one document under the first name, and saving → trashing → saving the
 * same bytes again violated the constraint and answered 500.
 *
 * This entity owns identity 1 and nothing else. It is not authorization: every
 * save still resolves its actor, its Workspace membership, its destination and its
 * payload before this row is consulted, and the row is scoped to the actor so one
 * member's key can never reach — or reveal — another member's operation.
 */

/** Which surface produced the result being saved. Part of an intention's meaning. */
export type SaveIntentSourceKind = "local-result" | "processing-job";

/**
 * `pending` — claimed, work in flight. `completed` — the document exists and the
 * row names it. `failed` — the attempt did not persist a document, and the same
 * key may be retried.
 */
export type SaveIntentStatus = "pending" | "completed" | "failed";

export interface WorkspaceSaveIntent {
  id: string;
  key: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
  sourceKind: SaveIntentSourceKind;
  sourceIdentity: string;
  payloadChecksum: string;
  status: SaveIntentStatus;
  documentId: string | null;
  ingestionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What a caller presents to claim an intention: the opaque key, plus what that
 * key MEANS. The destination is not here because the destination is the
 * Workspace the save is addressed to, and the server reads it from there rather
 * than from anything the client says twice.
 */
export interface SaveIntentRequest {
  key: string;
  sourceKind: SaveIntentSourceKind;
  sourceIdentity: string;
}

export const SAVE_INTENT_LIMITS = {
  /**
   * Long enough that a key cannot be a filename, a document id, a sequence
   * number or anything else guessable. `crypto.randomUUID()` is 36 characters, so
   * the client's own generator clears this by a wide margin; the bound exists to
   * refuse a *hand-written* key like "save1" rather than to measure entropy,
   * which a server cannot do.
   */
  minKeyLength: 16,
  maxKeyLength: 200,
  /** A job id, a result id — bounded so the column cannot be used as storage. */
  maxSourceIdentityLength: 200,
  /**
   * How long a `pending` claim is honoured before another request may take it
   * over. A claim is only abandoned by a process that died mid-save; a live save
   * finishes in well under a second, and the concurrent-request path waits for
   * the winner rather than waiting this out.
   */
  staleClaimMs: 60_000,
  /** How long a losing concurrent request waits for the winner's document. */
  convergenceTimeoutMs: 5_000,
  convergencePollMs: 50,
} as const;

/**
 * Keys are opaque to the server, so the only thing to check is that this one
 * could plausibly BE a key: printable, bounded, and not a short guessable label.
 *
 * Deliberately not a format: the client is free to change how it mints keys
 * (§ `lib/workflow/saveIntent.ts`) without a server deployment, and pinning a UUID
 * shape here would make the two halves have to ship together.
 */
const KEY_PATTERN = /^[A-Za-z0-9_.:@-]+$/u;

export function normalizeSaveIntentKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < SAVE_INTENT_LIMITS.minKeyLength) return null;
  if (trimmed.length > SAVE_INTENT_LIMITS.maxKeyLength) return null;
  if (!KEY_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function isSaveIntentSourceKind(value: unknown): value is SaveIntentSourceKind {
  return value === "local-result" || value === "processing-job";
}
