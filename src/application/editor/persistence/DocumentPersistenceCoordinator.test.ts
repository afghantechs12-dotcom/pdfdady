import { describe, expect, it } from "vitest";
import type { SerializedEditorState } from "../ports/ISerializer";
import {
  DocumentPersistenceCoordinator,
  draftPointerKeyFor,
  type CapturedDocument,
  type CoordinatorPorts,
  type OpenDocumentInput,
} from "./DocumentPersistenceCoordinator";
import { createDiagnostics, type Diagnostics } from "./diagnostics";
import { draftKeys, guestDocumentKey, workspaceDocumentKey } from "./draftEnvelope";
import { DraftRepository } from "./draftRepository";
import { PERSISTENCE_EVENT_TYPES } from "./events";
import type { PersistenceState } from "./persistenceMachine";
import type {
  KeyValueEntry,
  RemoteDocumentTransport,
  RemoteSaveOutcome,
  RemoteSavePayload,
} from "./ports";
import { MemoryKeyValueStore } from "./testing/memoryKeyValueStore";
import {
  type DraftLock,
  type LockRunResult,
  type PeerBus,
  type PeerMessage,
} from "./tabCoordination";
import { LockContendedError } from "../../../infrastructure/persistence/browser/WebLocksDraftLock";
import type { WriteSchedulerConfig } from "./writeScheduler";

/**
 * The coordinator is where separately-tested pure pieces become one behaviour, so
 * these tests are deliberately NOT about the pieces. Each one names a way the
 * assembly can lie about durability while every component beneath it behaves
 * exactly as its own suite proved.
 *
 * The five invariants the class documents are each pinned here: completion
 * identity, a synchronous capture, the absence of any export path, channel
 * independence, and never deleting a copy before its replacement is proven. The
 * rest cover the seams — gestures, loads, contention, reconnect ordering — where a
 * unit test has nothing to say because no unit owns them.
 *
 * `NOTHING_DURABLE` is -1 in the reducer, and the tests spell it out rather than
 * importing it: a test that tracked a private constant would keep passing if the
 * constant changed to something that no longer means "nothing".
 */
const NOTHING_DURABLE = -1;

/** A hand-driven clock and timer queue. No real time passes in this file. */
class Clock {
  now = 1_700_000_000_000;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextTimer = 1;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = target;
  }

  get armedTimers(): number {
    return this.timers.size;
  }
}

/**
 * Drains the microtask queue.
 *
 * One macrotask turn is enough however deep the promise chain: the repository's
 * commit awaits only the store, and the store resolves synchronously. A fixed
 * number of `await Promise.resolve()` calls would silently under-drain the moment
 * the commit sequence grew a step.
 */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** A promise plus its resolve, for holding a remote call open across other calls. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function scene(document: unknown): SerializedEditorState {
  return {
    format: "pdfdadi-editor",
    version: 6,
    document,
    activePageId: "page-1",
    selection: { objectIds: [] },
  };
}

/** A data URL long enough that the envelope externalises it into its own asset. */
function bigDataUrl(seed: string): string {
  return `data:image/png;base64,${seed.repeat(3000)}`;
}

/**
 * A store that can hold a write open.
 *
 * Every "a result arrived after the document changed" test needs a write that is
 * genuinely in flight across another synchronous call. Faults cannot express that:
 * they fail immediately, and a failure is a different code path from a late
 * success.
 */
class GatedStore extends MemoryKeyValueStore {
  private gates: Array<() => void> = [];
  blockWrites = false;

  override async putAll(entries: readonly KeyValueEntry[]): Promise<void> {
    if (this.blockWrites) {
      await new Promise<void>((resolve) => this.gates.push(resolve));
    }
    return super.putAll(entries);
  }

  /** Lets the oldest blocked write proceed. */
  releaseWrite(): void {
    const gate = this.gates.shift();
    if (!gate) throw new Error("no write is blocked");
    gate();
  }

  get blockedWrites(): number {
    return this.gates.length;
  }
}

class FakeTransport implements RemoteDocumentTransport {
  readonly saves: RemoteSavePayload[] = [];
  /** Consumed in order; falls back to `defaultOutcome` when empty. */
  readonly outcomes: RemoteSaveOutcome[] = [];
  defaultOutcome: RemoteSaveOutcome = { kind: "saved", serverVersion: 7, etag: "etag-7" };
  head: { serverVersion: number | null; etag: string | null } | null = {
    serverVersion: 4,
    etag: "etag-4",
  };
  headReads = 0;
  headThrows = false;

  /** Every call in order, so read-before-send can be asserted as ordering. */
  readonly calls: Array<"save" | "readVersion"> = [];

  async save(payload: RemoteSavePayload): Promise<RemoteSaveOutcome> {
    this.calls.push("save");
    this.saves.push(payload);
    return this.outcomes.shift() ?? this.defaultOutcome;
  }

  async readVersion(): Promise<{ serverVersion: number | null; etag: string | null } | null> {
    this.calls.push("readVersion");
    this.headReads += 1;
    if (this.headThrows) throw new Error("endpoint unreachable");
    return this.head;
  }
}

/** A lock that reports contention for a fixed number of attempts. */
function contendingLock(failures: number): DraftLock & { attempts: number } {
  let remaining = failures;
  const lock = {
    attempts: 0,
    supported: true,
    async run<T>(_name: string, body: () => Promise<T>): Promise<LockRunResult<T>> {
      lock.attempts += 1;
      if (remaining > 0) {
        remaining -= 1;
        throw new LockContendedError("another tab holds the draft lock");
      }
      return { held: true, serialised: true, value: await body() };
    },
  };
  return lock;
}

function recordingPeerBus(): PeerBus & {
  posted: PeerMessage[];
  deliver: (message: PeerMessage) => void;
  closed: boolean;
  listeners: number;
} {
  const listeners: Array<(message: PeerMessage) => void> = [];
  const bus = {
    posted: [] as PeerMessage[],
    closed: false,
    get listeners(): number {
      return listeners.length;
    },
    post(message: PeerMessage): void {
      bus.posted.push(message);
    },
    subscribe(listener: (message: PeerMessage) => void): () => void {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    close(): void {
      bus.closed = true;
      listeners.length = 0;
    },
    deliver(message: PeerMessage): void {
      for (const listener of [...listeners]) listener(message);
    },
  };
  return bus;
}

interface FixtureOptions {
  origin?: "guest" | "workspace";
  /** Provided even for a guest document, to prove origin alone gates the channel. */
  withTransport?: boolean;
  lock?: DraftLock;
  peers?: PeerBus | null;
  localConfig?: Partial<WriteSchedulerConfig>;
  remoteConfig?: Partial<WriteSchedulerConfig>;
  maxRemotePayloadBytes?: number;
  store?: GatedStore;
}

const DOCUMENT_KEY_GUEST = guestDocumentKey("guest-doc-1");
const DOCUMENT_KEY_WORKSPACE = workspaceDocumentKey("ws-1", "doc-1");

/**
 * Timers are tiny and automatic retries OFF by default.
 *
 * A test that means to observe one failure must not silently observe a retry of
 * it; the two suites that care about retrying turn it back on explicitly.
 */
const FAST: Partial<WriteSchedulerConfig> = {
  debounceMs: 10,
  maxDelayMs: 40,
  retryDelaysMs: [],
};

class Fixture {
  readonly clock = new Clock();
  readonly store: GatedStore;
  readonly repository: DraftRepository;
  readonly transport: FakeTransport;
  readonly diagnostics: Diagnostics;
  readonly coordinator: DocumentPersistenceCoordinator;
  readonly states: PersistenceState[] = [];
  readonly origin: "guest" | "workspace";

  /** What `capture()` returns. Mutable so a test can change the scene mid-flight. */
  captured: CapturedDocument | null;
  captureCalls = 0;
  /** Revision observed at each capture, to prove the pairing is synchronous. */
  readonly captureRevisions: number[] = [];

  private nextId = 1;

  constructor(options: FixtureOptions = {}) {
    this.origin = options.origin ?? "guest";
    this.store = options.store ?? new GatedStore();
    this.repository = new DraftRepository(this.store);
    this.transport = new FakeTransport();
    this.diagnostics = createDiagnostics({ now: () => this.clock.now });
    this.captured = {
      scene: scene({ pages: [{ id: "page-1", objects: [] }] }),
      sourceBytes: new Uint8Array([37, 80, 68, 70]),
      sourceReference: null,
      documentName: "Contract.pdf",
      pageCount: 3,
      objectCount: 2,
    };

    const useTransport = options.withTransport ?? true;
    const ports: CoordinatorPorts = {
      store: this.store,
      repository: this.repository,
      transport: useTransport ? this.transport : null,
      lock: options.lock,
      peers: options.peers,
      diagnostics: this.diagnostics,
      capture: () => {
        this.captureCalls += 1;
        this.captureRevisions.push(this.coordinator.revision);
        return this.captured;
      },
      now: () => this.clock.now,
      newId: () => `id-${this.nextId++}`,
      setTimer: this.clock.setTimer,
      clearTimer: this.clock.clearTimer,
      onStateChange: (state) => void this.states.push(state),
      deviceId: "device-A",
      tabId: "tab-1",
      maxRemotePayloadBytes: options.maxRemotePayloadBytes,
      localConfig: { ...FAST, ...options.localConfig },
      remoteConfig: { ...FAST, ...options.remoteConfig },
    };
    this.coordinator = new DocumentPersistenceCoordinator(ports);
  }

  get documentKey(): string {
    return this.origin === "workspace" ? DOCUMENT_KEY_WORKSPACE : DOCUMENT_KEY_GUEST;
  }

  openInput(overrides: Partial<OpenDocumentInput> = {}): OpenDocumentInput {
    const workspace = this.origin === "workspace";
    return {
      documentKey: this.documentKey,
      documentId: workspace ? "doc-1" : null,
      workspaceId: workspace ? "ws-1" : null,
      organizationId: workspace ? "org-1" : null,
      origin: this.origin,
      historyRevision: 0,
      online: true,
      serverVersion: workspace ? 4 : null,
      etag: workspace ? "etag-4" : null,
      ...overrides,
    };
  }

  async open(overrides: Partial<OpenDocumentInput> = {}): Promise<void> {
    await this.coordinator.openDocument(this.openInput(overrides));
  }

  get state(): PersistenceState {
    return this.coordinator.view.state;
  }

  /** One mutation at `historyRevision`, then run the debounce out and settle. */
  async mutateAndFlush(historyRevision: number): Promise<void> {
    this.coordinator.noteMutation(historyRevision);
    this.clock.advance(20);
    await settle();
  }

  diagnosticEvents(): string[] {
    return this.diagnostics.history().map((entry) => entry.event);
  }

  /** The manifest of the newest snapshot the store actually holds. */
  async storedManifest(): Promise<Record<string, unknown> | null> {
    const pointer = (await this.store.get(draftPointerKeyFor(this.documentKey))) as
      | { activeGeneration: number }
      | undefined;
    if (!pointer) return null;
    const record = (await this.store.get(
      draftKeys.snapshot(this.documentKey, pointer.activeGeneration),
    )) as { manifest: Record<string, unknown> } | undefined;
    return record?.manifest ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Opening                                                             */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — opening a document", () => {
  it("derives the draft id from the document key, so two tabs contend for one pointer", async () => {
    /*
     * The compare-and-swap in the repository guards `pointer:<draftId>`. If the
     * draft id were minted per mount, two tabs on the same document would swap
     * different pointers, both would succeed, and the guard would be decorative.
     */
    const first = new Fixture();
    await first.open();
    await first.mutateAndFlush(1);

    const second = new Fixture({ store: first.store });
    await second.open();
    await second.mutateAndFlush(1);

    const pointerKeys = first.store.keys().filter((key) => key.startsWith("pointer:"));
    expect(pointerKeys).toEqual([draftPointerKeyFor(DOCUMENT_KEY_GUEST)]);
  });

  it("gives every opening a new session id, including a reopen of the same document", async () => {
    const fixture = new Fixture();
    await fixture.open();
    const first = fixture.coordinator.documentSessionId;
    await fixture.open();
    const second = fixture.coordinator.documentSessionId;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it("leaves a guest document with no cloud channel even when a transport exists", async () => {
    const fixture = new Fixture({ origin: "guest", withTransport: true });
    await fixture.open();
    await fixture.mutateAndFlush(1);

    expect(fixture.state.remoteEnabled).toBe(false);
    expect(fixture.state.remote).toBe("not_applicable");
    expect(fixture.transport.saves).toHaveLength(0);
    // The local draft is unaffected by the absent cloud channel.
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("stays local-only when a workspace document is missing an identifier", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open({ organizationId: null });
    await fixture.mutateAndFlush(1);

    expect(fixture.state.remoteEnabled).toBe(false);
    expect(fixture.transport.saves).toHaveLength(0);
  });

  it("enables the cloud channel for a complete workspace document", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();

    expect(fixture.state.remoteEnabled).toBe(true);
    expect(fixture.state.remote).toBe("idle");
    expect(fixture.state.serverVersion).toBe(4);
  });

  it("does not claim a local draft exists merely because a document opened", async () => {
    /*
     * The tempting shortcut is to set the local watermark to the opened revision,
     * because the document is indeed safe to close. It is safe because it matches
     * the user's file — not because this browser stored anything.
     */
    const fixture = new Fixture();
    await fixture.open({ historyRevision: 0 });

    expect(fixture.state.lastLocallyDurableRevision).toBe(NOTHING_DURABLE);
    expect(fixture.state.baselineRevision).toBe(0);
    expect(fixture.state.edit).toBe("clean");
    expect(fixture.store.size).toBe(0);
  });

  it("reports an unusable store from a probe, before the first edit is lost", async () => {
    const store = new GatedStore();
    store.setAvailable(false);
    const fixture = new Fixture({ store });
    await fixture.open();

    expect(fixture.state.local).toBe("unavailable");
    // And no write is even attempted, so nothing fails a second time.
    await fixture.mutateAndFlush(1);
    expect(fixture.store.size).toBe(0);
    expect(fixture.state.lastLocallyDurableRevision).toBe(NOTHING_DURABLE);
  });

  it("keeps the cloud channel working when the local store is unavailable", async () => {
    const store = new GatedStore();
    store.setAvailable(false);
    const fixture = new Fixture({ origin: "workspace", store });
    await fixture.open();
    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("unavailable");
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBe(1);
  });

  it("opens paused when the caller reports the browser offline", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open({ online: false });
    await fixture.mutateAndFlush(1);

    expect(fixture.state.online).toBe(false);
    expect(fixture.transport.saves).toHaveLength(0);
    // The revision is retained rather than dropped: it is the user's work.
    expect(fixture.state.remoteChannel.pendingRevision).toBe(1);
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* The local channel                                                   */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — the local channel", () => {
  it("coalesces a burst into one write of the newest revision", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.noteMutation(1);
    fixture.coordinator.noteMutation(2);
    fixture.coordinator.noteMutation(3);
    fixture.clock.advance(20);
    await settle();

    expect(fixture.captureCalls).toBe(1);
    expect(fixture.state.lastLocallyDurableRevision).toBe(3);
    const manifest = await fixture.storedManifest();
    expect(manifest?.revision).toBe(3);
  });

  it("captures the revision and the bytes in the same turn", async () => {
    /*
     * Invariant 2. The proof available to a test is that the revision `capture()`
     * saw is the revision the stored manifest carries: an `await` between reading
     * the revision and reading the scene would let a mutation land in the gap and
     * separate the two.
     */
    const fixture = new Fixture();
    await fixture.open();
    await fixture.mutateAndFlush(1);
    await fixture.mutateAndFlush(2);

    expect(fixture.captureRevisions).toEqual([1, 2]);
    const manifest = await fixture.storedManifest();
    expect(manifest?.revision).toBe(2);
  });

  it("writes nothing until a gesture commits, and then writes once", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.beginGesture("Move");
    fixture.coordinator.noteMutation(1);
    fixture.coordinator.noteMutation(2);
    fixture.clock.advance(50);
    await settle();
    expect(fixture.captureCalls).toBe(0);

    fixture.coordinator.endGesture("commit");
    fixture.clock.advance(20);
    await settle();

    expect(fixture.captureCalls).toBe(1);
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("writes nothing for a cancelled gesture", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.beginGesture("Resize");
    fixture.coordinator.noteMutation(1);
    fixture.coordinator.endGesture("cancel");
    fixture.clock.advance(50);
    await settle();

    expect(fixture.captureCalls).toBe(0);
    expect(fixture.state.edit).toBe("clean");
    expect(fixture.store.size).toBe(0);
  });

  it("does not persist the history churn of a document load", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.beginLoad();
    fixture.coordinator.noteMutation(1);
    fixture.coordinator.noteMutation(2);
    fixture.coordinator.endLoad(2);
    fixture.clock.advance(50);
    await settle();

    expect(fixture.captureCalls).toBe(0);
    expect(fixture.state.edit).toBe("clean");

    // A real edit after the load still writes, at the next revision.
    await fixture.mutateAndFlush(3);
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("reports a quota failure without discarding the queued revision", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.store.quotaChars = 10;
    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("failed");
    expect(fixture.state.localChannel.failureReason?.category).toBe("quota_exceeded");
    expect(fixture.state.lastLocallyDurableRevision).toBe(NOTHING_DURABLE);
    /*
     * The watermark, not the channel's `pendingRevision`, is what records that the
     * work is unwritten: the reducer clears `pendingRevision` when an attempt
     * starts and does not restore it on failure. So the fact a caller must be able
     * to rely on is that the document still reads dirty and navigation is guarded.
     */
    expect(fixture.state.edit).toBe("dirty");
    expect(fixture.coordinator.canNavigate().decision).not.toBe("allow");
  });

  it("retries a failed local write on request and succeeds once the fault clears", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.store.quotaChars = 10;
    await fixture.mutateAndFlush(1);
    expect(fixture.state.local).toBe("failed");

    fixture.store.quotaChars = Number.POSITIVE_INFINITY;
    fixture.coordinator.retryLocal();
    fixture.clock.advance(20);
    await settle();

    expect(fixture.state.local).toBe("durable");
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("flushLocal reports durable only when the write actually landed", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.noteMutation(1);
    const flushed = await fixture.coordinator.flushLocal();

    expect(flushed.outcome).toBe("durable");
    expect(flushed.durableRevision).toBe(1);
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("flushLocal reports the failure rather than that the queue stopped moving", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.store.quotaChars = 10;
    fixture.coordinator.noteMutation(1);
    const flushed = await fixture.coordinator.flushLocal();

    expect(flushed.outcome).toBe("failed");
    expect(flushed.durableRevision).toBeNull();
    expect(flushed.queuedRevision).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Invariant 1 — identity on every completion                          */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — identity on completion", () => {
  it("a local write finishing after the document closed does not mark the next one durable", async () => {
    /*
     * The bug this forbids: the status bar reads "Saved" about a document whose
     * bytes were never written, because a completion from the PREVIOUS document
     * moved the new session's watermark.
     */
    const fixture = new Fixture();
    await fixture.open();
    fixture.store.blockWrites = true;
    fixture.coordinator.noteMutation(1);
    fixture.clock.advance(20);
    await settle();
    expect(fixture.store.blockedWrites).toBe(1);

    fixture.coordinator.closeDocument();
    await fixture.open({ documentKey: guestDocumentKey("guest-doc-2") });

    fixture.store.blockWrites = false;
    fixture.store.releaseWrite();
    await settle();

    expect(fixture.state.lastLocallyDurableRevision).toBe(NOTHING_DURABLE);
    expect(fixture.state.local).not.toBe("durable");
    expect(fixture.state.staleResponsesIgnored).toBeGreaterThan(0);
  });

  it("a cloud save finishing after a reopen does not mark the new session synced", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();

    const gate = deferred();
    fixture.transport.save = async (payload) => {
      fixture.transport.saves.push(payload);
      await gate.promise;
      return { kind: "saved", serverVersion: 99, etag: "etag-99" };
    };

    fixture.coordinator.noteMutation(1);
    fixture.clock.advance(20);
    await settle();
    expect(fixture.transport.saves).toHaveLength(1);

    // The same document, reopened: only the session id distinguishes them.
    await fixture.open();
    gate.release();
    await settle();

    expect(fixture.state.serverVersion).toBe(4);
    expect(fixture.state.remote).not.toBe("synced");
    expect(fixture.state.staleResponsesIgnored).toBeGreaterThan(0);
  });

  it("does not announce a peer commit for a write whose document already closed", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    fixture.store.blockWrites = true;
    fixture.coordinator.noteMutation(1);
    fixture.clock.advance(20);
    await settle();

    fixture.coordinator.closeDocument();
    fixture.store.blockWrites = false;
    fixture.store.releaseWrite();
    await settle();

    // `tab_closing` is expected; a `draft_committed` for a closed document is not,
    // because a sibling tab would treat it as this tab's live generation.
    expect(peers.posted.map((message) => message.kind)).toEqual(["tab_closing"]);
  });

  it("closing does not flush: a close that races a write must not complete it", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.noteMutation(1);
    fixture.coordinator.closeDocument();
    fixture.clock.advance(50);
    await settle();

    expect(fixture.captureCalls).toBe(0);
    expect(fixture.store.size).toBe(0);
  });

  it("a disposed coordinator does nothing at all", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.dispose();

    fixture.coordinator.noteMutation(1);
    fixture.clock.advance(50);
    await settle();
    await fixture.open();
    await fixture.mutateAndFlush(2);

    expect(fixture.captureCalls).toBe(0);
    expect(fixture.store.size).toBe(0);
    expect(fixture.clock.armedTimers).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Invariant 4 — the channels are independent                          */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — channel independence", () => {
  it("a failed cloud save leaves the local draft intact and durable", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    fixture.transport.defaultOutcome = {
      kind: "failed",
      failure: { category: "network", message: "offline", retryable: true },
    };
    await fixture.mutateAndFlush(1);

    expect(fixture.state.remote).toBe("failed");
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
    expect(fixture.state.local).toBe("durable");
    const manifest = await fixture.storedManifest();
    expect(manifest?.revision).toBe(1);
  });

  it("a failed local write does not stop the cloud save", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    fixture.store.quotaChars = 10;
    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("failed");
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBe(1);
  });

  it("builds the cloud payload from the capture, not by reading the local draft back", async () => {
    /*
     * If the remote snapshot were read out of the draft store, a browser that
     * cannot write IndexedDB would also have no cloud backup — the two failures
     * would compound instead of covering for each other.
     */
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    fixture.store.quotaChars = 10;
    fixture.captured = {
      ...fixture.captured!,
      scene: scene({ pages: [{ id: "page-1", objects: [{ id: "t", kind: "text", text: "hello" }] }] }),
    };
    await fixture.mutateAndFlush(1);

    expect(fixture.store.size).toBe(0);
    expect(fixture.transport.saves).toHaveLength(1);
    const snapshot = fixture.transport.saves[0].snapshot as {
      record: { manifest: { scene: { document: { pages: { objects: { text: string }[] }[] } } } };
    };
    expect(snapshot.record.manifest.scene.document.pages[0].objects[0].text).toBe("hello");
  });

  it("neither channel can retract the other's progress", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.mutateAndFlush(1);
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBe(1);

    // Now break the cloud and edit again: the local watermark must not regress.
    fixture.transport.defaultOutcome = {
      kind: "failed",
      failure: { category: "network", message: "offline", retryable: true },
    };
    await fixture.mutateAndFlush(2);

    expect(fixture.state.lastLocallyDurableRevision).toBe(2);
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Invariant 3 — there is no export path                               */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — no export path exists", () => {
  it("no event in the union refers to exporting", () => {
    const offenders = PERSISTENCE_EVENT_TYPES.filter((type) =>
      /EXPORT|DOWNLOAD|PRINT/i.test(type),
    );
    expect(offenders).toEqual([]);
  });

  it("no method on the coordinator refers to exporting", () => {
    const names = Object.getOwnPropertyNames(DocumentPersistenceCoordinator.prototype);
    expect(names.filter((name) => /export|download|print/i.test(name))).toEqual([]);
  });

  it("only an explicit version commit moves the committed watermark", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.mutateAndFlush(1);

    // An acknowledged autosave is NOT a version a colleague can see.
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBe(1);
    expect(fixture.state.lastCommittedRevision).toBe(NOTHING_DURABLE);

    fixture.coordinator.noteVersionCommitted({ revision: 1, serverVersion: 12, etag: "etag-12" });
    expect(fixture.state.lastCommittedRevision).toBe(1);
    expect(fixture.state.committedServerVersion).toBe(12);
  });
});

/* ------------------------------------------------------------------ */
/* Recovery                                                            */
/* ------------------------------------------------------------------ */

/** Commits a draft for `documentKey` using a throwaway coordinator, then drops it. */
async function seedDraft(
  store: GatedStore,
  options: { revision: number; origin?: "guest" | "workspace"; scene?: SerializedEditorState } ,
): Promise<void> {
  const seeder = new Fixture({ store, origin: options.origin ?? "guest" });
  await seeder.open();
  if (options.scene) seeder.captured = { ...seeder.captured!, scene: options.scene };
  for (let revision = 1; revision <= options.revision; revision += 1) {
    await seeder.mutateAndFlush(revision);
  }
  seeder.coordinator.dispose();
}

describe("DocumentPersistenceCoordinator — recovery", () => {
  it("offers a draft that is newer than what is on screen", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 3 });

    const fixture = new Fixture({ store });
    await fixture.open();
    const prompt = await fixture.coordinator.findRecoverableDraft();

    expect(prompt).not.toBeNull();
    // An unambiguous guest draft is restorable without asking.
    expect(prompt?.requiresChoice).toBe(false);
    expect(prompt?.caveat).toBeNull();
    expect(fixture.state.draft?.revision).toBe(3);
    expect(fixture.state.recovery).toBe("draft_available");
    expect(fixture.coordinator.view.recoveryOffer).toBe(prompt);
  });

  it("ignores a draft at or behind the revision already on screen", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 2 });

    const fixture = new Fixture({ store });
    // Opening at history revision 5 is not the same as persistence revision 5;
    // drive the persistence revision up with real mutations instead.
    await fixture.open();
    await fixture.mutateAndFlush(1);
    await fixture.mutateAndFlush(2);

    const prompt = await fixture.coordinator.findRecoverableDraft();
    expect(prompt).toBeNull();
    expect(fixture.diagnosticEvents()).toContain("draft_ignored_not_newer");
  });

  it("reports a load failure as a recovery failure rather than as no draft", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 1 });
    const fixture = new Fixture({ store });
    await fixture.open();
    store.injectFault({
      operation: "get",
      failure: { category: "corrupt_snapshot", message: "unreadable", retryable: false },
      times: Number.POSITIVE_INFINITY,
    });

    const prompt = await fixture.coordinator.findRecoverableDraft();
    expect(prompt).toBeNull();
    expect(fixture.state.recovery).toBe("recovery_failed");
    expect(fixture.diagnosticEvents()).toContain("draft_load_failed");
  });

  it("adopts the revision the editor reports, not the draft's own number", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 4 });
    const fixture = new Fixture({ store });
    await fixture.open();
    await fixture.coordinator.findRecoverableDraft();

    const outcome = await fixture.coordinator.restoreOfferedDraft(() => ({ historyRevision: 11 }));

    expect(outcome.kind).toBe("restored");
    if (outcome.kind !== "restored") throw new Error("expected a restore");
    expect(outcome.revision).toBe(4);
    expect(outcome.complete).toBe(true);
    expect(fixture.state.currentRevision).toBe(4);
    expect(fixture.state.lastLocallyDurableRevision).toBe(4);
    expect(fixture.state.recovery).toBe("recovered");

    // The next real edit continues from the adopted revision, not from 1.
    await fixture.mutateAndFlush(12);
    expect(fixture.state.currentRevision).toBe(5);
  });

  it("restores a partial draft without calling it durable", async () => {
    /*
     * A draft whose image assets were evicted is on screen but is NOT the durable
     * copy of what is on screen. Claiming durability is how a partial recovery
     * gets autosaved over a good workspace version.
     */
    const store = new GatedStore();
    const src = bigDataUrl("z");
    await seedDraft(store, {
      revision: 1,
      scene: scene({ pages: [{ id: "page-1", objects: [{ id: "i", kind: "image", src }] }] }),
    });
    const assetKey = store.keys().find((key) => key.startsWith("asset:") && key !== "asset:")!;
    // Evict every asset the draft references, as storage pressure does.
    for (const key of store.keys().filter((key) => key.startsWith("asset:"))) store.evict(key);
    expect(assetKey).toBeDefined();

    const fixture = new Fixture({ store });
    await fixture.open();
    const prompt = await fixture.coordinator.findRecoverableDraft();
    expect(fixture.state.draft?.missingAssets.length).toBeGreaterThan(0);
    // A partial recovery has to say so before the user accepts it.
    expect(prompt?.requiresChoice).toBe(true);
    expect(prompt?.caveat).not.toBeNull();

    const outcome = await fixture.coordinator.restoreOfferedDraft(() => ({ historyRevision: 7 }));
    expect(outcome.kind).toBe("restored");
    if (outcome.kind !== "restored") throw new Error("expected a restore");
    expect(outcome.complete).toBe(false);
    // Not durable, and marked dirty so the next autosave stores a complete copy.
    expect(fixture.state.lastLocallyDurableRevision).toBeLessThan(fixture.state.currentRevision);
    expect(fixture.state.edit).toBe("dirty");
  });

  it("declining a draft keeps it: declining is not deleting", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 2 });
    const before = store.size;

    const fixture = new Fixture({ store });
    await fixture.open();
    await fixture.coordinator.findRecoverableDraft();
    expect(fixture.state.draft).not.toBeNull();

    fixture.coordinator.dismissOfferedDraft();

    expect(store.size).toBe(before);
    expect(await store.get(draftPointerKeyFor(DOCUMENT_KEY_GUEST))).not.toBeUndefined();
    expect(fixture.state.recovery).toBe("none");
    expect(fixture.state.draft).toBeNull();
    expect(fixture.coordinator.view.recoveryOffer).toBeNull();
  });

  it("deletes a draft only when the user asks for it to be thrown away", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 2 });

    const fixture = new Fixture({ store });
    await fixture.open();
    await fixture.coordinator.findRecoverableDraft();
    expect(fixture.state.draft).not.toBeNull();

    await fixture.coordinator.deleteOfferedDraft();

    expect(store.keys().filter((key) => key.startsWith("snapshot:"))).toEqual([]);
    expect(fixture.state.recovery).toBe("none");
    expect(fixture.state.draft).toBeNull();
    // A second open finds nothing to offer.
    const reopened = new Fixture({ store });
    await reopened.open();
    expect(await reopened.coordinator.findRecoverableDraft()).toBeNull();
  });

  it("a failed restore leaves the revision counter where it was", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 3 });
    const fixture = new Fixture({ store });
    await fixture.open();
    await fixture.coordinator.findRecoverableDraft();

    const outcome = await fixture.coordinator.restoreOfferedDraft(() => {
      throw new Error("the scene would not deserialize");
    });

    expect(outcome.kind).toBe("failed");
    expect(fixture.state.recovery).toBe("recovery_failed");
    expect(fixture.state.currentRevision).toBe(0);
    expect(fixture.state.lastLocallyDurableRevision).toBe(NOTHING_DURABLE);
  });

  it("finds nothing when the store is unavailable, without raising a failure", async () => {
    const store = new GatedStore();
    store.setAvailable(false);
    const fixture = new Fixture({ store });
    await fixture.open();

    expect(await fixture.coordinator.findRecoverableDraft()).toBeNull();
    expect(fixture.state.recovery).toBe("none");
  });
});

/* ------------------------------------------------------------------ */
/* Conflicts                                                           */
/* ------------------------------------------------------------------ */

/** Drives a workspace fixture into a server-detected conflict at revision 1. */
async function conflicted(): Promise<Fixture> {
  const fixture = new Fixture({ origin: "workspace" });
  await fixture.open();
  fixture.transport.outcomes.push({
    kind: "conflict",
    actualServerVersion: 9,
    expectedServerVersion: 4,
    detail: "someone else saved",
  });
  await fixture.mutateAndFlush(1);
  return fixture;
}

describe("DocumentPersistenceCoordinator — conflicts", () => {
  it("reports a server conflict and leaves the local draft alone", async () => {
    const fixture = await conflicted();

    expect(fixture.state.remote).toBe("conflict");
    expect(fixture.state.conflict?.actualServerVersion).toBe(9);
    expect(fixture.state.conflict?.localRevision).toBe(1);
    // The local draft is the only copy of the work the server just refused.
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
    const manifest = await fixture.storedManifest();
    expect(manifest?.revision).toBe(1);
  });

  it("does not retry a conflict automatically", async () => {
    const fixture = new Fixture({
      origin: "workspace",
      remoteConfig: { debounceMs: 10, maxDelayMs: 40, retryDelaysMs: [5, 5, 5] },
    });
    await fixture.open();
    fixture.transport.outcomes.push({
      kind: "conflict",
      actualServerVersion: 9,
      expectedServerVersion: 4,
      detail: null,
    });
    await fixture.mutateAndFlush(1);
    fixture.clock.advance(200);
    await settle();

    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.state.remote).toBe("conflict");
  });

  it("presents the conflict with actions rather than resolving it silently", async () => {
    const fixture = await conflicted();
    const presentation = fixture.coordinator.view.conflict;

    expect(presentation).not.toBeNull();
    expect(presentation!.actions.length).toBeGreaterThan(1);
    expect(presentation!.actions.map((action) => action.id)).toContain("replace_workspace");
  });

  it("refuses to replace the workspace version without confirmation", async () => {
    const fixture = await conflicted();
    const outcome = await fixture.coordinator.resolveConflict("replace_workspace");

    expect(outcome.kind).toBe("failed");
    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.state.conflict).not.toBeNull();
  });

  it("re-reads the server version immediately before overriding it", async () => {
    /*
     * The version quoted in the conflict was current when the dialog opened, which
     * may have been minutes ago. Sending it would overwrite a third change nobody
     * has seen.
     */
    const fixture = await conflicted();
    fixture.transport.head = { serverVersion: 15, etag: "etag-15" };
    const outcome = await fixture.coordinator.resolveConflict("replace_workspace", {
      confirmed: true,
    });

    expect(fixture.transport.headReads).toBe(1);
    expect(outcome.kind).toBe("replaced");
    const override = fixture.transport.saves[1];
    expect(override.expectedServerVersion).toBe(15);
    expect(override.revision).toBe(1);
  });

  it("keeps the local draft after a successful replace", async () => {
    const fixture = await conflicted();
    await fixture.coordinator.resolveConflict("replace_workspace", { confirmed: true });

    const manifest = await fixture.storedManifest();
    expect(manifest?.revision).toBe(1);
  });

  it("returns any other action as not owned and leaves the conflict standing", async () => {
    const fixture = await conflicted();
    for (const action of [
      "cancel",
      "review_local",
      "review_workspace",
      "save_local_copy",
      "duplicate_as_new",
    ] as const) {
      const outcome = await fixture.coordinator.resolveConflict(action, { confirmed: true });
      expect(outcome).toEqual({ kind: "not_owned", action });
      expect(fixture.state.conflict).not.toBeNull();
    }
    expect(fixture.transport.headReads).toBe(0);
  });

  it("reports a still-unreachable workspace as a network failure, not as replaced", async () => {
    const fixture = await conflicted();
    fixture.transport.headThrows = true;
    const outcome = await fixture.coordinator.resolveConflict("replace_workspace", {
      confirmed: true,
    });

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("expected a failure");
    expect(outcome.failure.category).toBe("network");
    expect(fixture.state.conflict).not.toBeNull();
  });

  /*
   * T12 — a session's own publish must not become its next conflict.
   *
   * `Publish version` and autosave fence against the SAME column: the transport
   * sends `expectedServerVersion` as the document record's `expectedRevision`, and
   * the server refuses when its revision has moved past it. A publish moves that
   * revision, so the publishing session has to take the new value from the response
   * — otherwise its very next autosave presents a revision its own publish
   * superseded, and the user is asked to resolve a conflict with nobody.
   *
   * The trap is that the publish response also carries a version NUMBER, which is
   * the number the user is shown and is nearly always the smaller of the two. They
   * coincide on a freshly imported document and diverge permanently after the first
   * rename, favourite or move — each of which advances the revision and creates no
   * version. So these tests quote a revision that is deliberately not the version.
   */
  it("fences the next autosave against the revision its own publish produced (T12)", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    // Opened at record revision 4 — what the content route disclosed.
    await fixture.open();
    await fixture.mutateAndFlush(1);
    expect(fixture.transport.saves[0].expectedServerVersion).toBe(4);

    // The publish: version 9 for the user, revision 12 for the fence.
    fixture.coordinator.noteVersionCommitted({
      revision: fixture.state.currentRevision,
      serverVersion: 9,
      documentRevision: 12,
      etag: null,
    });
    // What the user is shown is unchanged by the fix — both numbers are kept.
    expect(fixture.state.committedServerVersion).toBe(9);

    fixture.transport.defaultOutcome = { kind: "saved", serverVersion: 12, etag: null };
    await fixture.mutateAndFlush(2);

    const next = fixture.transport.saves[fixture.transport.saves.length - 1];
    expect(fixture.transport.saves).toHaveLength(2);
    // 12, the revision the publish produced. 9 is the version number and would be
    // rejected by the server as stale; 4 is what the tab knew before publishing.
    expect(next.expectedServerVersion).toBe(12);
    expect(fixture.state.remote).toBe("synced");
    expect(fixture.state.conflict).toBeNull();
  });

  it("still conflicts when another tab moved the document (T12)", async () => {
    /*
     * The other half, and the reason the fix could not simply stop sending a token:
     * a competing write must still be refused. Same publish, but the server has
     * since moved to 13 — that IS a conflict and stays one.
     */
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.mutateAndFlush(1);
    fixture.coordinator.noteVersionCommitted({
      revision: fixture.state.currentRevision,
      serverVersion: 9,
      documentRevision: 12,
      etag: null,
    });

    fixture.transport.outcomes.push({
      kind: "conflict",
      actualServerVersion: 13,
      expectedServerVersion: 12,
      detail: null,
    });
    await fixture.mutateAndFlush(2);

    expect(fixture.state.remote).toBe("conflict");
    expect(fixture.state.conflict?.actualServerVersion).toBe(13);
    // And the work is still on this device, which is the whole point of refusing.
    expect(fixture.state.lastLocallyDurableRevision).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Offline and reconnect                                              */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — offline and reconnect", () => {
  it("keeps writing locally while offline and sends nothing", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);

    await fixture.mutateAndFlush(1);

    expect(fixture.state.online).toBe(false);
    expect(fixture.state.remote).toBe("offline");
    expect(fixture.transport.calls).toEqual([]);
    // The device is the only copy while the network is gone, so it must still work.
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
    expect((await fixture.storedManifest())?.revision).toBe(1);
  });

  it("reads the server version before sending anything after an outage", async () => {
    /*
     * Ordering is the whole point. A client whose first act after reconnecting is
     * to POST overwrites whatever happened during the outage; reading first turns
     * that into a conflict somebody can see.
     */
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);
    await fixture.mutateAndFlush(1);

    await fixture.coordinator.setOnline(true);
    fixture.clock.advance(20);
    await settle();

    expect(fixture.transport.calls).toEqual(["readVersion", "save"]);
    expect(fixture.state.remote).toBe("synced");
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBe(1);
    expect(fixture.diagnosticEvents()).toContain("reconnect_planned");
  });

  it("quotes the new server version only when the validator proves the bytes did not move", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);
    await fixture.mutateAndFlush(1);

    // The version number moved but the etag is the one this tab already holds:
    // a rename or a metadata touch, not new content.
    fixture.transport.head = { serverVersion: 9, etag: "etag-4" };
    await fixture.coordinator.setOnline(true);
    fixture.clock.advance(20);
    await settle();

    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].expectedServerVersion).toBe(9);
    expect(fixture.state.remote).toBe("synced");
  });

  it("sends the old expectation when the server moved and both sides hold work", async () => {
    /*
     * Raising the expectation to the server's current version here would make the
     * server ACCEPT the overwrite. Leaving it at the version this canvas was built
     * from is what turns the divergence into a refusal the user is shown.
     */
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);
    await fixture.mutateAndFlush(1);

    fixture.transport.head = { serverVersion: 9, etag: "etag-9" };
    fixture.transport.outcomes.push({
      kind: "conflict",
      actualServerVersion: 9,
      expectedServerVersion: 4,
      detail: null,
    });
    await fixture.coordinator.setOnline(true);
    fixture.clock.advance(20);
    await settle();

    expect(fixture.transport.saves).toHaveLength(1);
    expect(fixture.transport.saves[0].expectedServerVersion).toBe(4);
    expect(fixture.state.remote).toBe("conflict");
    // And the work the server refused is still on this device.
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("sends nothing when the server moved and the canvas holds nothing of the user's", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);
    fixture.transport.head = { serverVersion: 9, etag: "etag-9" };

    await fixture.coordinator.setOnline(true);
    fixture.clock.advance(50);
    await settle();

    expect(fixture.transport.calls).toEqual(["readVersion"]);
    const planned = fixture.diagnostics
      .history()
      .find((entry) => entry.event === "reconnect_planned");
    expect(planned?.fields.operation).toBe("reload_from_server");
  });

  it("stays paused when the connection is back but the endpoint is not answering", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);
    await fixture.mutateAndFlush(1);

    fixture.transport.headThrows = true;
    await fixture.coordinator.setOnline(true);
    fixture.clock.advance(200);
    await settle();

    // Resuming here would send blind against an unknown server version.
    expect(fixture.transport.calls).toEqual(["readVersion"]);
    expect(fixture.state.lastRemoteAcknowledgedRevision).toBeLessThan(1);
  });

  it("ignores a connectivity report that says what the state already says", async () => {
    // Visibility and online listeners fire in bursts; each burst must not
    // re-probe the server.
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    await fixture.mutateAndFlush(1);
    const before = fixture.transport.headReads;

    await fixture.coordinator.setOnline(true);
    await fixture.coordinator.setOnline(true);

    expect(fixture.transport.headReads).toBe(before);
  });

  it("does nothing on reconnect for a guest document", async () => {
    const fixture = new Fixture({ origin: "guest" });
    await fixture.open();
    await fixture.coordinator.setOnline(false);
    await fixture.mutateAndFlush(1);
    await fixture.coordinator.setOnline(true);
    fixture.clock.advance(50);
    await settle();

    expect(fixture.transport.calls).toEqual([]);
    expect(fixture.state.remote).toBe("not_applicable");
  });
});

/* ------------------------------------------------------------------ */
/* Sibling tabs                                                       */
/* ------------------------------------------------------------------ */

/** A peer announcement as it arrives over the bus, from this device's other tab. */
function peerCommit(overrides: Partial<Extract<PeerMessage, { kind: "draft_committed" }>> = {}) {
  return {
    kind: "draft_committed" as const,
    documentKey: DOCUMENT_KEY_GUEST,
    draftId: DOCUMENT_KEY_GUEST,
    generation: 2,
    revision: 1,
    deviceId: "device-A",
    tabId: "tab-2",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("DocumentPersistenceCoordinator — sibling tabs", () => {
  it("treats transient lock contention as waiting, not as failing", async () => {
    const lock = contendingLock(1);
    const fixture = new Fixture({ lock, localConfig: { retryDelaysMs: [5] } });
    await fixture.open();

    await fixture.mutateAndFlush(1);
    expect(fixture.state.local).not.toBe("failed");
    expect(fixture.diagnosticEvents()).toContain("draft_lock_contended");

    fixture.clock.advance(20);
    await settle();

    expect(lock.attempts).toBe(2);
    expect(fixture.state.local).toBe("durable");
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("reports persistent contention as a failure rather than saving forever", async () => {
    const lock = contendingLock(Number.MAX_SAFE_INTEGER);
    const fixture = new Fixture({ lock, localConfig: { retryDelaysMs: [5, 5, 5] } });
    await fixture.open();
    await fixture.mutateAndFlush(1);
    for (let tick = 0; tick < 6; tick += 1) {
      fixture.clock.advance(20);
      await settle();
    }

    expect(fixture.state.local).toBe("failed");
    expect(fixture.state.localChannel.failureReason?.category).toBe("timeout");
    expect(fixture.state.lastLocallyDurableRevision).toBe(NOTHING_DURABLE);
  });

  it("does not rewrite a revision a sibling tab already stored", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    peers.deliver(peerCommit({ revision: 1, generation: 2 }));

    await fixture.mutateAndFlush(1);

    // Byte-identical snapshot; writing it again only burns the user's quota.
    expect(fixture.store.keys().filter((key) => key.startsWith("snapshot:"))).toEqual([]);
    expect(fixture.state.local).toBe("durable");
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
    expect(fixture.diagnosticEvents()).toContain("peer_commit_observed");
  });

  it("refuses to write over a sibling tab's newer snapshot", async () => {
    /*
     * The compare-and-swap cannot catch this: the pointer is exactly where the
     * peer left it, so the swap succeeds and four revisions of their work become
     * an older document — with both tabs still reading "Saved".
     */
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    peers.deliver(peerCommit({ revision: 9, generation: 4 }));

    await fixture.mutateAndFlush(1);

    expect(fixture.store.keys().filter((key) => key.startsWith("snapshot:"))).toEqual([]);
    expect(fixture.state.local).toBe("failed");
    expect(fixture.state.localChannel.failureReason?.category).toBe("conflict");
    expect(fixture.diagnosticEvents()).toContain("cross_tab_conflict");
  });

  it("uses a peer's generation as the compare-and-swap expectation", async () => {
    /*
     * Paired with the test below, which is the same setup minus the
     * announcement. Only the pair proves the expectation came from the peer: on
     * its own, a refused write could just as easily be the seeded draft.
     */
    const store = new GatedStore();
    await seedDraft(store, { revision: 1 });
    const peers = recordingPeerBus();
    const fixture = new Fixture({ store, peers, lock: contendingLock(0) });
    await fixture.open();
    peers.deliver(peerCommit({ revision: 0, generation: 7 }));

    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("failed");
    // Nothing overwrote the draft that is actually there.
    const pointer = (await store.get(draftPointerKeyFor(DOCUMENT_KEY_GUEST))) as {
      activeGeneration: number;
    };
    expect(pointer.activeGeneration).toBe(1);
  });

  it("claims no generation when a lock is held and nothing is known", async () => {
    const store = new GatedStore();
    await seedDraft(store, { revision: 1 });
    const fixture = new Fixture({ store, lock: contendingLock(0) });
    await fixture.open();

    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("durable");
    const pointer = (await store.get(draftPointerKeyFor(DOCUMENT_KEY_GUEST))) as {
      activeGeneration: number;
    };
    expect(pointer.activeGeneration).toBe(2);
  });

  it("ignores announcements from another device or another document", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    // A different browser cannot have written to this browser's store...
    peers.deliver(peerCommit({ revision: 9, deviceId: "device-B" }));
    // ...and neither can a tab editing a different document.
    peers.deliver(peerCommit({ revision: 9, documentKey: guestDocumentKey("other") }));

    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("durable");
    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
  });

  it("ignores an announcement that arrives out of order", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    peers.deliver(peerCommit({ revision: 3, generation: 3, at: fixture.clock.now }));
    // A suspended tab waking up and replaying an older announcement must not walk
    // the peer's revision backwards.
    peers.deliver(peerCommit({ revision: 1, generation: 1, at: fixture.clock.now - 5_000 }));

    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("failed");
    expect(fixture.state.localChannel.failureReason?.category).toBe("conflict");
  });

  it("stops listening to a tab that said it was leaving", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    peers.deliver({
      kind: "tab_closing",
      documentKey: DOCUMENT_KEY_GUEST,
      deviceId: "device-A",
      tabId: "tab-2",
      at: fixture.clock.now,
    });
    // Anything still in flight from a tab that has gone describes a draft nobody
    // is holding open any more.
    peers.deliver(peerCommit({ revision: 9, tabId: "tab-2" }));

    await fixture.mutateAndFlush(1);

    expect(fixture.state.local).toBe("durable");
  });

  it("announces its own commit so the other tabs can skip it", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    await fixture.mutateAndFlush(1);

    const announced = peers.posted.filter((message) => message.kind === "draft_committed");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({
      documentKey: DOCUMENT_KEY_GUEST,
      revision: 1,
      deviceId: "device-A",
      tabId: "tab-1",
    });
  });

  it("closes the bus on dispose and stops listening", async () => {
    const peers = recordingPeerBus();
    const fixture = new Fixture({ peers });
    await fixture.open();
    expect(peers.listeners).toBe(1);

    fixture.coordinator.dispose();

    expect(peers.listeners).toBe(0);
    expect(peers.closed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Leaving the page                                                   */
/* ------------------------------------------------------------------ */

describe("DocumentPersistenceCoordinator — leaving the page", () => {
  it("allows leaving when nothing has been touched", async () => {
    const fixture = new Fixture();
    await fixture.open();
    expect(fixture.coordinator.canNavigate().decision).toBe("allow");
    expect(fixture.coordinator.view.navigation.armBeforeUnload).toBe(false);
  });

  it("blocks leaving while an edit is not stored anywhere", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.store.blockWrites = true;
    fixture.coordinator.noteMutation(1);
    fixture.clock.advance(20);
    await settle();

    const verdict = fixture.coordinator.canNavigate();
    expect(verdict.decision).not.toBe("allow");
    // Staying is always available; discarding is never the default.
    expect(verdict.actions[verdict.actions.length - 1]).toBe("cancel");
    expect(verdict.actions[0]).not.toBe("leave_and_discard");
    expect(verdict.armBeforeUnload).toBe(true);
  });

  it("allows leaving once the edit is on the device, and says the cloud is behind", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    fixture.transport.outcomes.push({
      kind: "failed",
      failure: { category: "network", message: "offline", retryable: true },
    });
    await fixture.mutateAndFlush(1);

    expect(fixture.state.lastLocallyDurableRevision).toBe(1);
    expect(fixture.state.remote).toBe("failed");
    const verdict = fixture.coordinator.canNavigate();
    // Nothing is lost by leaving, so no native dialog and no block — but "saved"
    // for a workspace document means colleagues can see it, and they cannot yet.
    expect(verdict.decision).toBe("warn");
    expect(verdict.armBeforeUnload).toBe(false);
    expect(verdict.actions).toContain("retry_cloud_save");
    expect(verdict.reason).toContain("workspace");
  });

  it("flushes the device copy on hide and reports the real verdict", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    fixture.coordinator.noteMutation(1);

    const result = await fixture.coordinator.flushOnHide();

    expect(result.outcome).toBe("durable");
    expect((await fixture.storedManifest())?.revision).toBe(1);
    // Local only: a request the browser is about to kill cannot be relied on, and
    // a cloud failure reported during teardown reads as data loss.
    expect(fixture.transport.calls).toEqual([]);
  });

  it("does not claim durability on hide when the write actually failed", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.noteMutation(1);
    fixture.store.injectFault({
      operation: "put",
      failure: { category: "quota_exceeded", message: "no room", retryable: false },
      times: Number.POSITIVE_INFINITY,
    });

    const result = await fixture.coordinator.flushOnHide();

    expect(result.outcome).not.toBe("durable");
    expect(fixture.coordinator.canNavigate().decision).not.toBe("allow");
  });

  it("flushes on hide even after the channel was paused by going offline", async () => {
    const fixture = new Fixture({ origin: "workspace" });
    await fixture.open();
    fixture.coordinator.noteMutation(1);
    await fixture.coordinator.setOnline(false);

    const result = await fixture.coordinator.flushOnHide();

    expect(result.outcome).toBe("durable");
    expect((await fixture.storedManifest())?.revision).toBe(1);
  });

  it("reports unavailable rather than failed when the browser will not store anything", async () => {
    const store = new GatedStore();
    store.setAvailable(false);
    const fixture = new Fixture({ store });
    await fixture.open();

    expect(fixture.state.local).toBe("unavailable");
    fixture.coordinator.noteMutation(1);
    const result = await fixture.coordinator.flushOnHide();

    /*
     * The scheduler's queue is empty here — nothing was ever queued, because a
     * channel that cannot be written is not scheduled — and an empty queue is
     * `durable` as far as the scheduler is concerned. Passing that on would let a
     * navigation guard obeying the contract close the tab over work that exists
     * nowhere. No retry will change it either, so the verdict has to say
     * `unavailable` and the user has to be told to export instead.
     */
    expect(result.outcome).toBe("unavailable");
    expect(result.failure?.category).toBe("storage_unavailable");
    expect(fixture.coordinator.view.status.tone).not.toBe("saved");
    expect(fixture.coordinator.canNavigate().decision).toBe("block");
  });

  it("reports an explicit save of an unwritable store as unavailable too", async () => {
    const store = new GatedStore();
    store.setAvailable(false);
    const fixture = new Fixture({ store });
    await fixture.open();
    fixture.coordinator.noteMutation(1);

    expect((await fixture.coordinator.flushLocal()).outcome).toBe("unavailable");
  });

  it("still reports durable when there is genuinely nothing to write", async () => {
    // The downgrade must be about unprotected work, not about the store's mood:
    // an untouched document has nothing to lose and must not report a failure.
    const store = new GatedStore();
    store.setAvailable(false);
    const fixture = new Fixture({ store });
    await fixture.open();

    expect((await fixture.coordinator.flushOnHide()).outcome).toBe("durable");
  });

  it("reports the flush of a closed document as cancelled, not durable", async () => {
    const fixture = new Fixture();
    await fixture.open();
    fixture.coordinator.noteMutation(1);
    fixture.coordinator.closeDocument();

    const result = await fixture.coordinator.flushOnHide();

    // Closing discarded the queue, so the queue is empty and the edit is gone.
    // Reporting that as durable is how "saved on exit" gets recorded about work
    // that was dropped a moment earlier.
    expect(result.outcome).toBe("cancelled");
  });
});
