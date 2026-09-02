import { describe, expect, it } from "vitest";
import {
  REPLACE_FLUSH_ATTEMPTS,
  describeUnsavedReplace,
  hasUnidentifiedWork,
  nextReplaceFlushStep,
} from "./replaceGuard";

/**
 * The policy behind "may this document be replaced yet".
 *
 * The defect this guards is not in these functions — it was in the CALL SITE, which
 * awaited a flush and ignored what it said. So the assertions that matter here are
 * the ones that pin the verdict mapping: every non-`block` decision must permit the
 * replace (or a document switch would hang on work that is already safe), and
 * `block` must never permit it while an attempt remains (or the retry that would
 * have saved the work is skipped).
 */

describe("nextReplaceFlushStep", () => {
  it("replaces when nothing is at risk", () => {
    expect(nextReplaceFlushStep({ decision: "allow", attemptsSpent: 1 })).toBe("replace");
  });

  it("replaces on `warn`, because the bytes are on this device", () => {
    /*
     * `warn` is "durable locally, not yet in the workspace". The draft survives the
     * replace, so holding the load open would be waiting for something the replace
     * does not endanger — and on a slow or offline connection it would never come.
     */
    expect(nextReplaceFlushStep({ decision: "warn", attemptsSpent: 1 })).toBe("replace");
  });

  it("retries a block while attempts remain", () => {
    expect(nextReplaceFlushStep({ decision: "block", attemptsSpent: 1 })).toBe("retry");
    expect(nextReplaceFlushStep({ decision: "block", attemptsSpent: 2 })).toBe("retry");
  });

  it("warns and replaces once the attempts are spent", () => {
    expect(
      nextReplaceFlushStep({ decision: "block", attemptsSpent: REPLACE_FLUSH_ATTEMPTS }),
    ).toBe("warn_and_replace");
  });

  it("never retries past the budget, however many were spent", () => {
    // A spent counter that overshot must not wrap back into retrying: the loop is
    // the one thing between a document switch and an unbounded hang.
    expect(
      nextReplaceFlushStep({ decision: "block", attemptsSpent: REPLACE_FLUSH_ATTEMPTS + 7 }),
    ).toBe("warn_and_replace");
  });

  it("honours an explicit budget", () => {
    expect(nextReplaceFlushStep({ decision: "block", attemptsSpent: 1, maxAttempts: 1 })).toBe(
      "warn_and_replace",
    );
    expect(nextReplaceFlushStep({ decision: "block", attemptsSpent: 1, maxAttempts: 2 })).toBe(
      "retry",
    );
  });

  it("budgets more than one attempt by default", () => {
    // One attempt is the pre-fix behaviour: a single flush whose verdict decides
    // nothing. The retry is the entire point.
    expect(REPLACE_FLUSH_ATTEMPTS).toBeGreaterThan(1);
  });

  it("does not retry a safe verdict even with attempts left", () => {
    expect(nextReplaceFlushStep({ decision: "allow", attemptsSpent: 1, maxAttempts: 9 })).toBe(
      "replace",
    );
  });
});

describe("hasUnidentifiedWork", () => {
  it("is work when a blank unidentified editor holds objects", () => {
    expect(hasUnidentifiedWork({ identityPresent: false, objectCount: 1 })).toBe(true);
  });

  it("is not work when the unidentified editor is empty", () => {
    // The ordinary first load: a blank page and nothing on it. Warning here would
    // fire on every document open in the product.
    expect(hasUnidentifiedWork({ identityPresent: false, objectCount: 0 })).toBe(false);
  });

  it("is not this rule's business once a document is identified", () => {
    // An identified document is the flush loop's problem, not this one's, and
    // reporting it here would double every warning.
    expect(hasUnidentifiedWork({ identityPresent: true, objectCount: 12 })).toBe(false);
  });
});

describe("describeUnsavedReplace", () => {
  it("names the document and passes the guard's reason through verbatim", () => {
    const reason = "Your most recent changes are not stored anywhere yet.";
    const message = describeUnsavedReplace({ documentName: "Contract", reason });
    expect(message).toContain("Contract");
    // Verbatim: a paraphrase is a second wording of the same fact to keep true.
    expect(message).toContain(reason);
  });

  it("stands alone when the guard offered no reason", () => {
    const message = describeUnsavedReplace({ documentName: "Contract", reason: null });
    expect(message).toContain("Contract");
    expect(message.trim().endsWith(".")).toBe(true);
    expect(message).not.toContain("undefined");
    expect(message).not.toContain("null");
  });

  it("falls back to a subject rather than quoting an empty name", () => {
    for (const documentName of [null, "", "   "]) {
      const message = describeUnsavedReplace({ documentName, reason: null });
      expect(message).toContain("the previous document");
      expect(message).not.toContain("“”");
    }
  });

  it("says the changes were not saved, not that they were", () => {
    // The whole point is that this reads as a loss. A message a user could mistake
    // for a save confirmation would be worse than silence.
    const message = describeUnsavedReplace({ documentName: "Deck", reason: null });
    expect(message).toContain("could not be saved");
  });
});
