import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The WIRING of the persistence hook.
 *
 * `persistenceBinding.test.ts` covers every decision the hook delegates: the
 * cached snapshot, the live capture, the serialised open, the lifecycle handlers,
 * the recovery probe. All of it is pure Node and all of it is thorough, and none of
 * it proves the hook is connected to any of it.
 *
 * This suite runs with no DOM — no jsdom, no React renderer — so a hook body
 * cannot be executed here at all. That makes the hook the one file in this
 * subsystem where a mistake is invisible to a green suite, and the two mistakes
 * available in it both lose data silently:
 *
 *     const [view, setView] = useState(binding.getView());   // a second copy of
 *                                                            // the truth, stale
 *     useEffect(() => { binding.setCapture(capture) }, [...]) // a scheduler timer
 *                                                            // between render and
 *                                                            // effect serialises
 *                                                            // the old document
 *
 * So the shape is asserted instead. What these check is what survives a refactor:
 * which functions are called, from where, and what is NOT there.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/**
 * Comments removed. This file's own subject is a doc comment that names the wrong
 * patterns on purpose, and the hook's comments name the calls they warn about.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const hookSource = read("hooks", "editor", "useDocumentPersistence.ts");
const hook = stripComments(hookSource);

/** The body of a named function/const declaration, brace-matched. */
function bodyOf(source: string, declaration: string): string {
  const at = source.indexOf(declaration);
  expect(at, `declaration not found: ${declaration}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
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

/** Every `useEffect(...)` call body in a source, brace-matched from the arrow. */
function effectBodies(source: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("useEffect(", from);
    if (at === -1) break;
    const open = source.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          bodies.push(source.slice(open, i + 1));
          from = i;
          break;
        }
      }
    }
    if (from <= at) break;
  }
  return bodies;
}

const body = bodyOf(hook, "export function useDocumentPersistence");

describe("the hook delegates instead of deciding", () => {
  it("holds a PersistenceBinding and builds nothing else", () => {
    expect(hook).toContain("new PersistenceBinding(");
    // Assembling a coordinator or a runtime here would put the wiring back in the
    // one file no test can run.
    expect(hook).not.toContain("new DocumentPersistenceCoordinator(");
    expect(hook).not.toContain("createPersistenceRuntime(");
    expect(hook).not.toContain("new DraftRepository(");
    expect(hook).not.toContain("new WriteScheduler(");
  });

  it("is a client module", () => {
    expect(hookSource.startsWith('"use client"')).toBe(true);
  });

  it("creates the binding once, in a ref, and only on the client", () => {
    expect(body).toContain("useRef<PersistenceBinding | null>(null)");
    expect(body).toContain("bindingRef.current === null");
    expect(body).toContain('typeof window !== "undefined"');
  });

  it("takes the origin from the caller, never from the not-yet-loaded document", () => {
    /*
     * The binding is built on the first render, when `identity` is still null. A
     * workspace editor whose origin was inferred from it would get a guest runtime:
     * no transport, no cloud autosave, and no error anywhere.
     */
    expect(body).toContain("origin: input.origin");
    expect(body).not.toContain('input.identity?.origin ?? "guest"');
  });
});

describe("the view React renders is the binding's, not a copy", () => {
  it("mirrors the binding through useSyncExternalStore", () => {
    expect(body).toContain("useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)");
    expect(body).toContain("binding.subscribe(onStoreChange)");
    expect(body).toContain("binding.getView()");
  });

  it("never keeps its own copy of the view", () => {
    // A `useState` view is a second source of truth that goes stale the moment the
    // scheduler resolves a write without a re-render.
    expect(body).not.toContain("useState");
  });

  it("never reads the coordinator's recomputing getter", () => {
    /*
     * `coordinator.view` builds a fresh object per read. Handed to
     * `useSyncExternalStore` that is an infinite render loop — a hang, in the one
     * file this suite cannot execute.
     */
    expect(body).not.toContain("coordinator.view");
  });

  it("returns a stable server snapshot", () => {
    expect(body).toContain("getServerSnapshot = useCallback(() => null, [])");
  });
});

describe("capture is refreshed during render", () => {
  it("assigns the newest capture outside every effect", () => {
    expect(body).toContain("binding.setCapture(input.capture)");
    for (const effect of effectBodies(body)) {
      expect(effect).not.toContain("setCapture");
    }
  });

  it("does not memoise the capture into the binding once", () => {
    // `useMemo`/`useCallback` around setCapture would freeze the closure for as
    // long as its dependencies held, which is exactly the bug.
    const at = body.indexOf("setCapture");
    const line = body.slice(body.lastIndexOf("\n", at) + 1, body.indexOf("\n", at));
    expect(line).not.toContain("useMemo");
    expect(line).not.toContain("useCallback");
  });
});

describe("the effects", () => {
  const effects = effectBodies(body);

  it("installs the lifecycle handlers and removes them on cleanup", () => {
    const attach = effects.find((effect) => effect.includes("binding.attach()"));
    expect(attach, "no effect attaches the lifecycle handlers").toBeTruthy();
    // `attach()` returns its own detach, so returning it IS the cleanup.
    expect(attach).toContain("return binding.attach()");
  });

  it("attaches before it opens the document", () => {
    /*
     * A tab closed while the first open is still in flight has to reach the flush
     * handlers. Effects run in declaration order, so this is an ordering assertion
     * on the source.
     */
    expect(body.indexOf("binding.attach()")).toBeLessThan(body.indexOf("binding.syncDocument("));
  });

  it("syncs the document in an effect keyed on the document, not the identity object", () => {
    const sync = effects.find((effect) => effect.includes("binding.syncDocument("));
    expect(sync, "no effect syncs the document").toBeTruthy();
    // A new identity object arrives on every render; keying on it would reopen the
    // document constantly and throw away every unanswered recovery offer.
    const deps = body.slice(body.indexOf(sync as string) + (sync as string).length);
    expect(deps.slice(0, 200)).toContain("documentKey");
    expect(deps.slice(0, 200)).not.toContain("input.identity,");
  });

  it("reports every revision change as a mutation", () => {
    const mutation = effects.find((effect) => effect.includes("binding.noteMutation("));
    expect(mutation, "no effect reports mutations").toBeTruthy();
    expect(mutation).toContain("input.revision");
    const deps = body.slice(body.indexOf(mutation as string) + (mutation as string).length);
    expect(deps.slice(0, 80)).toContain("input.revision");
  });

  it("disposes the binding when the mount ends, and only then", () => {
    const dispose = effects.find((effect) => effect.includes(".dispose()"));
    expect(dispose, "nothing disposes the binding").toBeTruthy();
    expect(dispose).toContain("return () =>");
    // An empty dependency list: disposing on any other change would tear down the
    // database connection and the lock under a live document.
    const deps = body.slice(body.indexOf(dispose as string) + (dispose as string).length);
    expect(deps.slice(0, 40)).toContain("[]");
  });
});

describe("what the hook hands back", () => {
  it("exposes every action a surface needs to honour a verdict", () => {
    for (const action of [
      "restore:",
      "dismissOffer:",
      "deleteOffer:",
      "acknowledgeRecovery:",
      "resolveConflict:",
      "retryLocal:",
      "retryRemote:",
      "noteVersionCommitted:",
      "saveNow:",
      "canNavigate:",
      "beginGesture:",
      "endGesture:",
      "beginLoad:",
      "endLoad:",
      "findAbandonedGuestDraft:",
    ]) {
      expect(body, `missing action: ${action}`).toContain(action);
    }
  });

  it("reaches the abandoned-draft probe, which nothing else can", () => {
    /*
     * `PersistenceBinding.findAbandonedGuestDraft` is the ONLY way a guest tab
     * recovers work after a refresh: the ordinary probe runs inside `syncDocument`
     * and needs a document key, which a tab with no file does not have. If the hook
     * does not forward it, the method is unreachable from the product and the whole
     * guest recovery path is dead code that passes its own unit tests.
     */
    expect(body).toContain("binding?.findAbandonedGuestDraft()");
    // Null, not a rejection: no draft is the common answer and must be silent.
    expect(body).toContain("?? Promise.resolve(null)");
  });

  it("reports the browser's limitations rather than implying full protection", () => {
    expect(body).toContain("binding?.runtime.limitations");
  });

  it("answers safely when there is no binding", () => {
    /*
     * Server render, or a disabled surface. Every action must be inert and every
     * promise must resolve to a verdict that does NOT say the work is safe.
     */
    expect(body).toContain('Promise.resolve({ kind: "no_draft" as const })');
    expect(body).toContain('{ kind: "not_owned" as const, action }');
    expect(hook).toContain('outcome: "cancelled"');
    expect(hook).not.toContain('outcome: "durable"');
  });

  it("exposes the navigation verdict as a method, not the rendered field", () => {
    /*
     * Callers ask this AFTER an await — "is the work safe now the flush resolved" —
     * and `view` is the snapshot from the render that started that await. A caller
     * handed the field would be told the answer from before the write, which is the
     * one answer that is never useful. `EditorWorkspace.flushBeforeReplace` is that
     * caller, and getting this wrong there loses the document on every tab switch.
     */
    expect(body).toContain("canNavigate: () => binding?.canNavigate()");
    expect(body).not.toContain("canNavigate: view");
    expect(body).not.toContain("canNavigate: view?.navigation");
  });
});

describe("surviving StrictMode's double-invoked effects", () => {
  /**
   * The dev-only lifecycle, which production never exercises.
   *
   * StrictMode mounts every effect, tears it down, and mounts it again — with NO
   * re-render in between. The teardown here disposes the binding, so the remount
   * re-runs `attach`/`syncDocument` against a corpse whose `publish` early-returns.
   *
   * WHAT WAS ACTUALLY MEASURED, rather than argued. The binding was instrumented and
   * /editor reached two ways in a real dev browser, with these guards absent:
   *
   *   direct load of the URL   → effectCleanups 0 — hydration is NOT double-invoked
   *   in-app click to /editor  → effectCleanups 1, disposed 1, attachOnDead 1
   *
   * Two things follow, and both are why these tests are worded the way they are.
   *
   * First, the teardown only happens on a client-side navigation mount. The probe's
   * first five phases arrive by URL, so they score the same with the guards reverted
   * and cannot be evidence for any of this. Its phase 6 clicks an in-app link to
   * reach this mount, and that phase is what covers the recovery described below.
   *
   * Second, the damage is narrower than "persistence is dead in dev": the cleanup
   * nulls the ref, so the next render builds a second healthy binding (constructed 2,
   * liveAttached 2) and autosave recovers by itself.
   *
   * So these assertions defend something small and precise, and it is worth being
   * exact about how small. Each of the three guards was deleted in turn and the
   * browser probe re-run against the result: all three left it green. What the probe
   * fails on is losing the REBUILD — the cleanup's ref-nulling and the disposed-ref
   * clause together — which drops the editor into a state where a drag still draws
   * an object while the readout says "No document" and no new draft generation is
   * ever written. These tests are therefore the only check on the three guards
   * themselves, which is the reason they pin source text this closely.
   */
  it("rebuilds a binding that a simulated unmount disposed", () => {
    // The render-time guard must treat a disposed binding as no binding. Measured,
    // this half never fires — the cleanup nulls the ref, so the null test short
    // circuits first every time (createdFromNull 2, corpse branch never observed).
    // It is kept, and pinned, because it makes "a disposed binding is never handed
    // out" true HERE rather than true only while a distant cleanup keeps nulling.
    expect(body).toContain("bindingRef.current === null || bindingRef.current.isDisposed");
  });

  it("asks React for the render that rebuilding needs", () => {
    /*
     * The remount cannot rebuild anything by itself: rebuilding happens during
     * render, and no render is coming. Reporting a store change from `subscribe` is
     * what makes one certain instead of incidental — without it the rebuild waits on
     * whatever unrelated state happens to change next. Observed firing exactly once
     * per navigation (subscribeOnDead 1), which is also the termination argument.
     *
     * TERMINATION, which is the risk this trades for: the requested render builds a
     * binding that is not disposed, so the branch cannot be taken twice for the same
     * one, and a rebuilt binding is never born disposed.
     */
    const subscribe = bodyOf(body, "const subscribe = useCallback(");
    expect(subscribe).toContain("binding.isDisposed");
    expect(subscribe).toContain("onStoreChange()");
    // Still the binding's own subscription in the ordinary case — a hook that only
    // ever reported synthetic changes would re-render forever and store nothing.
    expect(subscribe).toContain("binding.subscribe(onStoreChange)");
  });

  it("never arms lifecycle handlers on a disposed runtime", () => {
    /*
     * THE ONE THAT WAS CAUGHT IN A BROWSER. `attach` does not check disposal, and the
     * handlers it installs reach `runtime.coordinator`, so attaching a disposed
     * binding puts pagehide and beforeunload listeners for a torn-down runtime on the
     * real window — where they stay until the next render swaps the binding and React
     * runs this effect's cleanup. On an in-app navigation to /editor, the instrumented
     * counter `attachOnDead` reads 1 without the guarded line and 0 with it.
     */
    const effects = effectBodies(body);
    const attach = effects.find((effect) => effect.includes("binding.attach()"));
    expect(attach, "no effect attaches the lifecycle handlers").toBeTruthy();
    expect(attach).toContain("if (binding.isDisposed) return;");
    expect((attach as string).indexOf("isDisposed")).toBeLessThan(
      (attach as string).indexOf("binding.attach()"),
    );
  });

  it("still holds no state of its own", () => {
    // The obvious fix for all of the above is a generation counter in `useState`,
    // which is exactly the second-source-of-truth this hook is forbidden. The
    // rebuild is driven through the store subscription instead.
    expect(body).not.toContain("useState");
  });
});
