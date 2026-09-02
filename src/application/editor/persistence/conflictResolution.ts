import type { PersistenceState } from "./persistenceMachine";
import type { ConflictInfo } from "./events";

/**
 * What the user may do when the workspace copy and the local copy disagree.
 *
 * THE RULE: never choose for them, and never destroy either version. Not even the
 * "obviously right" choice — because the obvious heuristics are all wrong:
 *
 *  - Newest timestamp wins: clocks disagree between devices and jump on one, and
 *    the loser is a real person's real work.
 *  - Local wins: silently reverts whatever a colleague did in the meantime.
 *  - Server wins: silently discards everything the user just did.
 *
 * So a conflict is a STATE, not an event to be handled. Both versions stay where
 * they are, the local draft is left completely untouched, and the six actions
 * below are offered until one is chosen. The only destructive action —
 * `replace_workspace` — requires an explicit second confirmation, because it is
 * the one that ends someone else's version.
 */
export type ConflictActionId =
  /** Open the local version read-only, to see what would be sent. */
  | "review_local"
  /** Open the workspace version in a new tab, to see what would be replaced. */
  | "review_workspace"
  /** Download the local version as a file. Always available, never destructive. */
  | "save_local_copy"
  /** Overwrite the workspace with the local version. Needs confirmation. */
  | "replace_workspace"
  /** Keep both: the local version becomes a new workspace document. */
  | "duplicate_as_new"
  /** Decide later. The conflict state persists. */
  | "cancel";

export interface ConflictAction {
  id: ConflictActionId;
  label: string;
  description: string;
  /** True when choosing this discards a version someone might want. */
  destructive: boolean;
  /** True when a second, explicit confirmation is required. */
  requiresConfirmation: boolean;
}

const ACTIONS: Record<ConflictActionId, ConflictAction> = {
  review_local: {
    id: "review_local",
    label: "Review my changes",
    description: "See the version in this browser, exactly as it would be saved.",
    destructive: false,
    requiresConfirmation: false,
  },
  review_workspace: {
    id: "review_workspace",
    label: "Review the workspace version",
    description: "Open the version currently stored in your workspace in a new tab.",
    destructive: false,
    requiresConfirmation: false,
  },
  save_local_copy: {
    id: "save_local_copy",
    label: "Download my version",
    description: "Save the version in this browser to a file, so it cannot be lost.",
    destructive: false,
    requiresConfirmation: false,
  },
  duplicate_as_new: {
    id: "duplicate_as_new",
    label: "Keep both",
    description: "Save my version as a new document and leave the workspace copy alone.",
    destructive: false,
    requiresConfirmation: false,
  },
  replace_workspace: {
    id: "replace_workspace",
    label: "Replace the workspace version",
    description:
      "Overwrite the workspace copy with my version. Changes made elsewhere since then will be lost.",
    destructive: true,
    requiresConfirmation: true,
  },
  cancel: {
    id: "cancel",
    label: "Decide later",
    description: "Keep both versions where they are. Your changes stay on this device.",
    destructive: false,
    requiresConfirmation: false,
  },
};

export interface ConflictPresentation {
  headline: string;
  /** What is true right now, in one paragraph. Never alarmist, never reassuring. */
  explanation: string;
  /** The safety statement: exactly where the user's work currently lives. */
  safety: string;
  local: { revision: number; savedOnThisDevice: boolean; at: number | null };
  remote: { serverVersion: number | null; expectedServerVersion: number | null };
  detail: string | null;
  /**
   * Offered non-destructively first.
   *
   * `replace_workspace` sits after every non-destructive option and before
   * `cancel`, so the ordering itself discourages it without hiding it.
   */
  actions: ConflictAction[];
}

export function presentConflict(
  state: PersistenceState,
  conflict: ConflictInfo = state.conflict as ConflictInfo,
): ConflictPresentation | null {
  if (!conflict) return null;
  const locallyDurable = state.lastLocallyDurableRevision >= conflict.localRevision;
  return {
    headline: "This document changed somewhere else",
    explanation:
      "Your workspace holds a version that does not include your recent changes — someone else saved it, or you edited it in another tab or on another device. Nothing has been overwritten.",
    safety: locallyDurable
      ? "Your changes are stored in this browser and will stay there until you choose what to do."
      : "Your changes are only in this tab. Download a copy before closing it.",
    local: {
      revision: conflict.localRevision,
      savedOnThisDevice: locallyDurable,
      at: state.lastLocalSaveAt,
    },
    remote: {
      serverVersion: conflict.actualServerVersion,
      expectedServerVersion: conflict.expectedServerVersion,
    },
    detail: conflict.detail,
    actions: [
      ACTIONS.review_local,
      ACTIONS.review_workspace,
      ACTIONS.save_local_copy,
      ACTIONS.duplicate_as_new,
      ACTIONS.replace_workspace,
      ACTIONS.cancel,
    ],
  };
}

export { ACTIONS as CONFLICT_ACTIONS };
