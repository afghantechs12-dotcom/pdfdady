import { describe, expect, it } from "vitest";
import {
  RECOVERY_ACTIONS,
  buildRecoveryPrompt,
  describeAge,
  type RecoveryPromptInput,
} from "./recoveryPrompt";
import type { DraftDescriptor } from "./events";

/**
 * What the user is told about a draft *before* they decide to trust it.
 *
 * Two ways this goes wrong, and both are worse than not recovering at all.
 *
 * The first is choosing for the user. Restoring a draft over a workspace document
 * that a colleague also edited is a merge decision made silently, and the loser is
 * real work. So the question this file keeps asking is: does `requiresChoice` come
 * back true in every case where a second version genuinely exists?
 *
 * The second is calling a partial restore a restore. A document whose original
 * pages did not come back looks exactly like one that did — until the user saves
 * it over the good copy. So a draft that cannot be fully rebuilt has to say so in
 * the headline, in the caveat, and in the notice shown after an automatic restore.
 */

const NOW = Date.UTC(2026, 7, 22, 15, 0, 0);
const MINUTE = 60_000;

/** A complete guest draft: nothing missing, nothing ambiguous. */
function draft(overrides: Partial<DraftDescriptor> = {}): DraftDescriptor {
  return {
    draftId: "draft-1",
    documentKey: "guest:abc",
    documentId: null,
    documentName: "contract.pdf",
    revision: 12,
    updatedAt: NOW - 4 * MINUTE,
    schemaVersion: 1,
    fellBackToPreviousSnapshot: false,
    missingAssets: [],
    migratedFrom: null,
    serverVersion: null,
    lastRemoteAcknowledgedRevision: null,
    ...overrides,
  };
}

function prompt(overrides: Partial<RecoveryPromptInput> = {}) {
  return buildRecoveryPrompt({
    draft: draft(),
    savedVersionAt: null,
    openedRevision: 0,
    hasAlternateVersion: false,
    now: NOW,
    ...overrides,
  });
}

function detail(input: ReturnType<typeof prompt>, label: string): string {
  const found = input.details.find((entry) => entry.label === label);
  if (!found) throw new Error(`no detail labelled ${label}; got ${input.details.map((d) => d.label).join(", ")}`);
  return found.value;
}

describe("when the user must be asked", () => {
  it("does not ask about an unambiguous guest draft", () => {
    /*
     * The only copy of this work is the draft. A dialog here is a conversation
     * between the user and something that is unquestionably theirs.
     */
    expect(prompt().requiresChoice).toBe(false);
  });

  it("asks when the workspace also holds a version", () => {
    expect(prompt({ hasAlternateVersion: true }).requiresChoice).toBe(true);
  });

  it("asks when the draft cannot be fully restored, even with no other version", () => {
    expect(prompt({ draft: draft({ missingAssets: ["image:a1"] }) }).requiresChoice).toBe(true);
  });

  it("asks when the newest snapshot was unreadable and an older one was used", () => {
    expect(prompt({ draft: draft({ fellBackToPreviousSnapshot: true }) }).requiresChoice).toBe(true);
  });

  it("offers the saved version only when one exists to offer", () => {
    const ids = (p: ReturnType<typeof prompt>) => p.actions.map((action) => action.id);
    expect(ids(prompt())).not.toContain("open_saved_version");
    expect(ids(prompt({ hasAlternateVersion: true }))).toContain("open_saved_version");
  });
});

describe("the ordering and weight of the actions", () => {
  it("leads with restoring, which is what the user came for", () => {
    expect(prompt().actions[0]!.id).toBe("restore_draft");
    expect(prompt().actions[0]!.destructive).toBe(false);
  });

  it("puts the only irreversible action last", () => {
    const actions = prompt({ hasAlternateVersion: true }).actions;
    expect(actions[actions.length - 1]!.id).toBe("delete_draft");
    expect(actions.filter((action) => action.destructive).map((action) => action.id)).toEqual([
      "delete_draft",
    ]);
  });

  it("keeps opening the saved version non-destructive, because the draft survives it", () => {
    // Declining a draft is not deleting it: the user who clicks "Open the saved
    // version" and then changes their mind must still have somewhere to go back to.
    expect(RECOVERY_ACTIONS.open_saved_version.destructive).toBe(false);
  });
});

describe("a draft that cannot be fully rebuilt", () => {
  it("says so in the headline rather than only in the small print", () => {
    const partial = prompt({ draft: draft({ missingAssets: ["image:a1", "image:a2"] }) });
    expect(partial.headline).toContain("partly recoverable");
    expect(prompt().headline).not.toContain("partly");
  });

  it("names the consequence when the original pages are the thing that is missing", () => {
    const p = prompt({ draft: draft({ missingAssets: ["source-pdf"] }) });
    expect(p.caveat).not.toBeNull();
    expect(p.caveat!).toContain("original");
    expect(p.caveat!.toLowerCase()).toContain("pages");
  });

  it("reports the missing source even when other assets are missing too", () => {
    // The lost original outweighs a lost image, and only one caveat is shown.
    const p = prompt({ draft: draft({ missingAssets: ["image:a1", "source-pdf"] }) });
    expect(p.caveat!.toLowerCase()).toContain("original pdf");
  });

  it("never presents the automatic notice as an unqualified success", () => {
    const p = prompt({ draft: draft({ missingAssets: ["image:a1"] }) });
    expect(p.automaticNotice).toMatch(/could not be restored/i);
    expect(p.automaticNotice).not.toBe(prompt().automaticNotice);
  });

  it("counts the missing items in the user's language, singular and plural", () => {
    expect(detail(prompt({ draft: draft({ missingAssets: ["image:a1"] }) }), "Document data")).toBe(
      "1 item could not be restored",
    );
    expect(
      detail(prompt({ draft: draft({ missingAssets: ["image:a1", "image:a2"] }) }), "Document data"),
    ).toBe("2 items could not be restored");
  });

  it("says the data is complete only when nothing is missing", () => {
    expect(detail(prompt(), "Document data")).toBe("complete");
  });

  it("has no caveat for a clean draft, so a caveat always means something", () => {
    expect(prompt().caveat).toBeNull();
  });
});

describe("the facts offered for review", () => {
  it("distinguishes a document that was never saved elsewhere from one whose save time is unknown", () => {
    /*
     * Both are `savedVersionAt: null`, and they are opposite situations. For a
     * guest document "none" is the reassuring answer — there is nothing to lose by
     * restoring. For a workspace document the same null means the client simply
     * does not know, and saying "none" would invite the user to overwrite a version
     * that exists.
     */
    expect(detail(prompt(), "Saved version")).toContain("never saved elsewhere");
    expect(detail(prompt({ hasAlternateVersion: true }), "Saved version")).toBe("unknown");
  });

  it("pairs an absolute time with the relative one, so the age can be checked", () => {
    const value = detail(prompt({ savedVersionAt: NOW - 90 * MINUTE, hasAlternateVersion: true }), "Saved version");
    expect(value).toContain("2 hours ago");
    expect(value).not.toBe("2 hours ago");
  });

  it("reads a never-synced watermark as never synced rather than as revision -1", () => {
    // `NOTHING_DURABLE` is -1 on the wire. Printing it is how a prompt tells the
    // user their work is at "revision -1".
    expect(detail(prompt({ draft: draft({ lastRemoteAcknowledgedRevision: -1 }) }), "Workspace revision")).toBe(
      "never synced",
    );
    expect(detail(prompt(), "Workspace revision")).toBe("never synced");
    expect(detail(prompt({ draft: draft({ lastRemoteAcknowledgedRevision: 8 }) }), "Workspace revision")).toBe("8");
  });

  it("discloses that an older snapshot was used", () => {
    expect(detail(prompt({ draft: draft({ fellBackToPreviousSnapshot: true }) }), "Recovered from")).toContain(
      "unreadable",
    );
    expect(detail(prompt(), "Recovered from")).toContain("newest snapshot");
  });

  it("discloses a format upgrade, because it explains why bytes changed on the way in", () => {
    expect(detail(prompt({ draft: draft({ migratedFrom: 3, schemaVersion: 5 }) }), "Format")).toContain(
      "upgraded from version 3",
    );
    expect(detail(prompt({ draft: draft({ schemaVersion: 5 }) }), "Format")).toContain("current (version 5)");
  });

  it("leaves no detail blank", () => {
    for (const entry of prompt({ hasAlternateVersion: true, savedVersionAt: NOW - MINUTE }).details) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.value.length).toBeGreaterThan(0);
    }
  });
});

describe("the summary sentence", () => {
  it("quantifies what the saved version is missing", () => {
    expect(prompt({ openedRevision: 9, draft: draft({ revision: 12 }) }).summary).toContain(
      "3 changes the saved version does not have",
    );
  });

  it("says 'change' for one", () => {
    expect(prompt({ openedRevision: 11, draft: draft({ revision: 12 }) }).summary).toContain("1 change the saved");
  });

  it("claims no advantage when the draft is not ahead", () => {
    /*
     * A restore of a draft at the same revision, or behind, gains nothing. "0
     * changes the saved version does not have" — or worse, a negative count — is
     * the kind of sentence that makes a user distrust everything else on screen.
     */
    const level = prompt({ openedRevision: 12, draft: draft({ revision: 12 }) }).summary;
    expect(level).not.toMatch(/\d+ changes?/);
    expect(prompt({ openedRevision: 20, draft: draft({ revision: 12 }) }).summary).not.toContain("-");
  });

  it("dates the draft rather than making the user work it out", () => {
    expect(prompt().summary).toContain("4 minutes ago");
  });
});

describe("describing the age of a draft", () => {
  const cases: Array<[number, string]> = [
    [0, "moments ago"],
    [44_000, "moments ago"],
    [45_000, "1 minute ago"],
    [2 * MINUTE, "2 minutes ago"],
    [59 * MINUTE, "59 minutes ago"],
    [90 * MINUTE, "2 hours ago"],
    [23 * 60 * MINUTE, "23 hours ago"],
    [26 * 60 * MINUTE, "1 day ago"],
    [3 * 24 * 60 * MINUTE, "3 days ago"],
  ];

  for (const [elapsed, expected] of cases) {
    it(`reads ${elapsed}ms as "${expected}"`, () => {
      expect(describeAge(elapsed)).toBe(expected);
    });
  }

  it("does not report a future timestamp as a negative age", () => {
    /*
     * A draft written on a machine whose clock is ahead, or written just before a
     * clock correction, arrives with `updatedAt > now`. "-2 minutes ago" is not a
     * time, and it turns a recovery prompt into evidence that the feature is
     * broken.
     */
    expect(describeAge(-90_000)).toBe("moments ago");
    expect(prompt({ draft: draft({ updatedAt: NOW + 5 * MINUTE }) }).summary).toContain("moments ago");
  });
});
