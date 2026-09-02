/**
 * The canonical document handoff: how a produced PDF moves between surfaces.
 *
 * A tool result and the editor are two different pages. Before this, moving a
 * result into the editor meant the user downloading the file, finding it in their
 * Downloads folder, and uploading it again — which is also the only reason a
 * generated name ever came back into the product carrying a `(1)` marker.
 *
 * ## Why IndexedDB and not something simpler
 *
 * The candidates, and why each is rejected:
 *
 *  - **Navigation state / a module-level variable** — Next's client router keeps
 *    the JS context across a `push`, so this *usually* works and fails exactly
 *    when the user reloads, opens in a new tab, or the route is hit after a full
 *    navigation. A handoff that silently opens a blank editor some of the time is
 *    worse than one that fails loudly.
 *  - **The URL** — a base64 PDF in a query string is megabytes of URL, lands in
 *    history, and dies at the browser's length limit.
 *  - **`sessionStorage`** — string-only, so bytes cost a third more as base64, and
 *    capped near 5 MB. A two-page scan exceeds that.
 *  - **A server round trip** — uploading a browser-tool result to PDFDadi so the
 *    editor can download it again would send the user's document to a server that
 *    had no reason to see it. That is the privacy invariant of every local tool.
 *
 * IndexedDB stores `Uint8Array` natively, is asynchronous, and its quota scales
 * with the disk. The adapter already exists (`IndexedDbKeyValueStore`), so this
 * module is the POLICY — key naming, expiry, the size ceiling, single-consumption
 * — over a store it does not implement.
 *
 * ## Its own database
 *
 * `pdfdadi-handoff`, not the draft database. A handoff is in-flight workflow
 * state that is deleted the moment it is consumed; a draft is the user's work.
 * Sharing one store would make "are there unsaved drafts?" answer yes because a
 * merge result happened to be in transit.
 */

import type { KeyValueStore } from "@/src/application/editor/persistence/ports";
import { IndexedDbKeyValueStore } from "@/src/infrastructure/persistence/browser/IndexedDbKeyValueStore";

/** Where a handoff came from. Safe to log: no document content, no bytes. */
export interface HandoffProvenance {
  /** The tool that produced it, e.g. `merge-pdf`. Null for an editor export. */
  toolSlug: string | null;
  /** The input filenames, in the order the user supplied them. */
  sourceFileNames: readonly string[];
  /** The Workspace the work started in, when it started in one. */
  workspaceId: string | null;
  /** The Workspace document it was derived from, when there was one. */
  sourceDocumentId: string | null;
}

/**
 * One produced document, in transit between two surfaces.
 *
 * Bytes, always — not a URL. A single representation is what keeps the receiving
 * end from growing two code paths, and the editor runs in the browser, so bytes
 * are what it needs either way. A server job's output is fetched through the
 * authorized result route by whoever creates the handoff, so the expiring signed
 * URL never has to survive a navigation.
 */
export interface DocumentHandoff {
  id: string;
  fileName: string;
  mimeType: "application/pdf";
  bytes: Uint8Array;
  provenance: HandoffProvenance;
  /** Epoch millis. Used only for expiry — never displayed. */
  createdAt: number;
}

const DB_NAME = "pdfdadi-handoff";
const KEY_PREFIX = "handoff:";

/**
 * How long a handoff may sit unclaimed.
 *
 * Long enough to cover a slow editor load and a user who takes a phone call
 * mid-navigation; short enough that a handoff cannot outlive the intent that
 * created it and open yesterday's merge over today's document.
 */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

/**
 * The largest result that may travel this way.
 *
 * Not a storage limit — IndexedDB would take far more. It is the point past which
 * structured-cloning the bytes twice (write, then read) costs more than it saves,
 * and the user is better served by the download they already have.
 */
export const HANDOFF_MAX_BYTES = 100 * 1024 * 1024;

export const HANDOFF_QUERY_PARAM = "handoff";

/** The IndexedDB key for a handoff id. */
export function handoffKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/** True when this handoff is too old to open. */
export function isExpired(handoff: { createdAt: number }, now: number): boolean {
  return now - handoff.createdAt >= HANDOFF_TTL_MS;
}

/**
 * Validates a value read back out of the browser database.
 *
 * Everything in IndexedDB is `unknown`: it was written by a previous version of
 * this code, or by a user with a devtools console. A handoff that does not
 * type-check is discarded rather than opened.
 */
export function parseHandoff(value: unknown): DocumentHandoff | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const bytes = v.bytes;
  if (
    typeof v.id !== "string" ||
    typeof v.fileName !== "string" ||
    v.mimeType !== "application/pdf" ||
    typeof v.createdAt !== "number" ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0
  ) {
    return null;
  }
  const p = (typeof v.provenance === "object" && v.provenance !== null ? v.provenance : {}) as Record<
    string,
    unknown
  >;
  return {
    id: v.id,
    fileName: v.fileName,
    mimeType: "application/pdf",
    bytes,
    createdAt: v.createdAt,
    provenance: {
      toolSlug: typeof p.toolSlug === "string" ? p.toolSlug : null,
      sourceFileNames: Array.isArray(p.sourceFileNames)
        ? p.sourceFileNames.filter((n): n is string => typeof n === "string")
        : [],
      workspaceId: typeof p.workspaceId === "string" ? p.workspaceId : null,
      sourceDocumentId: typeof p.sourceDocumentId === "string" ? p.sourceDocumentId : null,
    },
  };
}

/** A `File` the editor can open, from a claimed handoff. */
export function handoffFile(handoff: DocumentHandoff): File {
  // A fresh copy: the stored array may be a view over a larger buffer, and File
  // would otherwise carry the whole backing store.
  return new File([new Uint8Array(handoff.bytes)], handoff.fileName, {
    type: handoff.mimeType,
  });
}

/**
 * The handoff store. Injectable so the three operations below can be tested
 * against the existing IndexedDB fake instead of a real browser database.
 */
export function handoffStore(): KeyValueStore {
  return new IndexedDbKeyValueStore({ databaseName: DB_NAME });
}

/** Why a handoff could not be created or claimed. Reported, never swallowed. */
export type HandoffFailure = "unavailable" | "too_large" | "missing" | "expired";

export class HandoffError extends Error {
  constructor(readonly failure: HandoffFailure) {
    super(failure);
    this.name = "HandoffError";
  }
}

/**
 * Stores a produced document and returns its id, for a URL the next page reads.
 *
 * The id is a random token rather than a guessable counter — not because it
 * protects anything (the database is same-origin and already the user's own) but
 * because two results in two tabs must not collide on one slot.
 */
export async function createHandoff(
  input: {
    fileName: string;
    bytes: Uint8Array;
    provenance: HandoffProvenance;
    now?: number;
    newId?: () => string;
  },
  db: KeyValueStore = handoffStore(),
): Promise<string> {
  if (input.bytes.byteLength > HANDOFF_MAX_BYTES) throw new HandoffError("too_large");
  if (!db.isAvailable()) throw new HandoffError("unavailable");
  const id = (input.newId ?? defaultId)();
  const handoff: DocumentHandoff = {
    id,
    fileName: input.fileName,
    mimeType: "application/pdf",
    bytes: input.bytes,
    provenance: input.provenance,
    createdAt: input.now ?? Date.now(),
  };
  await db.putAll([{ key: handoffKey(id), value: handoff }]);
  return id;
}

/**
 * Reads a handoff and DELETES it, whether or not it turned out to be usable.
 *
 * Single consumption is the property that makes a stale handoff impossible: a
 * reload of `/editor?handoff=…` after the first open finds nothing rather than
 * re-opening the document over whatever the user has been editing since. The
 * delete is awaited before the bytes are returned so a crash mid-open cannot
 * leave the slot armed.
 */
export async function claimHandoff(
  id: string,
  now = Date.now(),
  db: KeyValueStore = handoffStore(),
): Promise<DocumentHandoff> {
  if (!db.isAvailable()) throw new HandoffError("unavailable");
  const key = handoffKey(id);
  const raw = await db.get(key);
  await db.deleteAll([key]);
  const handoff = parseHandoff(raw);
  if (!handoff) throw new HandoffError("missing");
  if (isExpired(handoff, now)) throw new HandoffError("expired");
  return handoff;
}

/**
 * Deletes every handoff older than the TTL.
 *
 * ponytail: called opportunistically when a result page creates a handoff, rather
 * than on a timer. A sweep on a schedule would be a background task whose only job
 * is deleting at most a few megabytes the next sweep would get anyway; if handoffs
 * ever become large or frequent, move this to an idle callback.
 */
export async function sweepHandoffs(
  now = Date.now(),
  db: KeyValueStore = handoffStore(),
): Promise<number> {
  if (!db.isAvailable()) return 0;
  const keys = await db.keysWithPrefix(KEY_PREFIX);
  if (keys.length === 0) return 0;
  const values = await db.getMany(keys);
  const stale = keys.filter((_, i) => {
    const parsed = parseHandoff(values[i]);
    return parsed === null || isExpired(parsed, now);
  });
  if (stale.length > 0) await db.deleteAll(stale);
  return stale.length;
}

function defaultId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
