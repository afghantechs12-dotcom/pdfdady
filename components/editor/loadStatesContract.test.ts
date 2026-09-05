import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural contracts for the Phase J loading/error surfaces.
 *
 * Vitest runs in a Node environment here: there is no DOM, no layout engine and
 * no React renderer, so these read the source. That is an honest method for the
 * three claims below — each is a property of what the component *says*, not of
 * how a browser lays it out:
 *
 *   1. reduced motion is actually declared next to every animation;
 *   2. the error panel has no channel through which a raw exception could reach
 *      the screen;
 *   3. the editor's loading surfaces use editor tokens, not app tokens.
 *
 * Geometry, focus order and real interaction are verified in a browser by
 * `scripts/editor-load-states-probe.mjs`. These tests deliberately do not
 * pretend otherwise.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), "utf8");

/**
 * Source with comments removed.
 *
 * Needed because these tests assert things about CODE, and a comment that merely
 * *mentions* `setPersisted` would otherwise satisfy — or break — an invariant
 * check. The first run of the watermark test failed on its own explanatory
 * comment, which is exactly the false signal this strips out.
 */
const readCode = (relative: string) =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const LOADING_OVERLAY = "components/editor/DocumentLoadingOverlay.tsx";
const ERROR_PANEL = "components/editor/DocumentErrorPanel.tsx";
const ERROR_BOUNDARY = "components/editor/EditorErrorBoundary.tsx";
const ROUTE_ERROR = "app/editor/error.tsx";
const WORKSPACE = "components/editor/EditorWorkspace.tsx";
const PRIMITIVES = "components/app/primitives.tsx";

describe("reduced motion", () => {
  /**
   * Every animation utility must be paired with its reduced-motion opt-out.
   *
   * Tailwind's `motion-reduce:` variant compiles in this repository, and the
   * homepage's bespoke reduced-motion CSS block does NOT cover generic
   * `animate-spin`/`animate-pulse` on editor surfaces — so relying on it would
   * be a reduced-motion claim with no implementation behind it.
   */
  const ANIMATED = [LOADING_OVERLAY, ERROR_PANEL, ERROR_BOUNDARY, ROUTE_ERROR, WORKSPACE, PRIMITIVES];

  it("pairs every animate-pulse / animate-spin with motion-reduce:animate-none", () => {
    for (const file of ANIMATED) {
      // Comment-stripped, and for the same reason the watermark test is: these
      // files EXPLAIN their reduced-motion policy in prose, so a doc comment
      // naming `motion-reduce:animate-none` was being counted as an opt-out. That
      // phantom credit let a real opt-out be deleted from a live class list with
      // the ratio still balancing — the mutation test that removed one from
      // DocumentLoadingOverlay's first placeholder line passed, which is the
      // definition of a guard that does not guard.
      const source = readCode(file);
      // Count animation utilities inside class strings, then require at least as
      // many opt-outs. Class lists are authored one-per-element here, so a new
      // animated element without an opt-out lowers the ratio and fails.
      const animations = source.match(/animate-(pulse|spin)\b/g) ?? [];
      const optOuts = source.match(/motion-reduce:animate-none/g) ?? [];
      expect(
        optOuts.length,
        `${file} has ${animations.length} animation(s) but ${optOuts.length} motion-reduce opt-out(s)`,
      ).toBeGreaterThanOrEqual(animations.length);
    }
  });

  it("repairs the Skeleton primitive's reduced-motion claim", () => {
    // The comment used to promise reduced-motion support that no utility in the
    // class list provided. Comment-stripped for that exact reason: the repaired
    // comment now NAMES both utilities, so reading raw source here would pass on
    // the prose even if the class list were emptied again.
    const source = readCode(PRIMITIVES);
    const skeleton = source.slice(source.indexOf("export function Skeleton"));
    expect(skeleton).toContain("animate-pulse");
    expect(skeleton).toContain("motion-reduce:animate-none");
  });
});

describe("DocumentErrorPanel", () => {
  const source = read(ERROR_PANEL);

  it("renders only presentation-authored copy, with no detail or message channel", () => {
    // The panel's props are `presentation`, `onAction` and `secondary`. There is
    // no `detail`/`message`/`error` prop, so a raw exception cannot be routed to
    // it — the safety is a property of the type, not a rule to remember.
    expect(source).not.toMatch(/\bdetail\s*[?:]/);
    expect(source).not.toMatch(/error\.message|err\.message|String\(error\)/);
    expect(source).toContain("presentation.heading");
    expect(source).toContain("presentation.description");
  });

  it("moves focus once per distinct failure rather than on every render", () => {
    // Re-stealing focus on rerender would yank it away from a user who has
    // tabbed to Retry.
    expect(source).toContain("headingRef.current?.focus()");
    expect(source).toMatch(/\[presentation\.kind\]/);
  });

  it("makes the heading a focus destination without adding a tab stop", () => {
    expect(source).toContain("tabIndex={-1}");
  });

  it("announces itself as an alert", () => {
    expect(source).toContain('role="alert"');
  });
});

describe("DocumentLoadingOverlay", () => {
  const source = read(LOADING_OVERLAY);

  it("draws a page-shaped sheet rather than a bare centered spinner", () => {
    expect(source).toContain("aspectRatio");
    expect(source).toContain("loadingPageAspect");
    // The page's own visual identity: a white sheet with a border and the
    // editor's page shadow.
    expect(source).toContain("bg-editor-page");
    expect(source).toContain("shadow-page");
    expect(source).toContain("border-editor-border");
  });

  it("uses editor tokens, never app tokens", () => {
    // App-token leakage into the editor is how two design systems become one
    // inconsistent one.
    expect(source).not.toMatch(/\b(bg|text|border)-app-/);
  });

  it("stays out of the live-region contract while it holds no control", () => {
    // The single load announcement lives in EditorWorkspace; a second live
    // region here would compete with it. But an overlay carrying a reachable
    // Retry must not be aria-hidden.
    expect(source).toContain("aria-hidden={showRetry ? undefined : \"true\"}");
  });

  it("keeps its retry bound to a real callback, never a dead button", () => {
    expect(source).toContain("presentation.retry && Boolean(onRetry)");
  });
});

describe("EditorWorkspace load surfaces", () => {
  const source = read(WORKSPACE);

  it("projects the pure logic rather than reimplementing the rules in JSX", () => {
    expect(source).toContain("presentLoad(");
    expect(source).toContain("presentLoadError(");
    expect(source).toContain("loadAnnouncement(");
    expect(source).toContain("loadErrorFacts(");
  });

  it("stores failure EVIDENCE, not a server message", () => {
    // The shipped build kept `loadMessage` and rendered `error.detail ??
    // error.message`, which is how ingestion diagnostics reached the panel.
    expect(source).not.toContain("setLoadMessage");
    expect(source).not.toContain("error.detail");
    expect(source).toContain("setLoadError(loadErrorFacts(");
  });

  it("logs the diagnostic it refuses to render", () => {
    // The server's own words stay available to a developer.
    expect(source).toContain('console.error("Workspace document load failed", error)');
  });

  it("treats an abort as cancellation on every failure path", () => {
    // StrictMode's dev double-invoke and document switching both abort; a
    // failure panel over a healthy load would be the visible bug.
    expect(source).toContain("isAbortError(error)");
  });

  it("keeps exactly one document-load live region", () => {
    const liveRegions = source.match(/aria-live="polite"/g) ?? [];
    // Selection, active tool, and the load announcement — and no more.
    expect(liveRegions.length).toBe(3);
    expect(source).toContain("{loading ? `Opening ${openingFileName}` : announcement}");
  });

  it("does not turn the status bar into a live region", () => {
    // Comment-stripped: StatusBar's own header comment explains that it is NOT a
    // live region and names `role="status"` while doing so.
    const statusBar = readCode("components/editor/StatusBar.tsx");
    expect(statusBar).not.toContain('role="status"');
    expect(statusBar).not.toContain("aria-live");
  });

  it("bounds the pages-rail placeholders", () => {
    expect(source).toContain("placeholderThumbnailCount");
    expect(source).toContain("PagesPanelSkeleton");
  });
});

describe("editor error boundary scope", () => {
  it("exists as a narrow in-tree boundary with a real recovery action", () => {
    const source = read(ERROR_BOUNDARY);
    expect(source).toContain("getDerivedStateFromError");
    expect(source).toContain("componentDidCatch");
    // Loud in the logs: a render crash is a defect, not a user-facing state.
    expect(source).toContain("console.error");
    // And it does not render the crash's message.
    expect(source).not.toMatch(/\{this\.state\.error\.message\}|\{error\.message\}/);
  });

  it("wraps the editor INSIDE the workbench, so app chrome survives a crash", () => {
    const workbench = read("components/workspaces/DocumentWorkbench.tsx");
    expect(workbench).toContain("<EditorErrorBoundary");
    // Both editor mount sites are covered.
    expect((workbench.match(/<EditorErrorBoundary/g) ?? []).length).toBe(2);
  });

  it("adds NO global catch-all", () => {
    // A global boundary would replace the marketing site and every unrelated
    // route with one apologetic card, hiding real defects.
    let globalError = true;
    try {
      read("app/global-error.tsx");
    } catch {
      globalError = false;
    }
    expect(globalError, "app/global-error.tsx must not exist").toBe(false);

    let rootError = true;
    try {
      read("app/error.tsx");
    } catch {
      rootError = false;
    }
    expect(rootError, "app/error.tsx must not exist").toBe(false);
  });

  it("scopes the route boundary to /editor only", () => {
    const source = read(ROUTE_ERROR);
    expect(source).toContain('"use client"');
    // Next's real segment remount, not a cosmetic dismissal.
    expect(source).toContain("reset");
    expect(source).toContain("console.error");
  });
});

describe("standalone save failure", () => {
  const source = read("components/editor/StandaloneEditorShell.tsx");

  it("offers a real Retry that reuses the same save path", () => {
    // One persistence implementation, one watermark rule.
    expect(source).toContain("onClick={onSaveToWorkspace}");
    expect(source).toContain("Retry");
  });

  it("cannot start a concurrent retry", () => {
    // "One click, one retry": a second click during an upload would risk a
    // duplicate document.
    expect(source).toContain('disabled={save.kind !== "error"}');
    expect(source).toContain('if (!saveTarget || !handleRef.current || save.kind === "saving") return');
  });

  it("never claims success, and never orphans the document, on the failure path", () => {
    /*
     * The invariant that matters most, in both of its halves. Structurally, the
     * catch block may not:
     *
     *   - set a `saved` state — a failure that advanced a durability claim is the
     *     one error direction that produces a FALSE SAFE, and
     *   - clear `workspaceDocumentRef` — the retry has to target the SAME
     *     Workspace document, or every failure leaves a duplicate behind.
     *
     * Read from comment-stripped code: the catch block's own explanation names
     * both by name, and matching that would be a test passing on prose.
     */
    const code = readCode("components/editor/StandaloneEditorShell.tsx");
    // Anchored INSIDE the save handler: the file's first `} catch` belongs to the
    // handoff effect, and a slice that drifts there asserts nothing about saving
    // while still passing.
    const saveAt = code.indexOf("const onSaveToWorkspace");
    expect(saveAt).toBeGreaterThan(-1);
    const catchStart = code.indexOf("} catch (error) {", saveAt);
    const catchEnd = code.indexOf("};", catchStart);
    const catchBody = code.slice(catchStart, catchEnd);
    expect(catchStart).toBeGreaterThan(saveAt);
    expect(catchBody.length).toBeGreaterThan(100);
    expect(catchBody).toContain("setSave({");
    expect(catchBody).toContain('kind: "error"');
    expect(catchBody).not.toContain('kind: "saved"');
    expect(catchBody).not.toContain("workspaceDocumentRef.current =");
    /*
     * And there is exactly one place that decides what the save pill says: the
     * shell forwards the canonical status and computes none of its own. The
     * retired `saveIndicator` is what made two answers possible at once.
     */
    expect(code).toContain("onSaveStatusChange={setStatus}");
    expect(code).not.toContain("saveIndicator");
    expect(code).not.toContain("setPersisted");
  });

  it("creates the Workspace document once, then versions THAT document (T11)", () => {
    /*
     * The identity half of the same invariant, on the SUCCESS path. Saving twice
     * in one editing session must update one document: the shell creates a record
     * only while it has none, and every later save is a new version of the id it
     * kept.
     *
     * Pinned here because nothing else could catch it. Deleting the condition —
     * `if (existing === null)` becoming an unconditional create — left all 793
     * editor tests green, while the browser probe found two `Untitled PDF.pdf`
     * records for one session. The Workspace round trip is what makes it visible,
     * and a unit test cannot make that round trip.
     */
    /*
     * The decision now lives in `commitToWorkspace` (Phase 2 closeout), which is
     * where a Node test can drive it directly — see
     * `workspaceCommitWiring.test.ts`. It is still pinned by source text here
     * because the CALL SHAPE is what a refactor breaks silently: the shell must
     * hand over both ports and read the id it holds, not decide for itself.
     */
    const logic = readCode("components/editor/standaloneShellLogic.ts");
    // The id the session already owns is what decides create-vs-version.
    expect(logic).toContain("const existing = ports.existingDocumentId();");
    expect(logic).toContain("let documentId = existing;");
    // Exactly one create CALL (the interface member also matches the bare name),
    // and it is the one inside that branch.
    expect(logic.match(/await ports\.create\(/g)?.length).toBe(1);
    const branch = logic.slice(logic.indexOf("if (documentId === null) {"));
    expect(branch.slice(0, branch.indexOf("\n  }"))).toContain("await ports.create(bytes)");
    /*
     * The other side of it targets the id already held, not a fresh record — and
     * carries the scene and the source bytes (Phase 3), because a version that can
     * only be reopened by re-importing its own flattened output is not a checkpoint
     * of the document that was being edited.
     */
    expect(logic).toContain("await ports.commit(documentId, bytes, scene, sourceBytes)");

    const code = readCode("components/editor/StandaloneEditorShell.tsx");
    expect(code).toContain("existingDocumentId: () => workspaceDocumentRef.current");
    expect(code.match(/createWorkspaceDocument\(saveTarget, asBlob\(bytes\), fileName\)/g)?.length).toBe(1);
    expect(code).toContain("saveWorkspaceVersion(saveTarget, documentId, {");
  });

  it("does not lose the first save's CAS to its own import job", () => {
    /*
     * A first save is create + version commit, and the upload's ingestion cuts
     * version 1 in between — bumping the revision with the same write that sets
     * `currentVersionId`. Reading the revision before that landed made the FIRST
     * save report a conflict nobody caused: the Phase 2 probe's "the first
     * Workspace save reports success in a live region" failed with the conflict
     * banner while the document sat at revision 2.
     *
     * Pinned as source because the fix is a property of ONE read: the revision
     * handed to the compare-and-swap comes from a response that already shows a
     * current version. Comment-stripped, since the helper explains all of this in
     * prose that would otherwise satisfy the assertions.
     */
    // In the publish transport, which the Workspace workbench now shares with the
    // standalone shell — one CAS read for both surfaces, not two.
    const code = readCode("components/editor/workspacePublish.ts");
    expect(code).toContain("const revision = await revisionForCommit(base, query);");
    expect(code).toContain("if (body?.document?.currentVersionId || Date.now() >= deadline) return revision;");
    // Bounded: an ingestion that never completes must not hang the save forever.
    expect(code).toContain("const deadline = Date.now() + IMPORT_SETTLE_TIMEOUT_MS;");
    // And the waiting is all it does — a rejected write is still the user's to retry.
    const commit = code.slice(code.indexOf("async function saveWorkspaceVersion("));
    expect(commit).not.toMatch(/for \(|while \(/);
  });

  it("announces a save failure assertively and a success politely", () => {
    expect(source).toContain('role={save.kind === "error" ? "alert" : "status"}');
  });
});

describe("export is not persistence", () => {
  it("reports nothing to the save model on either export path", () => {
    const code = readCode(WORKSPACE);
    const start = code.indexOf("const onExport = async () => {");
    const end = code.indexOf("const onSave = ", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = code.slice(start, end);
    // Guards the slice itself: an empty body would satisfy every `not.toContain`
    // below while asserting nothing at all.
    expect(body.length).toBeGreaterThan(200);

    /*
     * An export is a copy the user now holds; it does not make the document
     * durable. The shell used to turn a completed export into "Exported — no edits
     * since" in the same app bar whose status readout was calling the document
     * unsaved, which is how defect B reached a recording.
     */
    expect(body).not.toContain("onPersisted");
    expect(body).not.toContain("persistence.");
    expect(body).not.toContain("markSaved");
    // The failure path still tells the user, rather than swallowing it.
    expect(body).toContain("} catch");
    expect(body).toContain("Export failed");
  });
});
