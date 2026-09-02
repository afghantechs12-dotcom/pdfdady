/**
 * Keeping two tabs on the same document from destroying each other's work.
 *
 * THE FAILURE. A user opens the same PDF twice — a duplicated tab, a second click
 * on the same workspace link, a restored session. Both tabs autosave to the same
 * draft key. Both read the pointer, both write generation G+1, and the second one
 * wins. The first tab's snapshot is unreachable, nobody was told, and both tabs are
 * showing "Saved".
 *
 * THREE DEFENCES, in order of preference:
 *
 *  1. A lock, so the writes do not interleave at all. Web Locks is the right
 *     primitive and it is what the infrastructure adapter uses.
 *  2. A compare-and-swap on the pointer, which still holds when the lock does not:
 *     Web Locks is absent in some contexts, and any lease-based fallback can expire
 *     under a suspended tab. See `DraftCommitInput.expectedActiveGeneration`.
 *  3. Peer announcements, so a tab knows a sibling has written something NEWER than
 *     what it holds — the one case where the correct answer is not "write anyway
 *     with a guard" but "stop and ask".
 *
 * THREE IDENTITIES, which are deliberately not two. Each answers a different
 * question, and every pair of them has a bug waiting in the collapse:
 *
 *  - `deviceId` — which browser profile the draft store belongs to. Must SURVIVE a
 *    refresh, or every reload orphans the draft the previous load wrote.
 *  - `tabId` — which page load a write came from. Must NOT survive a refresh, or
 *    two tabs look like one and interleave freely.
 *  - `documentSessionId` — which opening of a document a request belongs to. Must
 *    change even within one tab, or a response issued before a close lands on the
 *    state after it (see the header of `events.ts`).
 */

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/** The synchronous string store the device id needs. `localStorage`, in practice. */
export interface IdentityStorage {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export const DEVICE_ID_KEY = "pdfdadi.device-id";

/** Bounds on a stored id, so a corrupt value is replaced rather than propagated. */
const MIN_ID_LENGTH = 8;
const MAX_ID_LENGTH = 128;

export interface ResolvedDeviceId {
  deviceId: string;
  /** True when no usable id was stored and a new one was minted. */
  created: boolean;
  /** False when the id could not be written and will not survive this page load. */
  persisted: boolean;
}

/**
 * The stable id for this browser profile, created on first use.
 *
 * Every failure here degrades to an ephemeral id rather than throwing. A private
 * window, blocked site data or an exhausted quota means recovery will not survive a
 * reload — which is worth reporting, and is what `persisted: false` is for — but an
 * editor that refuses to open is a strictly worse outcome than one that cannot
 * remember which device it is.
 */
export function resolveDeviceId(
  storage: IdentityStorage | null,
  newId: () => string,
): ResolvedDeviceId {
  let stored: string | null = null;
  if (storage) {
    try {
      stored = storage.read(DEVICE_ID_KEY);
    } catch {
      stored = null;
    }
  }
  const trimmed = stored?.trim() ?? "";
  if (trimmed.length >= MIN_ID_LENGTH && trimmed.length <= MAX_ID_LENGTH) {
    return { deviceId: trimmed, created: false, persisted: true };
  }

  const deviceId = newId();
  if (!storage) return { deviceId, created: true, persisted: false };
  try {
    storage.write(DEVICE_ID_KEY, deviceId);
    return { deviceId, created: true, persisted: true };
  } catch {
    return { deviceId, created: true, persisted: false };
  }
}

/** A fresh id for this page load. Never persisted: persistence is the bug. */
export function createTabId(newId: () => string): string {
  return `tab_${newId()}`;
}

/** A fresh id for one opening of one document. */
export function createDocumentSessionId(newId: () => string): string {
  return `sess_${newId()}`;
}

/** Which tab and device a message or a plan belongs to. */
export interface CoordinationSelf {
  deviceId: string;
  tabId: string;
}

/* ------------------------------------------------------------------ */
/* Locking                                                             */
/* ------------------------------------------------------------------ */

/**
 * The lock name for a document's draft.
 *
 * Per document, so editing two files at once is not serialised for no reason. The
 * document key is already unambiguous between guest and workspace documents, and is
 * embedded whole so no two keys can produce the same name.
 */
export function draftLockName(documentKey: string): string {
  return `pdfdadi.draft.${documentKey}`;
}

export interface LockRunResult<T> {
  /** Whether the body ran under real mutual exclusion. */
  held: boolean;
  /** Same as `held`, named for the property the caller actually cares about. */
  serialised: boolean;
  value: T;
}

export interface DraftLock {
  /** False when this context has no lock primitive; see `unlockedDraftLock`. */
  readonly supported: boolean;
  run<T>(name: string, body: () => Promise<T>): Promise<LockRunResult<T>>;
}

/**
 * The fallback for a context with no lock primitive.
 *
 * It runs the body unserialised and says so. Refusing to save instead would turn
 * "this browser lacks one API" into "this browser has no autosave", and the
 * compare-and-swap already converts an interleaving into a reported conflict rather
 * than a silent loss — which is the property that actually matters.
 *
 * A rejection propagates. Wrapping a failed write in a `held: false` result would
 * make a failure indistinguishable from an unserialised success.
 */
export function unlockedDraftLock(): DraftLock {
  return {
    supported: false,
    async run<T>(_name: string, body: () => Promise<T>): Promise<LockRunResult<T>> {
      return { held: false, serialised: false, value: await body() };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Peer announcements                                                  */
/* ------------------------------------------------------------------ */

export type PeerMessage =
  /** A sibling tab promoted a new generation of this document's draft. */
  | {
      kind: "draft_committed";
      documentKey: string;
      draftId: string;
      generation: number;
      revision: number;
      deviceId: string;
      tabId: string;
      at: number;
    }
  /**
   * A sibling tab is going away.
   *
   * Recorded so that a write which was already in flight when the tab closed
   * cannot move this tab's view of the store when it lands. The closing tab is no
   * longer editing, so its late result describes a document nobody is looking at.
   */
  | {
      kind: "tab_closing";
      documentKey: string;
      deviceId: string;
      tabId: string;
      at: number;
    };

/** What sibling tabs have told this one about the shared draft. */
export interface PeerActivity {
  /** The newest generation a peer announced. */
  generation: number | null;
  /** The revision that generation held. */
  revision: number | null;
  tabId: string | null;
  at: number | null;
  /** Tabs that announced they were closing. Their later messages are ignored. */
  departedTabIds: readonly string[];
}

export const NO_PEER_ACTIVITY: PeerActivity = {
  generation: null,
  revision: null,
  tabId: null,
  at: null,
  departedTabIds: [],
};

/** The port a broadcast transport implements. */
export interface PeerBus {
  post(message: PeerMessage): void;
  subscribe(listener: (message: PeerMessage) => void): () => void;
  close(): void;
}

/**
 * Folds one peer message into what this tab knows.
 *
 * Every rejection below returns the SAME object, so a caller can use identity to
 * see that nothing changed and skip a re-render.
 */
export function observePeer(
  activity: PeerActivity,
  message: PeerMessage,
  self: CoordinationSelf,
  documentKey: string,
): PeerActivity {
  // Not about this document, not from this device, or an echo of our own write.
  if (message.documentKey !== documentKey) return activity;
  if (message.deviceId !== self.deviceId) return activity;
  if (message.tabId === self.tabId) return activity;

  if (message.kind === "tab_closing") {
    if (activity.departedTabIds.includes(message.tabId)) return activity;
    return { ...activity, departedTabIds: [...activity.departedTabIds, message.tabId] };
  }

  if (activity.departedTabIds.includes(message.tabId)) return activity;
  // Broadcast delivery is not ordered across a suspended tab's wake-up, and an
  // older announcement arriving late must not walk the generation backwards.
  if (activity.at !== null && message.at < activity.at) return activity;

  return {
    generation: message.generation,
    revision: message.revision,
    tabId: message.tabId,
    at: message.at,
    departedTabIds: activity.departedTabIds,
  };
}

/* ------------------------------------------------------------------ */
/* The commit decision                                                 */
/* ------------------------------------------------------------------ */

export interface CrossTabCommitInput {
  /** The revision this tab is about to write. */
  revision: number;
  /** The generation this tab's own last successful commit produced. */
  ownGeneration: number | null;
  peer: PeerActivity;
  /** Whether the write will run under real mutual exclusion. */
  lockHeld: boolean;
}

export type CrossTabCommitPlan =
  | {
      decision: "proceed";
      /**
       * The value to pass as `expectedActiveGeneration`.
       *
       * `undefined` means "make no claim" and is only ever chosen when a lock is
       * held AND this tab has never committed, so there is nothing to compare.
       */
      expectedActiveGeneration: number | null | undefined;
    }
  /** A peer already stored this exact revision. Writing it again buys nothing. */
  | { decision: "already_durable"; peerRevision: number }
  /** A peer's snapshot is ahead of this tab. Overwriting it would lose their work. */
  | { decision: "conflict"; peerRevision: number; peerTabId: string | null };

/**
 * Whether this tab may write, and under what guard.
 *
 * The interesting case is a peer whose snapshot holds a NEWER revision than the one
 * this tab is about to write. A compare-and-swap would not catch it — the pointer
 * is exactly where the peer left it, so the swap succeeds — and the result is four
 * revisions of someone's work replaced by an older document, with both tabs still
 * reading "Saved". That is the one situation a guard cannot fix and a decision must.
 */
export function planCrossTabCommit(input: CrossTabCommitInput): CrossTabCommitPlan {
  const { peer, revision } = input;

  if (peer.revision !== null) {
    if (peer.revision > revision) {
      return { decision: "conflict", peerRevision: peer.revision, peerTabId: peer.tabId };
    }
    if (peer.revision === revision) {
      return { decision: "already_durable", peerRevision: peer.revision };
    }
  }

  /*
   * The guard value: the newest generation this tab has reason to believe is
   * active. A peer's announcement supersedes this tab's own last commit, because it
   * happened afterwards — and passing the stale one would reject a write that is
   * perfectly correct.
   */
  const known = [input.ownGeneration, peer.generation].filter(
    (value): value is number => value !== null,
  );
  if (known.length > 0) {
    return { decision: "proceed", expectedActiveGeneration: Math.max(...known) };
  }

  /*
   * Nothing known. With a lock, no claim is needed: no other tab can be inside a
   * commit. Without one, `null` — "there was no draft when I looked" — is the only
   * thing standing between two first-commits and a silent overwrite.
   */
  return {
    decision: "proceed",
    expectedActiveGeneration: input.lockHeld ? undefined : null,
  };
}
