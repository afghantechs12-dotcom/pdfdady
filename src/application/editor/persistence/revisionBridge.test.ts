import { describe, expect, it } from "vitest";
import { RevisionBridge } from "./revisionBridge";

/**
 * The number persistence counts by, which is NOT the number the editor counts by.
 *
 * `CommandHistory.revision` is a mutation counter for a freshly mounted history
 * stack. It starts near zero every time the page loads, it advances for things
 * that are not user edits (`clear()` during a document load), and it advances on
 * every buffered command inside a transaction — so a single drag gesture pushes it
 * forward once per animation frame.
 *
 * Handing that number to persistence produces three distinct failures:
 *
 *  1. After recovering a draft that holds revision 80, a fresh history reports 1.
 *     A watermark comparison then reads 1 < 80 and concludes the draft is newer
 *     than the document — so the user's next edits are never written, forever,
 *     because they never appear to advance past what is already stored.
 *  2. Loading the document advances it, so the editor asks for a durable write of
 *     a document nobody has edited, and the status bar reports unsaved work on a
 *     file the user just opened.
 *  3. A drag across sixty frames schedules sixty writes of intermediate states
 *     nobody asked to keep, which is both a performance problem and a correctness
 *     one — a draft captured mid-gesture holds a shape halfway to nowhere.
 *
 * So this bridge owns a separate revision, advanced only by committed mutations.
 */

const KEY = "guest:abc";
const SESSION = "session-a";

function bridge(historyRevision = 0, restoredRevision: number | null = null) {
  const b = new RevisionBridge();
  b.beginSession({
    documentKey: KEY,
    documentSessionId: SESSION,
    historyRevision,
    restoredRevision,
  });
  return b;
}

describe("a session is a document opening, not a document", () => {
  it("starts at zero for a document with no draft", () => {
    const b = bridge(7);
    expect(b.revision).toBe(0);
    expect(b.sessionId).toBe(SESSION);
    expect(b.documentKey).toBe(KEY);
  });

  it("ignores observations before a session exists", () => {
    const b = new RevisionBridge();
    expect(b.observe(3, SESSION)).toBeNull();
    expect(b.revision).toBe(0);
  });

  it("ignores observations from a session that has been replaced", () => {
    const b = bridge(0);
    b.observe(1, SESSION);
    b.beginSession({
      documentKey: "guest:def",
      documentSessionId: "session-b",
      historyRevision: 0,
      restoredRevision: null,
    });
    /*
     * The stale notification. A `CommandHistory` subscription from the previous
     * document can fire once more after the swap; counting it would attribute the
     * old document's mutation to the new document's draft.
     */
    expect(b.observe(2, SESSION)).toBeNull();
    expect(b.revision).toBe(0);
    expect(b.sessionId).toBe("session-b");
  });

  it("resets the revision when a different document is opened", () => {
    const b = bridge(0);
    b.observe(1, SESSION);
    b.observe(2, SESSION);
    expect(b.revision).toBe(2);
    b.beginSession({
      documentKey: "guest:def",
      documentSessionId: "session-b",
      historyRevision: 40,
      restoredRevision: null,
    });
    expect(b.revision).toBe(0);
    // …and the new document's own history baseline is respected, not the old one's.
    expect(b.observe(41, "session-b")).toBe(1);
  });

  it("reopening the same document is still a new session", () => {
    const b = bridge(0);
    b.observe(1, SESSION);
    b.beginSession({
      documentKey: KEY,
      documentSessionId: "session-b",
      historyRevision: 0,
      restoredRevision: null,
    });
    expect(b.observe(1, SESSION)).toBeNull();
    expect(b.revision).toBe(0);
  });
});

describe("defect E — a recovered draft's revision is adopted, not restarted", () => {
  it("makes the first edit after recovering revision 80 into revision 81", () => {
    const b = bridge(1, 80);
    expect(b.revision).toBe(80);
    expect(b.observe(2, SESSION)).toBe(81);
  });

  it("does not treat the draft revision as a history baseline", () => {
    /*
     * THE FAILURE THIS PINS DOWN. Seeding the history baseline with 80 makes every
     * real history revision (2, 3, 4…) look older than what has already been
     * written, so `observe` never advances and no edit is ever persisted again.
     * The document appears saved and quietly stops saving.
     */
    const b = bridge(1, 80);
    expect(b.observe(2, SESSION)).toBe(81);
    expect(b.observe(3, SESSION)).toBe(82);
    expect(b.observe(4, SESSION)).toBe(83);
  });

  it("adopts a draft recovered after the document was already open", () => {
    // The offer-then-restore flow: the document mounts, a draft is found, the user
    // accepts it. Restoring is a load, so it is suppressed, and then adopted.
    const b = bridge(1);
    expect(b.observe(2, SESSION)).toBe(1);
    b.beginLoad();
    b.observe(3, SESSION);
    b.observe(4, SESSION);
    b.endLoad(4);
    expect(b.adoptRecoveredRevision(80, 4)).toBe(80);
    expect(b.revision).toBe(80);
    expect(b.observe(5, SESSION)).toBe(81);
  });

  it("never moves the revision backwards when adopting an older draft", () => {
    /*
     * A draft older than the work already done in this session. Restoring it is
     * the user's business, but the persistence revision may not go back: a
     * watermark that decreases would mark already-written revisions as unwritten.
     */
    const b = bridge(0);
    b.observe(1, SESSION);
    b.observe(2, SESSION);
    b.observe(3, SESSION);
    expect(b.revision).toBe(3);
    expect(b.adoptRecoveredRevision(2, 3)).toBe(4);
    expect(b.revision).toBe(4);
  });

  it("counts undo as a mutation that needs persisting", () => {
    // Undo changes the document, so the draft on disk is now wrong. One write.
    const b = bridge(0);
    b.observe(1, SESSION);
    expect(b.observe(2, SESSION)).toBe(2); // CommandHistory advances on undo
  });

  it("counts redo as a mutation that needs persisting", () => {
    const b = bridge(0);
    b.observe(1, SESSION);
    b.observe(2, SESSION);
    expect(b.observe(3, SESSION)).toBe(3);
  });
});

describe("defect F — loading a document is not editing it", () => {
  it("absorbs the history churn of a load", () => {
    /*
     * `EditorDocumentService.loadState` calls `CommandHistory.clear()`, which
     * ADVANCES the counter deliberately (so a stale in-flight save cannot be
     * credited to the new document). Reading that as a user edit is how opening a
     * file produces an immediate "Unsaved changes".
     */
    const b = bridge(0);
    b.beginLoad();
    expect(b.observe(1, SESSION)).toBeNull();
    expect(b.observe(2, SESSION)).toBeNull();
    b.endLoad(2);
    expect(b.revision).toBe(0);
  });

  it("does not retroactively count absorbed churn on the next real edit", () => {
    const b = bridge(0);
    b.beginLoad();
    b.observe(1, SESSION);
    b.observe(2, SESSION);
    b.endLoad(2);
    // The next edit is revision 1, not revision 3.
    expect(b.observe(3, SESSION)).toBe(1);
  });

  it("absorbs a load whose final notification arrives after the scope closed", () => {
    const b = bridge(0);
    b.beginLoad();
    b.observe(1, SESSION);
    // The caller reports the history revision it ended at, so a late duplicate
    // notification for the same revision cannot become an edit.
    b.endLoad(2);
    expect(b.observe(2, SESSION)).toBeNull();
    expect(b.revision).toBe(0);
  });

  it("nests loads without releasing suppression early", () => {
    const b = bridge(0);
    b.beginLoad();
    b.beginLoad();
    b.endLoad(1);
    expect(b.isLoading).toBe(true);
    expect(b.observe(2, SESSION)).toBeNull();
    b.endLoad(2);
    expect(b.isLoading).toBe(false);
  });
});

describe("defect F — a gesture is one mutation, however many frames it took", () => {
  it("writes nothing during a drag and exactly once at the end", () => {
    const b = bridge(0);
    b.beginGesture("Move");
    // Sixty frames of preview, each of which advanced CommandHistory because the
    // transaction buffers applied commands.
    for (let h = 1; h <= 60; h += 1) {
      expect(b.observe(h, SESSION)).toBeNull();
    }
    expect(b.revision).toBe(0);
    expect(b.endGesture("commit")).toBe(1);
    expect(b.revision).toBe(1);
  });

  it("writes nothing for a cancelled gesture", () => {
    /*
     * A rolled-back transaction leaves the document exactly as it was, but the
     * counter moved. Absorbing without advancing is what makes Escape during a
     * drag, and Cancel in the crop tool, produce no durable write.
     */
    const b = bridge(0);
    b.beginGesture("Move");
    for (let h = 1; h <= 10; h += 1) b.observe(h, SESSION);
    expect(b.endGesture("cancel")).toBeNull();
    expect(b.revision).toBe(0);
    // And the absorbed frames do not resurface on the next real edit.
    expect(b.observe(11, SESSION)).toBe(1);
  });

  it("writes nothing for a gesture that changed nothing", () => {
    // A click that begins a drag and releases without moving.
    const b = bridge(0);
    b.beginGesture("Move");
    expect(b.endGesture("commit")).toBeNull();
    expect(b.revision).toBe(0);
  });

  it("treats nested gesture scopes as one mutation", () => {
    const b = bridge(0);
    b.beginGesture("Resize");
    b.beginGesture("Resize handle");
    b.observe(1, SESSION);
    expect(b.endGesture("commit")).toBeNull();
    expect(b.gestureDepth).toBe(1);
    b.observe(2, SESSION);
    expect(b.endGesture("commit")).toBe(1);
  });

  it("cancels the whole gesture if any scope cancels", () => {
    /*
     * An inner rollback aborts the outer transaction too — `CommandHistory` has
     * one pending transaction, not a stack — so a cancel anywhere means nothing
     * was committed.
     */
    const b = bridge(0);
    b.beginGesture("Resize");
    b.beginGesture("Resize handle");
    b.observe(1, SESSION);
    b.endGesture("cancel");
    b.observe(2, SESSION);
    expect(b.endGesture("commit")).toBeNull();
    expect(b.revision).toBe(0);
  });

  it("counts a sequence of separate gestures separately", () => {
    const b = bridge(0);
    let h = 0;
    for (let i = 0; i < 3; i += 1) {
      b.beginGesture("Move");
      b.observe((h += 1), SESSION);
      b.observe((h += 1), SESSION);
      b.endGesture("commit");
    }
    expect(b.revision).toBe(3);
  });

  it("keeps a load inside a gesture suppressed", () => {
    // Page reorder loads state while a transaction is open. One write, at the end.
    const b = bridge(0);
    b.beginGesture("Reorder pages");
    b.beginLoad();
    b.observe(1, SESSION);
    b.endLoad(1);
    b.observe(2, SESSION);
    expect(b.endGesture("commit")).toBe(1);
  });

  it("does not advance for a gesture whose only churn was an absorbed load", () => {
    const b = bridge(0);
    b.beginGesture("Reorder pages");
    b.beginLoad();
    b.observe(1, SESSION);
    b.observe(2, SESSION);
    b.endLoad(2);
    expect(b.endGesture("commit")).toBeNull();
    expect(b.revision).toBe(0);
  });
});

describe("monotonicity", () => {
  it("advances by exactly one per committed mutation", () => {
    const b = bridge(0);
    for (let h = 1; h <= 5; h += 1) expect(b.observe(h, SESSION)).toBe(h);
  });

  it("ignores a repeated notification for a revision already counted", () => {
    const b = bridge(0);
    expect(b.observe(1, SESSION)).toBe(1);
    expect(b.observe(1, SESSION)).toBeNull();
    expect(b.revision).toBe(1);
  });

  it("ignores a history revision that went backwards", () => {
    /*
     * Should not happen — `CommandHistory` only ever increments — but if it did,
     * the persistence revision must not follow, because a decreasing watermark
     * marks written revisions as unwritten.
     */
    const b = bridge(10);
    expect(b.observe(11, SESSION)).toBe(1);
    expect(b.observe(5, SESSION)).toBeNull();
    expect(b.revision).toBe(1);
  });

  it("counts a multi-step history jump as one mutation", () => {
    // The history panel jumping back four entries advances the counter once.
    const b = bridge(0);
    expect(b.observe(4, SESSION)).toBe(1);
  });
});
