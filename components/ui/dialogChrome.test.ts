import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Modal } from "@/components/ui/Modal";
import { ConflictDialog } from "@/components/editor/persistence/ConflictDialog";
import { presentConflict } from "@/src/application/editor/persistence/conflictResolution";
import { INITIAL_PERSISTENCE_STATE } from "@/src/application/editor/persistence/persistenceMachine";

/**
 * Phase 6 §19 — U22 (the conflict dialog stays keyboard accessible) and U25
 * (dialogs fit a narrow viewport).
 *
 * Both dialogs are rendered for real. The conflict presentation is built by
 * `presentConflict` rather than hand-written, so this also proves the rendered
 * dialog is showing the copy and the action ORDER the policy produced — a
 * hand-made fixture would happily render a destructive action first.
 *
 * The honest limit: `renderToStaticMarkup` runs no effects, so the Escape
 * handler and the focus-on-open are asserted against the source and their
 * rendered proof is the browser probe (F1 measures a modal taking focus, F5 the
 * drawer's Escape returning it to the trigger).
 */

const CONFLICT_SOURCE = readFileSync("components/editor/persistence/ConflictDialog.tsx", "utf8");

const presentation = () => {
  const at = Date.UTC(2026, 7, 22, 15, 0, 0);
  const result = presentConflict({
    ...INITIAL_PERSISTENCE_STATE,
    documentId: "doc-1",
    documentKey: "workspace:doc-1",
    remoteEnabled: true,
    remote: "conflict",
    currentRevision: 12,
    lastLocallyDurableRevision: 12,
    lastLocalSaveAt: at - 1_000,
    conflict: {
      localRevision: 12,
      expectedServerVersion: 9,
      actualServerVersion: 11,
      detail: null,
      detectedAt: at,
    },
  });
  if (result === null) throw new Error("expected a conflict presentation");
  return result;
};

const conflictHtml = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    h(ConflictDialog, {
      conflict: presentation(),
      workspaceKnown: true,
      onAction: () => {},
      ...props,
    } as Parameters<typeof ConflictDialog>[0]),
  );

/** `<button …>` open tags, in document order. */
const buttons = (html: string) => html.match(/<button\b[^>]*>/g) ?? [];

describe("U22 — the conflict dialog remains keyboard accessible", () => {
  it("is an alertdialog whose name and description point at elements that exist", () => {
    const html = conflictHtml();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    // A dangling idref is worse than none: the dialog announces itself as unnamed.
    expect(html).toContain(`<h2 id="${labelledBy}"`);
    expect(html).toContain(`<p id="${describedBy}"`);
    expect(labelledBy).not.toBe(describedBy);
  });

  it("offers every action as a real button with a visible focus indicator", () => {
    const html = conflictHtml();
    const rows = buttons(html);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const button of rows) {
      expect(button).toContain('type="button"');
      expect(button).toMatch(/focus-visible:ring-2/);
    }
  });

  it("puts no destructive action first, and never acts on one in a single press", () => {
    const html = conflictHtml();
    const labels = html.match(/text-sm font-semibold (?:text-red-700|text-editor-text)">([^<]+)</g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(3);
    // Exactly one destructive row, and it sits after every safe option and
    // before "Decide later" — the ordering is the first discouragement.
    const destructive = labels.findIndex((label) => label.includes("text-red-700"));
    expect(labels.filter((label) => label.includes("text-red-700"))).toHaveLength(1);
    expect(destructive).toBeGreaterThan(0);
    expect(destructive).toBe(labels.length - 2);
    // The destructive row's button says "Continue" — it opens the second
    // confirmation rather than replacing the workspace copy on one keystroke.
    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain(">Replace it</button>");
  });

  it("keeps a decide-later action so Escape has a visible equivalent", () => {
    // WCAG 2.1.1: a dismiss gesture that exists only as a key press leaves a
    // switch or pointer user with no way out of a dialog about losing work.
    expect(conflictHtml()).toContain("Decide later");
    expect(CONFLICT_SOURCE).toMatch(/event\.key !== "Escape"/);
    expect(CONFLICT_SOURCE).toMatch(/else onAction\("cancel"\)/);
  });

  it("disables every control while an action is in flight", () => {
    for (const button of buttons(conflictHtml({ busy: true }))) {
      expect(button).toContain("disabled");
    }
  });

  it("reports a failed action in a live region and leaves the choices standing", () => {
    const html = conflictHtml({ error: "The workspace refused the write." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The workspace refused the write.");
    expect(html).toContain('role="alertdialog"');
    expect(buttons(html).length).toBeGreaterThanOrEqual(3);
  });

  it("hides the actions that need a workspace when there is none", () => {
    const withWorkspace = conflictHtml();
    const without = conflictHtml({ workspaceKnown: false });
    expect(buttons(without).length).toBeLessThan(buttons(withWorkspace).length);
    // A dead button in this dialog is worse than a missing one.
    expect(without).not.toContain("Review the workspace version");
    expect(without).toContain("Decide later");
  });
});

describe("U25 — dialogs fit a narrow viewport", () => {
  const modal = (size?: string) =>
    renderToStaticMarkup(
      h(Modal, {
        open: true,
        onClose: () => {},
        ariaLabel: "Rename document",
        sizeClassName: size,
        children: h("p", null, "body"),
      }),
    );

  it("constrains the panel by a maximum, so 320px collapses it instead of clipping", () => {
    const html = modal("max-w-2xl");
    expect(html).toMatch(/class="relative my-8 w-full rounded-2xl bg-white shadow-xl max-w-2xl"/);
    // `w-full` + a max is what makes this responsive. A fixed width (`w-[640px]`)
    // is the failure: at 320px it overflows the viewport and cannot be scrolled to.
    expect(html).not.toMatch(/class="[^"]*\bw-\[/);
  });

  it("scrolls a tall dialog from the top rather than centring it out of reach", () => {
    const html = modal();
    // `items-start` + `overflow-y-auto` on the wrapper, and `my-8` on the panel:
    // a dialog taller than a 320x800 phone is reachable end to end. Centring it
    // would push its top edge above the viewport with no way to scroll up.
    expect(html).toContain("fixed inset-0 z-dialog flex items-start justify-center overflow-y-auto p-4 sm:p-6");
    expect(html).toContain("my-8");
  });

  it("names itself, and never both ways at once", () => {
    expect(modal()).toContain('aria-label="Rename document"');
    const labelled = renderToStaticMarkup(
      h(Modal, { open: true, onClose: () => {}, labelledById: "t1", ariaLabel: "ignored", children: "x" }),
    );
    // An `aria-labelledby` wins and the redundant `aria-label` is dropped, so the
    // two can never disagree about the dialog's name.
    expect(labelled).toContain('aria-labelledby="t1"');
    expect(labelled).not.toContain("ignored");
  });

  it("renders nothing at all when closed", () => {
    // Not `hidden`, not `max-height: 0` — the regression that leaves links
    // focusable inside invisible content.
    expect(renderToStaticMarkup(h(Modal, { open: false, onClose: () => {}, children: "x" }))).toBe("");
  });

  it("keeps the conflict dialog inside a narrow viewport too", () => {
    // The editor's dialog does not use Modal (it is scoped to the canvas area),
    // so it carries the same contract itself.
    const html = conflictHtml();
    expect(html).toContain("w-full max-w-xl");
    expect(html).toContain("inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4");
    expect(html).not.toMatch(/class="[^"]*\bw-\[/);
  });

  it("every Modal call site in the product names its dialog and sizes it by a maximum", () => {
    // A coverage guard, and the file says so: the six dialogs are opened by state
    // an SSR render cannot set, so this proves the call, not the pixels.
    const sources = [
      "components/admin/ToolsManager.tsx",
      "components/workspaces/CommandPalette.tsx",
      "components/workspaces/WorkspaceCreateDialog.tsx",
      "components/workspaces/NewMenu.tsx",
      "components/workspaces/DocumentFileManager.tsx",
    ].map((file) => readFileSync(file, "utf8"));
    // `(?<!=)>` and not plain `>`: two call sites pass an arrow function to
    // `onClose`, and its `=>` would otherwise end the tag early and hide the props.
    const opens = sources.flatMap((source) => source.match(/<Modal[\s\S]*?(?<!=)>/g) ?? []);
    expect(opens).toHaveLength(6);
    for (const open of opens) {
      expect(open).toMatch(/labelledById=|ariaLabel=/);
      const size = /sizeClassName="([^"]+)"/.exec(open);
      if (size) expect(size[1]).toMatch(/^max-w-/);
    }
  });
});
