import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * U13 — the Workspace destination selector stays accessible.
 *
 * WHAT THIS FILE DOES NOT PROVE, and where the proof lives instead. The
 * destination list arrives from `/api/workflow/save-target` in a `useEffect`, and
 * effects do not run under SSR, so the MULTI-DESTINATION selector cannot be
 * rendered here — the rendered proof is browser probe scenario E3. What SSR does
 * settle is the more important half of the accessibility claim: that no selector
 * appears before the destinations are known, i.e. the product never shows an empty
 * dropdown. The rest are structural guards on the markup that E3 exercises.
 *
 * The pure gate functions (`resolveInitialSelection`, `awaitingDestinationChoice`)
 * are deliberately NOT re-tested here — `resultWorkflowWiring.test.ts` already
 * covers them, and duplicating them would hide that this file is about the label,
 * the platform control and the disabled state.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));

const SOURCE = readFileSync(
  join(__dirname, "ResultWorkflowActions.tsx"),
  "utf8",
);
const sliceBetween = (start: string, end: string) => {
  const from = SOURCE.indexOf(start);
  const to = SOURCE.indexOf(end);
  // Throw rather than return "": an empty slice would make every `not.toContain`
  // below pass for the wrong reason.
  if (from < 0 || to <= from) throw new Error(`selector markup not found: ${start}`);
  return SOURCE.slice(from, to);
};
const selector = sliceBetween(
  "{destinations.length > 1",
  '<div className="flex flex-col gap-3 sm:flex-row">',
);

const render = async () => {
  const { ResultWorkflowActions } = await import("./ResultWorkflowActions");
  return renderToStaticMarkup(
    h(ResultWorkflowActions, {
      toolSlug: "merge-pdf",
      fileName: "merged.pdf",
      outputMimeType: "application/pdf",
      loadBytes: async () => new Uint8Array([1]),
      save: async () => new Response(null, { status: 200 }),
    }),
  );
};

describe("U13 — destination selector remains accessible", () => {
  it("shows no selector before the destinations are known", async () => {
    const html = await render();
    // The first paint knows nothing about Workspaces. An empty or one-option
    // dropdown here would be a control with no decision in it.
    expect(html).not.toContain("<select");
    expect(html).not.toContain("Save to which Workspace?");
    // ...and the panel is genuinely rendering, so the assertion above is not
    // passing because nothing came out at all.
    expect(html).toContain("Open in Editor");
  });

  it("labels the select with a real label bound to the generated id", () => {
    // `useId` and not a hardcoded id: two results can share a page, and a
    // duplicated id would point both labels at the first control (WCAG 1.3.1).
    expect(SOURCE).toContain("const selectId = useId();");
    expect(selector).toContain('<label htmlFor={selectId}');
    expect(selector).toContain("Save to which Workspace?");
    expect(selector).toMatch(/<select\s+id=\{selectId\}/);
    // No placeholder-as-label, which vanishes the moment a choice is made.
    expect(selector).not.toContain("aria-label=");
  });

  it("uses the platform control rather than a custom listbox", () => {
    // Keyboard, type-ahead, screen-reader announcement and the mobile native
    // picker all come free from `<select>`. A div-based combobox would owe every
    // one of them.
    for (const custom of [
      'role="listbox"',
      'role="combobox"',
      'role="option"',
      "aria-activedescendant",
      "aria-expanded",
    ]) {
      expect(selector).not.toContain(custom);
    }
    expect(selector).toContain("<option value=\"\">Choose a Workspace…</option>");
  });

  it("keeps the unchosen state representable and Save inert", () => {
    // The empty-valued placeholder is what `null` selection renders as. Without
    // it the browser would preselect the first Workspace and Save would target a
    // destination the user never picked.
    expect(selector).toContain("value={selectedWorkspaceId ?? \"\"}");
    expect(selector).toContain("setSelectedWorkspaceId(event.target.value || null)");
  });

  it("appears only while the choice is live, and truly disables while saving", () => {
    expect(selector).toContain(
      "{destinations.length > 1 && (actions.saveToWorkspace || choosing) && saveState.kind !== \"saved\" ?",
    );
    // A real `disabled` attribute, not `aria-disabled` decoration: an in-flight
    // upload has already committed to a destination.
    expect(selector).toContain('disabled={saveState.kind === "saving"}');
    expect(selector).not.toContain("aria-disabled");
  });

  it("meets the touch target and shows a focus indicator that is not colour alone", () => {
    const className = /<select[\s\S]*?className="([^"]+)"/.exec(selector)?.[1] ?? "";
    expect(className).toContain("h-11"); // 44px — WCAG 2.5.8 on a phone.
    expect(className).toContain("focus:ring-2");
    expect(className).toContain("focus:border-primary");
  });

  it("shows the Workspace name, never the id it saves with", () => {
    // The ids the save routes re-authorize travel in the request. Putting one on
    // screen would be noise the user cannot act on.
    expect(selector).toContain("{destinationOption.workspaceName}");
    expect(selector).toMatch(/value=\{destinationOption\.workspaceId\}/);
    expect(selector).not.toMatch(/>\s*\{destinationOption\.workspaceId\}/);
  });
});
