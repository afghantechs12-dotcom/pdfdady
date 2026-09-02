import type { PeerBus, PeerMessage } from "@/src/application/editor/persistence/tabCoordination";

/**
 * A {@link PeerBus} over `BroadcastChannel`.
 *
 * Announcements only. Nothing in the persistence system trusts a peer message for
 * anything a peer could get wrong: it never carries document content, and the
 * decisions it feeds (`planCrossTabCommit`) are re-checked against the store's own
 * pointer by the compare-and-swap. A message that is dropped, duplicated or
 * delivered late costs at most one avoidable conflict prompt, never a lost edit.
 *
 * `BroadcastChannel` does not echo to the sender, and `observePeer` filters on
 * `tabId` anyway — a transport that did echo would otherwise have every tab
 * conflicting with itself.
 */

/** The slice of `BroadcastChannel` this needs, so a test can supply one. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export const PEER_CHANNEL_NAME = "pdfdadi.editor.persistence";

export class BroadcastChannelPeerBus implements PeerBus {
  private readonly listeners = new Set<(message: PeerMessage) => void>();
  private closed = false;

  private readonly onMessage = (event: { data: unknown }): void => {
    const message = parsePeerMessage(event.data);
    if (!message) return;
    for (const listener of this.listeners) listener(message);
  };

  constructor(private readonly channel: BroadcastChannelLike) {
    channel.addEventListener("message", this.onMessage);
  }

  post(message: PeerMessage): void {
    if (this.closed) return;
    try {
      this.channel.postMessage(message);
    } catch {
      /*
       * A post that fails is not worth surfacing. The receiving side is an
       * optimisation over the compare-and-swap, and a thrown error here would turn
       * a best-effort courtesy into a failed save.
       */
    }
  }

  subscribe(listener: (message: PeerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.close();
  }
}

/**
 * Validates a message off the wire.
 *
 * A `BroadcastChannel` is shared by every page on the origin, including older
 * builds of this app and anything else that picked the same channel name. An
 * unvalidated `data` would let a stray message move this tab's view of which
 * generation is durable, so every field is checked and anything unrecognised is
 * dropped silently.
 */
export function parsePeerMessage(data: unknown): PeerMessage | null {
  if (data === null || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (
    typeof record.documentKey !== "string" ||
    typeof record.deviceId !== "string" ||
    typeof record.tabId !== "string" ||
    typeof record.at !== "number" ||
    !Number.isFinite(record.at)
  ) {
    return null;
  }
  if (record.kind === "tab_closing") {
    return {
      kind: "tab_closing",
      documentKey: record.documentKey,
      deviceId: record.deviceId,
      tabId: record.tabId,
      at: record.at,
    };
  }
  if (record.kind !== "draft_committed") return null;
  if (
    typeof record.draftId !== "string" ||
    typeof record.generation !== "number" ||
    !Number.isInteger(record.generation) ||
    typeof record.revision !== "number" ||
    !Number.isInteger(record.revision)
  ) {
    return null;
  }
  return {
    kind: "draft_committed",
    documentKey: record.documentKey,
    draftId: record.draftId,
    generation: record.generation,
    revision: record.revision,
    deviceId: record.deviceId,
    tabId: record.tabId,
    at: record.at,
  };
}

/**
 * A bus for this context, or a silent one where `BroadcastChannel` is absent.
 *
 * The no-op bus is safe by construction: with no announcements, `planCrossTabCommit`
 * sees no peer and every commit goes out under a compare-and-swap, which is the
 * degraded-but-correct path.
 */
export function createPeerBus(
  factory: ((name: string) => BroadcastChannelLike) | undefined = typeof BroadcastChannel ===
  "function"
    ? (name) => new BroadcastChannel(name) as unknown as BroadcastChannelLike
    : undefined,
): PeerBus {
  if (!factory) return silentPeerBus();
  try {
    return new BroadcastChannelPeerBus(factory(PEER_CHANNEL_NAME));
  } catch {
    return silentPeerBus();
  }
}

export function silentPeerBus(): PeerBus {
  return {
    post: () => {},
    subscribe: () => () => {},
    close: () => {},
  };
}
