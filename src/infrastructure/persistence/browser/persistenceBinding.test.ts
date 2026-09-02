import { describe, expect, it, vi } from "vitest";
import type { CapturedDocument } from "../../../application/editor/persistence/DocumentPersistenceCoordinator";
import { createDiagnostics } from "../../../application/editor/persistence/diagnostics";
import { describeGuestDocument, describeWorkspaceDocument } from "../../../application/editor/persistence/documentIdentity";
import type { PersistenceFailure } from "../../../application/editor/persistence/events";
import type { KeyValueEntry, KeyValueStore } from "../../../application/editor/persistence/ports";
import { MemoryKeyValueStore } from "../../../application/editor/persistence/testing/memoryKeyValueStore";
import type { SerializedEditorState } from "../../../application/editor/ports/ISerializer";
import { PERSISTENCE_LIFECYCLE_EVENTS, PersistenceBinding, readOnline } from "./persistenceBinding";

/** A window-like scope that records what was listened for and can fire it. */
class FakeScope {
  readonly handlers = new Map<string, Set<(event: unknown) => void>>();
  readonly document = { visibilityState: "visible" as "visible" | "hidden" };
  readonly navigator = { onLine: true, locks: undefined };
  readonly localStorage = (() => {
    const backing = new Map<string, string>();
    return {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    };
  })();
  readonly crypto = {
    randomUUID: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  };
  readonly setTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
  readonly clearTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(listener);
    this.handlers.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.handlers.get(type)?.delete(listener);
  }

  fire(type: string, event: unknown = {}): void {
    for (const listener of [...(this.handlers.get(type) ?? [])]) listener(event);
  }

  count(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

/**
 * A store whose next read is slow, once, on demand.
 *
 * Delegation rather than a subclass so it stays honest about the port's shape: this
 * is a {@link KeyValueStore}, and the only thing it changes is how long one read
 * takes. Opening a document reads the draft index, so a slow read is how a test
 * makes open #1 finish after open #2 — the interleaving the queue exists to stop.
 */
class SlowReadStore implements KeyValueStore {
  private pendingDelayMs = 0;

  constructor(private readonly inner = new MemoryKeyValueStore()) {}

  /** Makes exactly the next read slow. */
  slowNextRead(ms: number): void {
    this.pendingDelayMs = ms;
  }

  private async stall(): Promise<void> {
    const ms = this.pendingDelayMs;
    if (ms <= 0) return;
    this.pendingDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  isAvailable(): boolean {
    return this.inner.isAvailable();
  }

  async get(key: string): Promise<unknown> {
    await this.stall();
    return this.inner.get(key);
  }

  async getMany(keys: readonly string[]): Promise<unknown[]> {
    await this.stall();
    return this.inner.getMany(keys);
  }

  putAll(entries: readonly KeyValueEntry[]): Promise<void> {
    return this.inner.putAll(entries);
  }

  deleteAll(keys: readonly string[]): Promise<void> {
    return this.inner.deleteAll(keys);
  }

  keysWithPrefix(prefix: string): Promise<string[]> {
    return this.inner.keysWithPrefix(prefix);
  }

  classifyError(error: unknown): PersistenceFailure {
    return this.inner.classifyError(error);
  }
}

function scene(): SerializedEditorState {
  return { version: 1, pages: [], objects: [] } as unknown as SerializedEditorState;
}

function captured(name: string): CapturedDocument {
  return {
    scene: scene(),
    sourceBytes: new Uint8Array([1, 2, 3]),
    sourceReference: null,
    documentName: name,
    pageCount: 1,
    objectCount: 0,
  };
}

interface Harness {
  binding: PersistenceBinding;
  scope: FakeScope;
  store: KeyValueStore;
  notifications: number;
}

function build(
  options: {
    origin?: "guest" | "workspace";
    documentName?: string;
    store?: KeyValueStore;
    now?: () => number;
  } = {},
): Harness {
  const scope = new FakeScope();
  const store = options.store ?? new MemoryKeyValueStore();
  const harness = { scope, store, notifications: 0 } as Harness;
  harness.binding = new PersistenceBinding({
    origin: options.origin ?? "guest",
    capture: () => captured(options.documentName ?? "a.pdf"),
    scope,
    store,
    now: options.now,
    diagnostics: createDiagnostics({ now: () => 0 }),
    /*
     * Long on purpose. With a zero debounce the scheduler's own timer lands the
     * write, and every test below that means to prove "the hide handler forced a
     * save" would pass without a hide handler at all.
     */
    localConfig: { debounceMs: 10_000, maxDelayMs: 10_000 },
  });
  harness.binding.subscribe(() => {
    harness.notifications += 1;
  });
  return harness;
}

const GUEST = describeGuestDocument("abc");
const OTHER_GUEST = describeGuestDocument("def");

describe("the snapshot React reads", () => {
  it("returns the same object until something changes", async () => {
    /*
     * `useSyncExternalStore` compares snapshots with `Object.is` on every render.
     * `coordinator.view` is a getter that builds a new object per read, so handing
     * it over directly is an infinite render loop — a hang, in a file no test in
     * this repo can execute. This is that test, moved somewhere it can run.
     */
    const { binding } = build();
    const first = binding.getView();
    expect(binding.getView()).toBe(first);
    expect(binding.getView()).toBe(first);
    binding.dispose();
  });

  it("returns a new object once the state moves", async () => {
    // The other half: a snapshot that never changes identity is a UI that never
    // updates, and it would pass the test above on its own.
    const { binding } = build();
    const before = binding.getView();
    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(binding.getView()).not.toBe(before);
    expect(binding.getView().state.documentId).not.toBe(before.state.documentId);
    binding.dispose();
  });

  it("notifies subscribers and stops when they leave", async () => {
    const harness = build();
    let extra = 0;
    const unsubscribe = harness.binding.subscribe(() => {
      extra += 1;
    });

    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(harness.notifications).toBeGreaterThan(0);
    expect(extra).toBeGreaterThan(0);

    const seen = extra;
    unsubscribe();
    harness.binding.noteMutation(1);
    await harness.binding.flushLocal();
    expect(extra).toBe(seen);
    // The still-subscribed listener kept hearing about it.
    expect(harness.notifications).toBeGreaterThan(seen);
    harness.binding.dispose();
  });
});

describe("capture is read live", () => {
  it("uses the newest capture closure, not the one from construction", async () => {
    /*
     * Every render builds a new capture closure over new editor state. A binding
     * that held the first one would autosave the document as it looked on mount
     * forever, and report every one of those writes as durable.
     */
    const harness = build({ documentName: "original.pdf" });
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });

    harness.binding.setCapture(() => captured("edited.pdf"));
    harness.binding.noteMutation(1);
    await harness.binding.flushLocal();

    const index = (await harness.store.get("index:guest:abc")) as { documentName?: string };
    expect(index.documentName).toBe("edited.pdf");
    harness.binding.dispose();
  });
});

describe("following the open document", () => {
  it("opens the document it is given", async () => {
    const { binding } = build();
    await binding.syncDocument({ identity: GUEST, historyRevision: 3 });
    expect(binding.openDocumentKey).toBe("guest:abc");
    expect(binding.getView().state.documentId).toBe("guest:abc");
    binding.dispose();
  });

  it("does not reopen the same document on a re-render", async () => {
    /*
     * Reopening mints a new document-session id, throws away a recovery offer the
     * user has not answered, and resets the revision baseline. An effect that
     * re-runs with unchanged inputs must therefore do nothing at all.
     */
    const { binding } = build();
    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    const session = binding.runtime.coordinator.documentSessionId;

    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    await binding.syncDocument({ identity: { ...GUEST }, historyRevision: 7 });

    expect(binding.runtime.coordinator.documentSessionId).toBe(session);
    binding.dispose();
  });

  it("switches when the document actually changes", async () => {
    const { binding } = build();
    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    const session = binding.runtime.coordinator.documentSessionId;

    await binding.syncDocument({ identity: OTHER_GUEST, historyRevision: 0 });

    expect(binding.openDocumentKey).toBe("guest:def");
    expect(binding.runtime.coordinator.documentSessionId).not.toBe(session);
    binding.dispose();
  });

  it("closes when the document goes away", async () => {
    const { binding } = build();
    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    await binding.syncDocument({ identity: null, historyRevision: 0 });
    expect(binding.openDocumentKey).toBeNull();
    expect(binding.getView().state.documentId).toBeNull();
    binding.dispose();
  });

  it("serialises overlapping switches so the last one wins", async () => {
    /*
     * Identity changes arrive from an effect and opening is async. Without a queue,
     * a slow first open lands after a fast second one, and the binding is left
     * believing document A is open while the coordinator serves document B — after
     * which a re-render for A is a no-op and every edit to A autosaves into B's
     * draft. The store makes the first open the slow one so the wrong order is
     * reachable.
     */
    const store = new SlowReadStore();
    const harness = build({ store });
    store.slowNextRead(40);

    const first = harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    const second = harness.binding.syncDocument({ identity: OTHER_GUEST, historyRevision: 0 });
    await Promise.all([first, second]);

    expect(harness.binding.openDocumentKey).toBe("guest:def");
    // The binding and the coordinator agree about which document is open.
    expect(harness.binding.getView().state.documentId).toBe("guest:def");
    harness.binding.dispose();
  });

  it("takes the browser's word on connectivity when the caller says nothing", async () => {
    const harness = build({ origin: "workspace" });
    harness.scope.navigator.onLine = false;
    await harness.binding.syncDocument({
      identity: describeWorkspaceDocument({
        workspaceId: "w1",
        documentId: "d1",
        organizationId: "org1",
      }),
      historyRevision: 0,
    });
    expect(harness.binding.getView().state.remote).toBe("offline");
    harness.binding.dispose();
  });
});

describe("finding work left behind", () => {
  /** Writes a draft for `identity` through a throwaway binding, then drops it. */
  async function seedDraft(
    store: KeyValueStore,
    identity: typeof GUEST,
    documentName: string,
    revision: number,
  ): Promise<void> {
    const seeder = new PersistenceBinding({
      origin: "guest",
      capture: () => captured(documentName),
      scope: new FakeScope(),
      store,
      diagnostics: createDiagnostics({ now: () => 0 }),
      localConfig: { debounceMs: 0, maxDelayMs: 0 },
    });
    await seeder.syncDocument({ identity, historyRevision: 0 });
    for (let r = 1; r <= revision; r += 1) {
      seeder.noteMutation(r);
      const flushed = await seeder.flushLocal();
      expect(flushed.outcome).toBe("durable");
    }
    seeder.dispose();
  }

  it("offers a draft from an earlier session as soon as the document opens", async () => {
    /*
     * The guest-refresh case. The tab was reloaded, the `File` handle is gone, and
     * the only thing that knows the work existed is the draft store. If opening did
     * not look, autosave would have written a draft nobody ever reads — which is
     * indistinguishable, to the user, from no autosave at all.
     */
    const store = new MemoryKeyValueStore();
    await seedDraft(store, GUEST, "before-refresh.pdf", 3);

    const harness = build({ store });
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });

    expect(harness.binding.getView().state.recovery).toBe("draft_available");
    expect(harness.binding.getView().recoveryOffer).not.toBeNull();
    expect(harness.binding.getView().state.draft?.revision).toBe(3);
    expect(harness.binding.getView().state.draft?.documentKey).toBe("guest:abc");
    harness.binding.dispose();
  });

  it("offers nothing when no earlier session left anything", async () => {
    // The pair: a probe that always reported a draft would pass the test above.
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(harness.binding.getView().state.recovery).toBe("none");
    expect(harness.binding.getView().recoveryOffer).toBeNull();
    harness.binding.dispose();
  });

  it("offers the open document's draft, not the one it switched away from", async () => {
    /*
     * Both documents have drafts. A probe that ran outside the serialised open can
     * finish after the switch and leave the user looking at an offer to restore a
     * document that is not on screen — which, accepted, replaces their work with
     * someone else's document.
     */
    const store = new SlowReadStore();
    await seedDraft(store, GUEST, "first.pdf", 2);
    await seedDraft(store, OTHER_GUEST, "second.pdf", 5);

    const harness = build({ store });
    store.slowNextRead(40);
    const first = harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    const second = harness.binding.syncDocument({ identity: OTHER_GUEST, historyRevision: 0 });
    await Promise.all([first, second]);

    expect(harness.binding.getView().state.documentId).toBe("guest:def");
    expect(harness.binding.getView().state.draft?.documentKey).toBe("guest:def");
    expect(harness.binding.getView().state.draft?.revision).toBe(5);
    harness.binding.dispose();
  });

  it("restores the offered draft and reports the revision the editor reached", async () => {
    const store = new MemoryKeyValueStore();
    await seedDraft(store, GUEST, "restore-me.pdf", 4);

    const harness = build({ store });
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });

    let appliedName: string | null = null;
    const outcome = await harness.binding.restore((draft) => {
      appliedName = draft.descriptor.documentName;
      return { historyRevision: 12 };
    });

    expect(outcome.kind).toBe("restored");
    expect(appliedName).toBe("restore-me.pdf");
    expect(harness.binding.getView().state.recovery).toBe("recovered");
    harness.binding.dispose();
  });

  it("keeps the draft when the user declines it", async () => {
    /*
     * Declining is "not now", not "delete". A user who dismisses the prompt and
     * then reloads must still be offered the work.
     */
    const store = new MemoryKeyValueStore();
    await seedDraft(store, GUEST, "keep-me.pdf", 2);

    const first = build({ store });
    await first.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(first.binding.getView().recoveryOffer).not.toBeNull();
    first.binding.dismissOffer();
    expect(first.binding.getView().recoveryOffer).toBeNull();
    first.binding.dispose();

    const second = build({ store });
    await second.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(second.binding.getView().state.draft?.revision).toBe(2);
    second.binding.dispose();
  });

  it("forgets the draft when the user deletes it", async () => {
    const store = new MemoryKeyValueStore();
    await seedDraft(store, GUEST, "delete-me.pdf", 2);

    const first = build({ store });
    await first.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    await first.binding.deleteOffer();
    expect(first.binding.getView().recoveryOffer).toBeNull();
    first.binding.dispose();

    const second = build({ store });
    await second.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(second.binding.getView().state.draft).toBeNull();
    second.binding.dispose();
  });
});

describe("page lifecycle", () => {
  it("listens for every event that can be the last one", () => {
    const harness = build();
    harness.binding.attach();
    for (const event of PERSISTENCE_LIFECYCLE_EVENTS) {
      expect(harness.scope.handlers.get(event)?.size ?? 0).toBe(1);
    }
    harness.binding.dispose();
  });

  it("attaches once however many times the effect re-runs", () => {
    // Two sets of handlers means two flushes per hide and a double-armed prompt.
    const harness = build();
    harness.binding.attach();
    harness.binding.attach();
    harness.binding.attach();
    expect(harness.scope.count()).toBe(PERSISTENCE_LIFECYCLE_EVENTS.length);
    harness.binding.dispose();
  });

  it("removes every listener on detach", () => {
    const harness = build();
    const detach = harness.binding.attach();
    detach();
    expect(harness.scope.count()).toBe(0);
    harness.binding.dispose();
  });

  it("removes every listener on dispose", () => {
    const harness = build();
    harness.binding.attach();
    harness.binding.dispose();
    expect(harness.scope.count()).toBe(0);
  });

  it("tries to save when the page is hidden", async () => {
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    harness.binding.attach();
    harness.binding.noteMutation(1);

    harness.scope.fire("pagehide");
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.binding.getView().state.lastLocallyDurableRevision).toBe(1);
    harness.binding.dispose();
  });

  it("tries to save when a mobile tab is backgrounded", async () => {
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    harness.binding.attach();
    harness.binding.noteMutation(1);

    harness.scope.document.visibilityState = "hidden";
    harness.scope.fire("visibilitychange");
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.binding.getView().state.lastLocallyDurableRevision).toBe(1);
    harness.binding.dispose();
  });

  it("does not treat becoming visible as leaving", async () => {
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    harness.binding.attach();
    harness.binding.noteMutation(1);

    harness.scope.document.visibilityState = "visible";
    harness.scope.fire("visibilitychange");
    // The same settle time the hidden case gets, so a handler that ignored
    // `visibilityState` would have every chance to land its write here.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Nothing was forced; the debounced write is still the scheduler's business.
    expect(harness.binding.getView().state.lastLocallyDurableRevision).toBe(-1);
    harness.binding.dispose();
  });

  it("warns before unload while work is unprotected", async () => {
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    harness.binding.attach();
    harness.binding.noteMutation(1);

    expect(harness.binding.getView().armBeforeUnload).toBe(true);
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    harness.scope.fire("beforeunload", event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe("");
    harness.binding.dispose();
  });

  it("stays silent when there is nothing to lose", async () => {
    /*
     * The pair for the test above. A guard that always warned would pass it, and
     * would train every user to click through the one prompt that matters.
     */
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    harness.binding.attach();
    harness.binding.noteMutation(1);
    await harness.binding.flushLocal();

    expect(harness.binding.getView().armBeforeUnload).toBe(false);
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    harness.scope.fire("beforeunload", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.returnValue).toBeUndefined();
    harness.binding.dispose();
  });

  it("reads the arming decision at event time, not at attach time", async () => {
    // Armed state is captured in a closure only if written carelessly; this pins
    // that the handler reads the current view.
    const harness = build();
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    harness.binding.attach();

    const clean = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    harness.scope.fire("beforeunload", clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();

    harness.binding.noteMutation(1);
    const dirty = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    harness.scope.fire("beforeunload", dirty);
    expect(dirty.preventDefault).toHaveBeenCalled();
    harness.binding.dispose();
  });

  it("follows the connection", async () => {
    const harness = build({ origin: "workspace" });
    await harness.binding.syncDocument({
      identity: describeWorkspaceDocument({
        workspaceId: "w1",
        documentId: "d1",
        organizationId: "org1",
      }),
      historyRevision: 0,
      online: true,
    });
    harness.binding.attach();

    harness.scope.fire("offline");
    await Promise.resolve();
    expect(harness.binding.getView().state.online).toBe(false);

    harness.scope.fire("online");
    await Promise.resolve();
    expect(harness.binding.getView().state.online).toBe(true);
    harness.binding.dispose();
  });

  it("survives a scope with no event support", () => {
    const store = new MemoryKeyValueStore();
    const binding = new PersistenceBinding({
      origin: "guest",
      capture: () => captured("a.pdf"),
      scope: {},
      store,
      diagnostics: createDiagnostics({ now: () => 0 }),
    });
    expect(() => binding.attach()()).not.toThrow();
    binding.dispose();
  });
});

describe("after dispose", () => {
  it("ignores everything rather than throwing", async () => {
    const { binding } = build();
    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    binding.dispose();

    expect(binding.isDisposed).toBe(true);
    expect(() => binding.noteMutation(2)).not.toThrow();
    expect(() => binding.beginGesture("drag")).not.toThrow();
    expect(() => binding.endGesture("commit")).not.toThrow();
    expect(() => binding.retryLocal()).not.toThrow();
    await expect(binding.syncDocument({ identity: OTHER_GUEST, historyRevision: 0 })).resolves.toBeUndefined();
    await expect(binding.flushLocal()).resolves.toMatchObject({ outcome: "cancelled" });
    await expect(binding.restore(() => ({ historyRevision: 0 }))).resolves.toMatchObject({
      kind: "no_draft",
    });
    await expect(binding.resolveConflict("replace_workspace")).resolves.toMatchObject({
      kind: "not_owned",
    });
  });

  it("reports a flush after dispose as cancelled, never as durable", async () => {
    /*
     * `durable` is the verdict that lets a caller navigate away from unsaved work.
     * A disposed binding knows nothing about what was written, so it must not be
     * the thing that says it is safe to leave.
     */
    const { binding } = build();
    await binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    binding.noteMutation(1);
    binding.dispose();
    const flushed = await binding.flushLocal();
    expect(flushed.outcome).not.toBe("durable");
  });

  it("can be disposed twice", () => {
    const { binding } = build();
    binding.dispose();
    expect(() => binding.dispose()).not.toThrow();
  });
});

describe("readOnline", () => {
  it("believes the browser", () => {
    expect(readOnline({ navigator: { onLine: false } })).toBe(false);
    expect(readOnline({ navigator: { onLine: true } })).toBe(true);
  });

  it("assumes online when the browser will not say", () => {
    // Guessing offline would suspend cloud saves on a working connection.
    expect(readOnline({})).toBe(true);
    expect(readOnline(undefined)).toBe(true);
    expect(readOnline({ navigator: {} })).toBe(true);
  });
});

describe("finding a guest draft with no document open", () => {
  /**
   * Writes a draft through a throwaway binding whose clock is `at`, so the
   * record's `updatedAt` is controllable — the age bound is the whole point of
   * several tests below.
   */
  async function seedAt(
    store: KeyValueStore,
    identity: typeof GUEST,
    revision: number,
    at: number,
  ): Promise<void> {
    const seeder = new PersistenceBinding({
      origin: "guest",
      capture: () => captured("left-behind.pdf"),
      scope: new FakeScope(),
      store,
      now: () => at,
      diagnostics: createDiagnostics({ now: () => 0 }),
      localConfig: { debounceMs: 0, maxDelayMs: 0 },
    });
    await seeder.syncDocument({ identity, historyRevision: 0 });
    for (let r = 1; r <= revision; r += 1) {
      seeder.noteMutation(r);
      expect((await seeder.flushLocal()).outcome).toBe("durable");
    }
    seeder.dispose();
  }

  it("names the document a refreshed tab should reopen", async () => {
    /*
     * After F5 a guest tab has no File, so no fingerprint and no document key —
     * the ordinary probe has nothing to probe under. Without this the autosave
     * that ran before the refresh is unreachable, which is the same as no
     * autosave at all with the storage used up.
     */
    const store = new MemoryKeyValueStore();
    await seedAt(store, GUEST, 3, 1_000);

    const harness = build({ store, now: () => 2_000 });
    const identity = await harness.binding.findAbandonedGuestDraft();
    expect(identity).not.toBeNull();
    expect(identity?.documentKey).toBe("guest:abc");
    expect(identity?.origin).toBe("guest");
    harness.binding.dispose();
  });

  it("finds nothing when nothing was left behind", async () => {
    // The pair. A method that returned a fabricated identity would pass above.
    const harness = build();
    expect(await harness.binding.findAbandonedGuestDraft()).toBeNull();
    harness.binding.dispose();
  });

  it("prefers the most recently touched draft", async () => {
    const store = new MemoryKeyValueStore();
    await seedAt(store, GUEST, 5, 1_000);
    await seedAt(store, OTHER_GUEST, 2, 5_000);

    const harness = build({ store, now: () => 6_000 });
    // Newest wins over higher revision: the last thing the user touched is the
    // thing they were working on.
    expect((await harness.binding.findAbandonedGuestDraft())?.documentKey).toBe("guest:def");
    harness.binding.dispose();
  });

  it("does not offer to reopen the document already on screen", async () => {
    /*
     * A guest who re-picks the same file gets the same key from the fingerprint
     * map, and the ordinary probe already offers that draft. Returning it here as
     * well would put a second "restore?" prompt over a document that is open.
     */
    const store = new MemoryKeyValueStore();
    await seedAt(store, GUEST, 3, 1_000);

    const harness = build({ store, now: () => 2_000 });
    await harness.binding.syncDocument({ identity: GUEST, historyRevision: 0 });
    expect(await harness.binding.findAbandonedGuestDraft()).toBeNull();
    harness.binding.dispose();
  });

  it("ignores a draft old enough that the user has moved on", async () => {
    const store = new MemoryKeyValueStore();
    await seedAt(store, GUEST, 3, 0);

    const fifteenDays = 15 * 24 * 60 * 60 * 1000;
    const harness = build({ store, now: () => fifteenDays });
    expect(await harness.binding.findAbandonedGuestDraft()).toBeNull();
    harness.binding.dispose();

    // And the boundary from the other side, so the bound is a real bound rather
    // than a clock the test never advanced.
    const thirteenDays = 13 * 24 * 60 * 60 * 1000;
    const fresh = build({ store, now: () => thirteenDays });
    expect((await fresh.binding.findAbandonedGuestDraft())?.documentKey).toBe("guest:abc");
    fresh.binding.dispose();
  });

  it("stays quiet when the draft index cannot be read", async () => {
    /*
     * The user opened the editor; they did not ask for recovery. An unreadable
     * store must not throw into the mount path — but it IS recorded, because
     * "recovery silently never offered" is otherwise unexplainable in support.
     */
    const store = new MemoryKeyValueStore();
    const diagnostics = createDiagnostics({ now: () => 0 });
    const binding = new PersistenceBinding({
      origin: "guest",
      capture: () => captured("a.pdf"),
      scope: new FakeScope(),
      store,
      diagnostics,
    });
    binding.runtime.repository.listDrafts = () => Promise.reject(new Error("index unreadable"));

    await expect(binding.findAbandonedGuestDraft()).resolves.toBeNull();
    expect(diagnostics.history().some((entry) => entry.event === "draft_load_failed")).toBe(true);
    binding.dispose();
  });

  it("finds nothing after dispose", async () => {
    const store = new MemoryKeyValueStore();
    await seedAt(store, GUEST, 3, 1_000);
    const harness = build({ store, now: () => 2_000 });
    harness.binding.dispose();
    expect(await harness.binding.findAbandonedGuestDraft()).toBeNull();
  });
});
