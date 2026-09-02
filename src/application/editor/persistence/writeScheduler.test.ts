import { describe, expect, it } from "vitest";
import {
  WriteScheduler,
  type FlushResult,
  type PreparedWrite,
  type WriteAttempt,
  type WriteSchedulerConfig,
  type WriteSchedulerPorts,
} from "./writeScheduler";
import { persistenceFailure, type PersistenceFailure } from "./events";

/**
 * The scheduler's job is WHEN to write; these tests are mostly about what
 * `flush()` is allowed to tell its caller afterwards.
 *
 * `flush()` is the last thing that runs before the tab goes away. Its resolution
 * is what a navigation guard reads to decide whether leaving is safe — so a
 * `Promise<void>` that resolves whenever the queue stops moving is not merely
 * imprecise, it is the bug: a write that failed and was re-queued for a retry that
 * will never run also stops the queue moving, and resolving there reports the
 * document as safe at the moment it is least safe.
 *
 * So flush resolves with a verdict, and only one value of it means "durable".
 */

/** A hand-driven clock and timer queue: no real time passes in these tests. */
class Harness {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextTimer = 1;
  private nextRequest = 1;

  /** Revisions handed to `perform`, in order, with the payload they carried. */
  readonly performed: Array<{ revision: number; payload: string }> = [];
  readonly scheduled: WriteAttempt[] = [];
  readonly started: WriteAttempt[] = [];
  readonly succeeded: WriteAttempt[] = [];
  readonly failed: Array<{ attempt: WriteAttempt; failure: PersistenceFailure }> = [];

  /** The revision `prepare` will claim it captured. Defaults to the attempt's. */
  prepareRevision: ((attempt: WriteAttempt) => number | null) | null = null;

  private resolvers: Array<{
    revision: number;
    resolve: (value: string) => void;
    reject: (error: unknown) => void;
  }> = [];

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextTimer++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advances the clock and fires every timer that comes due. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = target;
  }

  get armedTimers(): number {
    return this.timers.size;
  }

  ports(): WriteSchedulerPorts<string, string> {
    return {
      now: () => this.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      newRequestId: () => `req-${this.nextRequest++}`,
      prepare: (attempt): PreparedWrite<string> | null => {
        const revision = this.prepareRevision ? this.prepareRevision(attempt) : attempt.revision;
        if (revision === null) return null;
        // The payload is stamped with the revision it holds, which is what lets a
        // test prove the bytes and the label agree.
        return { revision, payload: `snapshot@${revision}` };
      },
      perform: (attempt, payload) => {
        this.performed.push({ revision: attempt.revision, payload });
        return new Promise<string>((resolve, reject) => {
          this.resolvers.push({ revision: attempt.revision, resolve, reject });
        });
      },
      onScheduled: (a) => void this.scheduled.push(a),
      onStarted: (a) => void this.started.push(a),
      onSucceeded: (a) => void this.succeeded.push(a),
      onFailed: (attempt, failure) => void this.failed.push({ attempt, failure }),
      classify: (error) =>
        error instanceof Error && error.message.startsWith("cat:")
          ? persistenceFailure(
              error.message.slice(4) as "network",
              error.message,
            )
          : persistenceFailure("unknown", "failed"),
    };
  }

  /** Settles the oldest outstanding `perform`. */
  async settle(mode: "ok" | { failCategory: string }): Promise<void> {
    const next = this.resolvers.shift();
    if (!next) throw new Error("no write in flight");
    if (mode === "ok") next.resolve(`ok@${next.revision}`);
    else next.reject(new Error(`cat:${mode.failCategory}`));
    // Two microtask turns: one for `perform`'s continuation, one for whatever it
    // chains (a re-queue, a follow-up start, a drain release).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  get inFlightCount(): number {
    return this.resolvers.length;
  }
}

function make(harness: Harness, config?: Partial<WriteSchedulerConfig>) {
  return new WriteScheduler<string, string>(harness.ports(), config);
}

const TARGET = { documentId: "doc-1", documentSessionId: "session-a" };

describe("coalescing and delay bounds", () => {
  it("writes one snapshot for a burst, at the newest revision", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 1 });
    s.schedule({ ...TARGET, revision: 2 });
    s.schedule({ ...TARGET, revision: 3 });
    expect(h.performed).toHaveLength(0);
    h.advance(700);
    expect(h.performed).toEqual([{ revision: 3, payload: "snapshot@3" }]);
    await h.settle("ok");
    expect(h.succeeded.map((a) => a.revision)).toEqual([3]);
  });

  it("does not let continuous mutation postpone the write past maxDelayMs", () => {
    const h = new Harness();
    const s = make(h, { debounceMs: 700, maxDelayMs: 2000, retryDelaysMs: [] });
    let revision = 1;
    s.schedule({ ...TARGET, revision: revision++ });
    // Keep typing: a new mutation every 500ms, which a plain debounce would defer
    // forever.
    for (let i = 0; i < 10; i += 1) {
      h.advance(500);
      s.schedule({ ...TARGET, revision: revision++ });
    }
    expect(h.performed.length).toBeGreaterThan(0);
    expect(h.performed[0]!.revision).toBeLessThanOrEqual(5);
  });

  it("never runs two writes at once", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 1 });
    h.advance(700);
    s.schedule({ ...TARGET, revision: 2 });
    h.advance(5000);
    expect(h.inFlightCount).toBe(1);
    await h.settle("ok");
    expect(h.inFlightCount).toBe(1);
    expect(h.performed.map((p) => p.revision)).toEqual([1, 2]);
  });
});

describe("defect G — the revision written and the bytes written agree", () => {
  it("labels the attempt with the revision the payload actually holds", async () => {
    const h = new Harness();
    const s = make(h);
    /*
     * The scenario: revision 10 is scheduled, and revision 11 arrives before
     * serialization begins. Two answers are acceptable — write an immutable rev-10
     * snapshot, or supersede and write rev 11 AS rev 11. The one that loses
     * documents is rev-11 bytes reported as rev 10, because the watermark then
     * says 10 is durable while the stored draft holds 11, and a later recovery
     * disagrees with the status bar about what exists.
     */
    s.schedule({ ...TARGET, revision: 10 });
    h.prepareRevision = () => 11; // capture sees the newer scene
    h.advance(700);

    expect(h.performed).toEqual([{ revision: 11, payload: "snapshot@11" }]);
    expect(h.started.at(-1)!.revision).toBe(11);
    await h.settle("ok");
    expect(h.succeeded.at(-1)!.revision).toBe(11);
  });

  it("reports the older revision when capture pinned older bytes", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 11 });
    h.prepareRevision = () => 10; // an immutable rev-10 snapshot was pinned
    h.advance(700);
    expect(h.performed).toEqual([{ revision: 10, payload: "snapshot@10" }]);
    await h.settle("ok");
    expect(h.succeeded.at(-1)!.revision).toBe(10);
    // …and 11 is therefore still outstanding, not silently credited.
    expect(s.hasQueuedWork).toBe(true);
  });

  it("announces the started attempt only after the payload is pinned", () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 4 });
    h.prepareRevision = () => 6;
    h.advance(700);
    // `onStarted` is what moves the reducer to `writing` with an active revision.
    // Announcing 4 and then writing 6 would leave the reducer unable to match the
    // completion to the attempt.
    expect(h.started.map((a) => a.revision)).toEqual([6]);
  });

  it("treats a capture that declines as nothing to write", () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 4 });
    h.prepareRevision = () => null;
    h.advance(700);
    expect(h.performed).toHaveLength(0);
    expect(h.started).toHaveLength(0);
    expect(s.busy).toBe(false);
  });
});

describe("defect C — what flush is allowed to claim", () => {
  it("resolves durable only when the queue is empty and the write succeeded", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    let result: FlushResult | null = null;
    const flushed = s.flush().then((r) => (result = r));
    expect(result).toBeNull();
    await h.settle("ok");
    await flushed;
    expect(result).toMatchObject({ outcome: "durable", durableRevision: 5, queuedRevision: null });
  });

  it("does not resolve successful while a revision is still queued", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    const flushed = s.flush();
    // A newer edit lands while revision 5 is being written.
    s.schedule({ ...TARGET, revision: 6 });
    await h.settle("ok");
    // Revision 5 is durable but 6 is not, so the flush must keep going rather than
    // report success over unwritten work.
    expect(h.performed.map((p) => p.revision)).toEqual([5, 6]);
    await h.settle("ok");
    const result = await flushed;
    expect(result.outcome).toBe("durable");
    expect(result.durableRevision).toBe(6);
  });

  it("resolves failed — not successful — when the attempt failed", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    const flushed = s.flush();
    await h.settle({ failCategory: "network" });
    const result = await flushed;
    /*
     * The requirement in one assertion: a retryable failure re-queues the revision
     * and arms a retry, which means the queue has stopped moving — and a
     * `Promise<void>` would resolve here, telling navigation it may proceed over
     * work that exists nowhere.
     */
    expect(result.outcome).toBe("failed");
    expect(result.failure?.category).toBe("network");
    expect(result.queuedRevision).toBe(5);
    expect(result.durableRevision).toBeNull();
  });

  it("resolves failed for a non-retryable failure and keeps it visible", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    const flushed = s.flush();
    await h.settle({ failCategory: "quota_exceeded" });
    const result = await flushed;
    expect(result.outcome).toBe("failed");
    expect(result.failure?.retryable).toBe(false);
    // Still queued: an explicit retry, or a later flush, must be able to find it.
    expect(s.hasQueuedWork).toBe(true);
    expect(h.armedTimers).toBe(0);
  });

  it("distinguishes an unavailable store from a failed write", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    const flushed = s.flush();
    await h.settle({ failCategory: "storage_unavailable" });
    const result = await flushed;
    expect(result.outcome).toBe("unavailable");
    expect(result.failure?.retryable).toBe(false);
  });

  it("resolves cancelled when the document closes mid-flush", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    const flushed = s.flush();
    s.cancel();
    const result = await flushed;
    expect(result.outcome).toBe("cancelled");
    expect(result.durableRevision).toBeNull();
  });

  it("resolves cancelled when another session replaces this one mid-flush", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    const flushed = s.flush();
    s.schedule({ documentId: "doc-2", documentSessionId: "session-b", revision: 1 });
    const result = await flushed;
    expect(result.outcome).toBe("cancelled");
  });

  it("resolves durable with nothing to do when there was no work", async () => {
    const h = new Harness();
    const s = make(h);
    const result = await s.flush();
    expect(result.outcome).toBe("durable");
    expect(result.durableRevision).toBeNull();
    expect(result.queuedRevision).toBeNull();
  });

  it("reports pending rather than attempting when suspended and told not to resume", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    s.pause();
    const result = await s.flush({ resumeIfPaused: false });
    /*
     * The offline route transition: the local channel is flushed for real, and the
     * remote channel is asked not to make a request that cannot succeed. It must
     * still not claim durability.
     */
    expect(result.outcome).toBe("pending");
    expect(result.queuedRevision).toBe(5);
    expect(h.performed).toHaveLength(0);
  });

  it("does attempt a suspended channel when the flush is explicit", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    s.pause();
    const flushed = s.flush();
    expect(h.performed.map((p) => p.revision)).toEqual([5]);
    await h.settle("ok");
    expect((await flushed).outcome).toBe("durable");
  });

  it("waits for a write that was already in flight before the flush began", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    h.advance(700);
    expect(s.busy).toBe(true);
    const flushed = s.flush();
    await h.settle("ok");
    expect((await flushed).outcome).toBe("durable");
  });
});

describe("an armed retry is not an empty queue", () => {
  it("keeps queued work visible while backing off", async () => {
    const h = new Harness();
    const s = make(h, { debounceMs: 700, maxDelayMs: 4000, retryDelaysMs: [1000] });
    s.schedule({ ...TARGET, revision: 5 });
    h.advance(700);
    await h.settle({ failCategory: "network" });
    expect(s.hasQueuedWork).toBe(true);
    expect(s.retryArmed).toBe(true);
    expect(s.queuedRevision).toBe(5);
    h.advance(1000);
    expect(h.performed.map((p) => p.revision)).toEqual([5, 5]);
  });

  it("stops retrying once the backoff list is exhausted, keeping the work queued", async () => {
    const h = new Harness();
    const s = make(h, { debounceMs: 0, maxDelayMs: 0, retryDelaysMs: [10] });
    s.schedule({ ...TARGET, revision: 5 });
    h.advance(0);
    await h.settle({ failCategory: "network" });
    h.advance(10);
    await h.settle({ failCategory: "network" });
    expect(s.retryArmed).toBe(false);
    expect(s.hasQueuedWork).toBe(true);
    // An explicit retry still works, which is what the UI's Retry button offers.
    s.retry();
    h.advance(0);
    expect(h.performed).toHaveLength(3);
  });

  it("resumes a paused channel by writing the retained revision", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    s.pause();
    h.advance(5000);
    expect(h.performed).toHaveLength(0);
    expect(s.hasQueuedWork).toBe(true);
    s.resume();
    h.advance(0);
    expect(h.performed.map((p) => p.revision)).toEqual([5]);
  });
});

describe("session boundaries", () => {
  it("drops queued work belonging to a replaced session", () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    s.schedule({ documentId: "doc-2", documentSessionId: "session-b", revision: 1 });
    h.advance(700);
    expect(h.performed.map((p) => p.revision)).toEqual([1]);
  });

  it("does not chain a follow-up write for a closed session", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    h.advance(700);
    s.schedule({ ...TARGET, revision: 6 });
    s.cancel();
    await h.settle("ok");
    expect(h.performed.map((p) => p.revision)).toEqual([5]);
  });

  it("does not re-queue a failed attempt from a session that has ended", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    h.advance(700);
    s.cancel();
    await h.settle({ failCategory: "network" });
    expect(s.hasQueuedWork).toBe(false);
    expect(h.armedTimers).toBe(0);
  });

  it("reports a completion after dispose without starting anything else", async () => {
    const h = new Harness();
    const s = make(h);
    s.schedule({ ...TARGET, revision: 5 });
    h.advance(700);
    s.dispose();
    await h.settle("ok");
    expect(h.succeeded).toHaveLength(1);
    expect(h.performed).toHaveLength(1);
    s.schedule({ ...TARGET, revision: 6 });
    h.advance(5000);
    expect(h.performed).toHaveLength(1);
  });
});
