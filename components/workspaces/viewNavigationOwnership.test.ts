import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_NAV_ITEMS, navItemsForSection } from "@/components/app/appShellLogic";

/**
 * The five document views are navigated from exactly one place: the sidebar.
 *
 * `DocumentFileManager` used to render its own vertical rail with the same five
 * labels the sidebar's Workspace section already had. The duplication was not
 * just visual weight (~160px of the document list, at every desktop width) —
 * the two controls disagreed about state:
 *
 *   sidebar → `<Link href="?view=favorites">`  (navigates; URL is the truth)
 *   rail    → `onClick={() => loadView(...)}`  (local state only; URL unchanged)
 *
 * So selecting a view in the rail left the sidebar highlighting the old item,
 * and a refresh or Back press reverted the list without warning.
 *
 * These assertions read source text because the suite runs in Node with no DOM
 * renderer. They are deliberately about the *contract* (one owner for view
 * navigation), not about markup details that will drift. (Launch polish P1-9.)
 */

const ROOT = join(__dirname, "..", "..");
const fileManager = readFileSync(
  join(ROOT, "components", "workspaces", "DocumentFileManager.tsx"),
  "utf8",
);

describe("document view navigation has a single owner", () => {
  it("the sidebar still offers all five views", () => {
    const views = navItemsForSection("workspace")
      .map((item) => item.view)
      .filter((view): view is string => view !== null);
    expect(views).toEqual(["all", "favorites", "recent", "archived", "trashed"]);
  });

  it("the file manager no longer renders a competing view rail", () => {
    expect(fileManager).not.toContain('aria-label="Document views"');
  });

  it("the file manager does not re-list the sidebar's view labels as controls", () => {
    // The labels still exist as a *heading* lookup (VIEW_LABELS), which is why
    // this asserts on the rail's rendering shape rather than on the strings.
    const railButtons = /VIEWS\.map\(/.test(fileManager);
    expect(railButtons).toBe(false);
  });

  it("every sidebar view remains reachable by URL", () => {
    // Guards the removal: the rail is gone, so these links are now the only way
    // in. A view that stopped being linkable would strand the documents in it.
    for (const item of APP_NAV_ITEMS) {
      if (item.view === null) continue;
      expect(item.route).toBeNull();
      expect(typeof item.view).toBe("string");
    }
  });
});
