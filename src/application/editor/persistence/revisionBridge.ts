/**
 * The revision persistence counts by.
 *
 * WHY THIS IS NOT `CommandHistory.revision`. That counter is a per-mount mutation
 * count, and persistence needs something else: a number whose comparison against a
 * stored watermark means "this document has changed since it was written". The two
 * differ in three ways, each of which loses documents on its own.
 *
 *  - IT RESTARTS. A fresh page load builds a fresh `CommandHistory` starting near
 *    zero. If a recovered draft holds revision 80, comparing it against a history
 *    revision of 1 says the stored draft is 79 revisions AHEAD of the document on
 *    screen — so nothing the user does afterwards ever looks new enough to write.
 *    The status settles on "Saved" and the editor silently stops saving.
 *  - IT ADVANCES FOR NON-EDITS. `clear()` bumps it, deliberately, and `clear()` is
 *    called by `loadState` — so opening a document registers as editing it, and the
 *    user is told their untouched file has unsaved changes.
 *  - IT ADVANCES PER FRAME. Inside a transaction every buffered command bumps it,
 *    so one drag is sixty revisions. Persisting those means writing sixty drafts of
 *    positions nobody chose, and a draft captured mid-gesture holds a half-finished
 *    shape.
 *
 * So the bridge keeps its own counter and advances it only for COMMITTED mutations,
 * driven by three explicit scopes: a session (one document opening), a load
 * (churn that is not the user's doing), and a gesture (many frames, one mutation).
 *
 * Note what the bridge deliberately does NOT do: it never inspects the document.
 * It is a pure counter over notifications, which is what makes every rule here
 * testable without an editor.
 */

export interface RevisionBridgeSession {
  /** Identifies the document across reloads. Held for the coordinator's benefit. */
  documentKey: string;
  /** Identifies THIS opening of it, so a stale notification can be refused. */
  documentSessionId: string;
  /** `CommandHistory.revision` at the moment the document finished mounting. */
  historyRevision: number;
  /**
   * The revision a recovered draft holds, when the session opened onto one.
   *
   * Becomes the starting persistence revision so the first subsequent edit is 81
   * rather than 1. Note that it does NOT become the history baseline — see the
   * class comment for why that inversion is fatal.
   */
  restoredRevision?: number | null;
}

export class RevisionBridge {
  private session: RevisionBridgeSession | null = null;
  /** The persistence revision. Monotonic within a session. */
  private current = 0;
  /** The history revision already accounted for. */
  private applied = 0;
  /** The newest history revision observed, accounted for or not. */
  private observed = 0;
  private loadDepth = 0;
  private gestureNesting = 0;
  /** True when any scope of the current gesture cancelled. */
  private gestureCancelled = false;

  get revision(): number {
    return this.current;
  }

  get sessionId(): string | null {
    return this.session?.documentSessionId ?? null;
  }

  get documentKey(): string | null {
    return this.session?.documentKey ?? null;
  }

  get isLoading(): boolean {
    return this.loadDepth > 0;
  }

  get gestureDepth(): number {
    return this.gestureNesting;
  }

  /**
   * A document was opened. Establishes the baseline and discards everything about
   * the previous opening.
   *
   * Called for a REOPENING of the same document too: the session id is what
   * changes, and it is what makes a notification from the previous mount refusable.
   */
  beginSession(session: RevisionBridgeSession): number {
    this.session = session;
    this.current = Math.max(0, session.restoredRevision ?? 0);
    this.applied = session.historyRevision;
    this.observed = session.historyRevision;
    this.loadDepth = 0;
    this.gestureNesting = 0;
    this.gestureCancelled = false;
    return this.current;
  }

  endSession(): void {
    this.session = null;
    this.loadDepth = 0;
    this.gestureNesting = 0;
    this.gestureCancelled = false;
  }

  /**
   * `CommandHistory.revision` changed. Returns the new persistence revision when
   * this is a committed mutation, or `null` when it is not one worth writing.
   *
   * `sessionId` is required rather than inferred so that a subscription surviving a
   * document swap by one notification cannot attribute the old document's mutation
   * to the new document's draft.
   */
  observe(historyRevision: number, sessionId: string): number | null {
    if (!this.session || this.session.documentSessionId !== sessionId) return null;
    // Strictly greater: a repeat notification for a revision already counted is
    // not a new mutation, and a counter that appears to go backwards must never
    // drag the persistence revision back with it.
    if (historyRevision <= this.applied) return null;
    this.observed = Math.max(this.observed, historyRevision);

    if (this.loadDepth > 0) {
      // Not the user's doing. Accounted for without advancing, so it cannot
      // resurface as an edit later.
      this.applied = this.observed;
      return null;
    }
    if (this.gestureNesting > 0) {
      // Deferred to the end of the gesture, where it becomes one mutation.
      return null;
    }
    return this.commit();
  }

  /**
   * Enter a scope whose history churn is not a user edit: opening a document,
   * restoring a draft, reordering pages by reloading state.
   */
  beginLoad(): void {
    this.loadDepth += 1;
  }

  /**
   * Leave a load scope, accounting for everything it did.
   *
   * `historyRevision` is the counter's value at the end of the load, passed
   * explicitly because a load's final notification can arrive after the awaited
   * call that caused it has returned. Absorbing up to a known point is what stops
   * that straggler becoming the document's first phantom edit.
   */
  endLoad(historyRevision: number): void {
    this.observed = Math.max(this.observed, historyRevision);
    this.applied = Math.max(this.applied, this.observed);
    if (this.loadDepth > 0) this.loadDepth -= 1;
  }

  /**
   * Enter a gesture: a continuous interaction that will produce at most one
   * committed mutation however many intermediate states it passes through.
   */
  beginGesture(_label: string): void {
    if (this.gestureNesting === 0) this.gestureCancelled = false;
    this.gestureNesting += 1;
  }

  /**
   * Leave a gesture. Returns the new persistence revision if the gesture produced
   * a committed mutation, `null` otherwise.
   *
   * `"cancel"` absorbs the churn without advancing, which is correct precisely
   * because a cancelled gesture reverts the document: the counter moved, the
   * content did not. A cancel at ANY nesting level cancels the whole gesture,
   * because `CommandHistory` holds one pending transaction rather than a stack —
   * an inner rollback has already discarded the outer scope's buffered commands.
   */
  endGesture(outcome: "commit" | "cancel"): number | null {
    if (this.gestureNesting === 0) return null;
    if (outcome === "cancel") this.gestureCancelled = true;
    this.gestureNesting -= 1;
    if (this.gestureNesting > 0) return null;

    const cancelled = this.gestureCancelled;
    this.gestureCancelled = false;
    if (cancelled) {
      this.applied = Math.max(this.applied, this.observed);
      return null;
    }
    // Nothing actually changed — a click that opened a drag and released without
    // moving. Not a mutation, so not a write.
    if (this.observed <= this.applied) return null;
    return this.commit();
  }

  /**
   * A recovered draft is now the document on screen.
   *
   * The revision is adopted so subsequent edits continue from it. It is clamped to
   * never move backwards: restoring a draft older than work already done in this
   * session is the user's business, but a persistence revision that decreased
   * would re-mark already-written revisions as unwritten. In that case the adoption
   * counts as the mutation it is, and the revision advances instead.
   */
  adoptRecoveredRevision(revision: number, historyRevision: number): number {
    this.observed = Math.max(this.observed, historyRevision);
    this.applied = Math.max(this.applied, this.observed);
    this.current = revision > this.current ? revision : this.current + 1;
    return this.current;
  }

  private commit(): number {
    this.applied = this.observed;
    this.current += 1;
    return this.current;
  }
}
