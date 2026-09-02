/**
 * The two browser adapters behind cross-tab coordination.
 *
 * Both are tested against doubles rather than the real APIs, because the conditions
 * that matter — a contended lock, a stray message from another build on the same
 * origin, an absent API — cannot be provoked from a real `navigator.locks` or
 * `BroadcastChannel` on demand, and are the entire reason the adapters exist.
 */

import { describe, expect, it, vi } from "vitest";

import {
  BroadcastChannelPeerBus,
  PEER_CHANNEL_NAME,
  createPeerBus,
  parsePeerMessage,
  silentPeerBus,
  type BroadcastChannelLike,
} from "./BroadcastChannelPeerBus";
import {
  LockContendedError,
  WebLocksDraftLock,
  createDraftLock,
  type LockManagerLike,
} from "./WebLocksDraftLock";

/** A `navigator.locks` double whose contention is under the test's control. */
function lockManager(options: { available?: boolean } = {}): LockManagerLike & {
  requests: Array<{ name: string; options: unknown }>;
} {
  const available = options.available ?? true;
  const requests: Array<{ name: string; options: unknown }> = [];
  return {
    requests,
    async request(name, requestOptions, callback) {
      requests.push({ name, options: requestOptions });
      // The `ifAvailable` contract: the callback runs either way, with `null` when
      // another context holds the lock.
      return callback(available ? { name } : null);
    },
  };
}

function channel(): BroadcastChannelLike & {
  posted: unknown[];
  closed: boolean;
  deliver(data: unknown): void;
  listenerCount: number;
} {
  const listeners = new Set<(event: { data: unknown }) => void>();
  return {
    posted: [],
    closed: false,
    get listenerCount() {
      return listeners.size;
    },
    postMessage(message) {
      this.posted.push(message);
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
    close() {
      this.closed = true;
    },
    deliver(data) {
      for (const listener of listeners) listener({ data });
    },
  };
}

const COMMITTED = {
  kind: "draft_committed" as const,
  documentKey: "guest:abc",
  draftId: "draft-1",
  generation: 3,
  revision: 9,
  deviceId: "device-1",
  tabId: "tab-2",
  at: 1_000,
};

/* ------------------------------------------------------------------ */

describe("WebLocksDraftLock", () => {
  it("runs the body under an exclusive lock and reports it was serialised", async () => {
    const locks = lockManager();
    const lock = new WebLocksDraftLock(locks);
    const result = await lock.run("pdfdadi.draft.guest:abc", async () => "written");

    expect(result).toEqual({ held: true, serialised: true, value: "written" });
    expect(locks.requests[0]!.name).toBe("pdfdadi.draft.guest:abc");
    expect(locks.requests[0]!.options).toEqual({ mode: "exclusive", ifAvailable: true });
  });

  it("asks rather than queues", async () => {
    // A queued request waits for the other tab's whole write, which would let a
    // pagehide flush hold the tab open.
    const locks = lockManager();
    await new WebLocksDraftLock(locks).run("n", async () => 1);
    expect(locks.requests[0]!.options).toMatchObject({ ifAvailable: true });
  });

  it("does not run the body when another tab holds the lock", async () => {
    const body = vi.fn(async () => "written");
    const lock = new WebLocksDraftLock(lockManager({ available: false }));

    await expect(lock.run("n", body)).rejects.toBeInstanceOf(LockContendedError);
    expect(body).not.toHaveBeenCalled();
  });

  it("names the lock it could not take", async () => {
    const lock = new WebLocksDraftLock(lockManager({ available: false }));
    try {
      await lock.run("pdfdadi.draft.guest:abc", async () => 1);
      expect.unreachable("a contended lock must be reported");
    } catch (error) {
      expect((error as LockContendedError).lockName).toBe("pdfdadi.draft.guest:abc");
      expect((error as Error).message).toMatch(/another tab is saving/i);
    }
  });

  it("propagates a failed write instead of reporting a contended lock", async () => {
    const lock = new WebLocksDraftLock(lockManager());
    // Letting the rejection escape into `locks.request` makes a failed write
    // indistinguishable from contention, and contention is retried silently.
    await expect(
      lock.run("n", async () => {
        throw new Error("quota exceeded");
      }),
    ).rejects.toThrow(/quota exceeded/);
    await expect(lock.run("n", async () => 1)).resolves.toMatchObject({ held: true });
  });

  it("releases the lock before the caller sees the result", async () => {
    const order: string[] = [];
    const locks: LockManagerLike = {
      async request(_name, _options, callback) {
        order.push("acquired");
        await callback({});
        order.push("released");
      },
    };
    await new WebLocksDraftLock(locks).run("n", async () => {
      order.push("body");
    });
    expect(order).toEqual(["acquired", "body", "released"]);
  });
});

describe("createDraftLock", () => {
  it("uses Web Locks when the context has them", () => {
    expect(createDraftLock({ locks: lockManager() }).supported).toBe(true);
  });

  it("degrades to an unserialised lock rather than refusing to save", async () => {
    for (const context of [undefined, null, {}, { locks: {} }, { locks: { request: 1 } }]) {
      const lock = createDraftLock(context);
      expect(lock.supported).toBe(false);
      // Still writes — the pointer compare-and-swap is what makes that safe.
      await expect(lock.run("n", async () => "written")).resolves.toEqual({
        held: false,
        serialised: false,
        value: "written",
      });
    }
  });
});

describe("BroadcastChannelPeerBus", () => {
  it("posts a message to the channel", () => {
    const c = channel();
    new BroadcastChannelPeerBus(c).post(COMMITTED);
    expect(c.posted).toEqual([COMMITTED]);
  });

  it("delivers a valid message to every subscriber", () => {
    const c = channel();
    const bus = new BroadcastChannelPeerBus(c);
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    c.deliver(COMMITTED);

    expect(a).toHaveBeenCalledWith(COMMITTED);
    expect(b).toHaveBeenCalledWith(COMMITTED);
  });

  it("stops delivering after unsubscribe", () => {
    const c = channel();
    const bus = new BroadcastChannelPeerBus(c);
    const listener = vi.fn();
    bus.subscribe(listener)();
    c.deliver(COMMITTED);
    expect(listener).not.toHaveBeenCalled();
  });

  it("detaches from the channel and closes it on close", () => {
    const c = channel();
    const bus = new BroadcastChannelPeerBus(c);
    expect(c.listenerCount).toBe(1);
    bus.close();
    expect(c.listenerCount).toBe(0);
    expect(c.closed).toBe(true);
  });

  it("ignores a post after close", () => {
    const c = channel();
    const bus = new BroadcastChannelPeerBus(c);
    bus.close();
    bus.post(COMMITTED);
    expect(c.posted).toEqual([]);
  });

  it("survives a channel that throws on post", () => {
    const c = channel();
    c.postMessage = () => {
      throw new Error("channel closed");
    };
    // The bus is a courtesy over the compare-and-swap; a failed post must not turn
    // into a failed save.
    expect(() => new BroadcastChannelPeerBus(c).post(COMMITTED)).not.toThrow();
  });

  it("drops a message from something else on the same origin", () => {
    const c = channel();
    const listener = vi.fn();
    new BroadcastChannelPeerBus(c).subscribe(listener);

    for (const junk of [
      null,
      "hello",
      42,
      {},
      { kind: "draft_committed" },
      { ...COMMITTED, kind: "something_else" },
      { ...COMMITTED, documentKey: 7 },
      { ...COMMITTED, at: Number.NaN },
      { ...COMMITTED, generation: 1.5 },
      { ...COMMITTED, revision: "9" },
      { ...COMMITTED, draftId: null },
    ]) {
      c.deliver(junk);
    }
    // An unvalidated message could move this tab's belief about which generation is
    // durable, and a channel name is shared by every page on the origin.
    expect(listener).not.toHaveBeenCalled();
  });

  it("accepts a closing announcement without the commit fields", () => {
    const c = channel();
    const listener = vi.fn();
    new BroadcastChannelPeerBus(c).subscribe(listener);
    const closing = {
      kind: "tab_closing",
      documentKey: "guest:abc",
      deviceId: "device-1",
      tabId: "tab-2",
      at: 900,
    };
    c.deliver(closing);
    expect(listener).toHaveBeenCalledWith(closing);
  });
});

describe("parsePeerMessage", () => {
  it("keeps only the fields it validated", () => {
    const parsed = parsePeerMessage({ ...COMMITTED, extra: "ignored" });
    expect(parsed).toEqual(COMMITTED);
    expect(parsed && "extra" in parsed).toBe(false);
  });
});

describe("createPeerBus", () => {
  it("uses the channel name the whole app agrees on", () => {
    const names: string[] = [];
    createPeerBus((name) => {
      names.push(name);
      return channel();
    });
    expect(names).toEqual([PEER_CHANNEL_NAME]);
  });

  it("falls back to a silent bus when there is no BroadcastChannel", () => {
    const bus = createPeerBus(undefined);
    const listener = vi.fn();
    expect(() => {
      bus.subscribe(listener)();
      bus.post(COMMITTED);
      bus.close();
    }).not.toThrow();
    // With no announcements every commit goes out under a compare-and-swap, which
    // is the degraded-but-correct path rather than a broken one.
    expect(listener).not.toHaveBeenCalled();
  });

  it("falls back to a silent bus when constructing the channel throws", () => {
    const bus = createPeerBus(() => {
      throw new Error("blocked");
    });
    expect(bus.post).toBeTypeOf("function");
    expect(() => bus.post(COMMITTED)).not.toThrow();
  });

  it("has a silent bus that does nothing at all", () => {
    const bus = silentPeerBus();
    const listener = vi.fn();
    bus.subscribe(listener);
    bus.post(COMMITTED);
    expect(listener).not.toHaveBeenCalled();
  });
});
