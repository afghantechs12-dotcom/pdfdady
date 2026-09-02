import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Public routes must not ship the heavy application code.
 *
 * The launch brief makes three of these non-negotiable: a marketing page must
 * never load PDF.js, the editor application, or the Workspace application.
 * Each is hundreds of kilobytes that a visitor reading the homepage cannot
 * possibly use, and each has crept in before — `HeroUpload` imported the entire
 * 45-tool catalog into the homepage bundle simply to render four links.
 *
 * Rather than eyeball a bundle report once, this reads the per-route client
 * reference manifests that `next build` writes. A component that becomes a
 * client component, or a client component that grows an import of the editor,
 * fails here.
 *
 * The manifests only exist after a production build. When they are absent the
 * suite skips rather than fails: `npm run test` is routinely run without a
 * preceding build, and a test that fails for that reason would be noise. The
 * final gate sequence runs `build` before `test`, so the check is enforced
 * where it matters.
 */

const ROOT = join(__dirname, "..", "..");

/** Routes a signed-out visitor can reach, and their manifest paths. */
const PUBLIC_ROUTES: { label: string; manifest: string }[] = [
  { label: "/", manifest: "(marketing)/page" },
  { label: "/tools", manifest: "(marketing)/tools/page" },
  { label: "/tools/[slug]", manifest: "(marketing)/tools/[slug]/page" },
  { label: "/pricing", manifest: "(marketing)/pricing/page" },
  { label: "/blog", manifest: "(marketing)/blog/page" },
  { label: "/blog/[slug]", manifest: "(marketing)/blog/[slug]/page" },
  { label: "/about", manifest: "(marketing)/about/page" },
  { label: "/contact", manifest: "(marketing)/contact/page" },
];

/**
 * Module paths that must not appear in a public route's client bundle, with
 * the reason each is disqualifying.
 */
const FORBIDDEN: { pattern: RegExp; because: string }[] = [
  { pattern: /node_modules[\\/]pdfjs-dist/, because: "PDF.js is ~1 MB and no public page renders a PDF" },
  { pattern: /[\\/]components[\\/]editor[\\/]/, because: "the editor application must not load on a marketing page" },
  { pattern: /[\\/]components[\\/]workspaces[\\/]/, because: "the Workspace application must not load on a marketing page" },
  { pattern: /[\\/]components[\\/]app[\\/]/, because: "authenticated app chrome must not load on a marketing page" },
  { pattern: /[\\/]src[\\/]application[\\/]editor[\\/]/, because: "the editor core must not load on a marketing page" },
  { pattern: /[\\/]components[\\/]admin[\\/]/, because: "admin console code must not load on a public page" },
];

function manifestPathFor(route: string): string {
  // `route` already ends in the segment whose manifest we want ("…/page"), so
  // the file sits beside it: <segment>_client-reference-manifest.js.
  const parts = route.split("/");
  const leaf = parts.pop()!;
  return join(
    ROOT,
    ".next",
    "server",
    "app",
    ...parts,
    `${leaf}_client-reference-manifest.js`,
  );
}

/** Parses the client module ids out of a built route manifest. */
function clientModulesFor(route: string): string[] | null {
  const file = manifestPathFor(route);
  if (!existsSync(file)) return null;
  const source = readFileSync(file, "utf8");
  const assignment = source.indexOf("] = ");
  if (assignment === -1) return null;
  const json = source.slice(assignment + 4).replace(/;\s*$/, "");
  const parsed = JSON.parse(json) as { clientModules?: Record<string, unknown> };
  return Object.keys(parsed.clientModules ?? {});
}

const built = existsSync(join(ROOT, ".next", "server", "app"));

describe.skipIf(!built)("public route client bundles", () => {
  it("finds the built manifests it is meant to inspect", () => {
    // Without this, a change to Next's output layout would make every
    // assertion below vacuous.
    const found = PUBLIC_ROUTES.filter((r) => clientModulesFor(r.manifest) !== null);
    expect(found.length, "no public route manifests were readable").toBeGreaterThan(0);
  });

  for (const route of PUBLIC_ROUTES) {
    describe(route.label, () => {
      for (const { pattern, because } of FORBIDDEN) {
        it(`excludes ${pattern.source} (${because})`, () => {
          const modules = clientModulesFor(route.manifest);
          if (modules === null) return; // route not built in this run
          const offenders = modules.filter((m) => pattern.test(m));
          expect(
            offenders,
            `${route.label} pulls in: ${offenders.slice(0, 5).join(", ")}`,
          ).toEqual([]);
        });
      }
    });
  }

  it("keeps the homepage's client module count modest", () => {
    const modules = clientModulesFor("(marketing)/page");
    if (modules === null) return;
    // Not a byte budget — a tripwire. The homepage's only client components
    // are the header, the hero uploader and the FAQ accordion; a jump here
    // means something became interactive that did not need to be.
    expect(modules.length).toBeLessThan(80);
  });
});
