import {
  unlockedDraftLock,
  type DraftLock,
  type LockRunResult,
} from "@/src/application/editor/persistence/tabCoordination";

/**
 * A {@link DraftLock} over the Web Locks API.
 *
 * WHY WEB LOCKS AND NOT A LEASE IN STORAGE. The obvious cross-tab mutex is a record
 * that says "tab X holds the lock until T", refreshed by a heartbeat. It has one
 * failure mode that cannot be engineered away: a background tab gets throttled or
 * frozen, its heartbeat stops, its lease expires, and a second tab takes a lock the
 * first one still believes it holds. Web Locks is released by the BROWSER when the
 * holding context goes away, so a frozen tab keeps its lock and a crashed one loses
 * it — which is exactly the semantics a write needs and a lease cannot provide.
 *
 * `ifAvailable` rather than a queue. A queued request waits for however long the
 * other tab's write takes, and autosave callers are on a debounce that will simply
 * come round again; a queue would also let a `pagehide` flush block the tab from
 * closing. So a contended lock returns `held: false` and the caller decides —
 * which, for a draft commit, means writing under a compare-and-swap instead.
 */

/** The slice of `navigator.locks` this needs, so a test can supply one. */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
}

export class WebLocksDraftLock implements DraftLock {
  readonly supported = true;

  constructor(private readonly locks: LockManagerLike) {}

  async run<T>(name: string, body: () => Promise<T>): Promise<LockRunResult<T>> {
    let value: T | undefined;
    let ran = false;
    let held = false;
    let thrown: unknown;

    await this.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      /*
       * `lock === null` means another context holds it. The callback still runs —
       * that is the `ifAvailable` contract — and it must NOT run the body, or the
       * whole point of asking is lost.
       */
      if (lock === null) return;
      held = true;
      ran = true;
      try {
        value = await body();
      } catch (error) {
        /*
         * Captured and rethrown outside, not allowed to escape into
         * `locks.request`. A rejection there is reported as a lock failure, which
         * would make a failed write indistinguishable from a contended lock — and a
         * contended lock is retried while a failed write must be reported.
         */
        thrown = error;
      }
    });

    if (thrown !== undefined) throw thrown;
    if (!ran) {
      /*
       * Contended. The body did not run at all, so there is nothing to report as a
       * result and the caller has to be told, not handed a fabricated one.
       */
      throw new LockContendedError(name);
    }
    return { held, serialised: held, value: value as T };
  }
}

/** Thrown when another tab held the lock and the body was not run. */
export class LockContendedError extends Error {
  constructor(readonly lockName: string) {
    super("Another tab is saving this document right now.");
    this.name = "LockContendedError";
  }
}

/**
 * The best lock this context can provide.
 *
 * Falls back to {@link unlockedDraftLock} — which runs the body unserialised and
 * says so — rather than refusing to save. Web Locks is absent in some browsers and
 * in insecure contexts, and the pointer compare-and-swap turns an interleaved write
 * into a reported conflict there rather than a silent loss.
 *
 * The navigator is a required argument rather than a defaulted one. A default would
 * read the ambient global whenever a caller passed `undefined`, which makes the
 * "this context has no Web Locks" branch unreachable from a test — and in a modern
 * Node, `globalThis.navigator.locks` exists, so the branch would have looked tested
 * while never running.
 */
export function createDraftLock(navigatorLike: unknown): DraftLock {
  const locks = (navigatorLike as { locks?: LockManagerLike } | undefined)?.locks;
  if (!locks || typeof locks.request !== "function") return unlockedDraftLock();
  return new WebLocksDraftLock(locks);
}
