import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentFileManager } from "@/components/workspaces/DocumentFileManager";
import type { DocumentItem } from "@/components/workspaces/fileManagerLogic";

/**
 * Phase 6 §19 — U15, U16, U24, U28 for the Workspace document list.
 *
 * RENDERED, not scanned: `DocumentFileManager` is entirely prop-driven (its only
 * state defaults are `view`/`viewMode`, and the list view is the default), so
 * `renderToStaticMarkup` produces the real table for a real document set. What
 * the claims are about is the emitted markup, so that is what is asserted.
 *
 * Two states are NOT reachable this way and are guarded against the source
 * instead, which the file says out loud: the load error and the load spinner
 * both live behind `useState` that only an event can set. Their rendered proof
 * is the browser probe (scenario F walks the Workspace surfaces), not this file.
 */

const SOURCE = readFileSync("components/workspaces/DocumentFileManager.tsx", "utf8");

const doc = (over: Partial<DocumentItem> = {}): DocumentItem => ({
  id: "d1",
  name: "Quarterly report.pdf",
  favorite: false,
  lifecycleState: "active",
  createdAt: "2026-07-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
  lastAccessedAt: null,
  folderId: null,
  projectId: null,
  revision: 1,
  ...over,
});

const render = (props: Partial<Parameters<typeof DocumentFileManager>[0]> = {}) =>
  renderToStaticMarkup(
    h(DocumentFileManager, {
      workspaceId: "w1",
      organizationId: "o1",
      items: [doc()],
      ...props,
    }),
  );

/** The `<th …>` open tags, in document order. */
const headerCells = (html: string) => html.match(/<th\b[^>]*>/g) ?? [];
/** The `<tr …>` open tags inside `<tbody>`. */
const bodyRows = (html: string) => {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return body.match(/<tr\b[^>]*>/g) ?? [];
};

describe("U15 — the Workspace list preserves semantic table structure", () => {
  it("is a real table with a caption, not a grid of divs wearing ARIA", () => {
    const html = render();
    expect(html).toContain("<table");
    expect(html).toContain('<caption class="sr-only">Documents in this view</caption>');
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    // A retrofitted `role="table"` on divs is the failure mode this guards: it
    // reads the same to a sighted user and loses row/column semantics entirely.
    expect(html).not.toMatch(/role="(table|row|columnheader|cell)"/);
  });

  it("gives every header cell a scope, so a screen reader can announce columns", () => {
    const cells = headerCells(render());
    expect(cells.length).toBeGreaterThanOrEqual(6);
    for (const cell of cells) expect(cell).toContain('scope="col"');
  });

  it("emits one body row per document and names each row's own controls", () => {
    const html = render({
      items: [doc(), doc({ id: "d2", name: "Invoice.pdf" })],
    });
    expect(bodyRows(html)).toHaveLength(2);
    expect(html).toContain('aria-label="Select Quarterly report.pdf"');
    expect(html).toContain('aria-label="Select Invoice.pdf"');
    // The select-all control is distinct from the per-row ones.
    expect(html).toContain('aria-label="Select all documents"');
  });

  it("reports the sort state on the column, not only in the button's icon", () => {
    const html = render();
    const sortable = headerCells(html).filter((cell) => cell.includes("aria-sort"));
    expect(sortable.length).toBe(4);
    // Exactly one column is the active sort; the rest say "none" rather than
    // leaving the attribute off, which would read as "not sortable".
    expect(sortable.filter((cell) => cell.includes('aria-sort="ascending"'))).toHaveLength(1);
    expect(sortable.filter((cell) => cell.includes('aria-sort="none"'))).toHaveLength(3);
  });
});

describe("U16 — the narrow-width representation preserves actions", () => {
  it("drops metadata columns at narrow widths and keeps name and actions", () => {
    const cells = headerCells(render());
    // Name (index 1) and the actions column (last) are never gated on a
    // breakpoint; the three metadata columns are, each at its own width.
    expect(cells[1]).not.toContain("hidden");
    expect(cells[cells.length - 1]).not.toContain("hidden");
    const gated = cells.filter((cell) => /\bhidden\b/.test(cell));
    expect(gated).toHaveLength(3);
    expect(gated.map((cell) => /(md|lg|xl):table-cell/.exec(cell)?.[1])).toEqual([
      "md",
      "lg",
      "xl",
    ]);
  });

  it("keeps both per-row actions present and named at every width", () => {
    const html = render();
    const actionsCell = html.slice(html.lastIndexOf('<td class="px-3 py-2">'), html.indexOf("</tr></tbody>"));
    expect(actionsCell).toContain('aria-label="Add Quarterly report.pdf to favorites"');
    expect(actionsCell).toContain('aria-label="More actions for Quarterly report.pdf"');
    // No CLASS in the actions cell hides it at a breakpoint: a mobile user who
    // cannot reach the row menu cannot rename, archive or restore at all.
    // (Matched inside `class="…"` only — `aria-hidden` on the icons is correct.)
    for (const cls of actionsCell.match(/class="[^"]*"/g) ?? []) {
      expect(cls).not.toMatch(/\bhidden\b|(sm|md|lg|xl):(inline|flex|block|table-cell)/);
    }
  });

  it("marks the favorite toggle's state, which colour alone would not convey", () => {
    expect(render()).toContain('aria-pressed="false"');
    expect(render({ items: [doc({ favorite: true })] })).toContain('aria-pressed="true"');
  });
});

describe("U24 — a long filename does not create overflow", () => {
  const LONG = `${"Consolidated-quarterly-financial-statement-and-appendix-".repeat(4)}final.pdf`;

  it("truncates the name inside a container that is allowed to shrink", () => {
    const html = render({ items: [doc({ name: LONG })] });
    const cell = html.slice(html.indexOf('<td class="min-w-0 px-2 py-2">'), html.indexOf("</td><td class=\"hidden"));
    // `truncate` alone is not enough. A flex child defaults to `min-width: auto`,
    // so it refuses to shrink below its content and pushes the row wider than the
    // table — the chain of `min-w-0` is what actually lets the ellipsis happen.
    expect(cell).toContain("min-w-0");
    expect(cell).toMatch(/<a class="min-w-0 flex-1 truncate/);
    expect(html).toContain('<table class="w-full min-w-0');
    // Present in full four times — the visible link text plus the three
    // accessible names (select, favorite, more actions). Truncation is visual
    // only: a screen reader still hears the whole filename.
    expect(html.split(LONG)).toHaveLength(5);
  });

  it("does not widen the table with a fixed pixel width for the name column", () => {
    const cells = headerCells(render({ items: [doc({ name: LONG })] }));
    expect(cells[1]).not.toMatch(/\bw-\[|\bmin-w-\[/);
    // The metadata columns are fixed-width (w-32/w-28/w-24) by design; the name
    // column is the one that absorbs the remaining space.
    expect(cells[1]).toBe('<th scope="col" class="px-2 py-2" aria-sort="ascending">');
  });
});

describe("U28 — the empty state keeps a way out", () => {
  it("offers the canonical route back when a filtered view is empty", () => {
    for (const view of ["favorites", "recent", "archived", "trashed"] as const) {
      const html = render({ items: [], initialView: view });
      expect(html).toContain("View all documents");
      // A link to the canonical URL, not a local view switch: the sidebar and the
      // URL must keep agreeing (see the P1-9 note in the component).
      expect(html).toContain('href="/workspaces/w1?organizationId=o1"');
    }
  });

  it("explains an empty view in its own words rather than one generic line", () => {
    expect(render({ items: [], initialView: "trashed" })).toContain("Trash is empty.");
    expect(render({ items: [], initialView: "favorites" })).toContain(
      "Star a document to keep it here.",
    );
  });

  it("does not offer a link back to the view the user is already in", () => {
    const html = render({ items: [], initialView: "all" });
    expect(html).toContain("No documents in this Workspace yet.");
    expect(html).not.toContain("View all documents");
  });

  /*
   * The two states an SSR render cannot reach. Both are asserted against the
   * source on purpose, and the honest limit is stated: this proves the recovery
   * control is wired, not that it is visible. Scenario F is the rendered proof.
   */
  it("keeps a retry on the load error and a labelled spinner on the load", () => {
    expect(SOURCE).toContain('role="alert"');
    expect(SOURCE).toMatch(/onClick=\{\(\) => loadView\(view\)\}[\s\S]{0,200}Retry/);
    expect(SOURCE).toMatch(/role="status" aria-live="polite">[\s\S]{0,400}Loading documents/);
  });
});
