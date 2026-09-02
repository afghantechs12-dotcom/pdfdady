import { describe, expect, it, vi } from "vitest";
import type { CapturedDocument } from "../../../application/editor/persistence/DocumentPersistenceCoordinator";
import { createDiagnostics } from "../../../application/editor/persistence/diagnostics";
import { DEVICE_ID_KEY } from "../../../application/editor/persistence/tabCoordination";
import { MemoryKeyValueStore } from "../../../application/editor/persistence/testing/memoryKeyValueStore";
import type { SerializedEditorState } from "../../../application/editor/ports/ISerializer";
import { browserIdFactory, createPersistenceRuntime } from "./createPersistenceRuntime";

/** A scope with every capability, so a test can remove exactly one. */
function fullScope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const backing = new Map<string, string>();
  return {
    localStorage: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => void backing.set(key, value),
    },
    navigator: {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: unknown) => Promise<unknown>,
        ) => callback({}),
      },
    },
    BroadcastChannel: class {
      postMessage(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {}
    },
    crypto: { randomUUID: () => `uuid-${backing.size}-${Math.random().toString(36).slice(2)}` },
    fetch: async () => new Response("{}", { status: 200 }),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ...overrides,
  };
}

function scene(): SerializedEditorState {
  return { version: 1, pages: [], objects: [] } as unknown as SerializedEditorState;
}

function captured(): CapturedDocument {
  return {
    scene: scene(),
    sourceBytes: new Uint8Array([1, 2, 3]),
    sourceReference: null,
    documentName: "a.pdf",
    pageCount: 1,
    objectCount: 0,
  };
}

interface Harness {
  store: MemoryKeyValueStore;
  runtime: ReturnType<typeof createPersistenceRuntime>;
  states: number;
}

function build(
  options: {
    origin?: "guest" | "workspace";
    scope?: Record<string, unknown>;
    store?: MemoryKeyValueStore;
  } = {},
): Harness {
  const store = options.store ?? new MemoryKeyValueStore();
  const harness: Harness = { store, runtime: null as never, states: 0 };
  harness.runtime = createPersistenceRuntime({
    origin: options.origin ?? "guest",
    capture: () => captured(),
    onStateChange: () => {
      harness.states += 1;
    },
    scope: options.scope ?? fullScope(),
    store,
    diagnostics: createDiagnostics({ now: () => 0 }),
    localConfig: { debounceMs: 0, maxDelayMs: 0 },
  });
  return harness;
}

describe("createPersistenceRuntime", () => {
  it("reports nothing wrong when the browser can do everything", () => {
    /*
     * Pairs with each degradation test below. Without it, a function that always
     * reported every limitation would pass all of them.
     */
    const { runtime } = build();
    expect(runtime.limitations).toEqual([]);
    runtime.dispose();
  });

  it("gives a guest document no cloud channel at all", async () => {
    /*
     * A guest has nowhere to save to. Handing the coordinator a transport anyway
     * would schedule a doomed cloud write per edit, and the UI reports a failing
     * channel as a problem rather than as an absence.
     */
    const { runtime } = build({ origin: "guest" });
    await runtime.coordinator.openDocument({
      documentKey: "guest:abc",
      documentId: null,
      workspaceId: null,
      organizationId: null,
      origin: "guest",
      historyRevision: 0,
    });
    expect(runtime.coordinator.view.state.remote).toBe("not_applicable");
    runtime.dispose();
  });

  it("gives a workspace document a cloud channel", async () => {
    const { runtime } = build({ origin: "workspace" });
    await runtime.coordinator.openDocument({
      documentKey: "ws:w1:d1",
      documentId: "d1",
      workspaceId: "w1",
      organizationId: "org1",
      origin: "workspace",
      historyRevision: 0,
      online: true,
    });
    expect(runtime.coordinator.view.state.remote).toBe("idle");
    runtime.dispose();
  });

  it("turns the cloud channel off when the caller omits the organization", async () => {
    /*
     * `remoteEnabled` requires all three workspace ids. A surface that forgets the
     * organization id gets local-only autosave with no error anywhere — so this
     * pins the requirement where a wiring change would trip over it.
     */
    const { runtime } = build({ origin: "workspace" });
    await runtime.coordinator.openDocument({
      documentKey: "ws:w1:d1",
      documentId: "d1",
      workspaceId: "w1",
      organizationId: null,
      origin: "workspace",
      historyRevision: 0,
      online: true,
    });
    expect(runtime.coordinator.view.state.remote).toBe("not_applicable");
    runtime.dispose();
  });

  it("says so when the browser will not store anything", () => {
    const store = new MemoryKeyValueStore();
    store.setAvailable(false);
    const { runtime } = build({ store });
    expect(runtime.limitations.map((l) => l.code)).toContain("no_local_store");
    // The message is shown to a user, so it must not name an API.
    const message = runtime.limitations.find((l) => l.code === "no_local_store")?.message ?? "";
    expect(message).not.toMatch(/indexeddb/i);
    expect(message.length).toBeGreaterThan(20);
    runtime.dispose();
  });

  it("says so when tabs cannot be coordinated", () => {
    const { runtime } = build({ scope: fullScope({ navigator: {} }) });
    expect(runtime.limitations.map((l) => l.code)).toContain("no_cross_tab_lock");
    runtime.dispose();
  });

  it("says so when sibling tabs cannot be told about saves", () => {
    const { runtime } = build({ scope: fullScope({ BroadcastChannel: undefined }) });
    expect(runtime.limitations.map((l) => l.code)).toContain("no_peer_channel");
    runtime.dispose();
  });

  it("says so when the device id cannot be remembered", () => {
    const scope = fullScope({
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("blocked");
        },
      },
    });
    const { runtime } = build({ scope });
    expect(runtime.limitations.map((l) => l.code)).toContain("device_id_not_persisted");
    // But it still opens: an ephemeral id beats no editor.
    expect(runtime.deviceId).toBeTruthy();
    runtime.dispose();
  });

  it("keeps one device id across tabs and a fresh tab id per runtime", () => {
    const scope = fullScope();
    const first = build({ scope });
    const second = build({ scope });

    expect(second.runtime.deviceId).toBe(first.runtime.deviceId);
    expect(second.runtime.tabId).not.toBe(first.runtime.tabId);
    expect(
      (scope.localStorage as { getItem(k: string): string | null }).getItem(DEVICE_ID_KEY),
    ).toBe(first.runtime.deviceId);

    first.runtime.dispose();
    second.runtime.dispose();
  });

  it("writes a real draft end to end", async () => {
    /*
     * The assembly test. Every part is unit-tested elsewhere; what can only break
     * here is a port wired to the wrong thing, and the way that shows up is a
     * coordinator that reports success while the store stays empty.
     */
    const harness = build({ origin: "guest" });
    const { coordinator } = harness.runtime;

    await coordinator.openDocument({
      documentKey: "guest:abc",
      documentId: null,
      workspaceId: null,
      organizationId: null,
      origin: "guest",
      historyRevision: 0,
    });
    coordinator.noteMutation(1);
    const flushed = await coordinator.flushLocal();

    expect(flushed.outcome).toBe("durable");
    expect(harness.store.keys().filter((key) => key.startsWith("snapshot:"))).not.toEqual([]);
    expect(harness.store.keys()).toContain("index:guest:abc");
    expect(coordinator.view.state.lastLocallyDurableRevision).toBe(1);
    expect(harness.states).toBeGreaterThan(0);

    harness.runtime.dispose();
  });

  it("can be disposed twice without throwing", () => {
    const { runtime } = build();
    runtime.dispose();
    expect(() => runtime.dispose()).not.toThrow();
  });
});

describe("browserIdFactory", () => {
  it("prefers randomUUID", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    const id = browserIdFactory({ crypto: { randomUUID } })();
    expect(randomUUID).toHaveBeenCalled();
    expect(id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("falls back to random bytes", () => {
    const getRandomValues = vi.fn((buffer: Uint8Array) => {
      buffer.fill(0xab);
      return buffer;
    });
    const id = browserIdFactory({ crypto: { getRandomValues } })();
    expect(getRandomValues).toHaveBeenCalled();
    expect(id).toBe("ab".repeat(16));
  });

  it("still produces distinct ids with no crypto at all", () => {
    const factory = browserIdFactory({});
    const ids = new Set([factory(), factory(), factory(), factory()]);
    expect(ids.size).toBe(4);
    for (const id of ids) expect(id.length).toBeGreaterThan(8);
  });
});
