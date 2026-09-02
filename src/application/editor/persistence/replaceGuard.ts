import type { NavigationDecision } from "./navigationGuard";

/**
 * Whether the document on screen may be REPLACED yet.
 *
 * Every load path in the editor ends the same way: flush the outgoing document,
 * then hand the incoming one to `actions.loadState`, which destroys whatever was
 * there. The flush is the only thing standing between a switch and the user's
 * unsaved work, and the surfaces used to await it and THROW THE VERDICT AWAY:
 *
 *     if (identity !== null) await persistence.saveNow();   // verdict discarded
 *     actions.loadState(loaded.state);                      // work destroyed
 *
 * `saveNow` resolves for four reasons that are not "the work is safe", and the
 * widest of them is not a race at all:
 *
 *  - `failed` — the write threw and the revision was RE-QUEUED for a retry. The
 *    status bar offers that retry honestly, and then the replace runs
 *    `closeDocument`, which discards the queue. The retry the user was promised has
 *    nothing left to retry, and nothing ever said so.
 *  - `unavailable` — the store cannot be written at all, so the work exists only in
 *    this tab's memory and the replace is what ends it.
 *  - `pending` — a suspended channel that was not woken.
 *  - `durable`, but the user edited again between the scheduler's last capture and
 *    the moment React reported that mutation. `noteMutation` runs in an effect, so
 *    a mutation landing in the final milliseconds of a write can settle the flush
 *    before the scheduler was ever told about it.
 *
 * So the question is asked of the NAVIGATION GUARD instead of the flush, because
 * replacing the document is leaving it: both destroy the tab's copy, and the guard
 * already owns the rule for whether that loses work (durability, never dirtiness).
 * A `block` verdict means the newest revision exists only in memory. Anything else —
 * `allow`, or `warn` for "on this device but not yet in the workspace" — means the
 * bytes survive the replace, which is all a replace needs.
 *
 * Retrying is worth it because the common `block` is transient: a write that is
 * still in flight, or a mutation the scheduler has not been handed yet. Retrying
 * FOREVER is not — a user who keeps typing would hold the load open indefinitely,
 * and a store that is genuinely unavailable never becomes durable no matter how
 * many times it is asked.
 */

/** What to do after one flush attempt. */
export type ReplaceFlushStep =
  /** Nothing is at risk. Replace the content. */
  | "replace"
  /** Work is still unprotected and another flush could fix it. */
  | "retry"
  /** Out of attempts. The replace must proceed, and the user must be told. */
  | "warn_and_replace";

/**
 * How many flushes one replace is allowed.
 *
 * Three, not one: the first can lose a race with React's mutation effect, and the
 * second can lose it to a keystroke that arrived during the first. A third
 * consecutive loss is no longer a race — it is a user still typing, or a store that
 * cannot be written — and neither is fixed by asking again.
 */
export const REPLACE_FLUSH_ATTEMPTS = 3;

export interface ReplaceFlushStepInput {
  /**
   * The navigation guard's verdict, read AFTER the flush resolved and from the
   * binding rather than from a render — a React snapshot taken before the await is
   * exactly the stale answer this check exists to avoid.
   */
  decision: NavigationDecision;
  /** Attempts already spent, including the one whose verdict this is. 1-based. */
  attemptsSpent: number;
  maxAttempts?: number;
}

export function nextReplaceFlushStep(input: ReplaceFlushStepInput): ReplaceFlushStep {
  // `warn` is safe to replace over: the draft is on this device, so the bytes
  // survive. Only `block` means the tab's memory is the only copy.
  if (input.decision !== "block") return "replace";
  const max = input.maxAttempts ?? REPLACE_FLUSH_ATTEMPTS;
  return input.attemptsSpent < max ? "retry" : "warn_and_replace";
}

/**
 * Whether an editor with NO identity is holding work a replace would destroy.
 *
 * The first load into a surface has nothing to flush — there is no document open,
 * so there is no draft key, no session, and no `saveNow` to make. That is correct
 * right up until the user puts something on the blank page while their document is
 * still being fetched: a paste reaches the editor through a window listener that no
 * loading overlay covers, and the objects it creates are destroyed by `loadState`
 * without ever having been savable anywhere.
 *
 * It cannot be saved — an unidentified document has nowhere to be saved TO — so the
 * only honest handling is to stop it being silent.
 */
export function hasUnidentifiedWork(input: {
  identityPresent: boolean;
  objectCount: number;
}): boolean {
  return !input.identityPresent && input.objectCount > 0;
}

/**
 * What to tell the user when a replace went ahead over work that is not saved.
 *
 * The guard's own `reason` is reused rather than paraphrased: it is already a
 * user-facing sentence, it is already specific about which copy exists and which
 * does not, and a second wording of the same fact is a second thing to keep true.
 */
export function describeUnsavedReplace(input: {
  documentName: string | null;
  reason: string | null;
}): string {
  const named = input.documentName?.trim();
  const subject = named ? `“${named}”` : "the previous document";
  const because = input.reason?.trim();
  return because
    ? `Unsaved changes to ${subject} could not be saved before it closed. ${because}`
    : `Unsaved changes to ${subject} could not be saved before it closed.`;
}
