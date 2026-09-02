import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AC6 — the WIRING of one-shot vs pinned tools.
 *
 * `toolSession.test.ts` covers the policy: which tools are one-shot, what a
 * re-click does, what `afterInsertion` returns. It is pure and it is thorough,
 * and it proves nothing at all about whether the product is connected to it.
 * The bug this file exists for got past a fully green suite:
 *
 *     const insertionComplete = useCallback(() => {
 *       if (onInsertionComplete) insertionComplete();   // <-- itself
 *       else onToolChange("select");
 *     }, [onInsertionComplete, onToolChange]);
 *
 * Infinite recursion, a blown stack on the first shape drawn, and 26 passing
 * policy tests — because none of them touch the canvas. The other half of the
 * hazard is the reverse mistake: routing a CROP EXIT through the insertion path,
 * which would let a pinned tool keep the user trapped inside crop mode.
 *
 * Asserting on source is the honest option here, as in `toolbarChrome.test.ts`:
 * `EditorCanvas` and `EditorToolbar` both need `EditorContext`, a DOM and a
 * layout engine to render, and this suite is pure Node. What survives a refactor
 * is the shape of the wiring, and that is what these check.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

/**
 * Comments removed. Documenting the call a site USED to make must not read as a
 * live second copy of it — and this file's own subject is a doc comment that
 * mentions `onToolChange("select")` by name.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const canvas = read("components", "editor", "EditorCanvas.tsx");
const toolbar = read("components", "editor", "EditorToolbar.tsx");
const workspace = read("components", "editor", "EditorWorkspace.tsx");
const statusBar = read("components", "editor", "StatusBar.tsx");

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

describe("AC6 wiring — the canvas defers to the policy, and never to itself", () => {
  it("calls the PROP from the defaulting wrapper, not the wrapper again", () => {
    const wrapper = bodyOf(canvas, "const insertionComplete = useCallback(");
    // The whole defect in one assertion: the wrapper must not name itself.
    expect(wrapper).not.toContain("insertionComplete(");
    expect(wrapper).toContain("onInsertionComplete()");
  });

  it("keeps the historical fallback for an embedder that omits the prop", () => {
    // Omitting the prop must not silently disable disarming — before the session
    // model existed, every insertion returned to Select, and a caller that has
    // not adopted pinning is entitled to exactly that behaviour.
    const wrapper = bodyOf(canvas, "const insertionComplete = useCallback(");
    expect(wrapper).toContain('onToolChange("select")');
  });

  it("declares the prop as optional, which is what makes the fallback reachable", () => {
    expect(canvas).toMatch(/onInsertionComplete\?: \(\) => void;/);
  });

  it("routes every insertion through the policy rather than hard-coding Select", () => {
    // Insertions are the sites that used to call `onToolChange("select")`
    // unconditionally. There were eight such calls; the five that CREATE
    // something now ask the policy, and only crop's three exits remain.
    const code = stripComments(canvas);
    expect([...code.matchAll(/insertionComplete\(\)/g)]).toHaveLength(5);
    /*
     * The wrapper's own fallback is the one legitimate `onToolChange("select")`
     * outside crop, so it is subtracted before counting. What remains must be
     * exactly crop's three exits: bounce-on-invalid-target, apply, and cancel.
     */
    const withoutWrapper = code.replace(
      bodyOf(code, "const insertionComplete = useCallback("),
      "",
    );
    expect([...withoutWrapper.matchAll(/onToolChange\("select"\)/g)]).toHaveLength(3);
  });

  it("leaves crop's exits hard-coded, because leaving a mode is not an insertion", () => {
    /*
     * The trap this prevents: if crop's apply/cancel went through
     * `insertionComplete`, a PINNED tool would keep the session armed and the
     * user would still be in crop mode after pressing Escape. Crop exits by
     * applying or cancelling; it never "creates and continues".
     */
    const at = canvas.indexOf("onInsertionComplete?: () => void;");
    const rationale = canvas.slice(Math.max(0, at - 1200), at);
    expect(rationale).toContain("crop");
    expect(rationale.toLowerCase()).toContain("mode exit");
  });

  it("does not leave `onToolChange` in a dep array whose body no longer uses it", () => {
    /*
     * A stale dep is invisible: the memoized callback keeps the FIRST
     * `insertionComplete` it ever saw, so flipping the pin mid-session would go
     * on using the old closure and the tool would disarm anyway. Every
     * `onToolChange` in a dep array must sit beside a real use of it.
     */
    for (const match of canvas.matchAll(/\[[^[\]]*onToolChange[^[\]]*\]\s*\)/g)) {
      const depsAt = match.index ?? 0;
      // Walk back to the start of this callback and confirm the body uses it.
      const open = canvas.lastIndexOf("useCallback(", depsAt);
      const region = canvas.slice(open, depsAt);
      expect(
        region.includes("onToolChange("),
        `dep array "${match[0].trim()}" lists onToolChange but its body never calls it`,
      ).toBe(true);
    }
  });
});

describe("AC6 wiring — the workspace actually connects the two", () => {
  it("hands the canvas its insertion callback", () => {
    // Without this line the whole session model is inert: the wrapper falls back
    // to Select and pinning has no observable effect anywhere in the product.
    expect(workspace).toContain("onInsertionComplete={completeInsertion}");
  });

  it("hands the toolbar both the pin state and the pin control", () => {
    expect(workspace).toContain("toolPinned={toolSession.pinned}");
    expect(workspace).toContain("onToolPinnedChange={setToolPinned}");
  });

  it("derives all four handles from ONE session, so they cannot disagree", () => {
    // `tool` must be read off the session rather than kept as a second copy of
    // the active tool in its own `useState` — two sources would drift.
    expect(workspace).toContain("const tool = toolSession.active;");
    expect(workspace).toMatch(/useState<ToolSession>\(INITIAL_TOOL_SESSION\)/);
    for (const fn of ["selectTool", "afterInsertion", "setPinned"]) {
      expect(workspace, `${fn} must own its transition`).toContain(fn);
    }
  });
});

describe("AC6 — pinned is distinguishable without seeing colour", () => {
  it("names the tool's persistence in its accessible name", () => {
    // The brief: "Do not rely only on color to communicate active state." An
    // accent surface can say "active"; it cannot say "and this disarms after one
    // use", which is the difference a user actually needs.
    expect(toolbar).toContain("toolStateLabel");
    expect(toolbar).toMatch(/aria-label=\{active \? `\$\{t\.ariaLabel\} — \$\{stateLabel\}`/);
  });

  it("gives a pinned tool a different SHAPE, not just a different tint", () => {
    const at = toolbar.indexOf("active && toolPinned");
    expect(at, "the active tool must render a pin glyph when pinned").toBeGreaterThan(-1);
    const glyph = toolbar.slice(at, at + 200);
    expect(glyph).toContain("<Pin");
    // Decorative: the state is already in the accessible name, so announcing it
    // again would be duplicate noise for a screen reader.
    expect(glyph).toContain('aria-hidden="true"');
  });

  it("offers an explicit pin toggle, not only the click-again gesture", () => {
    const at = toolbar.indexOf("onToolPinnedChange(!toolPinned)");
    expect(at, "a discoverable pin control must exist").toBeGreaterThan(-1);
    const button = toolbar.slice(toolbar.lastIndexOf("<button", at), toolbar.indexOf("</button>", at));
    expect(button).toContain("aria-pressed={toolPinned}");
    // Named for what it will DO, both states spelled out — "Pin"/"Unpin" alone
    // does not tell you what pinning changes.
    expect(button).toMatch(/aria-label=/);
    expect(button).toContain("Unpin");
    expect(button).toContain("after each use");
  });

  it("only offers the toggle where the policy can honour it", () => {
    // Select/Hand/Crop are modal and Draw is already continuous; a pin control on
    // those would present a state `setPinned` refuses to enter.
    expect(toolbar).toContain("isPinnable");
    expect(toolbar).toMatch(/onToolPinnedChange && pinnableActive/);
  });

  it("reports the persistence in the status bar too, in words", () => {
    expect(statusBar).toContain("toolStateLabel");
    expect(statusBar).toMatch(/Active tool: \$\{TOOL_LABELS\[tool\]\} — /);
    // The visible half, for users who never hear an accessible name.
    expect(statusBar).toContain("· pinned");
    expect(statusBar).toContain("· one use");
  });

  it("keeps the row's own token vocabulary — no invented colour class", () => {
    /*
     * `text-editor-textmuted` is not a token in `tailwind.config.ts`; the real
     * one is `text-editor-muted`. A typo'd Tailwind class is silently inert, so
     * the readout would render at full strength and compete with the tool name.
     */
    const config = read("tailwind.config.ts");
    for (const cls of statusBar.matchAll(/text-editor-([a-z]+)/g)) {
      expect(config, `text-editor-${cls[1]} is not a declared token`).toContain(`${cls[1]}:`);
    }
  });
});
