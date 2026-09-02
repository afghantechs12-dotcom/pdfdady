import { describe, expect, it } from "vitest";
import {
  APP_NAV_ITEMS,
  QUICK_ACCESS_CARDS,
  activeNavItemId,
  formatCount,
  itemCountLabel,
  navItemHref,
  navItemsForSection,
  workspaceHref,
} from "./appShellLogic";

describe("navigation structure", () => {
  it("offers no AI Assistant entry, because no AI capability is implemented", () => {
    const labels = APP_NAV_ITEMS.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("ai"))).toBe(false);
    expect(QUICK_ACCESS_CARDS.some((card) => card.id.includes("ai"))).toBe(false);
  });

  it("offers no 'Shared with me' entry, because no such listing view exists", () => {
    expect(APP_NAV_ITEMS.some((item) => item.label.toLowerCase().includes("shared"))).toBe(false);
  });

  it("groups items into the Workspace and Tools sections", () => {
    expect(navItemsForSection("workspace").map((i) => i.id)).toEqual([
      "home",
      "documents",
      "favorites",
      "recent",
      "archived",
      "trash",
    ]);
    expect(navItemsForSection("tools").map((i) => i.id)).toEqual(["editor"]);
  });

  it("gives every item a unique id", () => {
    const ids = APP_NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("workspaceHref", () => {
  it("encodes both ids so an id with a slash cannot redirect elsewhere", () => {
    expect(workspaceHref("workspace one", "org/1")).toBe(
      "/workspaces/workspace%20one?organizationId=org%2F1",
    );
  });

  it("omits the default view rather than pinning ?view=all onto every link", () => {
    expect(workspaceHref("w1", "o1", { view: "all" })).toBe("/workspaces/w1?organizationId=o1");
    expect(workspaceHref("w1", "o1", { view: null })).toBe("/workspaces/w1?organizationId=o1");
  });

  it("carries a non-default view", () => {
    expect(workspaceHref("w1", "o1", { view: "favorites" })).toBe(
      "/workspaces/w1?organizationId=o1&view=favorites",
    );
  });

  it("appends a sub-path before the query", () => {
    expect(workspaceHref("w1", "o1", { path: "/settings" })).toBe(
      "/workspaces/w1/settings?organizationId=o1",
    );
  });
});

describe("navItemHref", () => {
  it("sends standalone-route items to their route, not a Workspace view", () => {
    const editor = APP_NAV_ITEMS.find((item) => item.id === "editor")!;
    expect(navItemHref(editor, "w1", "o1")).toBe("/editor");
  });

  it("sends view items to the tenant-scoped Workspace URL", () => {
    const favorites = APP_NAV_ITEMS.find((item) => item.id === "favorites")!;
    expect(navItemHref(favorites, "w1", "o1")).toBe("/workspaces/w1?organizationId=o1&view=favorites");
  });
});

describe("activeNavItemId", () => {
  it("marks Home on the bare Workspace route", () => {
    expect(activeNavItemId({ pathname: "/workspaces/w1", view: null, workspaceId: "w1" })).toBe("home");
  });

  it("treats an explicit view=all as Documents rather than leaving nothing current", () => {
    expect(activeNavItemId({ pathname: "/workspaces/w1", view: "all", workspaceId: "w1" })).toBe(
      "documents",
    );
  });

  it("marks the matching view item", () => {
    expect(activeNavItemId({ pathname: "/workspaces/w1", view: "trashed", workspaceId: "w1" })).toBe(
      "trash",
    );
  });

  it("marks the editor on the editor route", () => {
    expect(activeNavItemId({ pathname: "/editor", view: null, workspaceId: "w1" })).toBe("editor");
  });

  it("marks nothing on a Workspace sub-route such as settings", () => {
    expect(
      activeNavItemId({ pathname: "/workspaces/w1/settings", view: null, workspaceId: "w1" }),
    ).toBeNull();
  });

  it("marks nothing when the path belongs to a different Workspace", () => {
    expect(activeNavItemId({ pathname: "/workspaces/other", view: null, workspaceId: "w1" })).toBeNull();
  });

  it("does not confuse a Workspace whose id prefixes another", () => {
    // "/workspaces/w10" must not match workspace "w1".
    expect(activeNavItemId({ pathname: "/workspaces/w10", view: null, workspaceId: "w1" })).toBeNull();
  });
});

describe("formatCount", () => {
  it("renders a real zero, because zero is information", () => {
    expect(formatCount(0)).toBe("0");
  });

  it("renders nothing when the count is unknown", () => {
    expect(formatCount(undefined)).toBeNull();
    expect(formatCount(null)).toBeNull();
  });

  it("rejects nonsense rather than displaying it", () => {
    expect(formatCount(Number.NaN)).toBeNull();
    expect(formatCount(-3)).toBeNull();
  });

  it("abbreviates large counts", () => {
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1500)).toBe("1.5k");
  });
});

describe("itemCountLabel", () => {
  it("pluralizes correctly", () => {
    expect(itemCountLabel(1)).toBe("1 document");
    expect(itemCountLabel(2)).toBe("2 documents");
    expect(itemCountLabel(0)).toBe("0 documents");
  });

  it("is absent when the count is unknown", () => {
    expect(itemCountLabel(undefined)).toBeNull();
  });
});
