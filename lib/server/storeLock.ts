/**
 * In-process async mutex for serializing admin store mutations.
 *
 * The admin store is a single JSON file that is read-modified-written by API
 * routes. Without serialization, two concurrent admin saves interleave and one
 * change is silently lost (last-write-wins), and a crash mid-write can leave a
 * truncated file. `updateStore` wraps every mutation in this mutex so the
 * read-modify-write is atomic within a single process.
 *
 * Single-instance guard. Behind multiple instances, coordination must move to
 * a shared layer (a database transaction or a distributed lock) — that is
 * Milestone 2 (Postgres). Until then, do not run more than one instance, or
 * accept that concurrent admin writes across instances can still race.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Runs `fn` only after any previously-queued work has completed, returning
   * fn's result. Errors from `fn` reject the returned promise but do NOT block
   * subsequent runs (the chain is advanced in `finally`).
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Shared mutex for all admin store mutations. */
export const storeMutex = new AsyncMutex();
