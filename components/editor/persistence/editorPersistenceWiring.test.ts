import { describe, expect, it } from "vitest";
import type {
  ConflictAction,
  ConflictActionId,
} from "@/src/application/editor/persistence/conflictResolution";
import { CONFLICT_ACTIONS } from "@/src/application/editor/persistence/conflictResolution";
import { GUEST_DOCUMENT_MAP_KEY } from "@/src/application/editor/persistence/documentIdentity";
import type { LoadedDraft } from "@/src/application/editor/persistence/draftRepository";
import type { SerializedEditorState } from "@/src/application/editor/ports/ISerializer";
import { deriveSaveStatus } from "@/src/application/editor/persistence/derivedStatus";
import {
  INITIAL_PERSISTENCE_STATE,
  type PersistenceState,
} from "@/src/application/editor/persistence/persistenceMachine";
import type { PersistenceLimitation } from "@/src/infrastructure/persistence/browser/createPersistenceRuntime";
import {
  blockingLimitation,
  conflictActionSupport,
  describeDuplicateOutcome,
  describeRestoreResult,
  documentNameForCapture,
  duplicateCopyName,
  guestIdentityNotice,
  identifyGuestDocument,
  planDraftRestore,
  saveStatusTriggerName,
  secondaryLimitations,
  shouldCaptureDocument,
  shouldProbeAbandonedGuestDraft,
  visibleConflictActions,
  workspaceSourceReference,
} from "./editorPersistenceWiring";

/**
 * The editor surface's persistence decisions, executed.
 *
 * `EditorWorkspace.tsx` cannot be rendered by this suite — Node, no jsdom, and the
 * component needs a layout engine and a canvas. So every judgement it makes about
 * persistence was moved here to be run for real, and `persistenceWiring.test.ts`
 * separately asserts that the component actually calls these.
 */

/** A scope with no `sessionStorage` at all — some embedded webviews. */
const ABSENT_STORAGE_SCOPE: unknown = {};

/** A `sessionStorage`-shaped double, with a switch for the private-mode failure. */
function fakeScope(options: { throwOnWrite?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    sessionStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (options.throwOnWrite) throw new Error("QuotaExceededError");
        map.set(key, value);
      },
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage,
    _map: map,
  };
}

function idFactory(...ids: string[]) {
  let i = 0;
  return () => ids[i++] ?? `overflow-${i}`;
}

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

describe("identifyGuestDocument", () => {
  it("mints an id for a file it has not seen, and remembers it for next time", () => {
    const scope = fakeScope();
    const first = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: BYTES,
      scope,
      newId: idFactory("guest-1"),
    });

    expect(first.reused).toBe(false);
    expect(first.persisted).toBe(true);
    expect(first.identity.origin).toBe("guest");
    expect(first.identity.documentId).toBeNull();
    expect(first.identity.workspaceId).toBeNull();
    expect(first.identity.documentKey).toContain("guest-1");
    expect(scope._map.get(GUEST_DOCUMENT_MAP_KEY)).toBeTruthy();
  });

  it("reuses the id for the same file, so its draft continues rather than orphaning", () => {
    const scope = fakeScope();
    const first = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: BYTES,
      scope,
      newId: idFactory("guest-1"),
    });
    const again = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: BYTES,
      scope,
      // A second mint would be a bug; if this is called the ids differ and the
      // expectation below fails loudly rather than silently orphaning a draft.
      newId: idFactory("guest-2"),
    });

    expect(again.reused).toBe(true);
    expect(again.identity.documentKey).toBe(first.identity.documentKey);
  });

  it("separates two different files, even with the same name", () => {
    const scope = fakeScope();
    const a = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: BYTES,
      scope,
      newId: idFactory("guest-1"),
    });
    const b = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: new Uint8Array([9, 9, 9, 9]),
      scope,
      newId: idFactory("guest-2"),
    });

    expect(b.identity.documentKey).not.toBe(a.identity.documentKey);
  });

  it("degrades to an ephemeral id rather than refusing to open the file", () => {
    for (const scope of [fakeScope({ throwOnWrite: true }), ABSENT_STORAGE_SCOPE]) {
      const resolved = identifyGuestDocument({
        fileName: "report.pdf",
        bytes: BYTES,
        scope,
        newId: idFactory("guest-1"),
      });
      expect(resolved.persisted).toBe(false);
      expect(resolved.identity.documentKey).toContain("guest-1");
    }
  });
});

describe("identifyGuestDocument({ forceNewIdentity }) — the escape from a declined draft", () => {
  /*
   * A blank page's fingerprint is only its NAME, so every blank page in a tab
   * resolves to the same key. That is deliberate — it is how a reload continues the
   * page you were drawing on. But it is wrong in exactly one situation: the user was
   * offered that key's draft and said no. Continuing it would advance its pointer
   * onto their fresh, near-empty page, so the bytes they declined to restore stop
   * being the ones a restore reads. `forceNewIdentity` is the caller's way of saying
   * "not that one".
   *
   * MUTATION-CHECKED: making the flag a no-op (both branches resolve) fails 2 of these.
   */
  const BLANK = { fileName: "document", bytes: null } as const;

  it("re-keys a blank page whose key was already taken", () => {
    const scope = fakeScope();
    const declined = identifyGuestDocument({ ...BLANK, scope, newId: idFactory("guest-1") });
    const replacement = identifyGuestDocument({
      ...BLANK,
      scope,
      newId: idFactory("guest-2"),
      forceNewIdentity: true,
    });

    expect(replacement.identity.documentKey).not.toBe(declined.identity.documentKey);
    expect(replacement.identity.documentKey).toContain("guest-2");
    expect(replacement.reused).toBe(false);
    expect(replacement.persisted).toBe(true);
  });

  it("shows what the default would have done, so the difference is not theoretical", () => {
    /*
     * The control for the test above. Without the flag the same call CONTINUES the
     * declined draft — which is correct for a reload and is the data-loss path after
     * a dismissal. Both behaviours have to be pinned or a future edit could collapse
     * them into one and only one of the two tests would notice.
     */
    const scope = fakeScope();
    const declined = identifyGuestDocument({ ...BLANK, scope, newId: idFactory("guest-1") });
    const continued = identifyGuestDocument({ ...BLANK, scope, newId: idFactory("guest-2") });

    expect(continued.identity.documentKey).toBe(declined.identity.documentKey);
    expect(continued.reused).toBe(true);
  });

  it("is still a guest identity with no server document attached", () => {
    const scope = fakeScope();
    const forced = identifyGuestDocument({
      ...BLANK,
      scope,
      newId: idFactory("guest-1"),
      forceNewIdentity: true,
    });
    expect(forced.identity.origin).toBe("guest");
    expect(forced.identity.documentId).toBeNull();
    expect(forced.identity.workspaceId).toBeNull();
  });

  it("does not strand the tab when storage refuses the write", () => {
    // The dismissal already happened; refusing to produce a key here would leave the
    // editor with nothing to save under, which is the failure the flag exists to end.
    for (const scope of [fakeScope({ throwOnWrite: true }), ABSENT_STORAGE_SCOPE]) {
      const forced = identifyGuestDocument({
        ...BLANK,
        scope,
        newId: idFactory("guest-9"),
        forceNewIdentity: true,
      });
      expect(forced.persisted).toBe(false);
      expect(forced.identity.documentKey).toContain("guest-9");
    }
  });

  it("re-keys a named file too, not just the blank page", () => {
    // Nothing about the flag is blank-specific; a dismissed offer for an opened file
    // must escape the same way.
    const scope = fakeScope();
    const first = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: BYTES,
      scope,
      newId: idFactory("guest-1"),
    });
    const forced = identifyGuestDocument({
      fileName: "report.pdf",
      bytes: BYTES,
      scope,
      newId: idFactory("guest-2"),
      forceNewIdentity: true,
    });
    expect(forced.identity.documentKey).not.toBe(first.identity.documentKey);
    // And the old entry is gone rather than shadowed, so it cannot come back.
    expect(
      identifyGuestDocument({
        fileName: "report.pdf",
        bytes: BYTES,
        scope,
        newId: idFactory("guest-3"),
      }).identity.documentKey,
    ).toBe(forced.identity.documentKey);
  });
});

describe("documentNameForCapture", () => {
  it("stores the stem, so one document is not two names in the recovery list", () => {
    expect(documentNameForCapture("report.pdf")).toBe("report");
    expect(documentNameForCapture("report.PDF")).toBe("report");
    expect(documentNameForCapture("  spaced.pdf  ")).toBe("spaced");
  });

  it("never stores a nameless draft", () => {
    expect(documentNameForCapture("")).toBe("document");
    expect(documentNameForCapture("   ")).toBe("document");
    expect(documentNameForCapture(".pdf")).toBe("document");
  });

  it("keeps an inner dot: only the extension is an extension", () => {
    expect(documentNameForCapture("v1.2.final.pdf")).toBe("v1.2.final");
  });
});

describe("workspaceSourceReference", () => {
  it("pins the version, so a reference cannot be mistaken for the current one", () => {
    expect(
      workspaceSourceReference({ workspaceId: "w1", documentId: "d1", versionNumber: 4 }),
    ).toBe("workspace:w1/d1@4");
    expect(
      workspaceSourceReference({ workspaceId: "w1", documentId: "d1", versionNumber: null }),
    ).toBe("workspace:w1/d1@current");
  });
});

describe("shouldCaptureDocument — the interlock against filing one document under another", () => {
  it("captures when the content in the editor is the content the open identity names", () => {
    expect(shouldCaptureDocument({ loadedKey: "guest:a", openKey: "guest:a" })).toBe(true);
  });

  it("refuses while the two disagree — the window during a document switch", () => {
    expect(shouldCaptureDocument({ loadedKey: "guest:a", openKey: "guest:b" })).toBe(false);
    expect(shouldCaptureDocument({ loadedKey: "guest:b", openKey: "guest:a" })).toBe(false);
  });

  it("refuses while nothing is loaded, so an offered draft is not overwritten by a blank page", () => {
    expect(shouldCaptureDocument({ loadedKey: null, openKey: "guest:a" })).toBe(false);
  });

  it("refuses when nothing is open, rather than treating two nulls as agreement", () => {
    expect(shouldCaptureDocument({ loadedKey: null, openKey: null })).toBe(false);
  });
});

/** A `LoadedDraft` double: only `scene` and `sourceBytes` are read. */
function draft(pages: Array<{ id: string; sourcePageIndex: number | null }>, bytes: Uint8Array | null): LoadedDraft {
  return {
    descriptor: {} as LoadedDraft["descriptor"],
    manifest: {} as LoadedDraft["manifest"],
    scene: { document: { pages } } as unknown as SerializedEditorState,
    sourceBytes: bytes,
    generation: 1,
  };
}

describe("planDraftRestore", () => {
  it("plans a raster rebuild from the draft's own pages", () => {
    const plan = planDraftRestore(
      draft([{ id: "p1", sourcePageIndex: 0 }, { id: "p2", sourcePageIndex: 1 }], BYTES),
    );
    expect(plan.pages.map((p) => p.pageId)).toEqual(["p1", "p2"]);
    expect(plan.redraw).toBe(true);
    expect(plan.sourceBytes).toBe(BYTES);
    expect(plan.caveat).toBeNull();
  });

  it("says so, up front, when the source bytes are gone and pages need them", () => {
    const plan = planDraftRestore(draft([{ id: "p1", sourcePageIndex: 0 }], null));
    expect(plan.redraw).toBe(false);
    expect(plan.caveat).not.toBeNull();
    expect(plan.caveat).toContain("blank");
    // The scene is still restorable — a caveat is not a refusal.
    expect(plan.pages).toHaveLength(1);
  });

  it("treats zero-length bytes as no bytes", () => {
    const plan = planDraftRestore(draft([{ id: "p1", sourcePageIndex: 0 }], new Uint8Array(0)));
    expect(plan.sourceBytes).toBeNull();
    expect(plan.redraw).toBe(false);
    expect(plan.caveat).not.toBeNull();
  });

  it("is complete with no bytes when no page wants a raster (a document built from scratch)", () => {
    const plan = planDraftRestore(draft([{ id: "p1", sourcePageIndex: null }], null));
    expect(plan.redraw).toBe(false);
    expect(plan.caveat).toBeNull();
  });

  it("survives a scene written by an older build", () => {
    const plan = planDraftRestore({
      descriptor: {} as LoadedDraft["descriptor"],
      manifest: {} as LoadedDraft["manifest"],
      scene: { document: null } as unknown as SerializedEditorState,
      sourceBytes: BYTES,
      generation: 1,
    });
    expect(plan.pages).toEqual([]);
    expect(plan.redraw).toBe(false);
    expect(plan.caveat).toBeNull();
  });
});

describe("describeRestoreResult", () => {
  it("leads with what came back", () => {
    const message = describeRestoreResult({
      documentName: "report",
      complete: true,
      unrenderedPageCount: 0,
    });
    expect(message).toBe('Your unsaved work on "report" is back.');
  });

  it("counts the blank pages, and says the edits on them survived", () => {
    const message = describeRestoreResult({
      documentName: "report",
      complete: true,
      unrenderedPageCount: 3,
    });
    expect(message.startsWith('Your unsaved work on "report" is back.')).toBe(true);
    expect(message).toContain("3 pages");
    expect(message).toContain("intact");
  });

  it("says one page, not 1 pages", () => {
    expect(
      describeRestoreResult({ documentName: "r", complete: true, unrenderedPageCount: 1 }),
    ).toContain("1 page could not");
  });

  it("still reports an incomplete draft that rendered every page it had", () => {
    const message = describeRestoreResult({
      documentName: "report",
      complete: false,
      unrenderedPageCount: 0,
    });
    expect(message).toContain("is back.");
    expect(message).toContain("blank");
  });
});

const LIMITATIONS: PersistenceLimitation[] = [
  { code: "no_cross_tab_lock", message: "no lock" },
  { code: "no_local_store", message: "no store" },
  { code: "no_peer_channel", message: "no channel" },
];

describe("limitations", () => {
  it("promotes only the one that means the work is unprotected", () => {
    expect(blockingLimitation(LIMITATIONS)?.code).toBe("no_local_store");
    expect(blockingLimitation(LIMITATIONS.filter((l) => l.code !== "no_local_store"))).toBeNull();
  });

  it("keeps the rest — they are shown in the status detail, not thrown away", () => {
    expect(secondaryLimitations(LIMITATIONS).map((l) => l.code)).toEqual([
      "no_cross_tab_lock",
      "no_peer_channel",
    ]);
  });

  it("says nothing when there is nothing to say", () => {
    expect(blockingLimitation([])).toBeNull();
    expect(secondaryLimitations([])).toEqual([]);
  });
});

describe("guestIdentityNotice", () => {
  it("explains the degraded matching only when the map could not be stored", () => {
    expect(guestIdentityNotice({ origin: "guest", persisted: false })).toContain("Recovery is still offered");
    expect(guestIdentityNotice({ origin: "guest", persisted: true })).toBeNull();
  });

  it("never fires for a workspace document, whose identity is the URL", () => {
    expect(guestIdentityNotice({ origin: "workspace", persisted: false })).toBeNull();
  });
});

describe("conflict actions", () => {
  const ALL: ConflictAction[] = [
    CONFLICT_ACTIONS.review_local,
    CONFLICT_ACTIONS.review_workspace,
    CONFLICT_ACTIONS.save_local_copy,
    CONFLICT_ACTIONS.duplicate_as_new,
    CONFLICT_ACTIONS.replace_workspace,
    CONFLICT_ACTIONS.cancel,
  ];

  it("assigns every action an owner — a new one cannot be silently unhandled", () => {
    const ids: ConflictActionId[] = [
      "review_local",
      "review_workspace",
      "save_local_copy",
      "duplicate_as_new",
      "replace_workspace",
      "cancel",
    ];
    for (const id of ids) {
      expect(conflictActionSupport(id, { workspaceKnown: true })).toBeTruthy();
    }
  });

  it("drops 'review the local version': it is the document behind the dialog", () => {
    expect(conflictActionSupport("review_local", { workspaceKnown: true })).toBe("not_applicable");
    expect(visibleConflictActions(ALL, { workspaceKnown: true }).map((a) => a.id)).not.toContain(
      "review_local",
    );
  });

  it("always offers the download — the answer for a user who understands none of it", () => {
    expect(conflictActionSupport("save_local_copy", { workspaceKnown: false })).toBe("surface");
    expect(visibleConflictActions(ALL, { workspaceKnown: false }).map((a) => a.id)).toContain(
      "save_local_copy",
    );
  });

  it("hides the workspace-dependent actions when there is no workspace to act on", () => {
    const visible = visibleConflictActions(ALL, { workspaceKnown: false }).map((a) => a.id);
    expect(visible).not.toContain("review_workspace");
    expect(visible).not.toContain("duplicate_as_new");
  });

  it("keeps the presentation's order, and keeps the destructive one out of first place", () => {
    const visible = visibleConflictActions(ALL, { workspaceKnown: true }).map((a) => a.id);
    expect(visible).toEqual([
      "review_workspace",
      "save_local_copy",
      "duplicate_as_new",
      "replace_workspace",
      "cancel",
    ]);
    expect(visible[0]).not.toBe("replace_workspace");
    expect(visible.indexOf("replace_workspace")).toBeLessThan(visible.indexOf("cancel"));
  });

  it("leaves the overwrite to the coordinator", () => {
    expect(conflictActionSupport("replace_workspace", { workspaceKnown: true })).toBe("coordinator");
  });
});

describe("duplicateCopyName", () => {
  it("suffixes so the copy sorts beside its original", () => {
    expect(duplicateCopyName("report.pdf")).toBe("report (recovered copy)");
  });

  it("is idempotent — resolving twice does not nest the suffix", () => {
    const once = duplicateCopyName("report");
    expect(duplicateCopyName(once)).toBe(once);
  });
});

describe("describeDuplicateOutcome", () => {
  it("reports a real new document, and where it is", () => {
    const outcome = describeDuplicateOutcome({
      workspaceId: "w1",
      newDocumentId: "d2",
      conflictedDocumentId: "d1",
      deduplicated: false,
      name: "report (recovered copy)",
    });
    expect(outcome.notice).toContain("Saved as a new document");
    expect(outcome.notice).toContain("untouched");
    expect(outcome.href).toBe("/workspaces/w1/documents/d2");
    expect(outcome.resolved).toBe(true);
  });

  it("does not claim a copy was made when the upload de-duplicated into another document", () => {
    const outcome = describeDuplicateOutcome({
      workspaceId: "w1",
      newDocumentId: "d9",
      conflictedDocumentId: "d1",
      deduplicated: true,
      name: "report (recovered copy)",
    });
    expect(outcome.notice).not.toContain("Saved as a new document");
    expect(outcome.notice).toContain("matched a document already in this workspace");
    expect(outcome.href).toBe("/workspaces/w1/documents/d9");
  });

  it("does not send the user to the document they are already in when it deduplicated onto it", () => {
    const outcome = describeDuplicateOutcome({
      workspaceId: "w1",
      newDocumentId: "d1",
      conflictedDocumentId: "d1",
      deduplicated: true,
      name: "report (recovered copy)",
    });
    expect(outcome.href).toBeNull();
    expect(outcome.notice).toContain("nothing new was created");
  });
});

describe("shouldProbeAbandonedGuestDraft", () => {
  it("probes a fresh guest editor once", () => {
    expect(
      shouldProbeAbandonedGuestDraft({ origin: "guest", hasOpenDocument: false, alreadyProbed: false }),
    ).toBe(true);
  });

  it("never probes with a document open — that would offer a different document's draft", () => {
    expect(
      shouldProbeAbandonedGuestDraft({ origin: "guest", hasOpenDocument: true, alreadyProbed: false }),
    ).toBe(false);
  });

  it("never probes twice, so a dismissed offer stays dismissed", () => {
    expect(
      shouldProbeAbandonedGuestDraft({ origin: "guest", hasOpenDocument: false, alreadyProbed: true }),
    ).toBe(false);
  });

  it("never probes for a workspace document, which has its own probe on open", () => {
    expect(
      shouldProbeAbandonedGuestDraft({ origin: "workspace", hasOpenDocument: false, alreadyProbed: false }),
    ).toBe(false);
  });
});

/**
 * F2. The save-status control's accessible name.
 *
 * Every status is swept rather than listed, because the defect was in exactly the
 * state a hand-written list forgets: `idle`, whose `short` is a bare em-dash, so the
 * control's whole accessible name in the narrow presentation was punctuation. A
 * product sweep of the state machine's own dimensions reaches it without anyone
 * having to think of it.
 */
describe("the save-status trigger is named in every state (F2)", () => {
  const sweep = (): PersistenceState[] => {
    const states: PersistenceState[] = [{ ...INITIAL_PERSISTENCE_STATE }];
    for (const documentId of [null, "doc-1"]) {
      for (const local of ["idle", "writing", "durable", "failed", "unavailable"] as const) {
        for (const remote of ["idle", "saving", "synced", "failed", "conflict"] as const) {
          for (const edit of ["clean", "dirty"] as const) {
            for (const online of [true, false]) {
              for (const remoteEnabled of [true, false]) {
                for (const recovery of ["none", "recovered", "recovery_failed"] as const) {
                  states.push({
                    ...INITIAL_PERSISTENCE_STATE,
                    documentId,
                    documentSessionId: documentId === null ? null : "session-a",
                    documentKey: documentId === null ? null : "guest:abc",
                    local,
                    remote,
                    edit,
                    online,
                    remoteEnabled,
                    recovery,
                    currentRevision: edit === "dirty" ? 3 : 0,
                    lastLocallyDurableRevision: local === "durable" ? 3 : 0,
                    lastRemoteAcknowledgedRevision: remote === "synced" ? 3 : 0,
                    recoveredRevision: recovery === "recovered" ? 3 : null,
                  });
                }
              }
            }
          }
        }
      }
    }
    return states;
  };

  const statuses = sweep().map((state) => deriveSaveStatus(state));

  it("reaches the state that broke, and most of the others", () => {
    // Without this the sweep could narrow to one status and every assertion below
    // would pass while proving nothing.
    expect(new Set(statuses.map((s) => s.kind)).size).toBeGreaterThanOrEqual(12);
    expect(statuses.some((s) => s.short === "—")).toBe(true);
  });

  it("never names a control with punctuation alone", () => {
    for (const status of statuses) {
      for (const compact of [true, false]) {
        const name = saveStatusTriggerName(status, compact);
        expect(/[A-Za-z]/u.test(name.replace(/save status/u, "")), `${status.kind}/${compact}`).toBe(
          true,
        );
        expect(name, `${status.kind}/${compact}`).toContain("save status");
      }
    }
  });

  it("starts with the words the user can see, so speech input can say them", () => {
    // WCAG 2.5.3 Label in Name. Five `short` forms are not substrings of their own
    // `label`, so a name built from the label alone would fail this for them.
    for (const status of statuses) {
      expect(saveStatusTriggerName(status, true).startsWith(status.short)).toBe(true);
      expect(saveStatusTriggerName(status, false).startsWith(status.label)).toBe(true);
    }
  });

  it("always states the long form, and never states it twice", () => {
    for (const status of statuses) {
      expect(saveStatusTriggerName(status, true)).toContain(status.label);
      expect(saveStatusTriggerName(status, false)).toBe(`${status.label}, save status`);
    }
  });
});
