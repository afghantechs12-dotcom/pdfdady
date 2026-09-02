import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * One `<main>` per document, on both routes the editor ships on.
 *
 * The frame spent the document-level landmark on its canvas region, and the frame
 * is mounted twice: standalone at `/editor`, and inside `AppShell` for a Workspace
 * document. So the Workspace editor nested a second `main` inside
 * `AppShell`'s — invalid HTML and two `main` landmarks — while `/editor` had none
 * at all, which made the root layout's "Skip to content" link inert on the one
 * route where bypassing the chrome matters most (`getElementById("main")` was
 * measured null there). WCAG 2.4.1 Bypass Blocks and 1.3.1.
 *
 * Asserted on the source because this suite has no DOM; the rendered assertion —
 * that `#main` resolves and that exactly one `main` exists per route — is the
 * browser probe's scenario K. Both are kept: the probe needs a running server,
 * this runs on every commit.
 */
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

const frame = read("components", "editor", "PremiumEditorFrame.tsx");
const editorRoute = read("app", "editor", "page.tsx");
const appShell = read("components", "app", "AppShell.tsx");
const rootLayout = read("app", "layout.tsx");

/** Comments legitimately discuss `<main>`; only rendered elements count. */
const elements = (source: string) =>
  source.replace(/\{\/\*[\s\S]*?\*\/\}/gu, "").replace(/\/\*[\s\S]*?\*\//gu, "");

describe("the editor's landmarks", () => {
  it("keeps the skip link's target a real element on both routes", () => {
    expect(rootLayout).toContain('href="#main"');
    expect(elements(editorRoute)).toContain('<main id="main"');
    expect(elements(appShell)).toContain('<main id="main"');
  });

  it("never lets the frame claim a document landmark for a region", () => {
    // The frame is the nested half of the defect: `AppShell` supplies `main` for
    // the Workspace editor, so a `main` here is always a second one.
    expect(elements(frame)).not.toMatch(/<main[\s>]/u);
    expect(elements(frame)).toContain('aria-label="Document canvas"');
  });

  it("gives the frame's canvas a landmark that is still findable", () => {
    // A bare `<div>` would fix the violation by deleting the landmark. `<section>`
    // with an accessible name is a `region`, so the canvas stays in a screen
    // reader's landmark list — which is how a user gets past the toolbar.
    const canvas = elements(frame).match(/<section[\s\S]{0,200}/u);
    expect(canvas, "no <section> in the frame").not.toBeNull();
    expect(canvas![0]).toContain('aria-label="Document canvas"');
  });
});
