import {
  hasUnprotectedWork,
  isCurrentRevisionLocallyDurable,
  isCurrentRevisionRemotelyAcknowledged,
  type PersistenceState,
} from "./persistenceMachine";

/**
 * Whether leaving is safe, and what to offer when it is not.
 *
 * THE RULE: protection is keyed on DURABILITY, never on dirtiness. Almost every
 * editor gets this wrong and blocks on "the document has been edited", which is
 * the wrong question in both directions. It stops a user whose work is already
 * safe in IndexedDB (so they learn the dialog is noise and click through it), and
 * it says nothing at all about the one case that matters — the seconds between a
 * mutation and the write that captures it.
 *
 * So there are three outcomes, and the middle one is the interesting one:
 *
 *  - `allow`  Nothing is at risk. The newest revision is durable somewhere.
 *  - `warn`   Durable on this device but not in the workspace. In-app navigation
 *             is ALLOWED — the work survives — but the user is told the cloud copy
 *             is behind, because "I closed my laptop and my colleague never saw the
 *             change" is a real loss even though no bytes were destroyed.
 *  - `block`  The newest revision exists only in this tab's memory. Leaving
 *             destroys it, so leaving needs a decision.
 */
export type NavigationDecision = "allow" | "warn" | "block";

/** The choices offered when leaving would lose work. */
export type NavigationActionId =
  /** Hold the navigation until the in-flight local write finishes. */
  | "wait_for_save"
  /** Flush a local write now, then leave. */
  | "save_locally_and_leave"
  /** Try the workspace save again before leaving. */
  | "retry_cloud_save"
  /** Leave, accepting the loss. Never the default. */
  | "leave_and_discard"
  /** Stay. Always available, always the safe default. */
  | "cancel";

export interface NavigationGuardVerdict {
  decision: NavigationDecision;
  /** One sentence naming exactly what is and is not safe. */
  reason: string;
  /**
   * Offered in the order they should appear: the action that saves the work
   * first, then `leave_and_discard`, then `cancel`.
   *
   * The destructive action is never first and never last — not first because a
   * hurried user must not hit it by reflex, and not last because `cancel` is the
   * safe default and belongs in the position a dialog gives that role.
   */
  actions: NavigationActionId[];
  /**
   * Whether the browser's `beforeunload` should be armed.
   *
   * A last-resort fallback only. The browser shows its OWN fixed wording; it
   * cannot display any of the text above, and nothing in this app should claim
   * otherwise. It buys one chance to reconsider, nothing more — which is why the
   * real protection is the in-app dialog and the flush-on-hide path.
   */
  armBeforeUnload: boolean;
}

const SAFE: NavigationGuardVerdict = {
  decision: "allow",
  reason: "All changes are saved.",
  actions: [],
  armBeforeUnload: false,
};

export function evaluateNavigation(state: PersistenceState): NavigationGuardVerdict {
  if (state.documentId === null) return SAFE;

  const localDurable = isCurrentRevisionLocallyDurable(state);
  const remoteAcked = isCurrentRevisionRemotelyAcknowledged(state);

  if (!hasUnprotectedWork(state)) {
    /*
     * The newest revision is durable somewhere. Two shades of safe:
     * fully synced, or safe-on-this-device-only. The second is allowed to
     * navigate but says so, because the user's mental model of "saved" for a
     * workspace document includes their colleagues seeing it.
     */
    if (state.remoteEnabled && !remoteAcked && localDurable) {
      return {
        decision: "warn",
        reason:
          "Your changes are stored in this browser but have not reached your workspace yet. They will sync when possible; if you clear this browser's data first, they are lost.",
        actions: ["retry_cloud_save", "cancel"],
        armBeforeUnload: false,
      };
    }
    return SAFE;
  }

  /*
   * There IS unprotected work, and the first question is whether waiting could
   * possibly help — because that decides which actions are honest to offer.
   *
   * A store that cannot be opened is a different situation from a write that has
   * not happened yet, even though both leave the local watermark behind. "Save
   * locally and leave" over an unavailable store is worse than offering nothing:
   * the user clicks it, the dialog closes, and they leave believing a save
   * happened. Same for "Wait for save" — nothing is coming to wait for. The only
   * real exits are the workspace, if there is one, and exporting the file.
   */
  if (state.local === "unavailable") {
    const unavailableActions: NavigationActionId[] = [];
    if (state.remoteEnabled) unavailableActions.push("retry_cloud_save");
    unavailableActions.push("leave_and_discard", "cancel");
    return {
      decision: "block",
      reason: state.remoteEnabled
        ? "This browser will not store a local copy of your work, and your workspace has not accepted it yet. Closing this tab discards it."
        : "This browser will not store a local copy of your work, and it is not saved to a workspace. Closing this tab discards it — export the file to keep it.",
      actions: unavailableActions,
      armBeforeUnload: true,
    };
  }

  const waiting = state.local === "writing";
  const actions: NavigationActionId[] = [];
  if (waiting) actions.push("wait_for_save");
  else actions.push("save_locally_and_leave");
  if (state.remoteEnabled && (state.remote === "failed" || state.remote === "conflict")) {
    actions.push("retry_cloud_save");
  }
  actions.push("leave_and_discard", "cancel");

  return {
    decision: "block",
    reason: waiting
      ? "Your most recent changes are still being stored. Leaving now would lose them."
      : "Your most recent changes are not stored anywhere yet. Leaving now would lose them.",
    actions,
    armBeforeUnload: true,
  };
}

/** Human labels for the offered actions, kept beside the policy that offers them. */
export const NAVIGATION_ACTION_LABELS: Record<NavigationActionId, string> = {
  wait_for_save: "Wait for save",
  save_locally_and_leave: "Save locally and leave",
  retry_cloud_save: "Retry cloud save",
  leave_and_discard: "Leave and discard changes",
  cancel: "Stay on this document",
};

/**
 * Whether to arm `beforeunload`.
 *
 * Deliberately a narrower condition than the in-app guard: the native dialog is
 * an interruption the app cannot word, style, or explain, so it is reserved for
 * the case where the work would actually be destroyed.
 */
export function shouldArmBeforeUnload(state: PersistenceState): boolean {
  return evaluateNavigation(state).armBeforeUnload;
}
