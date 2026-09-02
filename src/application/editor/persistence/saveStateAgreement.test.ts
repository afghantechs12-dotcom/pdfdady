import { describe, expect, it } from "vitest";
import {
  deriveSaveStatus,
  deriveStatusBreakdown,
  statusHasPendingWork,
  type SaveStatusView,
} from "./derivedStatus";
import { evaluateNavigation, shouldArmBeforeUnload } from "./navigationGuard";
import {
  INITIAL_PERSISTENCE_STATE,
  hasUnprotectedWork,
  isCurrentRevisionCommitted,
  isCurrentRevisionLocallyDurable,
  persistenceReducer,
  type PersistenceState,
} from "./persistenceMachine";
import { persistenceFailure, type PersistenceEvent } from "./events";

/**
 * T14 — the agreement contract. Every surface reads ONE projection, and no
 * reachable state projects two claims that cannot both be true.
 *
 * This is the file for defect B. The editor shipped with two independent save
 * models — the app bar's, keyed on the last EXPORT, and the status bar's, keyed on
 * durability watermarks — rendered side by side, so a recording caught "Unsaved
 * changes" and "Saved on this device" on screen at the same moment. Deleting one
 * model fixes that instance. What stops the next one is a test that no state can
 * produce a contradiction at all, applied to a matrix rather than to the handful of
 * cases someone thought of.
 *
 * WHY THE MATRIX IS BUILT FROM EVENTS. Hand-written `PersistenceState` literals
 * can express states the reducer will never produce, and a contradiction found in
 * one of those is not a bug — it is a test asserting over fiction. Every state
 * below is reached by applying real events, so anything this file finds is
 * reachable in the product.
 */

const DOC = "doc-1";
const SESSION = "session-a";
const scope = { documentId: DOC, documentSessionId: SESSION } as const;

type Step = (state: PersistenceState) => PersistenceState;

const apply = (state: PersistenceState, ...events: PersistenceEvent[]) =>
  events.reduce(persistenceReducer, state);

function open(remoteEnabled: boolean): PersistenceState {
  return apply(INITIAL_PERSISTENCE_STATE, {
    ...scope,
    type: "DOCUMENT_OPENED",
    revision: 0,
    remoteEnabled,
    online: true,
    at: 1_000,
  });
}

const mutate =
  (revision: number): Step =>
  (s) =>
    apply(s, { ...scope, type: "DOCUMENT_MUTATED", revision, at: 2_000 });

const typing =
  (pending: boolean): Step =>
  (s) =>
    apply(s, { ...scope, type: "UNCOMMITTED_INPUT_CHANGED", pending, at: 2_010 });

const localWriting =
  (requestId = "l1"): Step =>
  (s) =>
    apply(
      s,
      { ...scope, type: "LOCAL_WRITE_SCHEDULED", requestId, revision: s.currentRevision, at: 2_100 },
      { ...scope, type: "LOCAL_WRITE_STARTED", requestId, revision: s.currentRevision, at: 2_110 },
    );

const localSaved =
  (requestId = "l1"): Step =>
  (s) =>
    apply(localWriting(requestId)(s), {
      ...scope,
      type: "LOCAL_WRITE_SUCCEEDED",
      requestId,
      revision: s.currentRevision,
      at: 2_200,
      draftId: "draft-1",
    });

const localFailed =
  (category: "quota_exceeded" | "transaction_aborted" = "quota_exceeded"): Step =>
  (s) =>
    apply(localWriting("lf")(s), {
      ...scope,
      type: "LOCAL_WRITE_FAILED",
      requestId: "lf",
      revision: s.currentRevision,
      at: 2_200,
      failure: persistenceFailure(category, "The write did not complete."),
    });

const storageUnavailable: Step = (s) =>
  apply(s, {
    type: "LOCAL_STORAGE_UNAVAILABLE",
    at: 2_050,
    failure: persistenceFailure("storage_unavailable", "This browser will not open local storage."),
  });

const remoteSaving =
  (requestId = "r1"): Step =>
  (s) =>
    apply(
      s,
      { ...scope, type: "REMOTE_SAVE_SCHEDULED", requestId, revision: s.currentRevision, at: 2_300 },
      { ...scope, type: "REMOTE_SAVE_STARTED", requestId, revision: s.currentRevision, at: 2_310 },
    );

const remoteSaved =
  (requestId = "r1"): Step =>
  (s) =>
    apply(remoteSaving(requestId)(s), {
      ...scope,
      type: "REMOTE_SAVE_SUCCEEDED",
      requestId,
      revision: s.currentRevision,
      at: 2_400,
      serverVersion: 7,
      etag: "etag-7",
    });

const remoteCommitted: Step = (s) =>
  apply(remoteSaved("rc")(s), {
    ...scope,
    type: "REMOTE_VERSION_COMMITTED",
    requestId: "rc",
    revision: s.currentRevision,
    at: 2_450,
    serverVersion: 8,
    etag: "etag-8",
  });

/**
 * The explicit "Save to Workspace" commit ON ITS OWN — no autosave draft in front
 * of it, which is exactly how the standalone editor commits: that surface has no
 * autosave channel at all.
 *
 * Phase 2 closeout added these cases because the shipped projection could only be
 * reached through `remoteCommitted` above, i.e. only for a document whose autosave
 * had already succeeded — a state the surface that actually commits can never be in.
 */
const explicitCommit =
  (serverVersion: number | null = 8): Step =>
  (s) =>
    apply(s, {
      ...scope,
      type: "REMOTE_VERSION_COMMITTED",
      requestId: "xc",
      revision: s.currentRevision,
      at: 2_460,
      serverVersion,
      etag: null,
    });

/** A commit response for an EARLIER revision, arriving after a newer one won. */
const staleCommit =
  (serverVersion: number): Step =>
  (s) =>
    apply(s, {
      ...scope,
      type: "REMOTE_VERSION_COMMITTED",
      requestId: "xc-stale",
      revision: Math.max(0, s.currentRevision - 1),
      at: 2_470,
      serverVersion,
      etag: null,
    });

const remoteFailed =
  (category: "network" | "payload_too_large" | "unauthorized"): Step =>
  (s) =>
    apply(remoteSaving("rf")(s), {
      ...scope,
      type: "REMOTE_SAVE_FAILED",
      requestId: "rf",
      revision: s.currentRevision,
      at: 2_400,
      failure: persistenceFailure(category, "The workspace refused the save."),
    });

const conflicted: Step = (s) =>
  apply(remoteSaving("rk")(s), {
    ...scope,
    type: "CONFLICT_DETECTED",
    requestId: "rk",
    revision: s.currentRevision,
    at: 2_400,
    conflict: {
      localRevision: s.currentRevision,
      expectedServerVersion: 3,
      actualServerVersion: 4,
      detail: null,
      detectedAt: 2_400,
    },
  });

const offline: Step = (s) => apply(s, { type: "NETWORK_WENT_OFFLINE", at: 2_020 });

const recovered: Step = (s) =>
  apply(s, {
    ...scope,
    type: "RECOVERY_SUCCEEDED",
    draftId: "draft-1",
    revision: s.currentRevision,
    locallyDurable: true,
    at: 2_030,
  });

const recoveryFailed: Step = (s) =>
  apply(s, {
    type: "RECOVERY_FAILED",
    draftId: "draft-1",
    failure: persistenceFailure("corrupt_snapshot", "The draft could not be read."),
    at: 2_030,
  });

/** Steps that make sense for any document. */
const SHARED: Array<[string, Step[]]> = [
  ["untouched", []],
  ["typing into a text box", [typing(true)]],
  ["typing then abandoned", [typing(true), typing(false)]],
  ["one edit", [mutate(1)]],
  ["local write in flight", [mutate(1), localWriting()]],
  ["locally durable", [mutate(1), localSaved()]],
  ["edited past the local watermark", [mutate(1), localSaved(), mutate(2)]],
  ["typing after a local write", [mutate(1), localSaved(), typing(true)]],
  ["local write failed (quota)", [mutate(1), localFailed()]],
  ["local write failed (aborted)", [mutate(1), localFailed("transaction_aborted")]],
  ["no local storage, untouched", [storageUnavailable]],
  ["no local storage, edited", [mutate(1), storageUnavailable]],
  ["offline with an unsaved edit", [offline, mutate(1)]],
  ["offline but locally durable", [mutate(1), localSaved(), offline]],
  ["restored from a draft", [recovered]],
  ["restored, then edited", [recovered, mutate(1)]],
  ["draft could not be restored", [recoveryFailed]],
  ["explicitly committed as a version", [mutate(1), localSaved(), explicitCommit()]],
  [
    "committed, then edited past it",
    [mutate(1), localSaved(), explicitCommit(), mutate(2), localSaved("l2")],
  ],
  ["committed with no version disclosed", [mutate(1), localSaved(), explicitCommit(null)]],
  [
    "a stale commit landed after a newer one",
    [mutate(1), localSaved(), explicitCommit(9), staleCommit(5)],
  ],
  ["typing after a commit", [mutate(1), localSaved(), explicitCommit(), typing(true)]],
];

/** Steps that only exist for a workspace document. */
const REMOTE_ONLY: Array<[string, Step[]]> = [
  ["cloud save in flight", [mutate(1), remoteSaving()]],
  ["cloud save in flight with newer edits", [mutate(1), remoteSaving(), mutate(2)]],
  ["synced", [mutate(1), localSaved(), remoteSaved()]],
  ["synced, then edited", [mutate(1), localSaved(), remoteSaved(), mutate(2)]],
  ["committed as a version", [mutate(1), remoteCommitted]],
  ["cloud failed, local durable", [mutate(1), localSaved(), remoteFailed("network")]],
  ["cloud failed, nothing durable", [mutate(1), remoteFailed("network")]],
  ["too large, local durable", [mutate(1), localSaved(), remoteFailed("payload_too_large")]],
  ["too large, nothing durable", [mutate(1), remoteFailed("payload_too_large")]],
  ["cloud rejected the caller", [mutate(1), remoteFailed("unauthorized")]],
  ["conflict, local durable", [mutate(1), localSaved(), conflicted]],
  ["conflict, nothing durable", [mutate(1), conflicted]],
];

interface Case {
  name: string;
  state: PersistenceState;
  status: SaveStatusView;
}

const MATRIX: Case[] = [
  ...SHARED.map(([name, steps]): Case[] => [
    { name: `guest — ${name}`, state: steps.reduce((s, step) => step(s), open(false)), status: null as never },
    { name: `workspace — ${name}`, state: steps.reduce((s, step) => step(s), open(true)), status: null as never },
  ]).flat(),
  ...REMOTE_ONLY.map(([name, steps]): Case => ({
    name: `workspace — ${name}`,
    state: steps.reduce((s, step) => step(s), open(true)),
    status: null as never,
  })),
].map((c) => ({ ...c, status: deriveSaveStatus(c.state) }));

/**
 * Whether a string tells the user their work is stored somewhere.
 *
 * Written as one predicate applied to BOTH the full label and the narrow-layout
 * short form, because those are the two strings the app-bar pill swaps between at
 * a breakpoint — and a pill that says "Saved here" at 500px and "Unsaved changes"
 * at 900px is defect B with a media query in front of it.
 *
 * The negative list is what makes the hierarchy statements legible to it: "Saved
 * on this device — no cloud backup" is not a claim that the work is saved, it is a
 * claim about one tier plus a denial of the other, and the brief requires the
 * editor to be able to say exactly that.
 */
function claimsStored(text: string): boolean {
  if (/not saved|no cloud backup|not backed up|failed|pending|couldn't|can't/i.test(text)) {
    return false;
  }
  return /\bsaved\b|backed up/i.test(text);
}

describe("T14 — no reachable state contradicts itself", () => {
  it("reaches every status the editor can show (a matrix that misses states proves nothing)", () => {
    const kinds = new Set(MATRIX.map((c) => c.status.kind));
    for (const expected of [
      "unchanged",
      "unsaved",
      "saving_local",
      "saved_local",
      "saving_remote",
      "saved",
      "remote_failed",
      "remote_unavailable",
      "conflict",
      "offline_durable",
      "offline_pending",
      "no_local_storage",
      "local_failed",
      "recovered",
      "recovery_failed",
    ] as const) {
      expect(kinds, `matrix never reaches ${expected}`).toContain(expected);
    }
  });

  it.each(MATRIX.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const { state, status } = c;
    const localDurable = isCurrentRevisionLocallyDurable(state);
    const durableSomewhere = !hasUnprotectedWork(state);

    // DEFECT B, as an invariant. `tone === "success"` is the set of states the
    // product presents as safe, so it may not stand over work the model itself
    // calls dirty — which is the pair the recording caught on screen together.
    if (status.tone === "success") {
      expect(state.edit).toBe("clean");
      expect(state.uncommittedInput).toBe(false);
      expect(hasUnprotectedWork(state)).toBe(false);
      expect(status.retry).toBeNull();
    }

    // The other direction, and the one that loses documents: work at risk may
    // never project as settled.
    if (hasUnprotectedWork(state)) {
      expect(statusHasPendingWork(status)).toBe(true);
    }

    // The words must be backed by a watermark, not by a request having resolved.
    if (claimsStored(status.label)) {
      expect(localDurable || durableSomewhere).toBe(true);
    }
    // The pill swaps these at `sm`. They are the same claim or the test fails.
    expect(claimsStored(status.short)).toBe(claimsStored(status.label));

    // Non-empty at every width: a pill with no text is an unexplained blob.
    expect(status.label.length).toBeGreaterThan(0);
    expect(status.short.length).toBeGreaterThan(0);
    expect(status.detail.length).toBeGreaterThan(0);

    // Accessibility: never colour-only, and never announced on a keystroke.
    if (status.announce) expect(status.kind).not.toBe("unsaved");

    // A Retry button is offered only where retrying is a real option.
    if (status.retry !== null) expect(["warning", "danger"]).toContain(status.tone);
  });

  /**
   * Test 6 of the Phase 2 closeout: the published-version sentence, in isolation.
   *
   * Three durability tiers are three different guarantees, and this is the one that
   * means "someone else can open it". The claim is allowed in exactly the states the
   * canonical predicate allows and nowhere else — not off an autosave
   * acknowledgement, not off a local draft, not off a commit whose version the
   * server never disclosed, and not off a stale response that lost the race.
   */
  it("quotes a workspace version only where the current revision really is committed", () => {
    const quotesVersion = (view: SaveStatusView) => /as version \d+/i.test(view.detail);
    let quoted = 0;
    for (const { name, state, status } of MATRIX) {
      const committed = isCurrentRevisionCommitted(state);
      expect(quotesVersion(status), `${name} disagrees with isCurrentRevisionCommitted`).toBe(
        committed,
      );
      if (!committed) continue;
      quoted += 1;
      // What the claim rests on, restated independently of the predicate: a real
      // version number, and a watermark that has reached the revision on screen.
      expect(state.committedServerVersion, name).not.toBeNull();
      expect(state.lastCommittedRevision, name).toBeGreaterThanOrEqual(state.currentRevision);
      expect(status.detail, name).toContain(`version ${state.committedServerVersion}`);
      expect(deriveStatusBreakdown(state).remote, name).toMatch(/committed as document version/);
    }
    // ANTI-VACUITY: the matrix must actually contain committed states, on BOTH
    // surfaces — a run where nothing was committed would satisfy every line above.
    expect(quoted).toBeGreaterThanOrEqual(3);
    const committedNames = MATRIX.filter((c) => isCurrentRevisionCommitted(c.state)).map(
      (c) => c.name,
    );
    expect(committedNames.some((n) => n.startsWith("guest — "))).toBe(true);
    expect(committedNames.some((n) => n.startsWith("workspace — "))).toBe(true);
  });

  it("never lets an autosave acknowledgement or a local draft imply a published version", () => {
    /*
     * The distinction the whole closeout turns on, asserted against the two states
     * that are easiest to mistake for a commit: a workspace document whose autosave
     * round trip succeeded, and a document whose local draft is current. Both are
     * genuinely durable. Neither published anything.
     */
    const byName = new Map(MATRIX.map((c) => [c.name, c] as const));
    for (const name of [
      "workspace — synced",
      "guest — locally durable",
      "workspace — locally durable",
      "workspace — committed with no version disclosed",
      "guest — committed with no version disclosed",
      "guest — committed, then edited past it",
      "workspace — committed, then edited past it",
      "guest — typing after a commit",
    ]) {
      const c = byName.get(name);
      expect(c, `${name} is missing from the matrix`).toBeDefined();
      expect(isCurrentRevisionCommitted(c!.state), name).toBe(false);
      expect(c!.status.detail, name).not.toMatch(/as version \d+/i);
    }
    // And the state that DID commit is not caught by the same net, so the loop
    // above is discriminating rather than uniformly negative.
    const committed = byName.get("guest — explicitly committed as a version");
    expect(committed?.status.detail).toMatch(/as version 8/);

    // The stale response never became the claim either: the older version number
    // is nowhere in the copy, and the reducer counted it as ignored.
    const stale = byName.get("workspace — a stale commit landed after a newer one");
    expect(stale?.state.committedServerVersion).toBe(9);
    expect(stale?.state.staleResponsesIgnored).toBeGreaterThan(0);
    expect(stale?.status.detail).not.toMatch(/version 5/);
  });

  it("gives one state one glyph, wherever it is rendered", () => {
    const byKind = new Map<string, string>();
    for (const { name, status } of MATRIX) {
      const seen = byKind.get(status.kind);
      if (seen === undefined) byKind.set(status.kind, status.icon);
      else expect(status.icon, `${status.kind} has two glyphs (${name})`).toBe(seen);
    }
    expect(byKind.size).toBeGreaterThan(10);
  });

  /**
   * The status pill and the navigation guard are two surfaces reading the same
   * state, and the pair that matters is "nothing to worry about" beside a
   * beforeunload prompt — or worse, the reverse.
   */
  it("agrees with the navigation guard", () => {
    for (const { name, state, status } of MATRIX) {
      const verdict = evaluateNavigation(state);
      expect(shouldArmBeforeUnload(state), name).toBe(verdict.armBeforeUnload);
      if (verdict.armBeforeUnload) {
        expect(statusHasPendingWork(status), `${name} warns on unload but reads settled`).toBe(true);
      }
      if (status.tone === "success") {
        expect(verdict.decision, `${name} claims safety but blocks navigation`).toBe("allow");
      }
    }
  });
});
