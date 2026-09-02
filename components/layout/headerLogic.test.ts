import { describe, expect, it } from "vitest";
import {
  GET_STARTED_HREF,
  LOGIN_LINK,
  OPEN_WORKSPACE_HREF,
  PRIMARY_CTA,
  authenticatedNavLinks,
  isActiveNavHref,
  navLinksForSession,
  menuKeyFor,
  registerHrefFor,
  resolveNavToolGroups,
  resolveNavToolMenus,
} from "./headerLogic";
import {
  navLinks as defaultNavLinks,
  navToolGroups,
  navToolMenus,
} from "@/data/nav";
import { tools } from "@/data/tools";
import type { Tool } from "@/data/tools";

/**
 * These assert the launch acceptance gates that concern navigation. They are
 * written against the pure logic module rather than rendered markup so that
 * restyling the header cannot silently break a product decision.
 */

describe("launch acceptance gates — navigation", () => {
  it("gives Tools its own header item", () => {
    expect(defaultNavLinks.some((link) => link.href === "/tools")).toBe(true);
  });

  it("keeps Pricing visible in the header", () => {
    expect(defaultNavLinks.some((link) => link.href === "/pricing")).toBe(true);
  });

  it("does NOT point Get Started Free at the Tools page", () => {
    // The specific defect found in the audit: the CTA linked to /tools.
    expect(GET_STARTED_HREF).not.toBe("/tools");
    expect(GET_STARTED_HREF.startsWith("/tools")).toBe(false);
  });

  it("points Get Started Free at registration, returning to workspaces", () => {
    expect(GET_STARTED_HREF).toBe("/register?returnTo=/workspaces");
  });

  it("offers a sign-in action", () => {
    expect(LOGIN_LINK.href).toBe("/login");
  });

  it("makes Open Workspace the signed-in primary CTA", () => {
    expect(PRIMARY_CTA.signedIn.label).toBe("Open Workspace");
    expect(PRIMARY_CTA.signedIn.href).toBe(OPEN_WORKSPACE_HREF);
  });
});

describe("navLinksForSession", () => {
  it("shows the public marketing nav when signed out", () => {
    expect(navLinksForSession(defaultNavLinks, false)).toEqual(defaultNavLinks);
  });

  it("offers routes back into the product when signed in", () => {
    const links = navLinksForSession(defaultNavLinks, true);
    const hrefs = links.map((l) => l.href);
    expect(hrefs).toContain("/workspaces");
    expect(hrefs).toContain("/editor");
    expect(hrefs).toContain("/tools");
  });

  it("drops the top-of-funnel marketing items when signed in", () => {
    const hrefs = navLinksForSession(defaultNavLinks, true).map((l) => l.href);
    expect(hrefs).not.toContain("/#features");
    expect(hrefs).not.toContain("/about");
  });

  it("never produces duplicate destinations", () => {
    for (const signedIn of [true, false]) {
      const hrefs = navLinksForSession(defaultNavLinks, signedIn).map((l) => l.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });

  it("tolerates an admin-emptied nav without inventing marketing links", () => {
    // Nav is admin-editable at runtime, so the empty case is reachable.
    const links = authenticatedNavLinks([]);
    expect(links.map((l) => l.href)).toEqual(["/workspaces", "/editor"]);
  });
});

describe("isActiveNavHref", () => {
  it("matches the exact route", () => {
    expect(isActiveNavHref("/tools", "/tools")).toBe(true);
  });

  it("matches a nested route under the same section", () => {
    expect(isActiveNavHref("/tools", "/tools/merge-pdf")).toBe(true);
  });

  it("does not treat a shared prefix as the same section", () => {
    // "/tools" must not light up on "/toolsmith".
    expect(isActiveNavHref("/tools", "/toolsmith")).toBe(false);
  });

  it("only matches the homepage exactly", () => {
    expect(isActiveNavHref("/", "/")).toBe(true);
    expect(isActiveNavHref("/", "/tools")).toBe(false);
  });

  it("never marks in-page hash links active", () => {
    expect(isActiveNavHref("/#features", "/")).toBe(false);
  });
});

describe("registerHrefFor", () => {
  it("defaults to the workspaces destination", () => {
    expect(registerHrefFor(null)).toBe("/register?returnTo=%2Fworkspaces");
  });
  it("carries a relative destination through", () => {
    expect(registerHrefFor("/workspaces/abc")).toBe(
      "/register?returnTo=%2Fworkspaces%2Fabc",
    );
  });

  it("refuses hostile destinations and falls back to workspaces", () => {
    // safeRedirectPath is the real boundary, but this helper must not be the
    // thing that authors a hostile link in the first place.
    const fallback = "/register?returnTo=%2Fworkspaces";
    expect(registerHrefFor("https://evil.test")).toBe(fallback);
    expect(registerHrefFor("//evil.test")).toBe(fallback);
    expect(registerHrefFor("/\\evil.test")).toBe(fallback);
    expect(registerHrefFor("javascript:alert(1)")).toBe(fallback);
    expect(registerHrefFor("")).toBe(fallback);
  });
});

/**
 * The header's Tools dropdown.
 *
 * The rule these protect: a navigation menu must not link a tool a visitor
 * cannot use. `ToolCard` already refuses to link unavailable tools — it renders
 * them as a plain div, outside the tab order — and a dropdown that linked the
 * same tool anyway would route around that decision.
 */
describe("resolveNavToolGroups", () => {
  const fake = (slug: string, status: Tool["status"]): Tool =>
    ({ slug, status, name: slug, href: `/tools/${slug}` }) as Tool;

  it("resolves committed groups against the real registry", () => {
    const groups = resolveNavToolGroups(navToolGroups, tools);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.tools.length, `${group.title} is empty`).toBeGreaterThan(0);
    }
  });

  it("never surfaces a tool that cannot be run", () => {
    const groups = resolveNavToolGroups(navToolGroups, tools);
    const bySlug = new Map(tools.map((t) => [t.slug, t]));
    for (const group of groups) {
      for (const tool of group.tools) {
        const status = bySlug.get(tool.slug)?.status;
        expect(
          status === "functional-client" || status === "functional-server",
          `${tool.slug} is ${status} and must not appear in the menu`,
        ).toBe(true);
      }
    }
  });

  it("drops a slug with no matching tool rather than linking nowhere", () => {
    // The registry is admin-mergeable at runtime, so this case is reachable.
    const groups = resolveNavToolGroups(
      [{ title: "Edit", slugs: ["edit-pdf", "does-not-exist"] }],
      [fake("edit-pdf", "functional-client")],
    );
    expect(groups[0].tools.map((t) => t.slug)).toEqual(["edit-pdf"]);
  });

  it("drops planned and AI tools", () => {
    const groups = resolveNavToolGroups(
      [{ title: "Mixed", slugs: ["works", "planned", "ai"] }],
      [
        fake("works", "functional-server"),
        fake("planned", "planned"),
        fake("ai", "coming-soon-ai"),
      ],
    );
    expect(groups[0].tools.map((t) => t.slug)).toEqual(["works"]);
  });

  it("omits a group that would render as a heading over nothing", () => {
    const groups = resolveNavToolGroups(
      [
        { title: "Empty", slugs: ["planned"] },
        { title: "Real", slugs: ["works"] },
      ],
      [fake("works", "functional-client"), fake("planned", "planned")],
    );
    expect(groups.map((g) => g.title)).toEqual(["Real"]);
  });

  it("returns nothing when the registry is empty", () => {
    expect(resolveNavToolGroups(navToolGroups, [])).toEqual([]);
  });
});

/**
 * The multi-menu header (Tools / Edit / Convert).
 *
 * The rule these protect: a nav item may only render as a menu trigger if the
 * menu it names actually resolves to something. Otherwise a visitor gets a
 * button that opens an empty panel — strictly worse than the plain link the item
 * degrades to.
 */
describe("resolveNavToolMenus", () => {
  const fake = (slug: string, status: Tool["status"]): Tool =>
    ({ slug, status, name: slug, href: `/tools/${slug}` }) as Tool;

  it("resolves every committed menu against the real registry", () => {
    const menus = resolveNavToolMenus(navToolMenus, tools);
    // Every menu the nav names must survive resolution against the real data.
    for (const key of Object.keys(navToolMenus)) {
      expect(menus[key], `menu "${key}" resolved to nothing`).toBeDefined();
      expect(menus[key].length).toBeGreaterThan(0);
    }
  });

  it("never surfaces a tool that cannot be run", () => {
    const menus = resolveNavToolMenus(navToolMenus, tools);
    const bySlug = new Map(tools.map((t) => [t.slug, t]));
    for (const groups of Object.values(menus)) {
      for (const group of groups) {
        for (const tool of group.tools) {
          const status = bySlug.get(tool.slug)?.status;
          expect(
            status === "functional-client" || status === "functional-server",
            `${tool.slug} is ${status} and must not appear in a menu`,
          ).toBe(true);
        }
      }
    }
  });

  it("omits a menu key entirely when nothing in it resolves", () => {
    const menus = resolveNavToolMenus(
      {
        real: [{ title: "Works", slugs: ["works"] }],
        dead: [{ title: "Planned", slugs: ["planned"] }],
      },
      [fake("works", "functional-client"), fake("planned", "planned")],
    );
    expect(Object.keys(menus)).toEqual(["real"]);
  });

  it("returns no menus when the registry is empty", () => {
    expect(resolveNavToolMenus(navToolMenus, [])).toEqual({});
  });
});

describe("menuKeyFor", () => {
  const menus = { tools: [{ title: "Edit", tools: [] }] };

  it("opens the menu a nav item names", () => {
    expect(menuKeyFor({ label: "Tools", href: "/tools", menu: "tools" }, menus)).toBe(
      "tools",
    );
  });

  it("treats a plain link as a plain link", () => {
    expect(menuKeyFor({ label: "Pricing", href: "/pricing" }, menus)).toBeNull();
  });

  it("honours the legacy hasDropdown flag as the Tools menu", () => {
    // `nav` is admin-editable, so entries written before menus existed persist.
    expect(menuKeyFor({ label: "Tools", href: "/tools", hasDropdown: true }, menus)).toBe(
      "tools",
    );
  });

  it("degrades to a plain link when the named menu resolved to nothing", () => {
    expect(menuKeyFor({ label: "Edit", href: "/tools/edit-pdf", menu: "edit" }, menus)).toBeNull();
    expect(menuKeyFor({ label: "Tools", href: "/tools", hasDropdown: true }, {})).toBeNull();
  });
});
