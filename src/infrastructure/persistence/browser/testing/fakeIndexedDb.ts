/**
 * A small IndexedDB implementation, faithful in exactly the ways the adapter's
 * correctness depends on.
 *
 * WHY NOT A LIBRARY. `fake-indexeddb` is not a dependency of this project, and the
 * three behaviours worth testing here are not the ones a full implementation is
 * needed for — they are the *failure* paths, and none of them can be provoked from
 * a real browser database on demand: an `open()` that never calls back, a
 * `QuotaExceededError` on the third of four writes, a `versionchange` from a tab
 * that does not exist.
 *
 * WHAT IS MODELLED ON PURPOSE:
 *
 *  - **Events are tasks, not microtasks.** Every callback fires from a
 *    `setTimeout`, exactly as the real thing dispatches events. This is not
 *    pedantry: the adapter aborts a transaction from inside a request's `onerror`
 *    so the original cause survives, and that only works if the abort event
 *    arrives *after* the promise rejection chain has run. Firing events
 *    synchronously — or as microtasks — would let `AbortError` overtake
 *    `QuotaExceededError` and the test would enshrine the wrong behaviour.
 *  - **Writes are buffered until commit.** A transaction that aborts must leave the
 *    database exactly as it was; a fake that wrote through would make the atomicity
 *    the draft repository depends on untestable.
 *  - **Auto-commit on a drained queue.** The transaction completes once no request
 *    is outstanding at the end of a task, which is what lets `await`-per-request
 *    work in a browser and what would break if it were awaited across a macrotask.
 *  - **Structured clone on the way in and out.** A caller that mutates the array it
 *    just stored must not change what is stored.
 */

interface FakeFault {
  op: "get" | "put" | "delete" | "getAllKeys";
  /** DOMException name to raise. */
  name: string;
  /** How many times to raise it. */
  times: number;
  match?: (key: string) => boolean;
}

export type FakeOpenBehaviour =
  | { kind: "success" }
  /** `open()` rejects with this DOMException name. */
  | { kind: "error"; name: string }
  /** `open()` throws synchronously, as a sandboxed iframe does. */
  | { kind: "throw"; name: string }
  /** `open()` never calls back at all, as private-browsing Firefox does. */
  | { kind: "silent" }
  /** `onblocked` fires and then nothing else, as an older tab holding v1 does. */
  | { kind: "blocked" };

function domError(name: string): DOMException {
  return new DOMException(`fake ${name}`, name);
}

function fire(handler: (() => void) | null | undefined): void {
  if (!handler) return;
  setTimeout(() => handler(), 0);
}

class FakeRequest<T> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  result!: T;
  error: DOMException | null = null;
  transaction: FakeTransaction | null;

  constructor(transaction: FakeTransaction | null) {
    this.transaction = transaction;
  }
}

class FakeObjectStore {
  constructor(private readonly tx: FakeTransaction) {}

  get(key: string) {
    return this.tx.enqueue<unknown>("get", key, () => {
      this.tx.backend.valueReads += 1;
      return this.tx.read(key);
    });
  }

  put(value: unknown, key: string) {
    return this.tx.enqueue<void>("put", key, () => {
      if (this.tx.mode !== "readwrite") throw domError("ReadOnlyError");
      this.tx.writes.push({ type: "put", key, value: structuredClone(value) });
      return undefined;
    });
  }

  delete(key: string) {
    return this.tx.enqueue<void>("delete", key, () => {
      if (this.tx.mode !== "readwrite") throw domError("ReadOnlyError");
      this.tx.writes.push({ type: "delete", key });
      return undefined;
    });
  }

  getAllKeys(range?: FakeKeyRange) {
    return this.tx.enqueue<string[]>("getAllKeys", "", () => {
      this.tx.backend.keyScans += 1;
      return this.tx.keys().filter((key) => (range ? range.includes(key) : true));
    });
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: DOMException | null = null;
  readonly writes: Array<{ type: "put" | "delete"; key: string; value?: unknown }> = [];
  private pending = 0;
  private settled = false;

  constructor(
    readonly backend: FakeBackend,
    readonly storeName: string,
    readonly mode: IDBTransactionMode,
  ) {}

  objectStore(name: string): FakeObjectStore {
    if (name !== this.storeName) throw domError("NotFoundError");
    if (this.settled) throw domError("InvalidStateError");
    return new FakeObjectStore(this);
  }

  read(key: string): unknown {
    for (let i = this.writes.length - 1; i >= 0; i -= 1) {
      const write = this.writes[i]!;
      if (write.key !== key) continue;
      return write.type === "put" ? structuredClone(write.value) : undefined;
    }
    const stored = this.backend.data.get(key);
    return stored === undefined ? undefined : structuredClone(stored);
  }

  keys(): string[] {
    const keys = new Set(this.backend.data.keys());
    for (const write of this.writes) {
      if (write.type === "put") keys.add(write.key);
      else keys.delete(write.key);
    }
    return [...keys].sort();
  }

  enqueue<T>(op: FakeFault["op"], key: string, run: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>(this);
    this.pending += 1;
    setTimeout(() => {
      if (this.backend.takeHang(op)) {
        // Never settles and never decrements `pending`, so the transaction cannot
        // auto-commit either. The adapter's own deadline is the only way out — which
        // is the entire point of having one.
        return;
      }
      this.pending -= 1;
      if (this.settled) return;
      const fault = this.backend.takeFault(op, key);
      if (fault) {
        request.error = domError(fault);
        request.onerror?.();
        this.scheduleCommitCheck();
        return;
      }
      try {
        request.result = run();
      } catch (error) {
        request.error = error as DOMException;
        request.onerror?.();
        this.scheduleCommitCheck();
        return;
      }
      request.onsuccess?.();
      this.scheduleCommitCheck();
    }, 0);
    return request;
  }

  /**
   * Commits once a task ends with nothing outstanding.
   *
   * The delay is what makes `await`-per-request legal: the caller's continuation is
   * a microtask, so a follow-up request is issued before this check runs.
   */
  private scheduleCommitCheck(): void {
    setTimeout(() => {
      if (this.settled || this.pending > 0) return;
      this.settled = true;
      for (const write of this.writes) {
        if (write.type === "put") this.backend.data.set(write.key, write.value);
        else this.backend.data.delete(write.key);
      }
      fire(this.oncomplete);
    }, 0);
  }

  /** Discards the buffered writes and reports the abort as a task, like the real API. */
  abort(): void {
    if (this.settled) return;
    this.settled = true;
    this.writes.length = 0;
    fire(this.onabort);
  }
}

class FakeDatabase {
  onversionchange: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  /** Set by the test to make `transaction()` throw, as a dead connection does. */
  transactionThrows: string | null = null;

  constructor(
    private readonly backend: FakeBackend,
    readonly version: number,
  ) {}

  get objectStoreNames() {
    const names = this.backend.stores;
    return {
      contains: (name: string) => names.has(name),
      get length() {
        return names.size;
      },
    };
  }

  createObjectStore(name: string): void {
    this.backend.stores.add(name);
  }

  transaction(storeName: string, mode: IDBTransactionMode): FakeTransaction {
    if (this.transactionThrows) throw domError(this.transactionThrows);
    if (this.closed) throw domError("InvalidStateError");
    if (!this.backend.stores.has(storeName)) throw domError("NotFoundError");
    return new FakeTransaction(this.backend, storeName, mode);
  }

  close(): void {
    this.closed = true;
    fire(this.onclose);
  }

  /** Simulates another tab opening the database at a newer version. */
  emitVersionChange(): void {
    this.onversionchange?.();
  }
}

class FakeBackend {
  readonly data = new Map<string, unknown>();
  readonly stores = new Set<string>();
  readonly faults: FakeFault[] = [];
  /** How many stored values were deserialized. A key scan must not raise this. */
  valueReads = 0;
  keyScans = 0;

  readonly hangs: Array<{ op: FakeFault["op"]; times: number }> = [];

  takeHang(op: FakeFault["op"]): boolean {
    const hang = this.hangs.find((entry) => entry.op === op && entry.times > 0);
    if (!hang) return false;
    hang.times -= 1;
    return true;
  }

  takeFault(op: FakeFault["op"], key: string): string | null {
    const index = this.faults.findIndex(
      (fault) => fault.op === op && fault.times > 0 && (fault.match ? fault.match(key) : true),
    );
    if (index < 0) return null;
    const fault = this.faults[index]!;
    fault.times -= 1;
    return fault.name;
  }
}

export class FakeIndexedDb {
  readonly backend = new FakeBackend();
  /** Every open request, in order, so a latched failure can be proven by count. */
  openCount = 0;
  /** Changed between calls to make the second open behave differently. */
  behaviour: FakeOpenBehaviour = { kind: "success" };
  /** Every connection handed out, for firing `versionchange` at one. */
  readonly connections: FakeDatabase[] = [];
  /** What each open asked for, so the configured name and version can be proven. */
  readonly openRequests: Array<{ name: string; version: number | undefined }> = [];

  open(name: string, version?: number) {
    this.openCount += 1;
    this.openRequests.push({ name, version });
    const behaviour = this.behaviour;
    if (behaviour.kind === "throw") throw domError(behaviour.name);

    const request = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onupgradeneeded: null as (() => void) | null,
      onblocked: null as (() => void) | null,
      result: undefined as unknown as FakeDatabase,
      error: null as DOMException | null,
      transaction: null,
    };

    if (behaviour.kind === "silent") return request;

    setTimeout(() => {
      if (behaviour.kind === "blocked") {
        request.onblocked?.();
        return;
      }
      if (behaviour.kind === "error") {
        request.error = domError(behaviour.name);
        request.onerror?.();
        return;
      }
      const db = new FakeDatabase(this.backend, version ?? 1);
      this.connections.push(db);
      request.result = db;
      const fresh = this.backend.stores.size === 0;
      if (fresh) request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);

    return request;
  }

  /** Makes the next matching request never answer, as a wedged transaction does. */
  hangNext(op: "get" | "put" | "delete" | "getAllKeys"): void {
    this.backend.hangs.push({ op, times: 1 });
  }

  /** Queues a fault for the next matching request. */
  failNext(op: FakeFault["op"], name: string, match?: (key: string) => boolean): void {
    this.backend.faults.push(match ? { op, name, times: 1, match } : { op, name, times: 1 });
  }

  get stored(): Map<string, unknown> {
    return this.backend.data;
  }
}

/** The subset of `IDBKeyRange.bound` the adapter uses. */
export class FakeKeyRange {
  constructor(
    readonly lower: string,
    readonly upper: string,
    readonly lowerOpen: boolean,
    readonly upperOpen: boolean,
  ) {}

  includes(key: string): boolean {
    if (this.lowerOpen ? key <= this.lower : key < this.lower) return false;
    if (this.upperOpen ? key >= this.upper : key > this.upper) return false;
    return true;
  }

  static bound(lower: string, upper: string, lowerOpen = false, upperOpen = false): FakeKeyRange {
    return new FakeKeyRange(lower, upper, lowerOpen, upperOpen);
  }
}

/**
 * Installs `IDBKeyRange` globally, because the adapter reads it off the global the
 * way browser code does rather than taking it as a dependency.
 */
export function installKeyRange(): () => void {
  const globals = globalThis as { IDBKeyRange?: unknown };
  const previous = globals.IDBKeyRange;
  globals.IDBKeyRange = FakeKeyRange;
  return () => {
    globals.IDBKeyRange = previous;
  };
}

/** A `setTimer`/`clearTimer` pair a test drives by hand. */
export function manualTimers() {
  let nextId = 1;
  const live = new Map<number, () => void>();
  return {
    setTimer(fn: () => void): unknown {
      const id = nextId++;
      live.set(id, fn);
      return id;
    },
    clearTimer(handle: unknown): void {
      live.delete(handle as number);
    },
    /** How many timers are still armed. A leaked one keeps a node process alive. */
    liveCount(): number {
      return live.size;
    },
    /** Fires every armed timer, as the clock reaching the deadline would. */
    fireAll(): void {
      const pending = [...live.entries()];
      live.clear();
      for (const [, fn] of pending) fn();
    },
  };
}
