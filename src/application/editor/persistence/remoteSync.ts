import type { ConflictInfo } from "./events";
import { isCurrentRevisionRemotelyAcknowledged, type PersistenceState } from "./persistenceMachine";

/**
 * What to do when the connection comes back.
 *
 * The naive reconnect is "retry the queued save", and it is how an offline editor
 * overwrites work someone else did during the outage. The client has been away; it
 * does not know what the server holds any more, and the version it expected to be
 * writing over may be several versions stale.
 *
 * So the sequence is: find the newest locally durable revision, ask the server
 * what version it is on NOW, and only then decide. That ordering is the whole
 * point — asking after sending is asking too late.
 *
 * `navigator.onLine` is treated as a retry SIGNAL and never as proof of
 * reachability. It reports a link-layer connection, not a route to this server:
 * a captive portal, a VPN that has not come up, or a server that is simply down
 * all present as "online". Which is why the plan always includes a real round
 * trip before anything is marked saved.
 */
export type ReconnectAction =
  /** Everything the server needs, it already has. */
  | { action: "nothing_to_sync" }
  /**
   * The version number moved but the CONTENT did not, proven by a matching
   * validator. Only then is a bare token refresh safe; see `planReconnect`.
   */
  | { action: "adopt_server_version"; serverVersion: number | null; etag: string | null }
  /**
   * The server moved on and this canvas holds nothing of the user's, so the
   * server copy should simply replace it. Costs the user nothing and leaves the
   * client genuinely up to date rather than merely claiming to be.
   */
  | { action: "reload_from_server"; serverVersion: number; etag: string | null }
  /** The server moved on AND the canvas holds the user's work. Neither may be discarded. */
  | { action: "conflict"; conflict: ConflictInfo }
  /** Safe to send: our expected version still matches the server's. */
  | { action: "sync"; revision: number; expectedServerVersion: number | null }
  /** No server to talk to. */
  | { action: "not_applicable" };

export interface ReconnectInput {
  state: PersistenceState;
  /** What the server reports RIGHT NOW, from a fresh read. */
  serverVersion: number | null;
  etag: string | null;
  now: number;
}

export function planReconnect(input: ReconnectInput): ReconnectAction {
  const { state, serverVersion } = input;
  if (!state.remoteEnabled || state.documentId === null) return { action: "not_applicable" };

  const hasUnsyncedWork = !isCurrentRevisionRemotelyAcknowledged(state);
  /*
   * `null` on either side means "unknown", not "changed". A server that does not
   * report a version cannot be used to prove divergence, and treating unknown as
   * conflict would make every save after a reconnect require a decision.
   */
  const serverMoved =
    serverVersion !== null && state.serverVersion !== null && serverVersion !== state.serverVersion;

  if (!serverMoved) {
    if (hasUnsyncedWork) {
      return {
        action: "sync",
        revision: state.currentRevision,
        expectedServerVersion: state.serverVersion,
      };
    }
    return { action: "nothing_to_sync" };
  }

  /*
   * THE SERVER HAS MOVED. Everything below is about one refusal: this client will
   * not carry a version token it did not read the content of.
   *
   * Adopting a version number means asserting "the canvas I hold IS that
   * version". The next save presents the token, the server's optimistic check
   * passes, and whatever that version contained is replaced by this canvas. That
   * is not a conflict the user gets to resolve — it is a silent overwrite, and the
   * client caused it by claiming to be up to date. So a bare adoption requires
   * PROOF of equivalence, and there are only three honest outcomes.
   */

  /*
   * 1. Proven equivalent. A matching validator means the version moved without
   *    the bytes moving — a rename, a metadata touch, a re-save of identical
   *    content. The canvas already IS the new version, so the token is safe.
   *
   *    Both sides must be non-null: two unknowns are not a match, and reading
   *    `null === null` as equality would restore the exact bug this guards.
   */
  const provenEquivalent = input.etag !== null && state.etag !== null && input.etag === state.etag;
  if (provenEquivalent) {
    return { action: "adopt_server_version", serverVersion, etag: input.etag };
  }

  /*
   * 2. Nothing of the user's on screen. The document is exactly as it was opened
   *    — no edits, no recovered draft — so replacing it with the server copy
   *    destroys nothing and makes the client honestly current. Note that this is
   *    a RELOAD, not an adoption: the bytes come too.
   *
   *    `currentRevision > baselineRevision` is the test rather than
   *    `hasUnsyncedWork`, because a document whose every edit reached the server
   *    as an autosave draft has nothing "unsynced" and still has the user's work
   *    on screen. A recovered draft raises `currentRevision` the same way.
   */
  const canvasHoldsUserWork = state.currentRevision > state.baselineRevision;
  if (!canvasHoldsUserWork) {
    return { action: "reload_from_server", serverVersion, etag: input.etag };
  }

  /*
   * 3. Divergence with something to lose on both sides. Reloading discards edits
   *    the user can see; adopting lets them overwrite a version they never saw.
   *    The only correct move is to stop and ask — which is what a conflict is.
   */
  return {
    action: "conflict",
    conflict: {
      localRevision: state.currentRevision,
      expectedServerVersion: state.serverVersion,
      actualServerVersion: serverVersion,
      detail:
        "The workspace copy changed while this tab was offline, so your changes were not sent.",
      detectedAt: input.now,
    },
  };
}

/**
 * Whether the newest revision has actually been acknowledged.
 *
 * The predicate `Saved` is allowed to depend on, and nothing else. Named and
 * exported so the assertion is testable in isolation from the UI that reads it —
 * "never display Saved merely because a request completed" is a claim about this
 * function.
 */
export function isFullySynced(state: PersistenceState): boolean {
  if (!state.remoteEnabled) return false;
  if (state.remote === "conflict" || state.remote === "failed") return false;
  return isCurrentRevisionRemotelyAcknowledged(state);
}
