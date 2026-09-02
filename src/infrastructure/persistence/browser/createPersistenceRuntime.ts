import {
  DocumentPersistenceCoordinator,
  type CapturedDocument,
  type CoordinatorPorts,
} from "../../../application/editor/persistence/DocumentPersistenceCoordinator";
import { createDiagnostics, type Diagnostics } from "../../../application/editor/persistence/diagnostics";
import { localIdentityStorage } from "../../../application/editor/persistence/documentIdentity";
import { draftMigrationRegistry } from "../../../application/editor/persistence/draftEnvelope";
import { DraftRepository } from "../../../application/editor/persistence/draftRepository";
import type { KeyValueStore, RemoteDocumentTransport } from "../../../application/editor/persistence/ports";
import type { PersistenceState } from "../../../application/editor/persistence/persistenceMachine";
import { createDraftLock } from "./WebLocksDraftLock";
import { createPeerBus } from "./BroadcastChannelPeerBus";
import { IndexedDbKeyValueStore } from "./IndexedDbKeyValueStore";
import { WorkspaceAutosaveTransport } from "./WorkspaceAutosaveTransport";
import { createTabId, resolveDeviceId } from "../../../application/editor/persistence/tabCoordination";
import type { WriteSchedulerConfig } from "../../../application/editor/persistence/writeScheduler";

/**
 * Where the browser meets the coordinator, and the only file that knows both.
 *
 * The coordinator is deliberately ignorant of IndexedDB, Web Locks,
 * `BroadcastChannel`, `fetch` and `Date`. That is what makes it testable, and it
 * means something has to assemble the real thing exactly once. This is that
 * something, and it is a plain function rather than a module-level singleton
 * because every one of these APIs is absent during server rendering: constructing
 * a bus or reading `localStorage` at import time would break the build, not the
 * feature.
 *
 * WHAT IT REFUSES TO DO QUIETLY. Each capability here can be missing — private
 * windows block storage, insecure contexts have no Web Locks, older browsers have
 * no `BroadcastChannel`. Every one degrades to a working-but-weaker path, and
 * every degradation is reported in {@link PersistenceRuntime.limitations} so a
 * surface can say "this browser will not remember your work" instead of showing a
 * reassuring "Saved locally" that is false.
 */

export type PersistenceLimitationCode =
  /** No usable draft store. Local recovery is off entirely. */
  | "no_local_store"
  /** The device id could not be persisted, so drafts written now look foreign later. */
  | "device_id_not_persisted"
  /** No Web Locks: concurrent tabs are guarded only by the pointer compare-and-swap. */
  | "no_cross_tab_lock"
  /** No BroadcastChannel: sibling tabs cannot announce commits to each other. */
  | "no_peer_channel";

export interface PersistenceLimitation {
  code: PersistenceLimitationCode;
  /** Plain language, safe to show a user. */
  message: string;
}

export interface PersistenceRuntimeOptions {
  origin: "guest" | "workspace";
  /** MUST NOT await — see the coordinator's invariant 2. */
  capture: () => CapturedDocument | null;
  onStateChange: (state: PersistenceState) => void;
  /** Window-like. Injected so this whole file is testable in Node. */
  scope?: unknown;
  diagnostics?: Diagnostics;
  /** Injected in tests; defaults to a real IndexedDB store. */
  store?: KeyValueStore;
  /**
   * Injected in tests. `undefined` builds the real workspace transport for a
   * workspace document; `null` forces the local-only path.
   */
  transport?: RemoteDocumentTransport | null;
  now?: () => number;
  newId?: () => string;
  localConfig?: Partial<WriteSchedulerConfig>;
  remoteConfig?: Partial<WriteSchedulerConfig>;
}

export interface PersistenceRuntime {
  coordinator: DocumentPersistenceCoordinator;
  repository: DraftRepository;
  diagnostics: Diagnostics;
  deviceId: string;
  tabId: string;
  limitations: readonly PersistenceLimitation[];
  dispose(): void;
}

export function createPersistenceRuntime(options: PersistenceRuntimeOptions): PersistenceRuntime {
  const scope: Record<string, unknown> =
    (options.scope as Record<string, unknown> | undefined) ??
    (globalThis as unknown as Record<string, unknown>);

  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? browserIdFactory(scope);
  const diagnostics = options.diagnostics ?? createDiagnostics({ now });
  const limitations: PersistenceLimitation[] = [];

  const store =
    options.store ??
    new IndexedDbKeyValueStore({
      factory: (scope.indexedDB as IDBFactory | undefined) ?? null,
    });
  if (!store.isAvailable()) {
    limitations.push({
      code: "no_local_store",
      message:
        "This browser will not let the page store data, so unsaved changes cannot be kept on this device.",
    });
  }

  /*
   * Local storage, not session storage: a device id that changed per tab would make
   * every tab's drafts look like a foreign device's, and cross-tab coordination
   * keys off exactly this value.
   */
  const device = resolveDeviceId(localIdentityStorage(scope), newId);
  const tabId = createTabId(newId);
  if (!device.persisted) {
    limitations.push({
      code: "device_id_not_persisted",
      message:
        "This browser is not storing a device id, so recovery will not survive closing the tab.",
    });
  }

  const lock = createDraftLock(scope.navigator);
  if (!lock.supported) {
    limitations.push({
      code: "no_cross_tab_lock",
      message: "This browser cannot coordinate tabs, so keep this document open in one tab.",
    });
  }

  const peers = createPeerBus(
    typeof scope.BroadcastChannel === "function"
      ? (name) =>
          new (scope.BroadcastChannel as new (n: string) => {
            postMessage(m: unknown): void;
            addEventListener(t: "message", l: (e: { data: unknown }) => void): void;
            removeEventListener(t: "message", l: (e: { data: unknown }) => void): void;
            close(): void;
          })(name)
      : undefined,
  );
  if (typeof scope.BroadcastChannel !== "function") {
    limitations.push({
      code: "no_peer_channel",
      message: "This browser cannot tell your other tabs about saves.",
    });
  }

  const repository = new DraftRepository(store, draftMigrationRegistry());

  /*
   * A guest document has nowhere to save to. Passing a transport anyway would make
   * every guest edit schedule a cloud write that fails, and a failing channel is
   * reported to the user as a problem rather than as an absence.
   */
  const transport =
    options.transport !== undefined
      ? options.transport
      : options.origin === "workspace"
        ? new WorkspaceAutosaveTransport({
            fetchImpl:
              typeof scope.fetch === "function"
                ? ((scope.fetch as typeof fetch).bind(scope) as typeof fetch)
                : undefined,
          })
        : null;

  const ports: CoordinatorPorts = {
    store,
    repository,
    transport,
    lock,
    peers,
    diagnostics,
    capture: options.capture,
    now,
    newId,
    setTimer: (callback, ms) => scopedSetTimeout(scope, callback, ms),
    clearTimer: (handle) => scopedClearTimeout(scope, handle),
    onStateChange: options.onStateChange,
    deviceId: device.deviceId,
    tabId,
    localConfig: options.localConfig,
    remoteConfig: options.remoteConfig,
  };

  const coordinator = new DocumentPersistenceCoordinator(ports);

  return {
    coordinator,
    repository,
    diagnostics,
    deviceId: device.deviceId,
    tabId,
    limitations,
    dispose() {
      // The coordinator closes the peer bus and cancels timers; the store's
      // connection is kept because a second runtime in the same tab reuses it.
      coordinator.dispose();
    },
  };
}

function scopedSetTimeout(scope: Record<string, unknown>, callback: () => void, ms: number): unknown {
  const setter = scope.setTimeout as typeof setTimeout | undefined;
  return setter ? setter(callback, ms) : setTimeout(callback, ms);
}

function scopedClearTimeout(scope: Record<string, unknown>, handle: unknown): void {
  const clearer = scope.clearTimeout as typeof clearTimeout | undefined;
  if (clearer) clearer(handle as ReturnType<typeof setTimeout>);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * Ids for this page load.
 *
 * `crypto.randomUUID` where it exists, `getRandomValues` next, and a
 * counter-plus-clock fallback last. The fallback's collision risk is confined to
 * one tab's request ids and one device id, both of which are compared only against
 * others from the same tab.
 */
export function browserIdFactory(scope: Record<string, unknown>): () => string {
  const crypto = scope.crypto as Crypto | undefined;
  if (crypto && typeof crypto.randomUUID === "function") {
    return () => crypto.randomUUID();
  }
  if (crypto && typeof crypto.getRandomValues === "function") {
    return () => {
      const buffer = new Uint8Array(16);
      crypto.getRandomValues(buffer);
      return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
  }
  let counter = 0;
  return () => `${Date.now().toString(36)}-${(counter += 1).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export { localIdentityStorage };
