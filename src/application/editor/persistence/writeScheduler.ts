/**
 * When to write, as opposed to what a write means.
 *
 * Kept strictly separate from `persistenceMachine.ts`, and tested separately,
 * because the two get different things wrong. The machine's failure mode is
 * *claiming* the wrong thing; the scheduler's is *doing* the wrong thing —
 * overlapping writes, a coalesced burst that drops the last revision, a timer
 * that fires for a document the user closed two minutes ago.
 *
 * WHAT THE SCHEDULER GUARANTEES
 *
 *  1. At most one write per channel is ever in flight. Two concurrent writers to
 *     the same draft can interleave a snapshot from revision 9 with the asset
 *     table from revision 12 and produce a draft that describes neither.
 *  2. The newest revision is always eventually written. Debounce alone does not
 *     give this: coalescing a burst and then starting a write means every mutation
 *     during that write must be re-queued, or the final keystroke of a paragraph
 *     is silently the one that never lands.
 *  3. No mutation waits longer than `maxDelayMs`. Continuous typing resets a plain
 *     debounce forever; a user typing for four minutes would have nothing durable.
 *  4. Work belonging to a closed or replaced session is dropped rather than run.
 *     A write for the previous document cannot be aborted once `perform` has been
 *     called — that is the reducer's scope check's job — but it must never be
 *     *started*, and no follow-up may be chained behind it.
 *  5. The revision reported for a write is the revision the written BYTES hold.
 *     See {@link WriteSchedulerPorts.prepare}.
 *  6. `flush()` resolves with a verdict, and only one value of it means the work
 *     is safe. See {@link FlushResult}.
 */
import type { PersistenceFailure } from "./events";

export type TimerHandle = unknown;

/** One attempt at writing one revision. */
export interface WriteAttempt {
  requestId: string;
  documentId: string;
  documentSessionId: string;
  revision: number;
  /** 0 for the first try, incremented for each retry of the same revision. */
  attempt: number;
}

/**
 * A snapshot pinned for one attempt, and the revision it actually contains.
 *
 * `revision` is authoritative and may differ from the revision that was queued.
 * Capture happens at a moment in time, and by then the scene may have moved on —
 * so the capture reports what it got rather than being told what to claim.
 */
export interface PreparedWrite<TPayload> {
  revision: number;
  payload: TPayload;
}

export interface WriteSchedulerPorts<TResult, TPayload> {
  now(): number;
  setTimer(callback: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  newRequestId(): string;
  /**
   * Captures the bytes for this attempt. MUST be synchronous, and MUST report the
   * revision the captured bytes hold.
   *
   * THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE. Suppose revision 10 is queued and
   * a write begins; the writer awaits something — the source PDF bytes, a font,
   * an image blob — and while it is awaiting, the user's next edit makes the scene
   * revision 11. Serialising after that await produces revision-11 content, which
   * is then stored and reported under the label the attempt started with: 10. The
   * durable watermark now says 10 while the stored draft holds 11, and every later
   * comparison is wrong in the direction that loses data — the status bar reports
   * work as unsaved that is saved, or saved that is not, depending on which way
   * the next edit falls.
   *
   * Being synchronous is the fix, not a convention: JavaScript is single-threaded,
   * so a capture with no await inside it cannot be interleaved with a mutation.
   * Returning the revision is the other half — a capture that legitimately sees a
   * newer scene supersedes the queued revision and is written under its own
   * number, rather than being back-dated.
   *
   * Returning `null` means there is nothing to write (no document mounted, no
   * scene). The queued entry is then dropped rather than retried, because a
   * capture that has nothing to give will have nothing to give a second later
   * either; the next real mutation re-schedules.
   */
  prepare(attempt: WriteAttempt): PreparedWrite<TPayload> | null;
  /**
   * Performs the write of an already-captured payload. Rejecting means failure;
   * the scheduler never retries on its own beyond `retryDelaysMs`, because an
   * unbounded retry loop against a failing store is how a browser tab becomes
   * unresponsive.
   */
  perform(attempt: WriteAttempt, payload: TPayload): Promise<TResult>;
  onScheduled(attempt: WriteAttempt): void;
  onStarted(attempt: WriteAttempt): void;
  onSucceeded(attempt: WriteAttempt, result: TResult): void;
  onFailed(attempt: WriteAttempt, failure: PersistenceFailure): void;
  /** Turns whatever `perform` rejected with into a classified failure. */
  classify(error: unknown): PersistenceFailure;
}

export interface WriteSchedulerConfig {
  /** Quiet period after the last mutation before a write starts. */
  debounceMs: number;
  /**
   * The longest a mutation may sit unwritten while newer ones keep arriving.
   * This is the number that bounds worst-case data loss.
   */
  maxDelayMs: number;
  /**
   * Backoff for automatic retries, in order. An empty array means the scheduler
   * never retries by itself and waits for an explicit `retry()`.
   */
  retryDelaysMs: readonly number[];
}

export interface ScheduleTarget {
  documentId: string;
  documentSessionId: string;
  revision: number;
}

/**
 * What a flush actually achieved.
 *
 *  - `durable`    every queued revision was written and verified. THE ONLY value
 *                 that permits navigation away from unsaved work.
 *  - `failed`     an attempt ran and failed. The revision is still queued (an
 *                 automatic retry may even be armed) — which is precisely why
 *                 this is not `pending`: the queue has stopped moving, and a
 *                 caller waiting for it to stop would read that as success.
 *  - `unavailable` the store cannot be written at all. Distinguished from
 *                 `failed` because no retry will change it, so the user must be
 *                 told to export instead of to try again.
 *  - `pending`    nothing was attempted, and work remains. A suspended channel
 *                 that was asked not to resume, for instance.
 *  - `cancelled`  the document closed or was replaced while the flush was
 *                 waiting. Says nothing about durability either way.
 */
export type FlushOutcome = "durable" | "failed" | "unavailable" | "pending" | "cancelled";

export interface FlushResult {
  outcome: FlushOutcome;
  /** The newest revision this channel has verifiably written, if any. */
  durableRevision: number | null;
  /** A revision still waiting to be written, if any. */
  queuedRevision: number | null;
  failure: PersistenceFailure | null;
}

export interface FlushOptions {
  /**
   * Whether a suspended channel should be woken to make the attempt. Default
   * `true`: a flush is an explicit, user-visible attempt.
   *
   * Set `false` when there is a known reason the attempt cannot succeed — an
   * offline route transition flushing the local store should not also fire a
   * remote request that will certainly fail, since the failure would be reported
   * to the user as though the workspace had rejected their work.
   */
  resumeIfPaused?: boolean;
}

const DEFAULT_CONFIG: WriteSchedulerConfig = {
  debounceMs: 700,
  maxDelayMs: 4000,
  retryDelaysMs: [1000, 4000, 12000],
};

function result(
  outcome: FlushOutcome,
  durableRevision: number | null,
  queuedRevision: number | null,
  failure: PersistenceFailure | null = null,
): FlushResult {
  return { outcome, durableRevision, queuedRevision, failure };
}

export class WriteScheduler<TResult, TPayload = void> {
  private readonly ports: WriteSchedulerPorts<TResult, TPayload>;
  private readonly config: WriteSchedulerConfig;

  /** The newest revision asked for but not yet handed to `perform`. */
  private pending: ScheduleTarget | null = null;
  private pendingRequestId: string | null = null;
  /** When the oldest currently-pending mutation arrived, for `maxDelayMs`. */
  private pendingSince: number | null = null;
  private timer: TimerHandle | null = null;
  /** True while `timer` is a backoff timer rather than a debounce timer. */
  private retryTimer = false;

  private inFlight: WriteAttempt | null = null;
  /** Retries already spent on the revision currently failing. */
  private retriesSpent = 0;
  /** The newest revision this channel has verifiably written. */
  private lastDurableRevision: number | null = null;
  /** Resolvers for `flush()` callers waiting for a verdict. */
  private flushWaiters: Array<(value: FlushResult) => void> = [];
  private disposed = false;
  /** The session the scheduler is currently serving. */
  private sessionId: string | null = null;
  private paused = false;

  constructor(ports: WriteSchedulerPorts<TResult, TPayload>, config?: Partial<WriteSchedulerConfig>) {
    this.ports = ports;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** True while a write is executing. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** The newest revision waiting to be written, or null when the queue is empty. */
  get pendingRevision(): number | null {
    return this.pending?.revision ?? null;
  }

  /** Alias of {@link pendingRevision}, read by the coordinator's status mapping. */
  get queuedRevision(): number | null {
    return this.pending?.revision ?? null;
  }

  get inFlightRevision(): number | null {
    return this.inFlight?.revision ?? null;
  }

  /**
   * Whether any work is outstanding — queued, in flight, or waiting on a backoff.
   *
   * Deliberately NOT "is a timer running". An armed retry and an empty queue look
   * identical from the outside (nothing is happening right now) and mean opposite
   * things; conflating them reports a document with a failed, re-queued write as
   * fully written.
   */
  get hasQueuedWork(): boolean {
    return this.pending !== null || this.inFlight !== null;
  }

  /** Whether an automatic retry is waiting to fire. */
  get retryArmed(): boolean {
    return this.timer !== null && this.retryTimer;
  }

  get durableRevision(): number | null {
    return this.lastDurableRevision;
  }

  /**
   * Suspend attempts without discarding the queue.
   *
   * Used when the network goes away: the queued revision must be RETAINED (it is
   * the user's work) while the pointless retries stop. Requirement, and also
   * simple decency toward the battery.
   */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.retriesSpent = 0;
    if (this.pending) this.arm(0, false);
  }

  /**
   * A revision needs writing.
   *
   * Coalescing is by revision, not by call: five mutations in one debounce window
   * produce one write of the newest revision, and the four older ones are not
   * "dropped" in any meaningful sense — the newest snapshot contains them.
   */
  schedule(target: ScheduleTarget): void {
    if (this.disposed) return;
    if (this.sessionId !== null && this.sessionId !== target.documentSessionId) {
      // A different session is now the subject. Anything queued for the previous
      // one describes a document that is no longer open — and anyone waiting on a
      // flush of that document is waiting for something that will never happen.
      this.discardQueue();
      this.settleFlush(result("cancelled", null, null));
      this.lastDurableRevision = null;
    }
    this.sessionId = target.documentSessionId;

    if (this.pending && this.pending.revision >= target.revision) {
      // Already queued at this revision or newer. Nothing to do — and notably no
      // timer reset, so a repeat notification cannot postpone the write forever.
      return;
    }

    const first = this.pending === null;
    this.pending = target;
    if (first) {
      this.pendingSince = this.ports.now();
      this.pendingRequestId = this.ports.newRequestId();
    }
    // A fresh request id per coalesced batch, not per mutation: the id identifies
    // the ATTEMPT, and the attempt is still the same one being deferred.
    const requestId = this.pendingRequestId ?? this.ports.newRequestId();
    this.pendingRequestId = requestId;
    this.ports.onScheduled({
      requestId,
      documentId: target.documentId,
      documentSessionId: target.documentSessionId,
      revision: target.revision,
      attempt: 0,
    });

    if (this.paused || this.inFlight) {
      // Queued behind an in-flight write. The follow-up starts from `finish()`,
      // with no debounce, because the debounce has already been served.
      return;
    }
    this.arm(this.nextDelay(), false);
  }

  /**
   * Write everything outstanding now, and report what was achieved.
   *
   * The path taken when the tab is being hidden or the user is navigating: there
   * is no time left to debounce, and an in-flight write must be allowed to finish
   * before the caller lets go.
   *
   * WHY THIS RETURNS A VERDICT. The caller is a navigation guard, and its question
   * is "is the user's work safe now" — but the only signal a void promise can give
   * is "the queue stopped moving", and a failed write that has been re-queued for
   * a retry stops the queue moving too. Resolving there would let the tab close
   * over work that exists nowhere, at the exact moment the failure made it most
   * important not to. So a flush that did not achieve durability says so.
   */
  async flush(options: FlushOptions = {}): Promise<FlushResult> {
    if (this.disposed) return result("cancelled", this.lastDurableRevision, this.queuedRevision);
    this.clearTimer();
    if (this.paused) {
      if (options.resumeIfPaused === false) {
        return result("pending", this.lastDurableRevision, this.queuedRevision);
      }
      this.paused = false;
      this.retriesSpent = 0;
    }
    if (!this.pending && !this.inFlight) {
      return result("durable", this.lastDurableRevision, null);
    }
    const wait = new Promise<FlushResult>((resolve) => this.flushWaiters.push(resolve));
    // Synchronously, so that a flush during `pagehide` gets its write started
    // before the browser stops giving this document any more turns.
    if (!this.inFlight) this.start();
    return wait;
  }

  /** Try the newest pending revision again immediately, resetting backoff. */
  retry(): void {
    if (this.disposed || !this.pending) return;
    this.paused = false;
    this.retriesSpent = 0;
    this.clearTimer();
    if (!this.inFlight) this.arm(0, false);
  }

  /**
   * The document was closed or replaced. Drop queued work and stop timers.
   *
   * An in-flight `perform` is deliberately NOT awaited or cancelled: most stores
   * offer no cancellation, and a half-cancelled transactional write is worse than
   * a completed one that nobody listens to. The reducer's session check is what
   * makes its eventual result inert.
   */
  cancel(): void {
    this.discardQueue();
    this.sessionId = null;
    this.lastDurableRevision = null;
    this.settleFlush(result("cancelled", null, null));
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private discardQueue(): void {
    this.clearTimer();
    this.pending = null;
    this.pendingRequestId = null;
    this.pendingSince = null;
    this.retriesSpent = 0;
  }

  /** Debounce, clipped so nothing waits past `maxDelayMs`. */
  private nextDelay(): number {
    const since = this.pendingSince;
    if (since === null) return this.config.debounceMs;
    const deadline = since + this.config.maxDelayMs;
    const remaining = deadline - this.ports.now();
    return Math.max(0, Math.min(this.config.debounceMs, remaining));
  }

  private arm(delayMs: number, isRetry: boolean): void {
    this.clearTimer();
    this.retryTimer = isRetry;
    this.timer = this.ports.setTimer(() => {
      this.timer = null;
      this.retryTimer = false;
      this.start();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.ports.clearTimer(this.timer);
      this.timer = null;
    }
    this.retryTimer = false;
  }

  private start(): void {
    if (this.disposed || this.inFlight || this.paused) return;
    const target = this.pending;
    if (!target) {
      this.settleFlush(result("durable", this.lastDurableRevision, null));
      return;
    }
    if (target.documentSessionId !== this.sessionId) {
      // Belt-and-braces: a timer that survived a session change must not write.
      this.discardQueue();
      this.settleFlush(result("cancelled", null, null));
      return;
    }
    const requestId = this.pendingRequestId ?? this.ports.newRequestId();

    /*
     * Capture, then label. Everything from here to `perform` is synchronous, so
     * the revision in `prepared` is still the revision on screen when `perform`
     * receives the bytes — see `prepare`'s contract for why that matters.
     */
    const prepared = this.ports.prepare({
      requestId,
      documentId: target.documentId,
      documentSessionId: target.documentSessionId,
      revision: target.revision,
      attempt: this.retriesSpent,
    });
    if (!prepared) {
      this.discardQueue();
      this.settleFlush(result("cancelled", this.lastDurableRevision, null));
      return;
    }

    const attempt: WriteAttempt = {
      requestId,
      documentId: target.documentId,
      documentSessionId: target.documentSessionId,
      // The captured revision wins over the queued one. A capture that saw a
      // newer scene supersedes; one that pinned an immutable older snapshot is
      // written under the older number and leaves the newer work queued below.
      revision: prepared.revision,
      attempt: this.retriesSpent,
    };

    this.pending = null;
    this.pendingRequestId = null;
    this.pendingSince = null;
    if (prepared.revision < target.revision) {
      // The capture is older than what the user has on screen, so the remainder
      // is still outstanding and must not be credited to this write.
      this.pending = { ...target };
      this.pendingRequestId = this.ports.newRequestId();
      this.pendingSince = this.ports.now();
    }

    this.inFlight = attempt;
    this.ports.onStarted(attempt);

    this.ports.perform(attempt, prepared.payload).then(
      (value) => this.finish(attempt, () => this.ports.onSucceeded(attempt, value), true),
      (error) => {
        const failure = this.ports.classify(error);
        this.finish(attempt, () => this.ports.onFailed(attempt, failure), false, failure);
      },
    );
  }

  private finish(
    attempt: WriteAttempt,
    report: () => void,
    succeeded: boolean,
    failure?: PersistenceFailure,
  ): void {
    if (this.inFlight?.requestId !== attempt.requestId) {
      // Should not happen with one in-flight write, but reporting anyway keeps a
      // late result visible to the reducer, which will decide it is stale.
      report();
      return;
    }
    this.inFlight = null;
    report();

    const live = !this.disposed && attempt.documentSessionId === this.sessionId;

    if (succeeded) {
      this.retriesSpent = 0;
      if (live) {
        this.lastDurableRevision = Math.max(this.lastDurableRevision ?? attempt.revision, attempt.revision);
      }
      if (live && this.pending) {
        /*
         * Newer work arrived during the write, or the capture superseded only part
         * of the queue. Start it immediately rather than through a fresh timer:
         * the debounce has already been served, and a flush waiting on this
         * channel may not get another macrotask before the tab goes away.
         */
        this.start();
        return;
      }
      this.settleFlush(result("durable", this.lastDurableRevision, this.queuedRevision));
      return;
    }

    const outcome: FlushOutcome = failure?.category === "storage_unavailable" ? "unavailable" : "failed";

    if (!live) {
      // The session ended under the write. The revision belongs to a document
      // nobody is editing, so it is not re-queued and no retry is armed.
      this.settleFlush(result("cancelled", this.lastDurableRevision, null, failure ?? null));
      return;
    }

    // Failed. Re-queue the revision so it is not lost, then back off.
    const requeued = this.requeue(attempt);
    if (requeued && failure?.retryable && this.retriesSpent < this.config.retryDelaysMs.length) {
      const delay = this.config.retryDelaysMs[this.retriesSpent] ?? 0;
      this.retriesSpent += 1;
      this.arm(delay, true);
    }
    /*
     * Either way the revision stays queued so an explicit Retry, a reconnect, or a
     * later flush can pick it up — dropping it here would quietly discard the
     * user's work at the exact moment the UI is telling them a retry is available.
     *
     * And either way the flush verdict is a failure, INCLUDING when a retry is
     * armed: the retry has not happened yet, so nothing about the work is safer
     * than it was a moment ago.
     */
    this.settleFlush(result(outcome, this.lastDurableRevision, this.queuedRevision, failure ?? null));
  }

  /**
   * Put a failed attempt's revision back at the head of the queue.
   *
   * Returns whether it was queued: a revision belonging to a session that has
   * since ended is dropped, and the caller must not arm a retry for it.
   */
  private requeue(attempt: WriteAttempt): boolean {
    if (attempt.documentSessionId !== this.sessionId) return false;
    if (this.pending && this.pending.revision >= attempt.revision) return true;
    this.pending = {
      documentId: attempt.documentId,
      documentSessionId: attempt.documentSessionId,
      revision: attempt.revision,
    };
    this.pendingRequestId = this.ports.newRequestId();
    this.pendingSince = this.ports.now();
    return true;
  }

  private settleFlush(value: FlushResult): void {
    if (this.flushWaiters.length === 0) return;
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const resolve of waiters) resolve(value);
  }
}
