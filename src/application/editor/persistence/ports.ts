import type { PersistenceFailure } from "./events";

/**
 * Ports the persistence layer needs from the outside world.
 *
 * Narrow on purpose. The draft repository's guarantees — a snapshot that is
 * either wholly visible or not visible at all, one known-good generation at all
 * times — are expressed in terms of these three operations and nothing else, so
 * they can be reasoned about, and tested, without IndexedDB in the room.
 */

export interface KeyValueEntry {
  key: string;
  value: unknown;
}

export interface KeyValueStore {
  /**
   * Whether this context can store anything at all.
   *
   * Separate from a failed write: private browsing and blocked site data are not
   * transient errors and must not be presented as retryable.
   */
  isAvailable(): boolean;

  get(key: string): Promise<unknown>;

  /** Reads several keys in one transaction. Missing keys come back `undefined`. */
  getMany(keys: readonly string[]): Promise<unknown[]>;

  /**
   * Writes every entry in ONE transaction: all of them land, or none do.
   *
   * This is the atomicity the pointer swap depends on. A pointer that advanced
   * while its index entry did not would leave a draft that loads but cannot be
   * found, and the reverse would advertise a draft that cannot be loaded.
   */
  putAll(entries: readonly KeyValueEntry[]): Promise<void>;

  /** Deletes keys in one transaction. Missing keys are not an error. */
  deleteAll(keys: readonly string[]): Promise<void>;

  /** Every key beginning with `prefix`, in lexicographic order. */
  keysWithPrefix(prefix: string): Promise<string[]>;

  /** Classifies a rejection from any of the above. */
  classifyError(error: unknown): PersistenceFailure;
}

/** The remote (workspace) side, as the coordinator needs it. */
export interface RemoteSavePayload {
  documentId: string;
  workspaceId: string;
  organizationId: string;
  /** Stable per browser profile; the server uses it to hold a write lease. */
  deviceId: string;
  /** The client's monotonic revision — the ordering authority. */
  revision: number;
  /** The server version the client believes it is writing over. */
  expectedServerVersion: number | null;
  etag: string | null;
  /** The serialized document. Opaque to the transport. */
  snapshot: unknown;
  /**
   * The client's wall clock, as METADATA only.
   *
   * Never an ordering input. Clocks disagree between devices and jump on the same
   * device, and a save ordered by timestamp will eventually let an older edit
   * overwrite a newer one. `revision` and `expectedServerVersion` are the
   * ordering; this is for display and for support diagnostics.
   */
  clientTimestamp: number;
}

export type RemoteSaveOutcome =
  | { kind: "saved"; serverVersion: number | null; etag: string | null }
  | {
      kind: "conflict";
      actualServerVersion: number | null;
      expectedServerVersion: number | null;
      detail: string | null;
    }
  | { kind: "failed"; failure: PersistenceFailure };

export interface RemoteDocumentTransport {
  save(payload: RemoteSavePayload, signal?: AbortSignal): Promise<RemoteSaveOutcome>;
  /**
   * The server's current version for this document, for the reconnect check.
   *
   * Deliberately separate from `save`: on reconnect the client must find out
   * whether the server moved on BEFORE sending anything, or its first action after
   * an outage is to overwrite whatever happened during it.
   */
  readVersion(input: {
    documentId: string;
    workspaceId: string;
    organizationId: string;
    deviceId: string;
  }): Promise<{ serverVersion: number | null; etag: string | null } | null>;
}
