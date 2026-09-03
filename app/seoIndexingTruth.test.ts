/**
 * R24/R25 — the two halves of one launch property: a route is either advertised
 * to crawlers or told not to be indexed, and what is advertised has to be true.
 *
 * The private-route list is NOT written down here. Hardcoding one is how the next
 * private page gets missed: the list would still be green while the new page was
 * indexable. So the rule is derived instead — every `app/**\/page.tsx` in the tree
 * is checked against `sitemap()`'s own output, and anything that surface does not
 * advertise must carry (or inherit) `robots: { index: false }`. A page added
 * tomorrow is covered the moment it exists.
 *
 * Every assertion calls the thing it is about: `sitemap()` and `robots()` are
 * invoked, and each page's `metadata` is read from the imported module rather
 * than grepped out of its source.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import robots from "./robots";
import sitemap from "./sitemap";
import { capabilityForSlug } from "@/lib/tools/capability";

const APP = join(process.cwd(), "app");

/** Every page module in the app tree, as a repo-relative path. */
function pageFiles(dir = APP, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pageFiles(full, out);
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out.sort();
}

/** `app/(marketing)/tools/[slug]/page.tsx` → `/tools/[slug]`. Route groups vanish. */
function routeOf(file: string): string {
  const segments = file
    .slice(APP.length + 1, -"/page.tsx".length)
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith("("));
  return `/${segments.join("/")}`;
}

/** Directories from the app root down to the page, for layout inheritance. */
function ancestorLayouts(file: string): string[] {
  const parts = file.slice(APP.length + 1).split("/").slice(0, -1);
  return parts.map((_, i) => join(APP, ...parts.slice(0, i + 1), "layout.tsx")).concat(join(APP, "layout.tsx"));
}

/** Does a concrete sitemap pathname satisfy this (possibly dynamic) route? */
function matches(route: string, pathname: string): boolean {
  const pattern = route
    .split("/")
    .map((s) => (/^\[\.\.\..+\]$/.test(s) ? ".+" : /^\[.+\]$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${pattern}/?$`).test(pathname);
}

type Meta = { robots?: { index?: boolean } };
const noindexed = (m: Meta | undefined) => m?.robots?.index === false;

/** True when the page cannot be indexed because it never renders anything. */
async function alwaysRedirects(mod: { default: (p: never) => unknown }): Promise<boolean> {
  try {
    await mod.default({ searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never);
    return false;
  } catch (err) {
    return String((err as { digest?: string })?.digest ?? "").startsWith("NEXT_REDIRECT");
  }
}

describe("R24 — no private route is indexable", () => {
  it("advertises a route in the sitemap or marks it noindex, with nothing in between", async () => {
    const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
    const advertised: string[] = [];
    const blocked: string[] = [];
    const offenders: string[] = [];

    for (const file of pageFiles()) {
      const route = routeOf(file);
      if (paths.some((p) => matches(route, p))) {
        advertised.push(route);
        continue;
      }
      const mod = (await import(file)) as { default: (p: never) => unknown; metadata?: Meta };
      const own = noindexed(mod.metadata);
      const inherited = own
        ? false
        : (
            await Promise.all(
              ancestorLayouts(file).map(async (l) => {
                try {
                  return noindexed(((await import(l)) as { metadata?: Meta }).metadata);
                } catch {
                  return false;
                }
              }),
            )
          ).some(Boolean);
      if (own || inherited || (await alwaysRedirects(mod))) blocked.push(route);
      else offenders.push(route);
    }

    expect(offenders).toEqual([]);
    // Anti-vacuity: both branches were populated, and the walker saw the tree.
    expect(advertised.length).toBeGreaterThan(20);
    expect(blocked.length).toBeGreaterThan(8);
    // The Workspace file manager. It was the one page in this tree with no
    // metadata at all, and the sitemap does not carry it — so it was indexable.
    expect(blocked).toContain("/workspaces/[workspaceId]");
  });

  it("never submits a URL that robots.txt forbids crawling", async () => {
    const [{ rules }, entries] = await Promise.all([robots(), sitemap()]);
    const disallow = [rules].flat().flatMap((r) => [r.disallow ?? []].flat());
    expect(disallow).toContain("/admin");
    expect(disallow).toContain("/api");
    const contradictions = entries
      .map((e) => new URL(e.url).pathname)
      .filter((p) => disallow.some((d) => p === d || p.startsWith(`${d}/`)));
    expect(contradictions).toEqual([]);
  });
});

describe("R25 — the sitemap tells the truth about what it advertises", () => {
  it("lists only tools this build can actually run, at the capability's own route", async () => {
    const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
    const toolPaths = paths.filter((p) => p.startsWith("/tools/") && p !== "/tools/");
    expect(toolPaths.length).toBeGreaterThan(20);
    for (const p of toolPaths) {
      const capability = capabilityForSlug(p.slice("/tools/".length));
      expect(capability?.available, p).toBe(true);
      expect(capability?.route).toBe(p);
    }
  });

  it("drops an unavailable slug even when the tool registry offers one", async () => {
    vi.resetModules();
    vi.doMock("@/lib/seo/adminRuntime", async (orig) => {
      const real = (await orig()) as typeof import("@/lib/seo/adminRuntime");
      return {
        ...real,
        getToolsList: async () => [
          ...(await real.getToolsList()),
          { slug: "chat-with-pdf", status: "functional-server", title: "Chat" },
        ],
        getBlogList: async () => [],
      };
    });
    const fresh = (await import("./sitemap")).default;
    const paths = (await fresh()).map((e) => new URL(e.url).pathname);
    vi.doUnmock("@/lib/seo/adminRuntime");
    vi.resetModules();

    expect(capabilityForSlug("chat-with-pdf")?.available).toBe(false);
    expect(paths).not.toContain("/tools/chat-with-pdf");
    expect(paths).toContain("/tools/merge-pdf"); // the injection did not empty the list
  });

  it("emits absolute, unique URLs on one origin", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls.length).toBeGreaterThan(30);
    expect(new Set(urls).size).toBe(urls.length);
    const origins = new Set(urls.map((u) => new URL(u).origin));
    expect(origins.size).toBe(1);
  });
});

/**
 * R24, the half that was missing: a 404 is a route too.
 *
 * `pageFiles()` above cannot see this one — Next's 404 is `not-found.tsx`, not
 * `page.tsx` — so every unknown public url was outside the rule this file
 * enforces. There was no root `not-found.tsx` at all, which meant a mistyped
 * marketing url got Next's framework default page: no brand, no navigation, no
 * link back, and (because that page carries its own `prefers-color-scheme:dark`
 * styles) a near-black screen on a dark-mode machine. The visual harness
 * recorded exactly that as the reference for `18-not-found` and passed it.
 */
describe("R24 — the public 404 is the product's own page, not the framework's", () => {
  it("exists at the root, so it answers for every route group", async () => {
    const mod = await import("./not-found");
    expect(typeof mod.default, "app/not-found.tsx must default-export a component")
      .toBe("function");
  });

  it("is noindex, like every other page the sitemap does not advertise", async () => {
    const { metadata } = await import("./not-found");
    expect(metadata?.robots).toMatchObject({ index: false });
  });

  it("offers a way back, which is the only thing a 404 owes the visitor", async () => {
    const src = readFileSync(join(APP, "not-found.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join(" ");
    expect(src, "a dead end is the framework default's actual defect")
      .toMatch(/href="\/"/);
    expect(src, "and it must carry its own chrome: the root layout has no header")
      .toMatch(/<Logo|LogoMark/);
    expect(src, "the root layout's skip link targets #main on every route")
      .toContain('id="main"');
  });
});

/**
 * The doubled brand, found at runtime on the new 404: "Page not found — PDFDadi
 * — PDFDadi".
 *
 * `app/layout.tsx` declares an admin-editable `title.template` (`%s — PDFDadi`
 * by default), so any page whose own title already ends in the product name gets
 * it appended a second time. Five authenticated pages did — every `brandTitle()`
 * caller — because nothing between them and the root layout re-declares the
 * template. The rule is derived from the template itself rather than from a list
 * of files, so the next page to brand its own title is caught the day it lands.
 */
describe("page titles do not brand themselves twice", () => {
  it("uses title.absolute for any title that already carries the product name", async () => {
    // `getSITE()` is where the root layout reads its template from; importing
    // `./layout` itself pulls in `next/font/google`, which needs the Next build.
    const { getSITE } = await import("@/lib/seo/metadata");
    const suffix = (await getSITE()).titleTemplate.replace("%s", "").trim();
    expect(suffix, "the root template must still append something, or this rule is moot")
      .not.toBe("");

    const offenders: string[] = [];
    for (const file of [...pageFiles(), join(APP, "not-found.tsx"), join(APP, "workspaces/not-found.tsx")]) {
      const mod = (await import(file)) as { metadata?: { title?: unknown } };
      const title = mod.metadata?.title;
      if (typeof title === "string" && title.includes(suffix)) offenders.push(file.slice(APP.length + 1));
    }
    expect(offenders, `these titles render as "…${suffix} ${suffix}"`).toEqual([]);
  });
});
