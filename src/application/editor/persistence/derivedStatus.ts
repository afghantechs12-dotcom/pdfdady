import {
  hasUnprotectedWork,
  isCurrentRevisionCommitted,
  isCurrentRevisionLocallyDurable,
  isCurrentRevisionRemotelyAcknowledged,
  type PersistenceState,
} from "./persistenceMachine";
import type { PersistenceChannel } from "./events";

/**
 * The ONE place where four independent state dimensions become one sentence.
 *
 * Everything the user is told about document safety is computed here, from the
 * revision watermarks — never from "a request completed". That is the whole point:
 * `remote === "synced"` means the last save succeeded, which is not the same claim
 * as "the document on screen is saved", and only the watermark comparison can tell
 * them apart. `Saved` is emitted exclusively when the CURRENT revision has been
 * acknowledged by every channel that applies to this document.
 *
 * The precedence order below is a data-safety ranking, not a severity ranking:
 * the state that appears is the one whose misreading would cost the user the most.
 * A failed local write outranks a workspace conflict because a user who closes the
 * tab loses the document in the first case and loses nothing in the second. And no
 * state is ever allowed to imply something about a dimension it does not describe:
 * a cloud failure says "your changes are safe on this device" when they are,
 * because the alternative sends the user hunting for a copy they already have.
 */
export type SaveStatusKind =
  /** Nothing open, nothing to say. */
  | "idle"
  /**
   * Open, but not edited yet — so there is nothing to save and nothing stored.
   *
   * Distinct from `saved_local`, which is the claim this state exists to avoid
   * making. A document that was only opened has no draft in this browser, and
   * saying "Saved on this device" over it is a lie that later becomes dangerous:
   * the user learns the phrase means nothing.
   */
  | "unchanged"
  /** Edits exist that no durable store holds. */
  | "unsaved"
  | "saving_local"
  /** Durable on this device; either a guest document, or the cloud is behind. */
  | "saved_local"
  | "saving_remote"
  /** The revision on screen is acknowledged everywhere it needs to be. */
  | "saved"
  /** No connection, but the newest revision is on this device. */
  | "offline_durable"
  /** No connection and the newest revision is not yet on this device either. */
  | "offline_pending"
  | "remote_failed"
  /**
   * The workspace cannot back this document up AT ALL, and no retry will change
   * that — the payload exceeds the autosave ceiling. Distinct from
   * `remote_failed`, which is an attempt that could succeed next time.
   */
  | "remote_unavailable"
  | "local_failed"
  /** This browser context has no durable store at all. */
  | "no_local_storage"
  | "conflict"
  | "recovered"
  | "recovery_failed";

export type SaveStatusTone = "neutral" | "progress" | "success" | "warning" | "danger";

/**
 * Which glyph the status uses.
 *
 * A named shape rather than a colour, because colour is not allowed to be the
 * only carrier of state — and because a user who cannot distinguish the amber
 * from the green ring still needs to know whether their work is safe.
 */
export type SaveStatusIcon =
  | "check"
  | "cloud-check"
  | "cloud-off"
  | "cloud-alert"
  | "device-check"
  | "spinner"
  | "alert"
  | "warning"
  | "history";

export interface SaveStatusView {
  kind: SaveStatusKind;
  /** The visible label. Short enough not to reflow the document title. */
  label: string;
  /** The abbreviated label for narrow layouts. Never the only text shown. */
  short: string;
  /**
   * The full sentence: tooltip, popover heading, and the screen-reader text.
   * Always states what IS safe, not only what failed.
   */
  detail: string;
  tone: SaveStatusTone;
  icon: SaveStatusIcon;
  /**
   * Whether this state is worth interrupting a screen-reader user for.
   *
   * False for `unsaved`, which changes on every keystroke — announcing it would
   * make the editor unusable with a screen reader. True for arrivals and
   * failures, which are the transitions a user needs to hear about.
   */
  announce: boolean;
  /** The channel a Retry button should target, when retrying can help. */
  retry: PersistenceChannel | null;
  /** True when the state needs a decision rather than a retry. */
  needsResolution: boolean;
}

/**
 * The one predicate behind every "unsaved changes" affordance — a workbench tab
 * dot, a close dialog, a menu badge.
 *
 * It reads the SAME {@link SaveStatusView} the readout renders, which is the
 * entire point: a dot derived independently is how a tab came to show "Unsaved
 * changes" beside a status bar reading "Saved on this device". The two cannot
 * disagree if there is only one fact.
 *
 * `tone === "success"` is the safe set rather than an enumeration of kinds, so a
 * state added to {@link SaveStatusKind} later cannot default to "safe" by being
 * forgotten here — a new state is pending until its projection says otherwise.
 * `idle` and `unchanged` are excluded because there is no work to be pending:
 * nothing is open, or nothing has been changed.
 */
export function statusHasPendingWork(status: SaveStatusView): boolean {
  if (status.kind === "idle" || status.kind === "unchanged") return false;
  return status.tone !== "success";
}

/** The independent per-dimension lines shown in the detail popover. */
export interface SaveStatusBreakdown {
  /** On-device durability, stated on its own terms. */
  local: string;
  /** Server durability, or why it does not apply. */
  remote: string;
  /** Recovery provenance, when there is any. */
  recovery: string | null;
  /** The last successful local write, as a timestamp. */
  lastLocalSaveAt: number | null;
  lastRemoteSaveAt: number | null;
}

const NEVER = -1;

export function deriveSaveStatus(state: PersistenceState): SaveStatusView {
  if (state.documentId === null && state.recovery === "none") {
    return {
      kind: "idle",
      label: "No document",
      short: "—",
      detail: "No document is open.",
      tone: "neutral",
      icon: "check",
      announce: false,
      retry: null,
      needsResolution: false,
    };
  }

  const localDurable = isCurrentRevisionLocallyDurable(state);
  const remoteAcked = isCurrentRevisionRemotelyAcknowledged(state);

  if (state.recovery === "recovery_failed") {
    return {
      kind: "recovery_failed",
      label: "Recovery failed",
      short: "Recovery failed",
      detail:
        state.recoveryFailure?.message ??
        "A draft was found for this document but could not be restored. The saved version is unchanged.",
      tone: "danger",
      icon: "alert",
      announce: true,
      retry: null,
      needsResolution: true,
    };
  }

  /*
   * Nothing has been edited beyond the source. Placed ahead of the storage and
   * connectivity branches deliberately: "This browser can't save locally — export
   * before closing" over a document the user has only LOOKED at is a false alarm,
   * and false alarms are what teach users to ignore the real one. Gated on
   * `!remoteAcked` so a workspace document still reports the truthful, stronger
   * claim that the server holds it.
   *
   * None of the branches below can be reached in this condition anyway — opening a
   * document schedules no write, so `writing`, `failed`, `saving` and `conflict`
   * are all unreachable — with the single exception of `unavailable`, which is
   * carried across from a previous document and is exactly the false alarm above.
   */
  if (
    state.currentRevision <= state.baselineRevision &&
    // Typing into a text box is a change, even though it has not become a command
    // yet. Without this, the first characters a user types read "No changes yet".
    !state.uncommittedInput &&
    !localDurable &&
    !remoteAcked
  ) {
    return {
      kind: "unchanged",
      label: "No changes yet",
      short: "No changes",
      detail:
        "You have not changed this document, so there is nothing to save. Your original file is untouched.",
      tone: "neutral",
      icon: "check",
      announce: false,
      retry: null,
      needsResolution: false,
    };
  }

  if (state.local === "failed") {
    /*
     * The most dangerous state in the system, and the only one whose copy asks
     * the user to act before closing. If the cloud copy happens to be current the
     * sentence says so — "resolve before closing" over work that is already on the
     * server would be a false alarm.
     */
    const cloudSafe = remoteAcked;
    return {
      kind: "local_failed",
      label: cloudSafe ? "Local save failed" : "Local save failed — resolve before closing",
      short: "Local save failed",
      detail: cloudSafe
        ? `This device could not store a copy (${state.localChannel.failureReason?.message ?? "unknown error"}), but your changes are saved in your workspace.`
        : `This device could not store your changes (${state.localChannel.failureReason?.message ?? "unknown error"}). Export or save to your workspace before closing this tab.`,
      tone: "danger",
      icon: "alert",
      announce: true,
      retry: state.localChannel.failureReason?.retryable ? "local" : null,
      needsResolution: !cloudSafe,
    };
  }

  if (state.remote === "conflict") {
    return {
      kind: "conflict",
      label: "Conflict detected",
      short: "Conflict",
      detail: localDurable
        ? "The workspace copy changed while you were editing. Both versions are kept — your changes are safe on this device until you choose one."
        : "The workspace copy changed while you were editing. Your changes are still in this tab; choose how to resolve it before closing.",
      tone: "warning",
      icon: "cloud-alert",
      announce: true,
      retry: null,
      needsResolution: true,
    };
  }

  if (state.local === "unavailable") {
    /*
     * Private browsing, a blocked storage API, or a browser that refused to open
     * the database. Offering a Retry here would be dishonest — nothing about the
     * next attempt would differ. What the user needs is to know that closing the
     * tab ends the document, and where the exit is.
     */
    const cloudSafe = remoteAcked;
    if (state.edit === "clean" && cloudSafe) {
      return savedView(state, true);
    }
    return {
      kind: "no_local_storage",
      label: cloudSafe ? "Not saved on this device" : "This browser can't save locally",
      short: "No local save",
      detail: cloudSafe
        ? "This browser will not store a local copy, but your changes are saved in your workspace."
        : "This browser will not store a local copy of your work — private browsing or blocked site storage. Export the file, or save it to a workspace, before closing this tab.",
      tone: cloudSafe ? "warning" : "danger",
      icon: "warning",
      announce: true,
      retry: null,
      needsResolution: !cloudSafe,
    };
  }

  if (state.local === "writing") {
    return {
      kind: "saving_local",
      label: "Saving locally…",
      short: "Saving…",
      detail: "Storing a copy of your changes in this browser.",
      tone: "progress",
      icon: "spinner",
      announce: false,
      retry: null,
      needsResolution: false,
    };
  }

  if (state.remoteEnabled && !state.online) {
    return localDurable
      ? {
          kind: "offline_durable",
          label: "Offline — changes saved on this device",
          short: "Offline — saved here",
          detail:
            "You are offline. Every change is stored in this browser and will sync to your workspace automatically when the connection returns.",
          tone: "warning",
          icon: "cloud-off",
          announce: true,
          retry: null,
          needsResolution: false,
        }
      : {
          kind: "offline_pending",
          label: "Offline — local save pending",
          short: "Offline — saving",
          detail:
            "You are offline and the newest changes are not stored in this browser yet. Keep this tab open until the local save completes.",
          tone: "danger",
          icon: "cloud-off",
          announce: true,
          retry: "local",
          needsResolution: false,
        };
  }

  /*
   * Defect I: a ceiling is not a fault. `payload_too_large` means the autosave
   * endpoint will refuse these exact bytes every single time — a document with a
   * few embedded photos clears 1 MiB easily — so presenting it as "Cloud save
   * failed" with a Retry button teaches the user that retrying does nothing, and
   * leaves them believing a backup is one click away when it is not.
   *
   * The honest report separates the two facts it is made of: the work IS safe
   * (locally), and the workspace copy is NOT being updated and will not be. That
   * second half is why this cannot silently fall through to a `saved_local` view —
   * a workspace user reading "Saved on this device" with no further qualification
   * reasonably assumes the cloud has it too.
   */
  if (state.remote === "failed" && state.remoteChannel.failureReason?.category === "payload_too_large") {
    const reason = state.remoteChannel.failureReason.message;
    return localDurable
      ? {
          kind: "remote_unavailable",
          label: "Saved on this device — no cloud backup",
          short: "No cloud backup",
          detail: `${reason} Every change is stored in this browser, so nothing is lost, but the workspace copy is not being updated. Export a copy, or remove some images, to keep it somewhere else.`,
          tone: "warning",
          icon: "cloud-off",
          announce: true,
          // Deliberately absent. The identical payload is refused identically, and
          // a button that cannot work is worse than no button.
          retry: null,
          needsResolution: false,
        }
      : {
          kind: "remote_unavailable",
          label: "Not saved — no cloud backup",
          short: "Not backed up",
          detail: `${reason} The workspace copy is not being updated and the newest changes are not stored in this browser yet. Export a copy before closing this tab.`,
          tone: "danger",
          icon: "cloud-off",
          announce: true,
          retry: null,
          needsResolution: true,
        };
  }

  if (state.remote === "failed") {
    /*
     * The required sentence, and the reason this whole module exists: a cloud
     * failure must not overwrite the fact that the work is durable locally.
     * Collapsing the two dimensions here is what makes users close tabs over
     * drafts that were never at risk.
     */
    return localDurable
      ? {
          kind: "remote_failed",
          label: "Cloud save failed — your changes are safe on this device",
          short: "Cloud save failed",
          detail: `Your workspace could not be updated (${state.remoteChannel.failureReason?.message ?? "unknown error"}). Every change is stored in this browser, so nothing is lost. Retry when you are ready.`,
          tone: "warning",
          icon: "cloud-alert",
          announce: true,
          retry: state.remoteChannel.failureReason?.retryable === false ? null : "remote",
          needsResolution: false,
        }
      : {
          kind: "remote_failed",
          label: "Cloud save failed",
          short: "Cloud save failed",
          detail: `Your workspace could not be updated (${state.remoteChannel.failureReason?.message ?? "unknown error"}), and the newest changes are not stored in this browser yet. Keep this tab open and retry.`,
          tone: "danger",
          icon: "cloud-alert",
          announce: true,
          retry: state.remoteChannel.failureReason?.retryable === false ? null : "remote",
          needsResolution: false,
        };
  }

  if (state.remote === "saving") {
    /*
     * "new changes pending" is not decoration. A save in flight for revision 10
     * while the user has reached 11 is NOT "Saving…" in the sense the user reads
     * it — that reading says "wait a moment and you're done", when in fact
     * another round trip is still required.
     */
    const active = state.remoteChannel.activeRevision ?? NEVER;
    const newerPending = state.currentRevision > active;
    return {
      kind: "saving_remote",
      label: newerPending ? "Saving… new changes pending" : "Saving…",
      short: "Saving…",
      detail: newerPending
        ? `Saving revision ${active} to your workspace; newer changes will be saved right after.`
        : "Saving your changes to your workspace.",
      tone: "progress",
      icon: "spinner",
      announce: false,
      retry: null,
      needsResolution: false,
    };
  }

  if (state.edit === "dirty") {
    if (localDurable) {
      // A workspace document whose local copy is current and whose cloud copy is
      // not. Safe against a crash, not yet safe against losing this device.
      return {
        kind: "saved_local",
        label: "Saved on this device",
        short: "Saved here",
        detail: state.remoteEnabled
          ? "Your changes are stored in this browser and are being synced to your workspace."
          : "Your changes are stored in this browser. Export the file or save it to a workspace to keep it elsewhere.",
        tone: state.remoteEnabled ? "progress" : "success",
        icon: "device-check",
        announce: !state.remoteEnabled,
        retry: null,
        needsResolution: false,
      };
    }
    return {
      kind: "unsaved",
      label: "Unsaved changes",
      short: "Unsaved",
      detail: "Your most recent edits are not stored anywhere yet.",
      tone: "neutral",
      icon: "warning",
      // Every keystroke passes through here. Announcing it would make the editor
      // unusable with a screen reader.
      announce: false,
      retry: null,
      needsResolution: false,
    };
  }

  if (state.recovery === "recovered") {
    /*
     * Persistent, not a toast. A recovered document looks exactly like a normal
     * one, so the only way the user learns that what they see came from a draft is
     * a notice that stays until they acknowledge it.
     */
    return {
      kind: "recovered",
      label: "Recovered draft — review changes",
      short: "Recovered",
      detail: state.remoteEnabled
        ? `Restored ${state.recoveredRevision === null ? "a draft" : `revision ${state.recoveredRevision}`} from this device. Review it, then save to your workspace.`
        : "Restored unsaved changes from this device. Review them, then export or save the file.",
      tone: "warning",
      icon: "history",
      announce: true,
      retry: null,
      needsResolution: false,
    };
  }

  return savedView(state, remoteAcked);
}

function savedView(state: PersistenceState, remoteAcked: boolean): SaveStatusView {
  /*
   * The published-version claim comes FIRST, and does not require `remoteEnabled`
   * or an autosave acknowledgement. The explicit "Save to Workspace" commit is the
   * strongest of the three durability tiers and it happens on the standalone canvas,
   * where the autosave channel is off and `remoteEnabled` is false — gating this
   * sentence behind either one made it unreachable in the shipped app. A commit this
   * document actually performed is its own evidence; `isCurrentRevisionCommitted`
   * still refuses to speak unless the version number is quotable and the revision on
   * screen is the one that was committed.
   */
  if (isCurrentRevisionCommitted(state)) {
    return {
      kind: "saved",
      label: "Saved",
      short: "Saved",
      detail: `Every change is saved to your workspace as version ${state.committedServerVersion}.`,
      tone: "success",
      icon: "cloud-check",
      announce: true,
      retry: null,
      needsResolution: false,
    };
  }
  if (state.remoteEnabled && remoteAcked) {
    /*
     * "Saved" is the right headline — the bytes are off this machine either way —
     * but the sentence under it must not promote a draft into a version. The
     * autosave route echoes the document version back unchanged, so claiming
     * "saved as version 9" over an autosave draft describes a revision the server
     * never created, and a user who reads it stops chasing the colleague who
     * cannot see their changes.
     */
    return {
      kind: "saved",
      label: "Saved",
      short: "Saved",
      detail:
        "Every change is backed up to your workspace as a draft. Save the document to publish it as a new version.",
      tone: "success",
      icon: "cloud-check",
      announce: true,
      retry: null,
      needsResolution: false,
    };
  }
  return {
    kind: "saved_local",
    label: "Saved on this device",
    short: "Saved here",
    detail: state.remoteEnabled
      ? "Your changes are stored in this browser."
      : "Your changes are stored in this browser. Export the file or save it to a workspace to keep a copy elsewhere.",
    tone: "success",
    icon: "device-check",
    announce: true,
    retry: null,
    needsResolution: false,
  };
}

/**
 * What a recovery notice says, and why it is NOT a {@link SaveStatusView}.
 *
 * Recovery answers a different question from saving. Saving is "where does this
 * work exist", changes constantly, and is correctly modelled as one mutually
 * exclusive state. Provenance is "where did the bytes on screen come from", is
 * true for the whole session, and must coexist with whatever saving is doing.
 *
 * Putting them in one enum is what hides the notice: a recovered workspace draft
 * is locally durable and not yet synced, so its save status is `saved_local` — and
 * a `recovered` case in the same enum loses to it, silently, at the exact moment
 * the user most needs to know that the document changed under them. Worse, the
 * two ranking rules genuinely conflict: a cloud failure SHOULD outrank a routine
 * save, and it must NOT outrank provenance.
 *
 * So this is a separate surface with its own lifetime, retired only by
 * `RECOVERY_ACKNOWLEDGED`.
 */
export type RecoveryNoticeKind =
  /** A draft was found and the user has not decided yet. */
  | "draft_available"
  /** A draft was restored and is complete. */
  | "recovered"
  /** A draft was restored but could not produce everything it referenced. */
  | "recovered_partial"
  | "recovery_failed";

export interface RecoveryNoticeView {
  kind: RecoveryNoticeKind;
  label: string;
  detail: string;
  tone: SaveStatusTone;
  icon: SaveStatusIcon;
  /**
   * Always true. Present as a field rather than implied so the UI cannot render
   * this as a toast without contradicting the model: a notice that auto-dismisses
   * is a notice the user can miss, and then they are editing a document whose
   * origin they never learned.
   */
  persistent: true;
  /** Whether an explicit acknowledgement retires it. */
  dismissible: boolean;
  /** True while the user still has to choose between a draft and the saved file. */
  needsDecision: boolean;
  /** Asset roles the draft referenced but could not produce. */
  missingAssets: readonly string[];
}

/**
 * The recovery notice, or null when there is nothing to disclose.
 *
 * Computed from `recovery` and `recoveryAcknowledged` ONLY. It deliberately reads
 * no save-status field: any dependency on those would reintroduce the displacement
 * this function exists to prevent.
 */
export function deriveRecoveryNotice(state: PersistenceState): RecoveryNoticeView | null {
  switch (state.recovery) {
    case "none":
    case "restoring":
      return null;

    case "draft_available": {
      if (state.draft === null) return null;
      const partial = state.draft.missingAssets.length > 0;
      const fellBack = state.draft.fellBackToPreviousSnapshot;
      return {
        kind: "draft_available",
        label: "Unsaved changes from this device were found",
        detail: `A draft on this device holds revision ${state.draft.revision}, saved ${new Date(state.draft.updatedAt).toISOString()}.${
          partial
            ? " Some of what it references is missing, so restoring it would be incomplete."
            : ""
        }${fellBack ? " The newest draft was unreadable, so this is the one before it." : ""} Restore it, or keep the version you opened.`,
        tone: "warning",
        icon: "history",
        persistent: true,
        // Dismissing an OFFER is declining it, which is a decision the user is
        // entitled to make — but it is not the same act as acknowledging a notice.
        dismissible: true,
        needsDecision: true,
        missingAssets: state.draft.missingAssets,
      };
    }

    case "recovered": {
      if (state.recoveryAcknowledged) return null;
      const missing = state.recoveredMissingAssets;
      const revision =
        state.recoveredRevision === null ? "a draft" : `revision ${state.recoveredRevision}`;
      if (missing.length > 0) {
        return {
          kind: "recovered_partial",
          label: "Recovered draft — some content is missing",
          detail: `Restored ${revision} from a draft on this device, but ${describeMissing(missing)} could not be recovered. Check the document before saving over anything.`,
          tone: "danger",
          icon: "warning",
          persistent: true,
          dismissible: true,
          needsDecision: false,
          missingAssets: missing,
        };
      }
      return {
        kind: "recovered",
        label: "Recovered draft — review changes",
        /*
         * "from this device" and nothing about the workspace. The temptation is to
         * reassure — "restored and saved" — and that sentence would tell the user
         * their workspace now holds these changes when the save has not been
         * attempted. What the notice may claim is exactly where the bytes came
         * from.
         */
        detail: `Restored ${revision} from a draft on this device. This is not what the saved copy contains — review the changes, then save.`,
        tone: "warning",
        icon: "history",
        persistent: true,
        dismissible: true,
        needsDecision: false,
        missingAssets: [],
      };
    }

    case "recovery_failed": {
      if (state.recoveryAcknowledged) return null;
      return {
        kind: "recovery_failed",
        label: "A draft was found but could not be restored",
        detail: `${state.recoveryFailure?.message ?? "The draft could not be read."} The version you opened is unchanged, and the draft has not been deleted.`,
        tone: "danger",
        icon: "alert",
        persistent: true,
        dismissible: true,
        needsDecision: false,
        missingAssets: [],
      };
    }
  }
}

/** "the original pages", "2 images" — plain words, not role identifiers. */
function describeMissing(roles: readonly string[]): string {
  const named = roles.map((role) => {
    if (role === "source-pdf") return "the original pages";
    if (role.startsWith("image")) return "an imported image";
    if (role.startsWith("signature")) return "a signature";
    if (role.startsWith("font")) return "an embedded font";
    return "part of the document";
  });
  const unique = [...new Set(named)];
  if (unique.length === 1) return unique[0]!;
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

/**
 * The per-dimension breakdown for the detail popover.
 *
 * Separate from the label because the label must collapse and this must not. The
 * popover is where a user checks the claim: "Cloud save failed" alongside
 * "This device: revision 41 stored 8 seconds ago" is the difference between panic
 * and an informed shrug.
 */
export function deriveStatusBreakdown(state: PersistenceState): SaveStatusBreakdown {
  const localLine = (() => {
    switch (state.local) {
      case "unavailable":
        return "This device: not available — this browser will not store a local copy.";
      case "writing":
        return `This device: storing revision ${state.localChannel.activeRevision ?? state.currentRevision}…`;
      case "failed":
        return `This device: failed — ${state.localChannel.failureReason?.message ?? "unknown error"}. Newest stored revision: ${describeRevision(state.lastLocallyDurableRevision)}.`;
      case "durable":
      case "idle":
        return isCurrentRevisionLocallyDurable(state)
          ? `This device: revision ${state.currentRevision} stored.`
          : `This device: revision ${describeRevision(state.lastLocallyDurableRevision)} stored; revision ${state.currentRevision} not yet.`;
    }
  })();

  const remoteLine = (() => {
    if (!state.remoteEnabled) {
      /*
       * An explicit "Save to Workspace" commit publishes a version even from a
       * canvas whose autosave channel is off. Reporting "not applicable" beside a
       * status that quotes version N would be exactly the disagreement between two
       * renderings of one state that this breakdown exists to expose.
       */
      if (isCurrentRevisionCommitted(state)) {
        return `Workspace: revision ${state.currentRevision} committed as document version ${state.committedServerVersion}; this document has no automatic backup.`;
      }
      // A commit happened, and the revision on screen is past it. "Not applicable"
      // here would hide the workspace copy the user just published, and quoting the
      // version without the gap would credit it with work it does not hold.
      if (state.committedServerVersion !== null) {
        return `Workspace: revision ${describeRevision(state.lastCommittedRevision)} committed as document version ${state.committedServerVersion}; revision ${state.currentRevision} not yet. This document has no automatic backup.`;
      }
      return "Workspace: not applicable — this document is only open in your browser.";
    }
    switch (state.remote) {
      case "not_applicable":
        return "Workspace: not applicable.";
      case "offline":
        return `Workspace: offline. Newest backed-up revision: ${describeRevision(state.lastRemoteAcknowledgedRevision)}.`;
      case "saving":
        return `Workspace: saving revision ${state.remoteChannel.activeRevision ?? state.currentRevision}…`;
      case "failed":
        // The capacity ceiling reads as a standing condition, not as an attempt
        // that went wrong, because that is what it is — and the breakdown is where
        // a user checks whether it is worth waiting for.
        return state.remoteChannel.failureReason?.category === "payload_too_large"
          ? `Workspace: no backup — ${state.remoteChannel.failureReason.message} Newest backed-up revision: ${describeRevision(state.lastRemoteAcknowledgedRevision)}.`
          : `Workspace: failed — ${state.remoteChannel.failureReason?.message ?? "unknown error"}. Newest backed-up revision: ${describeRevision(state.lastRemoteAcknowledgedRevision)}.`;
      case "conflict":
        // REVISION, not version. Both numbers are the document record's revision —
        // the counter the server's compare-and-swap uses — and it advances on renames
        // and moves as well as on versions, so it is routinely ahead of the version
        // number a user has seen. Calling it a version invites them to look for a
        // version 12 that does not exist.
        return `Workspace: conflict. The workspace copy is at revision ${state.conflict?.actualServerVersion ?? "unknown"}; your edits are based on revision ${state.conflict?.expectedServerVersion ?? "unknown"}.`;
      case "idle":
      case "synced":
        /*
         * Three different sentences for three different facts, in decreasing
         * strength. The old single sentence said "saved as version N" using
         * `serverVersion` — which is the version the draft was written AGAINST, not
         * one it created — so it credited the autosave with a publish that never
         * happened.
         */
        if (isCurrentRevisionCommitted(state)) {
          return `Workspace: revision ${state.currentRevision} committed as document version ${state.committedServerVersion}.`;
        }
        return isCurrentRevisionRemotelyAcknowledged(state)
          ? // No number for the second half: `serverVersion` is the record revision,
            // not a version number, and the fact worth stating is that this draft
            // published nothing — which is true whether or not a revision is known.
            `Workspace: revision ${state.currentRevision} backed up as a draft; no new document version was published.`
          : `Workspace: revision ${describeRevision(state.lastRemoteAcknowledgedRevision)} backed up as a draft; revision ${state.currentRevision} not yet.`;
    }
  })();

  const recoveryLine = (() => {
    switch (state.recovery) {
      case "none":
        return null;
      case "draft_available":
        return state.draft
          ? `A draft from this device holds revision ${state.draft.revision}.`
          : "A draft from this device is available.";
      case "restoring":
        return "Restoring a draft from this device…";
      case "recovered":
        // Reported whether or not the banner was acknowledged: acknowledging the
        // notice means "I have read it", never "it did not happen".
        return (
          `Restored from a draft on this device${state.recoveredRevision === null ? "" : ` at revision ${state.recoveredRevision}`}.` +
          (state.recoveredMissingAssets.length > 0
            ? ` ${describeMissing(state.recoveredMissingAssets)} could not be recovered.`
            : "") +
          (state.recoveryAcknowledged ? "" : " Not yet reviewed.")
        );
      case "recovery_failed":
        return `Recovery failed — ${state.recoveryFailure?.message ?? "unknown error"}.`;
    }
  })();

  return {
    local: localLine,
    remote: remoteLine,
    recovery: recoveryLine,
    lastLocalSaveAt: state.lastLocalSaveAt,
    lastRemoteSaveAt: state.lastRemoteSaveAt,
  };
}

function describeRevision(revision: number): string {
  return revision < 0 ? "none" : String(revision);
}

/**
 * "8 seconds ago". Coarse on purpose — a second-by-second countdown in a live
 * region would announce continuously, and the user only needs to know whether the
 * save was moments ago or minutes ago.
 */
export function formatSavedAgo(at: number | null, now: number): string | null {
  if (at === null) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * The longest label any state can produce.
 *
 * The status sits beside the document title, and a label that changes width moves
 * the title every time a save completes. Reserving the widest label's width once
 * costs a little space and removes the jump entirely.
 */
export const SAVE_STATUS_LABELS: readonly string[] = [
  "No document",
  "No changes yet",
  "Unsaved changes",
  "Saving locally…",
  "Saved on this device",
  "Saving…",
  "Saving… new changes pending",
  "Saved",
  "Offline — changes saved on this device",
  "Offline — local save pending",
  "Cloud save failed — your changes are safe on this device",
  "Cloud save failed",
  "Saved on this device — no cloud backup",
  "Not saved — no cloud backup",
  "Local save failed — resolve before closing",
  "Local save failed",
  "Not saved on this device",
  "This browser can't save locally",
  "Conflict detected",
  "Recovered draft — review changes",
  "Recovery failed",
];

/** Re-exported so navigation UI and the status pill agree on one predicate. */
export { hasUnprotectedWork };
