import { persistenceFailure, type PersistenceFailure } from "../events";
import type { KeyValueEntry, KeyValueStore } from "../ports";

/**
 * An in-memory {@link KeyValueStore} with the failure modes IndexedDB actually has.
 *
 * Follows `src/domain/editor/testFactories.ts`: a test double that lives in the
 * source tree because it is shared by several suites, and is imported by nothing
 * that ships.
 *
 * Two behaviours matter more than the storage itself:
 *
 *  - **Structured-clone semantics.** Values are deep-copied on the way in and out,
 *    exactly as IndexedDB does. Without this a test that mutates the object it
 *    stored would see the store change under it, and a repository bug that relied
 *    on shared references would pass here and fail in a browser.
 *  - **Injectable faults.** Quota exhaustion, aborted transactions, and a store
 *    that is simply unavailable are the three conditions this whole subsystem
 *    exists to survive, and none of them can be provoked from a real IndexedDB on
 *    demand.
 */
export interface MemoryStoreFault {
  /** Which operation to fail. */
  operation: "get" | "getMany" | "put" | "delete" | "keys";
  failure: PersistenceFailure;
  /** How many times to fail before recovering. `Infinity` for always. */
  times: number;
  /** Only fail when one of the keys matches this predicate. */
  match?: (key: string) => boolean;
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  private faults: MemoryStoreFault[] = [];
  private available = true;
  /** Total stored characters allowed. `Infinity` disables the limit. */
  quotaChars = Number.POSITIVE_INFINITY;
  /** Every operation, in order, so tests can assert on the commit sequence. */
  readonly log: Array<{ op: string; keys: string[] }> = [];

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  /** Queues a fault. Later calls to the matching operation reject. */
  injectFault(fault: MemoryStoreFault): void {
    this.faults.push({ ...fault });
  }

  clearFaults(): void {
    this.faults = [];
  }

  /** Replaces a stored value with arbitrary garbage, as an evicted page would. */
  corrupt(key: string, value: unknown): void {
    this.data.set(key, JSON.stringify(serialize(value)));
  }

  /** Removes a key behind the repository's back, as storage eviction does. */
  evict(key: string): void {
    this.data.delete(key);
  }

  has(key: string): boolean {
    return this.data.has(key);
  }

  get size(): number {
    return this.data.size;
  }

  keys(): string[] {
    return [...this.data.keys()].sort();
  }

  get usedChars(): number {
    let total = 0;
    for (const value of this.data.values()) total += value.length;
    return total;
  }

  async get(key: string): Promise<unknown> {
    this.log.push({ op: "get", keys: [key] });
    this.maybeFail("get", [key]);
    const raw = this.data.get(key);
    return raw === undefined ? undefined : deserialize(JSON.parse(raw));
  }

  async getMany(keys: readonly string[]): Promise<unknown[]> {
    this.log.push({ op: "getMany", keys: [...keys] });
    this.maybeFail("getMany", keys);
    return keys.map((key) => {
      const raw = this.data.get(key);
      return raw === undefined ? undefined : deserialize(JSON.parse(raw));
    });
  }

  async putAll(entries: readonly KeyValueEntry[]): Promise<void> {
    const keys = entries.map((entry) => entry.key);
    this.log.push({ op: "put", keys });
    this.maybeFail("put", keys);
    const encoded = entries.map(
      (entry) => [entry.key, JSON.stringify(serialize(entry.value))] as const,
    );
    /*
     * The quota check runs BEFORE anything is written, and the whole batch is
     * rejected together. That is what makes it a transaction: a partial batch
     * would leave a snapshot without its assets, which is the exact corruption the
     * repository's verify step is there to catch — and a test double that allowed
     * it would be testing the wrong thing.
     */
    let projected = this.usedChars;
    for (const [key, value] of encoded) {
      const existing = this.data.get(key);
      projected += value.length - (existing?.length ?? 0);
    }
    if (projected > this.quotaChars) {
      throw quotaError();
    }
    for (const [key, value] of encoded) this.data.set(key, value);
  }

  async deleteAll(keys: readonly string[]): Promise<void> {
    this.log.push({ op: "delete", keys: [...keys] });
    this.maybeFail("delete", keys);
    for (const key of keys) this.data.delete(key);
  }

  async keysWithPrefix(prefix: string): Promise<string[]> {
    this.log.push({ op: "keys", keys: [prefix] });
    this.maybeFail("keys", [prefix]);
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }

  classifyError(error: unknown): PersistenceFailure {
    if (error instanceof MemoryStoreError) return error.failure;
    if (error instanceof Error && error.name === "QuotaExceededError") {
      return persistenceFailure("quota_exceeded", "Out of storage space.");
    }
    return persistenceFailure(
      "unknown",
      error instanceof Error ? error.message : "Unknown store error.",
    );
  }

  private maybeFail(operation: MemoryStoreFault["operation"], keys: readonly string[]): void {
    const index = this.faults.findIndex(
      (fault) =>
        fault.operation === operation &&
        fault.times > 0 &&
        (fault.match === undefined || keys.some((key) => fault.match?.(key))),
    );
    if (index < 0) return;
    const fault = this.faults[index] as MemoryStoreFault;
    fault.times -= 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    throw new MemoryStoreError(fault.failure);
  }
}

export class MemoryStoreError extends Error {
  constructor(readonly failure: PersistenceFailure) {
    super(failure.message);
    this.name = "MemoryStoreError";
  }
}

export function quotaError(): Error {
  const error = new Error("The quota has been exceeded.");
  error.name = "QuotaExceededError";
  return error;
}

/**
 * A JSON-safe encoding that survives `Uint8Array`.
 *
 * IndexedDB stores typed arrays natively via structured clone; JSON does not, and
 * a double that quietly turned the source PDF's bytes into `{"0":37,"1":80,…}`
 * would make every source-bytes test meaningless.
 */
function serialize(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __bytes__: [...value] };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serialize(child);
    }
    return out;
  }
  return value;
}

function deserialize(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "__bytes__" in value) {
    const bytes = (value as { __bytes__: number[] }).__bytes__;
    return new Uint8Array(bytes);
  }
  if (Array.isArray(value)) return value.map(deserialize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deserialize(child);
    }
    return out;
  }
  return value;
}
