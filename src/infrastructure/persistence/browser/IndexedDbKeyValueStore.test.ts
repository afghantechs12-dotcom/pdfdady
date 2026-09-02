import { describe, expect, it } from "vitest";
import {
  DRAFT_DB_NAME,
  DRAFT_DB_VERSION,
  DRAFT_STORE_NAME,
  IndexedDbKeyValueStore,
} from "./IndexedDbKeyValueStore";
import { FakeIndexedDb, installKeyRange, manualTimers } from "./testing/fakeIndexedDb";

/**
 * The one place in the client that touches the browser database.
 *
 * Everything above this file is written against a port, so this adapter is the
 * only code whose bugs are invisible to the rest of the suite — and the bugs it
 * can have are the expensive kind:
 *
 *  - **A write that partly landed.** The draft repository's whole design rests on a
 *    snapshot, its assets, the pointer and the index row committing together. A
 *    transaction that applies three of four writes and then fails produces a
 *    pointer aimed at a snapshot whose assets do not exist, which reads back as
 *    corruption on the next launch.
 *  - **A cause replaced by a symptom.** Every failed write reaches the user as a
 *    sentence and reaches the retry policy as a category. "The browser is out of
 *    space" needs the user to act; "the browser interrupted the save" resolves
 *    itself. If a quota error surfaces as a bare `AbortError`, the product offers a
 *    retry that can never succeed and never tells them to free space.
 *  - **Unavailable mistaken for broken.** Private browsing and blocked site data do
 *    not become true on retry. Reopening the database on every scheduled write
 *    flickers the status and buries the one message that matters: this browser will
 *    not store drafts, so export.
 */

function setup(options: { timeoutMs?: number } = {}) {
  const fake = new FakeIndexedDb();
  const timers = manualTimers();
  const restore = installKeyRange();
  const store = new IndexedDbKeyValueStore({
    factory: fake as unknown as IDBFactory,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { fake, timers, store, restore };
}

/** Runs a body with the globals installed, and always removes them. */
async function withStore(
  body: (context: ReturnType<typeof setup>) => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const context = setup(options);
  try {
    await body(context);
  } finally {
    context.restore();
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("storing and reading back", () => {
  it("round-trips a value under the configured name and version", async () => {
    await withStore(async ({ store, fake }) => {
      await store.putAll([{ key: "a", value: { n: 1 } }]);
      expect(await store.get("a")).toEqual({ n: 1 });
      expect(fake.openRequests[0]).toEqual({ name: DRAFT_DB_NAME, version: DRAFT_DB_VERSION });
      expect(fake.backend.stores.has(DRAFT_STORE_NAME)).toBe(true);
    });
  });

  it("stores bytes as bytes, not as a re-encoded copy", async () => {
    await withStore(async ({ store }) => {
      // The reason for choosing IndexedDB over localStorage in the first place: a
      // draft carries the original PDF, and base64 would cost a third more.
      await store.putAll([{ key: "pdf", value: new Uint8Array([1, 2, 255]) }]);
      const read = await store.get("pdf");
      expect(read).toBeInstanceOf(Uint8Array);
      expect([...(read as Uint8Array)]).toEqual([1, 2, 255]);
    });
  });

  it("does not let a caller mutate what is already stored", async () => {
    await withStore(async ({ store }) => {
      /*
       * Structured-clone semantics. A snapshot handed to `putAll` is often the same
       * object the editor keeps mutating; if the store aliased it, the bytes on disk
       * would drift away from the revision they were recorded under, which is the
       * exact claim the whole revision-watermark design rests on.
       */
      const value = { pages: [1, 2] };
      await store.putAll([{ key: "scene", value }]);
      value.pages.push(3);
      expect(await store.get("scene")).toEqual({ pages: [1, 2] });
    });
  });

  it("returns undefined for a key that was never written", async () => {
    await withStore(async ({ store }) => {
      expect(await store.get("missing")).toBeUndefined();
    });
  });

  it("keeps getMany aligned with the keys it was asked for, holes included", async () => {
    await withStore(async ({ store }) => {
      // The repository reads a manifest and its assets positionally. A compacted
      // result array would silently pair asset bytes with the wrong hash.
      await store.putAll([
        { key: "k1", value: "one" },
        { key: "k3", value: "three" },
      ]);
      expect(await store.getMany(["k1", "k2", "k3"])).toEqual(["one", undefined, "three"]);
    });
  });

  it("touches the database at all only when there is work", async () => {
    await withStore(async ({ store, fake }) => {
      expect(await store.getMany([])).toEqual([]);
      await store.putAll([]);
      await store.deleteAll([]);
      expect(fake.openCount).toBe(0);
    });
  });

  it("deletes only the keys it was given", async () => {
    await withStore(async ({ store }) => {
      await store.putAll([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      await store.deleteAll(["a"]);
      expect(await store.getMany(["a", "b"])).toEqual([undefined, 2]);
    });
  });
});

describe("a batch commits or it does not happen", () => {
  it("leaves nothing behind when one write in the batch is refused", async () => {
    await withStore(async ({ store, fake }) => {
      fake.failNext("put", "QuotaExceededError", (key) => key === "c");
      const error = await rejection(
        store.putAll([
          { key: "a", value: 1 },
          { key: "b", value: 2 },
          { key: "c", value: 3 },
          { key: "d", value: 4 },
        ]),
      );
      expect(store.classifyError(error).category).toBe("quota_exceeded");
      // Not "a and b survived". A half-written batch is what produces a pointer
      // aimed at a snapshot whose assets are missing.
      expect([...fake.stored.keys()]).toEqual([]);
    });
  });

  it("reports the browser's actual complaint rather than the abort it caused", async () => {
    await withStore(async ({ store, fake }) => {
      /*
       * Aborting a transaction from a request's `onerror` is what keeps the cause
       * alive — but only because the abort event arrives after the rejection. If
       * this ever regresses, every storage fault becomes `transaction_aborted`:
       * retryable, unexplained, and wrong.
       */
      fake.failNext("put", "QuotaExceededError");
      const failure = store.classifyError(await rejection(store.putAll([{ key: "a", value: 1 }])));
      expect(failure.category).toBe("quota_exceeded");
      expect(failure.retryable).toBe(false);
      expect(failure.message).toMatch(/out of space/i);
    });
  });

  it("rolls back a delete batch that fails part way", async () => {
    await withStore(async ({ store, fake }) => {
      await store.putAll([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      fake.failNext("delete", "UnknownError", (key) => key === "b");
      const error = await rejection(store.deleteAll(["a", "b"]));
      expect(store.classifyError(error).category).toBe("transaction_aborted");
      expect(await store.getMany(["a", "b"])).toEqual([1, 2]);
    });
  });

  it("recognises its own wrapped failures without matching on prose", async () => {
    await withStore(async ({ store, fake }) => {
      // `classifyError` is called on values that already passed through it once.
      // Re-deriving the category from the message would be a match on English.
      fake.failNext("put", "QuotaExceededError");
      const error = await rejection(store.putAll([{ key: "a", value: 1 }]));
      expect(store.classifyError(error)).toEqual(store.classifyError(store.classifyError(error) && error));
      expect(store.classifyError(error).category).toBe("quota_exceeded");
    });
  });

  it("survives the batch after a failed one, so a transient fault is not terminal", async () => {
    await withStore(async ({ store, fake }) => {
      fake.failNext("put", "UnknownError");
      await rejection(store.putAll([{ key: "a", value: 1 }]));
      await store.putAll([{ key: "a", value: 1 }]);
      expect(await store.get("a")).toBe(1);
      expect(store.isAvailable()).toBe(true);
    });
  });
});

describe("scanning by prefix", () => {
  async function seeded(context: ReturnType<typeof setup>) {
    await context.store.putAll([
      { key: "d:1:snapshot", value: "s1" },
      { key: "d:1:asset:aa", value: "a1" },
      { key: "d:1:", value: "boundary" },
      { key: "d:10:snapshot", value: "other-doc" },
      { key: "d:2:snapshot", value: "s2" },
      { key: "c:1:snapshot", value: "before" },
    ]);
  }

  it("matches the prefix and not the document whose id merely starts the same", async () => {
    await withStore(async (context) => {
      await seeded(context);
      /*
       * `d:10:` shares the first four characters of `d:1:`. Without the separator
       * being part of the prefix, a scan for document 1 would return document 10's
       * drafts — and the repository would delete them as stale generations.
       */
      expect(await context.store.keysWithPrefix("d:1:")).toEqual([
        "d:1:",
        "d:1:asset:aa",
        "d:1:snapshot",
      ]);
    });
  });

  it("includes keys whose suffix is outside the basic multilingual plane", async () => {
    await withStore(async (context) => {
      // The upper bound is U+FFFF. An emoji in a document name reaches the key
      // builders as a surrogate pair, whose leading unit is below that bound — so it
      // is included, and a naive bound of "z" or "~" would silently lose the row.
      await context.store.putAll([{ key: "d:1:name:\u{1F600}", value: "emoji" }]);
      expect(await context.store.keysWithPrefix("d:1:")).toContain("d:1:name:\u{1F600}");
    });
  });

  it("returns nothing rather than everything for a prefix with no matches", async () => {
    await withStore(async (context) => {
      await seeded(context);
      expect(await context.store.keysWithPrefix("zzz:")).toEqual([]);
    });
  });

  it("reads keys without deserializing a single value", async () => {
    await withStore(async (context) => {
      await seeded(context);
      const before = context.fake.backend.valueReads;
      await context.store.keysWithPrefix("d:");
      // A draft index scan runs on every launch. Pulling PDF bytes into memory to
      // list key names is how a recovery check costs a hundred megabytes.
      expect(context.fake.backend.valueReads).toBe(before);
      expect(context.fake.backend.keyScans).toBeGreaterThan(0);
    });
  });
});

describe("a store that will never work", () => {
  it("reports unavailable, and fails without opening anything, when there is no IndexedDB", async () => {
    const restore = installKeyRange();
    try {
      const store = new IndexedDbKeyValueStore({ factory: null });
      expect(store.isAvailable()).toBe(false);
      const failure = store.classifyError(await rejection(store.get("a")));
      expect(failure.category).toBe("storage_unavailable");
      expect(failure.retryable).toBe(false);
    } finally {
      restore();
    }
  });

  it("latches a permission failure instead of reopening on every write", async () => {
    await withStore(async ({ store, fake }) => {
      fake.behaviour = { kind: "error", name: "SecurityError" };
      expect(store.classifyError(await rejection(store.get("a"))).category).toBe("storage_unavailable");
      expect(store.isAvailable()).toBe(false);
      await rejection(store.putAll([{ key: "a", value: 1 }]));
      // Second call did not touch the factory: the status stays "no local storage"
      // instead of flickering between saving and failing.
      expect(fake.openCount).toBe(1);
    });
  });

  it("latches an open that throws synchronously, as a sandboxed frame does", async () => {
    await withStore(async ({ store, fake }) => {
      fake.behaviour = { kind: "throw", name: "SecurityError" };
      expect(store.classifyError(await rejection(store.get("a"))).category).toBe("storage_unavailable");
      expect(store.isAvailable()).toBe(false);
      expect(fake.openCount).toBe(1);
    });
  });

  it("treats an open that never answers as unavailable, not as a slow save", async () => {
    await withStore(async ({ store, fake, timers }) => {
      /*
       * Firefox in permanent private browsing goes quiet: no success, no error, no
       * blocked. A timeout classification would leave a Retry button that goes quiet
       * in exactly the same way, so this is reported as the standing condition it is.
       */
      fake.behaviour = { kind: "silent" };
      const pending = rejection(store.get("a"));
      await Promise.resolve();
      timers.fireAll();
      expect(store.classifyError(await pending).category).toBe("storage_unavailable");
      expect(store.isAvailable()).toBe(false);
    });
  });

  it("does not latch a fault that could clear on its own", async () => {
    await withStore(async ({ store, fake }) => {
      // A disk hiccup is not a permission denial. Latching it would turn a
      // recoverable moment into "this browser will not store drafts" for the rest of
      // the session.
      fake.behaviour = { kind: "error", name: "UnknownError" };
      expect(store.classifyError(await rejection(store.get("a"))).category).toBe("transaction_aborted");
      expect(store.isAvailable()).toBe(true);
      fake.behaviour = { kind: "success" };
      await store.putAll([{ key: "a", value: 1 }]);
      expect(await store.get("a")).toBe(1);
      expect(fake.openCount).toBe(2);
    });
  });
});

describe("a request that hangs", () => {
  it("gives up on its own deadline instead of stalling the save queue", async () => {
    await withStore(async ({ store, fake, timers }) => {
      /*
       * A wedged transaction is not hypothetical: a browser under memory pressure,
       * or a database another tab is upgrading, can leave a request outstanding
       * indefinitely. Without a deadline the write scheduler waits on it forever and
       * the status sits on "Saving…" for the rest of the session.
       */
      fake.hangNext("put");
      const pending = rejection(
        store.putAll([
          { key: "a", value: 1 },
          { key: "b", value: 2 },
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      timers.fireAll();
      const failure = store.classifyError(await pending);
      expect(failure.category).toBe("timeout");
      expect(failure.retryable).toBe(true);
      // And the batch that was mid-flight left nothing behind.
      expect([...fake.stored.keys()]).toEqual([]);
    });
  });

  it("disarms its deadline once the work is done", async () => {
    await withStore(async ({ store, timers }) => {
      // A live 15-second timer per write keeps a node process (and a phone's radio)
      // awake, and would abort a transaction that had already committed.
      await store.putAll([{ key: "a", value: 1 }]);
      await store.get("a");
      await store.keysWithPrefix("a");
      expect(timers.liveCount()).toBe(0);
    });
  });
});

describe("a connection that goes away underneath", () => {
  it("steps aside for another tab's upgrade and reopens for the next write", async () => {
    await withStore(async ({ store, fake }) => {
      await store.putAll([{ key: "a", value: 1 }]);
      expect(fake.openCount).toBe(1);
      /*
       * Refusing to close here deadlocks both tabs: the new build waits forever for
       * this connection, and this tab keeps writing to a database version that is
       * being replaced.
       */
      fake.connections[0]!.emitVersionChange();
      expect(fake.connections[0]!.closed).toBe(true);
      await store.putAll([{ key: "b", value: 2 }]);
      expect(fake.openCount).toBe(2);
      expect(await store.getMany(["a", "b"])).toEqual([1, 2]);
    });
  });

  it("recovers from a dead handle rather than failing against it forever", async () => {
    await withStore(async ({ store, fake }) => {
      await store.putAll([{ key: "a", value: 1 }]);
      fake.connections[0]!.transactionThrows = "InvalidStateError";
      expect(store.classifyError(await rejection(store.get("a"))).category).toBe("storage_unavailable");
      // The handle is dropped, so the next call opens a fresh one. Keeping it would
      // make every later save fail against a connection that is already gone.
      fake.connections[0]!.transactionThrows = null;
      await store.putAll([{ key: "b", value: 2 }]);
      expect(fake.openCount).toBe(2);
      expect(await store.get("b")).toBe(2);
    });
  });

  it("reopens after an explicit close", async () => {
    await withStore(async ({ store, fake }) => {
      await store.putAll([{ key: "a", value: 1 }]);
      store.close();
      store.close();
      expect(await store.get("a")).toBe(1);
      expect(fake.openCount).toBe(2);
    });
  });

  it("does not create the object store a second time on reopen", async () => {
    await withStore(async ({ store, fake }) => {
      await store.putAll([{ key: "a", value: 1 }]);
      store.close();
      await store.get("a");
      expect(fake.backend.stores.size).toBe(1);
    });
  });
});

describe("naming the cause", () => {
  const cases: Array<[string, string, boolean]> = [
    ["QuotaExceededError", "quota_exceeded", false],
    ["AbortError", "transaction_aborted", true],
    ["SecurityError", "storage_unavailable", false],
    ["InvalidStateError", "storage_unavailable", false],
    ["NotAllowedError", "storage_unavailable", false],
    ["DataCloneError", "integrity_failed", true],
    ["VersionError", "unsupported_schema", false],
    ["TimeoutError", "timeout", true],
    ["UnknownError", "transaction_aborted", true],
    ["SomeFutureError", "unknown", true],
  ];

  for (const [name, category, retryable] of cases) {
    it(`maps ${name} to ${category}`, async () => {
      await withStore(async ({ store }) => {
        const failure = store.classifyError(new DOMException("boom", name));
        expect(failure.category).toBe(category);
        expect(failure.retryable).toBe(retryable);
      });
    });
  }

  it("classifies by name, not by message", async () => {
    await withStore(async ({ store }) => {
      // Messages are localised and differ per engine. A message match would stop
      // working in a browser nobody ran the suite in.
      expect(store.classifyError(new DOMException("out of space", "AbortError")).category).toBe(
        "transaction_aborted",
      );
    });
  });

  it("still surfaces something for a value that is not an error at all", async () => {
    await withStore(async ({ store }) => {
      // An unclassified fault must never read as success.
      const failure = store.classifyError("nonsense");
      expect(failure.category).toBe("unknown");
      expect(failure.message.length).toBeGreaterThan(0);
    });
  });
});
