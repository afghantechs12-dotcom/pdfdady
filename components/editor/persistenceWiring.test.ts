import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The WIRING of document persistence into the editor surface.
 *
 * The whole autosave/recovery/conflict subsystem — coordinator, write scheduler,
 * revision bridge, draft repository, browser runtime, binding, hook, capture,
 * identity policy — arrived with 1100+ passing tests and was imported by NOTHING.
 * `useDocumentPersistence` had exactly one importer, its own test file;
 * `restoreBackgrounds` had none. Every unit was correct and no document in the
 * product was protected, and the suite was green the entire time. That is the class
 * of defect this file exists to make impossible.
 *
 * `EditorWorkspace.tsx` cannot be rendered here — Node, no jsdom, and the component
 * wants a layout engine, a canvas and PDF.js — so the assertions are on source, as
 * in `toolPersistenceWiring.test.ts` and `useDocumentPersistence.test.ts`. What they
 * pin is what survives a refactor: which functions are called, in what ORDER, and
 * which calls must never appear. The ordering assertions are the important half.
 * Persistence is a set of sequencing invariants, and every way of getting them wrong
 * loses the user's work while reporting success:
 *
 *     setIdentity(identity);            // arms autosave...
 *     actions.loadState(loaded.state);  // ...over a blank editor, which is then
 *                                       //    committed as this document's draft
 *
 *     const capture = useCallback(...)  // freezes the closure; autosaves a stale
 *                                       //    document and calls the write durable
 *
 *     return { historyRevision: revision };   // the render's value, from before the
 *                                             //    restore: unsaved forever
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/**
 * Comments removed. Several of the calls asserted-absent below are NAMED in the
 * comments that explain why they are absent — including this file's own header —
 * and a warning about a call must not read as the call.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const workspaceSource = read("components", "editor", "EditorWorkspace.tsx");
const workspace = stripComments(workspaceSource);
const statusBar = stripComments(read("components", "editor", "StatusBar.tsx"));
const indicator = stripComments(read("components", "editor", "persistence", "SaveStatusIndicator.tsx"));
const recoveryDialog = stripComments(
  read("components", "editor", "persistence", "RecoveryPromptDialog.tsx"),
);
const conflictDialog = stripComments(read("components", "editor", "persistence", "ConflictDialog.tsx"));
const shell = read("components", "editor", "StandaloneEditorShell.tsx");
const shellCode = stripComments(shell);

/**
 * The body of a named function/const declaration, brace-matched.
 *
 * Anchored on the arrow rather than the next `{`, because a parameter typed with an
 * inline object literal (`options?: { confirmed?: boolean }`) would otherwise be
 * returned as the whole body — and every assertion against it would then pass or
 * fail for reasons that have nothing to do with the code being checked.
 */
function bodyOf(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  expect(at, `declaration not found: ${declaration}`).toBeGreaterThan(-1);
  const arrow = source.indexOf("=> {", at);
  const brace = source.indexOf("{", at);
  const open = arrow > -1 && arrow < source.indexOf("\n}", at) ? arrow + 3 : brace;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${declaration}`);
}

/** The source between two markers, for "nothing happens in between" assertions. */
function between(source: string, first: string, second: string): string {
  const from = source.indexOf(first);
  expect(from, `not found: ${first}`).toBeGreaterThan(-1);
  const to = source.indexOf(second, from);
  expect(to, `${second} does not follow ${first}`).toBeGreaterThan(from);
  return source.slice(from + first.length, to);
}

/** Asserts `first` appears before `second`, with both present. */
function precedes(source: string, first: string, second: string) {
  const a = source.indexOf(first);
  const b = source.indexOf(second);
  expect(a, `not found: ${first}`).toBeGreaterThan(-1);
  expect(b, `not found: ${second}`).toBeGreaterThan(-1);
  expect(a, `${first} must come before ${second}`).toBeLessThan(b);
}

/**
 * The slices, computed on first use rather than at module load.
 *
 * `bodyOf` and `between` assert their anchors exist, so slicing at module scope turns
 * one renamed declaration into a COLLECTION error: the file never loads, no test in
 * it reports, and the other forty-odd invariants silently stop being checked at the
 * exact moment one of them broke. Lazily, the failure lands on the tests that depend
 * on that anchor and every other assertion here still runs.
 */
const lazy = <T>(compute: () => T): (() => T) => {
  let held: { value: T } | null = null;
  return () => (held ??= { value: compute() }).value;
};

/**
 * The guest file-open handler.
 *
 * Anchored on `openFile`, not on the `onOpenPdfFile` change handler that used to
 * hold this code: Phase 5 split the two so a handed-off tool result can be opened
 * without a file input, and `onOpenPdfFile` is now four lines that clear the input
 * and delegate. The anchor moved with the logic — every invariant below is about
 * the function that replaces the document, wherever the DOM calls it from.
 */
const openLocalFile = lazy(() => bodyOf(workspace, "const openFile = async ("));
/** The workspace document load, from its fetch to the end of the success block. */
const workspaceLoad = lazy(() =>
  between(
    workspace,
    "await loadWorkspaceDocument(source, controller.signal)",
    'setPhase("ready")',
  ),
);
const captureFn = lazy(() => bodyOf(workspace, "const capture = () =>"));
const applyRestore = lazy(() => bodyOf(workspace, "const applyRestoredDraft = async ("));
const conflictHandler = lazy(() => bodyOf(workspace, "const onConflictAction = async ("));
const recoveryHandler = lazy(() => bodyOf(workspace, "const onRecoveryAction = async ("));
const startBlank = lazy(() => bodyOf(workspace, "const startBlankDocument = () =>"));

describe("the editor is actually connected to persistence", () => {
  it("mounts the hook", () => {
    /*
     * The assertion that would have failed for the entire life of the subsystem.
     * Everything else in this file is downstream of it.
     */
    expect(workspace).toContain("useDocumentPersistence({");
    expect(workspaceSource).toContain(
      'import { useDocumentPersistence } from "@/hooks/editor/useDocumentPersistence"',
    );
  });

  it("reaches the capture, the restore and the identity policy it was built with", () => {
    // Each of these had a complete unit suite and no product caller.
    expect(workspace).toContain("captureEditorDocument({");
    expect(workspace).toContain("restoreBackgrounds({");
    expect(workspace).toContain("identifyGuestDocument({");
    expect(workspace).toContain("describeWorkspaceDocument({");
  });

  it("takes the origin from the document prop, not from the identity", () => {
    /*
     * The runtime is built on the first render, when nothing has loaded and the
     * identity is null. A workspace editor that inferred "guest" from that would get
     * a local-only runtime: no transport, no cloud save, and no error anywhere saying
     * the workspace was never written to.
     */
    expect(workspace).toContain('const origin: "guest" | "workspace" = source ? "workspace" : "guest"');
    expect(workspace).not.toContain('identity?.origin ?? "guest"');
  });

  it("does not invent an ETag the content route never sent", () => {
    // A fabricated precondition is worse than none: it would make the server's
    // concurrency check pass against a value that describes nothing.
    expect(workspace).toContain("etag: null");
  });
});

describe("the capture interlock", () => {
  it("refuses unless the content on screen is the content the identity names", () => {
    expect(captureFn()).toContain("shouldCaptureDocument({");
    expect(captureFn()).toContain("loadedKey: loadedKeyRef.current");
    expect(captureFn()).toContain("openKey: identity?.documentKey ?? null");
    // Refusing must come FIRST. A capture built and then discarded would still have
    // serialised the wrong document, and the guard would be decoration.
    precedes(captureFn(), "shouldCaptureDocument({", "captureEditorDocument({");
    expect(captureFn()).toContain("return null;");
  });

  it("never awaits", () => {
    /*
     * The scheduler stamps the write with the revision it read BEFORE calling this.
     * A capture that yielded would file the document under a revision the user has
     * already edited past, and those edits would never be written.
     */
    expect(captureFn()).not.toContain("await");
    expect(workspace).not.toContain("const capture = async (");
  });

  it("is re-created every render rather than memoised", () => {
    /*
     * The hook re-registers the capture on every render precisely so the scheduler
     * serialises what is on screen now. A `useCallback` here freezes the closure for
     * as long as its dependencies hold — autosaving a stale document while reporting
     * the write as durable, which is a FALSE SAFE.
     */
    expect(workspace).toContain("const capture = () =>");
    expect(workspace).not.toContain("const capture = useCallback(");
    expect(workspace).not.toContain("const capture = useMemo(");
  });

  it("keys the interlock on a ref, because state is a render behind", () => {
    // A load replaces the content and the identity in one tick, and the scheduler's
    // timer can fire before the re-render that carries the new state.
    expect(workspace).toContain("const loadedKeyRef = useRef<string | null>(null)");
  });
});

describe("opening a local file", () => {
  it("flushes the outgoing document before its content is replaced", () => {
    /*
     * `closeDocument` cancels the schedulers rather than flushing them, so whatever
     * had not been written when the identity changes is dropped. This is the only
     * moment the outgoing document is both open and still on screen.
     */
    expect(openLocalFile()).toContain("await flushBeforeReplace()");
    precedes(openLocalFile(), "await flushBeforeReplace()", "actions.loadState(loaded.state)");
  });

  it("does not replace the content on a bare flush whose verdict it ignores", () => {
    /*
     * THE DEFECT THIS REPLACED. `await persistence.saveNow()` resolves for four
     * reasons that are not "the work is safe" — see `nextReplaceFlushStep` — and the
     * widest is `failed`: the revision is RE-QUEUED for the retry the status bar is
     * offering, and then this path runs `closeDocument`, which discards the queue.
     * The work is gone, the retry has nothing to retry, and nothing said a word.
     *
     * So the call must go through the guard, which reads the verdict and acts on it.
     */
    expect(openLocalFile()).not.toContain("await persistence.saveNow()");
    expect(openLocalFile()).not.toContain("await persistenceRef.current.saveNow()");
  });

  it("flushes only after the new file parsed, so a failed open costs nothing", () => {
    // A flush before the parse would be work done for an open that may never happen;
    // worse, clearing the identity there would unprotect a document that is intact.
    precedes(openLocalFile(), "await loadPdfIntoEditor(file, { onProgress: setLocalLoad })", "await flushBeforeReplace()");
  });

  it("reports work it could not save, after the new content is on screen", () => {
    // A banner about the document that just closed must not be what the user reads
    // while still wondering whether the open worked.
    expect(openLocalFile()).toContain("if (unsaved !== null) setNotice(unsaved)");
    precedes(openLocalFile(), "actions.loadState(loaded.state)", "setNotice(unsaved)");
  });

  it("sets the interlock in the same tick as the content it describes", () => {
    const gap = between(
      openLocalFile(),
      "loadedKeyRef.current = identified.identity.documentKey;",
      "actions.loadState(loaded.state);",
    );
    // Anything awaited here is a window in which the scheduler sees the interlock
    // and the content disagree.
    expect(gap).not.toContain("await");
    expect(gap.trim()).toBe("");
  });

  it("arms the autosave last, after the document is really in the editor", () => {
    /*
     * `captureEditorDocument` returns a perfectly valid document for the editor's
     * default blank page. An identity set before the content landed would commit that
     * blank page as this document's draft, and the next crash would offer to
     * "recover" it over the user's real work.
     */
    precedes(openLocalFile(), "actions.loadState(loaded.state)", "setIdentity(identified.identity)");
  });

  it("derives the id from the file, so reopening it continues its draft", () => {
    expect(openLocalFile()).toContain("identifyGuestDocument({");
    expect(openLocalFile()).toContain("bytes: loaded.sourceBytes");
    // Not a fresh id per open: that would orphan the draft the last session left and
    // grow a second, parallel history of the same document.
    expect(openLocalFile()).not.toContain("newId: () =>");
    expect(openLocalFile()).toContain("newId: nextId");
  });

  it("reports whether the id could be remembered at all", () => {
    // Private modes and some webviews refuse sessionStorage. The document still
    // opens; the user is told the recovery is only good for this tab.
    expect(openLocalFile()).toContain("setGuestIdentityPersisted(identified.persisted)");
  });
});

describe("loading a workspace document", () => {
  it("flushes the document being replaced", () => {
    // Switching tabs in the workbench mounts one editor against a second document.
    expect(workspaceLoad()).toContain("await flushBeforeReplaceRef.current()");
    precedes(workspaceLoad(), "flushBeforeReplaceRef.current()", "actions.loadState(loaded.state)");
  });

  it("does not replace the content on a bare flush whose verdict it ignores", () => {
    // Same defect as the local-open path, and worse here: a workbench tab switch is
    // the routine way this runs, so a transient write failure loses work on a
    // gesture users make all day.
    expect(workspaceLoad()).not.toContain("saveNow()");
  });

  it("reads the flush and the identity through refs, not the effect's closure", () => {
    /*
     * The load effect is keyed on `sourceKey` and captures the render it was created
     * in. Reading `persistence` or `identity` from that closure after several awaits
     * would flush through a binding from a previous document — so the guard is
     * reached through a ref, and the guard itself reads both through refs.
     */
    expect(workspaceLoad()).toContain("flushBeforeReplaceRef.current()");
    expect(workspaceLoad()).not.toContain("if (identity !== null)");
    const guard = bodyOf(workspace, "const flushBeforeReplace = async (");
    expect(guard).toContain("identityRef.current === null");
    expect(guard).toContain("persistenceRef.current.saveNow()");
    expect(guard).toContain("persistenceRef.current.canNavigate()");
    expect(guard).not.toContain("persistence.saveNow()");
  });

  it("cannot spin forever on a document that will never flush", () => {
    /*
     * THE HAZARD OF THIS SHAPE. The guard retries in an unbounded `for (;;)` whose
     * only exits are its two returns, and `nextReplaceFlushStep` is what decides when
     * one is reached. `replaceGuard.test.ts` proves the policy stops asking for
     * retries — but a policy with green tests whose consumer never reads the value
     * that stops it is a hang, not a save: every attempt calls `saveNow()`, so a
     * remote that stays down would loop on the network with the editor mid-replace.
     *
     * So both terminating branches are pinned here, in the consumer.
     */
    const guard = bodyOf(workspace, "const flushBeforeReplace = async (");
    expect(guard).toContain("nextReplaceFlushStep(");
    // The one the loop takes when the work is safe, and the one it takes when the
    // attempts are spent. Delete either and the remaining exit is unreachable.
    expect(guard).toContain('if (step === "replace") return null;');
    expect(guard).toContain('if (step === "warn_and_replace")');
    // The counter the policy compares against must actually advance.
    expect(guard).toContain("attemptsSpent += 1");
    expect(guard).toContain("attemptsSpent }");
  });

  it("does not silently drop work made before any identity existed", () => {
    /*
     * With no identity there is nothing to flush and nowhere to flush it, which is
     * correct for an ordinary first load — and a loss the moment the user has already
     * put something on the blank page while their document was being fetched. The
     * toolbar renders during the load phases and `useShortcuts` binds unconditionally,
     * so a paste reaches the editor through a window listener no overlay covers.
     *
     * `loadState` then replaces those objects with the fetched document's.
     */
    const guard = bodyOf(workspace, "const flushBeforeReplace = async (");
    expect(guard).toContain("hasUnidentifiedWork({ identityPresent: false, objectCount })");
    expect(guard).toContain("describeUnsavedReplace({ documentName: null, reason: null })");
  });

  it("counts stray work on every page, not just the one on screen", () => {
    // Paste, then scroll: the objects are on whichever page was current at the time.
    // Counting one page reports "nothing to lose" while discarding the rest.
    const guard = bodyOf(workspace, "const flushBeforeReplace = async (");
    // The whole statement, not a prefix of it: `[Object.values(...)[0]]` contains the
    // prefix and counts one page.
    expect(guard).toContain("const pages = Object.values(service.getState().document.pages);");
    expect(guard).toContain("pages.reduce(");
    expect(guard).toContain("Object.keys(page.objects).length");
  });

  it("spends its attempts on saving, not on re-asking a stale verdict", () => {
    // A retry that re-reads the verdict without flushing again would burn the budget
    // in one tick and warn about work that a second write would have saved.
    precedes(
      bodyOf(workspace, "const flushBeforeReplace = async ("),
      "await persistenceRef.current.saveNow();",
      "persistenceRef.current.canNavigate()",
    );
  });

  it("reports work it could not save, after the new content is on screen", () => {
    expect(workspaceLoad()).toContain("if (unsaved !== null) setNotice(unsaved)");
    precedes(workspaceLoad(), "actions.loadState(loaded.state)", "setNotice(unsaved)");
  });

  it("sets the interlock in the same tick as the content", () => {
    /*
     * The content arrives through one of TWO calls since Phase 3: a version saved
     * from an editing session is reopened through the canonical codec, and only an
     * imported version (which has no stored scene) is seeded from the PDF. So the
     * anchor is the branch rather than one of its arms. What must hold is unchanged —
     * nothing awaits between the interlock and the content it describes.
     */
    const gap = between(
      workspaceLoad(),
      "loadedKeyRef.current = workspaceIdentity.documentKey;",
      "if (loaded.scene !== null) actions.deserialize(loaded.scene);",
    );
    expect(gap).not.toContain("await");
    expect(gap.trim()).toBe("");
    // The other arm is the immediate `else`, not a second statement further down.
    expect(workspaceLoad()).toMatch(
      /if \(loaded\.scene !== null\) actions\.deserialize\(loaded\.scene\);\s*else actions\.loadState\(loaded\.state\);/,
    );
  });

  it("arms the autosave last, and records the revision it must not overwrite", () => {
    precedes(workspaceLoad(), "actions.loadState(loaded.state)", "setIdentity(workspaceIdentity)");
    /*
     * The document RECORD REVISION, which is what the server's compare-and-swap
     * compares against — not `loaded.versionNumber`, which is the user-visible
     * version count. They agree on a freshly imported document and diverge for good
     * after the first rename, favourite or move, because those advance the revision
     * and publish no version. Seeding the version number here meant the editor's
     * next autosave fenced against a stale revision and conflicted with its own
     * publish, so this assertion names the field rather than "the version".
     */
    expect(workspaceLoad()).toContain("setServerVersion(loaded.documentRevision)");
    expect(workspaceLoad()).not.toContain("setServerVersion(loaded.versionNumber)");
    // The version number is still read — it goes out to the chrome for display, and
    // nowhere near the fence. Both numbers are used; neither is used as the other.
    expect(workspaceLoad()).toContain("versionNumber: loaded.versionNumber,");
  });
});

describe("restoring a recovered draft", () => {
  it("applies the draft's own scene", () => {
    expect(applyRestore()).toContain("actions.deserialize(draft.scene)");
  });

  it("never reloads the source PDF as the document", () => {
    /*
     * `loadPdfIntoEditor` mints fresh page ids and returns its own state. Restoring
     * through it gives the user either a document of white pages (every background
     * key missing) or the file as it sits on disk with every edit silently gone —
     * and the second is indistinguishable, on screen, from a successful recovery.
     */
    expect(applyRestore()).not.toContain("loadPdfIntoEditor");
    expect(applyRestore()).not.toContain("actions.loadState(");
  });

  it("rebuilds only the page images, keyed on the pinned source index", () => {
    expect(applyRestore()).toContain("restoreBackgrounds({");
    expect(applyRestore()).toContain("pages: plan.pages");
    // No source bytes, or an unopenable PDF, still restores: the scene is the
    // document, and blank images are recoverable where lost edits are not.
    expect(applyRestore()).toContain("assembleRestoredBackgrounds(plan.pages, new Map())");
  });

  it("does not bracket the load a second time", () => {
    /*
     * `restoreOfferedDraft` already wraps this callback in `beginLoad`/`endLoad` and
     * adopts the revision it returns. A second bracket leaves the revision bridge
     * unbalanced for the rest of the session, which quietly stops every later
     * mutation from being counted.
     */
    expect(applyRestore()).not.toContain("beginLoad");
    expect(applyRestore()).not.toContain("endLoad");
  });

  it("returns the LIVE revision, read after the awaits", () => {
    /*
     * `revision` from the render's closure is the value from before the deserialize.
     * Baselining there leaves the coordinator believing the restore itself is an
     * unsaved change — forever, because nothing ever reaches that revision again.
     */
    expect(applyRestore()).toContain("historyRevision: service.revision");
    expect(applyRestore()).not.toContain("historyRevision: revision");
  });

  it("states the caveat rather than calling a partial recovery a full one", () => {
    expect(applyRestore()).toContain("describeRestoreResult({");
    expect(applyRestore()).toContain("complete: plan.caveat === null");
    expect(applyRestore()).toContain("unrenderedPageCount: unrendered");
  });

  it("keeps the draft on disk when the user declines it", () => {
    /*
     * Declining once is not a decision to destroy the only copy of the work. Only
     * `delete_draft` deletes, and a FAILED restore must not delete either.
     */
    expect(recoveryHandler()).toContain("persistence.dismissOffer()");
    const deleteBranch = between(recoveryHandler(), 'action === "delete_draft"', "return;");
    expect(deleteBranch).toContain("persistence.deleteOffer()");
    const restoreBranch = between(recoveryHandler(), 'action === "restore_draft"', "return;");
    expect(restoreBranch).not.toContain("deleteOffer");
  });
});

describe("the abandoned-draft probe — the guest refresh path", () => {
  it("is reached from the surface, which is the only thing that can reach it", () => {
    /*
     * A refreshed guest tab has no file, no fingerprint and possibly no session
     * identity map, so the ordinary probe inside `openDocument` has no key to look
     * under. Without this call the draft sits in IndexedDB, complete and
     * unreachable, and the entire guest recovery path is dead code with a green
     * unit suite.
     */
    expect(workspace).toContain("shouldProbeAbandonedGuestDraft({");
    expect(workspace).toContain("persistenceRef.current.findAbandonedGuestDraft()");
  });

  it("opens the recovered identity WITHOUT loading any content", () => {
    /*
     * The open is what raises the offer; the interlock is what stops the empty editor
     * from being captured over the draft while the offer is unanswered. Loading the
     * draft here instead would restore it without ever asking.
     */
    const probe = between(workspace, "shouldProbeAbandonedGuestDraft({", "}, [origin]);");
    expect(probe).toContain("setIdentity(found)");
    expect(probe).not.toContain("loadedKeyRef.current =");
    expect(probe).not.toContain("actions.deserialize");
    expect(probe).not.toContain("setBackgrounds");
  });

  it("is silent when there is nothing to offer", () => {
    const probe = between(workspace, "shouldProbeAbandonedGuestDraft({", "}, [origin]);");
    expect(probe).toContain("if (found === null) return;");
    // Most tabs have nothing abandoned. A "nothing to recover" message on every load
    // is how a user learns to ignore the one that matters.
    expect(probe).not.toContain("setNotice(");
  });

  it("does not re-probe once a document is open", () => {
    // Re-probing after the user opens a file would offer a draft from a DIFFERENT
    // document while they are working on this one.
    expect(workspace).toContain("hasOpenDocument: identityRef.current !== null");
    expect(workspace).toContain("alreadyProbed: probedRef.current");
    expect(workspace).toContain("}, [origin]);");
  });
});

describe("the conflict dialog's actions all have a home", () => {
  it("handles every action the presentation can offer", () => {
    /*
     * `resolveConflict` owns exactly one of these and returns `not_owned` for the
     * rest rather than swallowing them — so a forgotten action is a button that
     * visibly does nothing. These are the rest, and each needs a branch here.
     */
    for (const action of [
      "save_local_copy",
      "review_workspace",
      "duplicate_as_new",
      "replace_workspace",
      "cancel",
    ]) {
      expect(conflictHandler(), `no branch for ${action}`).toContain(`action === "${action}"`);
    }
  });

  it("offers a file on disk first, and does not need a workspace to do it", () => {
    const branch = between(conflictHandler(), 'action === "save_local_copy"', "return;");
    expect(branch).toContain("exportEditorPdf(");
    expect(branch).toContain("downloadBytes(");
    // The one outcome no server, lock or other tab can take back. Gating it on the
    // workspace being reachable would withhold it exactly when it matters.
    expect(branch).not.toContain("if (!source)");
  });

  it("opens the workspace version in a NEW tab", () => {
    /*
     * Navigating away from here closes the local version — the thing the user has not
     * decided about yet — in order to look at the other one.
     */
    // Bounded by the NEXT branch rather than the next `return`: this one opens with
    // a `if (!source) return;` guard, which the narrower slice would stop at.
    const branch = between(
      conflictHandler(),
      'action === "review_workspace"',
      'action === "duplicate_as_new"',
    );
    expect(branch).toContain("window.open(");
    expect(branch).toContain('"_blank"');
    expect(branch).not.toContain("router.push");
    expect(branch).not.toContain("location.href");
  });

  it("only clears the conflict when a real second document was created", () => {
    /*
     * The upload route DEDUPLICATES by content and can resolve onto an existing
     * document — possibly the very one in conflict. Assuming a copy was made would
     * dismiss the conflict having changed nothing.
     */
    const branch = between(conflictHandler(), 'action === "duplicate_as_new"', "return;");
    expect(branch).toContain("if (outcome.resolved) setConflictClosedKey(conflictKey)");
    expect(workspace).toContain("describeDuplicateOutcome({");
    expect(workspace).toContain("deduplicated: payload.deduplicated === true");
  });

  it("passes the user's confirmation through instead of asserting it", () => {
    /*
     * The coordinator refuses `replace_workspace` without `confirmed`. Hard-coding
     * `true` here would turn that gate into a formality and let one stray click
     * overwrite a version nobody has read.
     */
    expect(conflictHandler()).toContain("confirmed: options?.confirmed === true");
    expect(conflictHandler()).not.toContain("confirmed: true");
  });

  it("never reports a replace that did not happen", () => {
    const branch = between(conflictHandler(), 'action === "replace_workspace"', "setConflictError(");
    expect(branch).toContain('resolution.kind === "replaced"');
    // A second writer between the check and the write leaves the dialog up with the
    // new facts rather than a success message.
    expect(conflictHandler()).toContain('resolution.kind === "still_conflicted"');
    expect(branch).toContain("setServerVersion(resolution.serverVersion)");
  });

  it("treats Cancel as closing the dialog, not resolving the conflict", () => {
    /*
     * A conflict that vanished when dismissed would leave this tab quietly diverged
     * from the workspace with nothing on screen saying so.
     */
    const branch = between(conflictHandler(), 'action === "cancel"', "return;");
    expect(branch).toContain("setConflictClosedKey(conflictKey)");
    expect(branch).not.toContain("resolveConflict");
    expect(branch).not.toContain("dismiss");
  });

  it("keys the dismissal on the conflict, so a fresh one is raised again", () => {
    expect(workspace).toContain("conflictView.local.revision");
    expect(workspace).toContain("conflictKey !== conflictClosedKey");
  });

  it("hides the workspace-side actions when there is no workspace", () => {
    expect(workspace).toContain("workspaceKnown={source !== null}");
    expect(conflictDialog).toContain("visibleConflictActions(conflict.actions, { workspaceKnown })");
    // Rendering `conflict.actions` directly would offer "Open the workspace version"
    // on a surface that has no workspace to open.
    expect(conflictDialog).not.toContain("conflict.actions.map(");
  });
});

describe("what the user can see", () => {
  it("renders the save-status readout in the status bar", () => {
    expect(workspace).toContain("<SaveStatusIndicator");
    expect(workspace).toContain("trailing={");
    // Never during the server render or on a disabled surface: a readout with nothing
    // behind it still looks like a claim about the user's work.
    expect(workspace).toContain("persistence.view !== null ? (");
    expect(workspace).toContain("status={persistence.view.status}");
    expect(workspace).toContain("breakdown={persistence.view.breakdown}");
  });

  it("gives the trailing slot the margin instead of adding a spacer element", () => {
    /*
     * An empty flex child still consumes the row's `gap`, which would shift every
     * readout to its left. The margin goes on the wrapper that only exists when
     * there is something to put in it.
     */
    expect(statusBar).toContain('<div className="ml-auto flex items-center">{trailing}</div>');
  });

  it("banners only the limitation that means nothing is being saved", () => {
    /*
     * A tab that cannot take the cross-tab lock, or cannot hear its peers, still
     * saves the document. A tab with no store does not. Four stacked alerts over an
     * editor teach a user to dismiss alerts — and then the one that mattered goes
     * with them.
     */
    expect(workspace).toContain("const blockedBy = blockingLimitation(persistence.limitations)");
    expect(workspace).toContain("limitations={secondaryLimitations(persistence.limitations)}");
  });

  it("does not dress good news as an error", () => {
    /*
     * `notice` is styled as a failure because everything else that uses it is one.
     * "Your unsaved work is back", in that red band, reads as a problem to the person
     * least able to afford ambiguity about it.
     */
    const good = between(workspace, "{persistenceNotice !== null ? (", "Dismiss");
    expect(good).toContain('role="status"');
    expect(good).toContain("emerald");
    expect(good).not.toContain('role="alert"');
    // And dismissing it tells the coordinator, so "Recovered" does not stick to the
    // document for the rest of the session in a second place that cannot be closed.
    expect(workspace).toContain("persistence.acknowledgeRecovery()");
  });

  it("surfaces a guest identity that could not be stored", () => {
    expect(workspace).toContain("identityNotice={guestIdentityNotice({");
  });

  it("mounts both dialogs", () => {
    expect(workspace).toContain("<RecoveryPromptDialog");
    expect(workspace).toContain("<ConflictDialog");
    expect(workspace).toContain("prompt={recoveryOffer}");
    expect(workspace).toContain("conflict={conflictView}");
  });

  it("offers the way back to a conflict the user closed", () => {
    // Without this, closing the dialog is the same as losing the choice.
    expect(workspace).toContain("conflictView !== null ? () => setConflictClosedKey(null) : undefined");
  });
});

describe("the dialogs cannot be dismissed past a decision", () => {
  it("gives a required choice no escape hatch at all", () => {
    /*
     * `requiresChoice` means the draft is NEWER than what is on screen. An Escape, an
     * outside click or a stray X there discards the newer work by default —
     * "Open the saved version" is the explicit no-thanks, and it is a button.
     */
    // The Escape handler installs itself only for the non-blocking case...
    expect(recoveryDialog).toContain("if (prompt.requiresChoice) return;");
    // ...and the Dismiss button only renders for it.
    expect(recoveryDialog).toContain("{!prompt.requiresChoice ? (");
    // A focus trap, so Tab cannot leave the decision behind either.
    expect(recoveryDialog).toContain("if (!prompt.requiresChoice) return;");
  });

  it("filters the details action out of the button row instead of skipping it inside", () => {
    /*
     * Returning null from inside the map is the bug that was written here first: the
     * primary-button index and the autofocus ref then land on the wrong element, so
     * the focused button is not the one the layout calls primary.
     */
    expect(recoveryDialog).toContain('prompt.actions.filter((action) => action.id !== "review_details")');
    expect(recoveryDialog).not.toContain("if (action.id === \"review_details\") return null;");
  });

  it("narrates arrivals and failures without narrating every keystroke", () => {
    /*
     * `unsaved` changes on every keystroke. A live region carrying it reads the whole
     * document aloud as it is typed, and a screen-reader user turns the region off —
     * losing the announcements that mattered.
     */
    expect(indicator).toContain('{status.announce ? status.detail : ""}');
    expect(indicator).toContain('aria-live="polite"');
  });
});

describe("starting from a blank page", () => {
  /*
   * The standalone shell's "Create blank PDF" loads nothing: the editor's default A4
   * page IS the document and the click only dismisses the onboarding overlay. So this
   * path has no load to arm persistence from, and for the whole life of the feature it
   * had no identity either — a visitor could annotate a blank page for an hour with
   * nothing stored, while the save readout sat in the status bar honestly reporting
   * "No document is open."
   *
   * MUTATION-CHECKED against the source these read: reverting the guard to
   * `identityRef` fails 2, and hard-coding `forceNewIdentity: false` fails 1. Both
   * mutations were also run against the browser probe on a production build, where
   * they fail 3 checks each — the pairing this file exists to keep honest, because
   * before the fix the assertion below pinned the buggy guard and stayed green.
   */
  it("is offered to the shell and taken by it", () => {
    expect(workspace).toContain("startBlankDocument,");
    expect(shellCode).toContain("handleRef.current?.startBlankDocument()");
  });

  it("identifies the blank page by name, since it has no bytes to sample", () => {
    expect(startBlank()).toContain("identifyGuestDocument({");
    expect(startBlank()).toContain("bytes: null");
    expect(startBlank()).toContain("newId: nextId");
  });

  it("sets the interlock before the identity, with nothing awaited between", () => {
    // Same rule as both load paths, and cheaper to keep here: there is no content to
    // load, so the whole function is synchronous and must stay that way.
    expect(startBlank()).not.toContain("await");
    precedes(
      startBlank(),
      "loadedKeyRef.current = identified.identity.documentKey",
      "setIdentity(identified.identity)",
    );
  });

  it("touches no content, because the content is already on screen", () => {
    // Loading anything here would replace the page the visitor just chose to keep.
    expect(startBlank()).not.toContain("actions.loadState");
    expect(startBlank()).not.toContain("setBackgrounds");
    expect(startBlank()).not.toContain("loadPdfIntoEditor");
  });

  it("refuses to replace a document whose content is on screen", () => {
    /*
     * Reachable from a shell rather than from a load, so nothing upstream guarantees
     * the editor is empty. Replacing a live document would orphan its draft and start
     * a second history of the same work.
     *
     * `loadedKeyRef` and not `identityRef`, because those are not the same question.
     * Every path that puts content on screen sets `loadedKeyRef`; the abandoned-draft
     * probe deliberately sets an identity with NO content, so it can raise the
     * recovery offer without capturing over the draft it is offering.
     */
    expect(startBlank()).toContain("if (loadedKeyRef.current !== null) return;");
  });

  it("is not blocked by an identity that has no content behind it", () => {
    /*
     * THE REGRESSION THIS FILE ONCE PROTECTED. This assertion previously read
     * `identityRef`, and that guard was a silent data-loss path: after the user
     * answered the probe's offer by dismissing or deleting it, `loadedKeyRef` was
     * still null, so the capture interlock refused every write — and "Create blank
     * PDF" refused to repair it because an identity existed. The editor stayed fully
     * usable and saved NOTHING for the rest of the mount. Found against a production
     * build, not in this suite, which was green throughout and is why the assertion
     * is spelled out negatively here too.
     */
    expect(startBlank()).not.toContain("if (identityRef.current !== null) return;");
  });

  it("re-keys the tab when it is escaping a declined draft, and only then", () => {
    /*
     * Reusing the key would make the blank page the newest generation of the draft
     * the user just declined, so a later restore would read the blank bytes and their
     * work would sit one generation behind. A fresh id leaves that draft byte-
     * identical and still findable. Pinned as an exact expression because the two
     * halves matter separately: `true` always would break the ordinary first blank
     * page (a reload could no longer continue it), and `false` always is the data-loss
     * case above.
     */
    expect(startBlank()).toContain("forceNewIdentity: identityRef.current !== null,");
  });

  it("clears the stale offer's notice rather than leaving it over the new document", () => {
    // The re-key opens a different document, so anything the previous identity put on
    // screen — a guest-storage warning, a server version — is no longer about what the
    // user is looking at.
    expect(startBlank()).toContain("setPersistenceNotice(null)");
    expect(startBlank()).toContain("setServerVersion(null)");
  });
});

describe("the comments do not contradict the code", () => {
  it("no longer claims the application has no autosave", () => {
    /*
     * Both surfaces documented their export indicator as the only evidence work had
     * left the tab, "because there is no autosave". That is now false, and a false
     * comment in a data-safety path is how the next reader deletes something load
     * bearing while believing they are removing dead weight.
     */
    expect(workspaceSource).not.toContain("no autosave in this application");
    expect(shell).not.toContain("no autosave to consult");
  });
});
