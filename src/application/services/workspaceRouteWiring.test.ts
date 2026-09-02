import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wiring, not policy.
 *
 * The behaviour in `workspaceRouteAccess.test.ts` is worthless if no page calls
 * it — that is exactly the shape of the original defect, where the service layer
 * was fine in isolation and the composition was wrong. These assertions read the
 * consumers and fail if any of them goes back to calling the service directly or
 * hand-building a Workspace URL.
 *
 * They are source-text assertions, so they pin spellings on purpose. Renaming
 * `loadWorkspaceForRoute` means updating this file, which is the cheap half of
 * the deal; the expensive half was shipping a Workspace nobody could open.
 */
const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const PAGES = [
  "app/workspaces/[workspaceId]/page.tsx",
  "app/workspaces/[workspaceId]/settings/page.tsx",
  "app/workspaces/[workspaceId]/documents/[documentId]/page.tsx",
];

describe("every Workspace route resolves through the one shared helper", () => {
  it.each(PAGES)("%s calls loadWorkspaceForRoute and never service.get directly", (page) => {
    const source = read(page);
    expect(source).toContain("loadWorkspaceForRoute(service, actor, workspaceId)");
    expect(source).not.toMatch(/service\.get\(actor, workspaceId\)/);
  });

  it("the document route maps its document lookup the same way", () => {
    const source = read(PAGES[2]);
    expect(source).toContain("routeOr404(pageDocumentService().get(actor, workspaceId, documentId))");
  });

  it("the /workspaces boundaries exist and expose nothing from the error", () => {
    const notFoundPage = read("app/workspaces/not-found.tsx");
    const errorPage = read("app/workspaces/error.tsx");
    expect(notFoundPage).toContain("export default function");
    expect(errorPage).toContain('"use client"');
    // No message, digest or stack may be rendered — only logged.
    expect(errorPage).not.toMatch(/\{\s*error\.(message|digest|stack)/);
    expect(errorPage).toContain("console.error");
  });
});

describe("post-create navigation uses the identity the server returned", () => {
  const dialog = read("components/workspaces/WorkspaceCreateDialog.tsx");

  it("navigates with data.workspace.id through the shared href builder", () => {
    expect(dialog).toContain("workspaceHref(data.workspace.id, organizationId)");
    // Never a name, a slug, a list position or a hand-built template string.
    expect(dialog).not.toMatch(/\/workspaces\/\$\{/);
  });

  it("cannot submit twice", () => {
    // Two guards, one each side of the render. The in-flight guard is the
    // dialog's own: it covers the submit already dispatched, before React has
    // re-rendered anything.
    expect(dialog).toContain("if (loading) return;");
    expect(dialog).toContain('<Button type="submit" loading={loading}>');

    // The disabled attribute is `Button`'s, not this call site's. It used to be
    // written here as `disabled={loading}` beside `loading={loading}` — and four
    // other call sites that passed `loading` alone were double-submittable,
    // which is why the guard moved into the component (components/ui/Button.tsx,
    // asserted by components/ui/buttonStyles.test.ts).
    expect(read("components/ui/Button.tsx")).toContain(
      "disabled={loading || buttonProps.disabled}",
    );
  });

  it("hides nothing behind a delay, a retry or a poll", () => {
    expect(dialog).not.toMatch(/setTimeout|setInterval|sleep\(|retry/i);
  });
});

describe("refusals are observable to operators", () => {
  it("the container injects the logger WorkspaceService.get writes its diagnostics to", () => {
    expect(read("src/application/di/container.ts")).toMatch(
      /WorkspaceService[\s\S]{0,400}Tokens\.Logger/,
    );
  });
});
