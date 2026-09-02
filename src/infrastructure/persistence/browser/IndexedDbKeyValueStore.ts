import type { KeyValueEntry, KeyValueStore } from "@/src/application/editor/persistence/ports";
import { persistenceFailure, type PersistenceFailure } from "@/src/application/editor/persistence/events";

/**
 * The {@link KeyValueStore} port over IndexedDB — the only place in the client
 * that touches the browser database directly.
 *
 * WHY INDEXEDDB AND NOT localStorage. A draft carries the original PDF bytes, the
 * imported images, and a full scene graph. `localStorage` is synchronous (so
 * every write janks the frame that made the edit), string-only (so bytes cost a
 * third more as base64), and capped near 5 MB per origin with no way to ask for
 * more. A one-page scanned PDF exceeds that on its own. IndexedDB stores
 * `Uint8Array` natively via structured clone, is asynchronous, and is the only
 * origin store with a quota that scales with the disk.
 *
 * ONE OBJECT STORE, NAMESPACED KEYS. Snapshots, assets, pointers and index rows
 * all live in `entries`, keyed by the strings `draftKeys` builds. That is
 * deliberate: {@link putAll} must be able to write a snapshot, its assets, the
 * pointer and the index row in ONE transaction, and an IndexedDB transaction can
 * only span stores it was opened over. Splitting by kind would buy nothing and
 * would make the pointer swap non-atomic, which is the single guarantee the
 * draft repository is built on. Prefix scans use
 * `IDBKeyRange.bound(prefix, prefix + "￿")` — `￿` is above every
 * character the key builders emit, so the range is exactly "keys starting with
 * this prefix" and the scan reads keys only, never values.
 *
 * AVAILABILITY IS NOT A FAILURE. Firefox in permanent private browsing, Safari
 * with site data blocked, and a sandboxed iframe all reject `open()` — and none
 * of them will succeed on retry. {@link isAvailable} reports that state up front
 * so the UI can say "this browser will not store drafts" instead of showing a
 * Retry button that can never work.
 */

export const DRAFT_DB_NAME = "pdfdadi-drafts";
export const DRAFT_DB_VERSION = 1;
export const DRAFT_STORE_NAME = "entries";

export interface IndexedDbKeyValueStoreOptions {
  /**
   * Injected so tests can supply a fake. Defaults to `globalThis.indexedDB`,
   * read lazily — the module is imported during SSR, where there is none.
   */
  factory?: IDBFactory | null;
  databaseName?: string;
  storeName?: string;
  version?: number;
  /** Bounds every request. A hung transaction must not hang the save queue. */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** The upper bound of a prefix scan: above every character the key builders emit. */
const PREFIX_MAX = "￿";

function resolveFactory(explicit: IDBFactory | null | undefined): IDBFactory | null {
  if (explicit !== undefined) return explicit;
  const candidate = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  return candidate ?? null;
}

/**
 * DOMException names, mapped to the failure vocabulary.
 *
 * The names are matched rather than the messages: messages are localised and
 * differ per engine, and a message match would quietly stop working in a browser
 * nobody tested. `name` is specified.
 */
function classifyDomError(error: unknown): PersistenceFailure {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  switch (name) {
    case "QuotaExceededError":
      return persistenceFailure("quota_exceeded", "The browser is out of space for saved drafts.");
    case "AbortError":
      return persistenceFailure("transaction_aborted", "The browser interrupted the save. It will be retried.");
    case "SecurityError":
    case "InvalidStateError":
    case "NotAllowedError":
      // Private browsing, blocked site data, or a closing connection. None of
      // these become true by trying again.
      return persistenceFailure("storage_unavailable", "This browser is not allowing local storage for this site.");
    case "DataCloneError":
      // A value the structured-clone algorithm refuses. That is a defect in what
      // was handed to the store, not a transient condition.
      return persistenceFailure("integrity_failed", "A draft value could not be stored by this browser.");
    case "VersionError":
      return persistenceFailure("unsupported_schema", "A newer version of this app has upgraded the local draft database.");
    case "TimeoutError":
      return persistenceFailure("timeout", "The browser did not finish the local save in time.");
    case "UnknownError":
      // Safari and Firefox both report low-level disk errors this way.
      return persistenceFailure("transaction_aborted", "The browser could not complete the local save.");
    default:
      return persistenceFailure("unknown", error instanceof Error ? error.message : "Local storage failed.");
  }
}

/**
 * A rejection this adapter raised itself, so `classifyError` can recognise its
 * own categories without matching on prose.
 */
class IndexedDbStoreError extends Error {
  constructor(readonly failure: PersistenceFailure) {
    super(failure.message);
    this.name = "IndexedDbStoreError";
  }
}

export class IndexedDbKeyValueStore implements KeyValueStore {
  private readonly factory: IDBFactory | null;
  private readonly databaseName: string;
  private readonly storeName: string;
  private readonly version: number;
  private readonly timeoutMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private connection: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  /**
   * Set once `open()` has failed in a way that cannot succeed later. Without it
   * every scheduled write would re-attempt the same blocked open, and the UI
   * would flicker between "saving locally" and "no local storage".
   */
  private unavailable = false;

  constructor(options: IndexedDbKeyValueStoreOptions = {}) {
    this.factory = resolveFactory(options.factory);
    this.databaseName = options.databaseName ?? DRAFT_DB_NAME;
    this.storeName = options.storeName ?? DRAFT_STORE_NAME;
    this.version = options.version ?? DRAFT_DB_VERSION;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  isAvailable(): boolean {
    return this.factory !== null && !this.unavailable;
  }

  async get(key: string): Promise<unknown> {
    const [value] = await this.getMany([key]);
    return value;
  }

  async getMany(keys: readonly string[]): Promise<unknown[]> {
    if (keys.length === 0) return [];
    return this.transact("readonly", (store) =>
      Promise.all(keys.map((key) => this.request<unknown>(store.get(key)))),
    );
  }

  async putAll(entries: readonly KeyValueEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.transact("readwrite", async (store) => {
      /*
       * Every `put` is awaited. Firing them all and awaiting the transaction's
       * `complete` would also work, but a per-request error would then surface as
       * a bare abort with no indication of WHICH value the browser refused —
       * and `DataCloneError` on one asset is a different diagnosis from the disk
       * being full.
       */
      for (const entry of entries) await this.request(store.put(entry.value, entry.key));
    });
  }

  async deleteAll(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.transact("readwrite", async (store) => {
      for (const key of keys) await this.request(store.delete(key));
    });
  }

  async keysWithPrefix(prefix: string): Promise<string[]> {
    // `getAllKeys` over a bounded range: the values are never deserialized, so
    // scanning an index does not pull megabytes of PDF bytes into memory.
    const range = IDBKeyRange.bound(prefix, prefix + PREFIX_MAX, false, false);
    const keys = await this.transact("readonly", (store) =>
      this.request<IDBValidKey[]>(store.getAllKeys(range)),
    );
    return keys.map(String);
  }

  classifyError(error: unknown): PersistenceFailure {
    if (error instanceof IndexedDbStoreError) return error.failure;
    return classifyDomError(error);
  }

  /** Closes the connection. Safe to call twice; a later call reopens on demand. */
  close(): void {
    this.connection?.close();
    this.connection = null;
    this.opening = null;
  }

  // ---------------------------------------------------------------- internals

  private async transact<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let result: T;
      let tx: IDBTransaction;
      try {
        tx = db.transaction(this.storeName, mode);
      } catch (error) {
        /*
         * `InvalidStateError` here means the connection was closed underneath us
         * — a `versionchange` from another tab, or the browser evicting the
         * database. Dropping the handle means the next call reopens rather than
         * failing forever against a dead connection.
         */
        this.connection = null;
        this.opening = null;
        reject(new IndexedDbStoreError(classifyDomError(error)));
        return;
      }

      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        try {
          tx.abort();
        } catch {
          // Already finished or already aborting; nothing to do.
        }
        reject(new IndexedDbStoreError(persistenceFailure("timeout", "The browser did not finish the local save in time.")));
      }, this.timeoutMs);

      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        reject(new IndexedDbStoreError(this.classifyError(error)));
      };

      // `complete` — not the last request's success — is what makes the batch
      // atomic. Resolving earlier would let the repository advance its pointer
      // over a transaction the browser went on to abort.
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve(result);
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error ?? new DOMException("Transaction aborted", "AbortError"));

      let store: IDBObjectStore;
      try {
        store = tx.objectStore(this.storeName);
      } catch (error) {
        fail(error);
        return;
      }

      Promise.resolve(run(store)).then(
        (value) => {
          result = value;
        },
        (error) => {
          try {
            tx.abort();
          } catch {
            // The abort itself is best-effort; the rejection below is the report.
          }
          fail(error);
        },
      );
    });
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        /*
         * Stop the error from reaching the transaction as an unhandled request
         * error, which would abort the transaction with the ORIGINAL cause
         * replaced by a bare AbortError. `putAll` needs to report quota-exceeded
         * as quota-exceeded.
         */
        request.transaction?.abort();
        reject(request.error);
      };
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.connection) return Promise.resolve(this.connection);
    if (this.opening) return this.opening;
    const factory = this.factory;
    if (!factory || this.unavailable) {
      return Promise.reject(
        new IndexedDbStoreError(
          persistenceFailure("storage_unavailable", "This browser is not allowing local storage for this site."),
        ),
      );
    }

    this.opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.databaseName, this.version);
      } catch (error) {
        // Sandboxed iframes throw synchronously rather than rejecting.
        this.markUnavailable(error);
        reject(new IndexedDbStoreError(this.classifyError(error)));
        return;
      }

      const timer = this.setTimer(() => {
        /*
         * A blocked open never calls back at all: Firefox in permanent private
         * browsing simply goes quiet. Treated as unavailable rather than as a
         * timeout, because the next attempt would go quiet in exactly the same
         * way and the user is owed a truthful "this browser will not store
         * drafts".
         */
        this.unavailable = true;
        this.opening = null;
        reject(
          new IndexedDbStoreError(
            persistenceFailure("storage_unavailable", "This browser did not open its local database."),
          ),
        );
      }, this.timeoutMs);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          // Out-of-line keys: the key strings `draftKeys` builds are the whole
          // schema, and a keyPath would force every value to be an object.
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = () => {
        this.clearTimer(timer);
        const db = request.result;
        /*
         * Another tab running a newer build asks for a version upgrade. Closing
         * here is what lets that upgrade proceed instead of deadlocking both
         * tabs; the next call reopens at the new version.
         */
        db.onversionchange = () => {
          db.close();
          this.connection = null;
          this.opening = null;
        };
        db.onclose = () => {
          this.connection = null;
          this.opening = null;
        };
        this.connection = db;
        this.opening = null;
        resolve(db);
      };

      request.onerror = () => {
        this.clearTimer(timer);
        this.opening = null;
        this.markUnavailable(request.error);
        reject(new IndexedDbStoreError(this.classifyError(request.error)));
      };

      request.onblocked = () => {
        // An older tab is holding the previous version open. Not fatal and not
        // permanent: the timer above resolves it either way.
      };
    });

    return this.opening;
  }

  /** Latches `unavailable` only for causes that cannot change on retry. */
  private markUnavailable(error: unknown): void {
    if (this.classifyError(error).category === "storage_unavailable") this.unavailable = true;
  }
}
