import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PILOT_TOOL_SLUG } from "@/lib/server/processingPilot";

/**
 * The pilot's tool page must be rendered per request, not frozen into the build.
 *
 * THE BUG THIS PINS. `app/(marketing)/tools/[slug]/page.tsx` picks the runner —
 * legacy `ServerToolRunner` or `PipelineToolRunner` — from
 * `isProcessingPipelineEnabled`, a flag an operator flips at runtime. That page
 * also has `generateStaticParams`, so without an explicit request-time marker
 * Next prerenders it during the build and bakes in whichever runner the BUILD
 * machine's flag said. `/api/jobs` keeps reading the flag per request. The two
 * halves then disagree, and the disagreement is not a near miss:
 *
 *   stale legacy runner submits → route creates a unified-pipeline job →
 *   the legacy SSE client reads the pipeline's terminal frame, which carries a
 *   `stage` and no `result`, as a failure
 *
 * so the user is told "Processing failed. Please try again." about a job that
 * completed and whose output is sitting in storage. That is what a browser did
 * before this was fixed, while ~170 Node tests stayed green — none of them
 * render a page, so none of them can see which runner shipped.
 *
 * WHY TWO TESTS. The build-output test below is the real one: it checks the
 * artifact a user is actually served. It can only run after a production build,
 * which is the house order (`node scripts/next-build.js` then `npx vitest run`).
 * The source test runs anywhere, including a fresh clone, and pins the mechanism
 * so a refactor that drops the marker fails immediately rather than at the next
 * flag flip.
 *
 * WHAT SLICE 3.2 CHANGED, AND WHY THIS TEST FAILED WHEN IT DID. Nonce-based CSP
 * enforcement put `export const dynamic = "force-dynamic"` on the root layout,
 * because a prerendered document is built once and served from cache and therefore
 * physically cannot carry a per-request nonce. So EVERY page route is now dynamic,
 * not just the pilot's. This test failed at that moment — and correctly: its
 * anti-vacuity guard was "other tool pages ARE prerendered, so the pilot's absence
 * is a decision", and that premise is now false. The invariant it protects is
 * unchanged and in fact holds twice over (the layout AND this page's own
 * `await connection()`), but the guard had to be rewritten to a premise that is
 * still true, rather than relaxed. The `await connection()` marker is deliberately
 * KEPT: pilot correctness must not become a side effect of a CSP decision that a
 * future slice could reverse.
 */

const PAGE = path.join(
  process.cwd(),
  "app",
  "(marketing)",
  "tools",
  "[slug]",
  "page.tsx",
);
const MANIFEST = path.join(process.cwd(), ".next", "prerender-manifest.json");

describe("the pilot tool page is not statically prerendered", () => {
  it.skipIf(!existsSync(MANIFEST))(
    "is absent from the build's prerender manifest (skipped without a production build)",
    () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
        routes?: Record<string, unknown>;
      };
      const prerendered = Object.keys(manifest.routes ?? {});

      // Not vacuous: the build DID prerender things, so an absence below is a
      // decision and not an empty manifest or a changed manifest shape. What it
      // prerenders is now only metadata and asset routes (/icon, /opengraph-image,
      // /robots.txt, /sitemap.xml, and the per-slug blog OG images) — those do not
      // execute scripts, so they need no nonce and stay at build time.
      expect(prerendered.length).toBeGreaterThan(5);
      expect(prerendered).toContain("/sitemap.xml");

      expect(prerendered).not.toContain(`/tools/${PILOT_TOOL_SLUG}`);

      // Stronger than the pre-3.2 assertion, not weaker: no tool page is frozen
      // into the build at all now, so no tool page can ship a stale runner choice.
      // If a future slice reverses the root layout's `force-dynamic`, this line
      // keeps holding only because of this page's own `await connection()`.
      expect(prerendered.filter((r) => r.startsWith("/tools/"))).toEqual([]);
    },
  );

  it("reads the pilot flag behind a request-time marker, before choosing a runner", () => {
    const src = readFileSync(PAGE, "utf8");

    expect(src).toMatch(/import \{ connection \} from "next\/server"/);

    const marker = src.indexOf("await connection()");
    const flagRead = src.indexOf("isProcessingPipelineEnabled(slug)");
    expect(marker).toBeGreaterThan(-1);
    expect(flagRead).toBeGreaterThan(-1);
    // Order matters, not just presence: a marker placed after the flag read
    // would not stop the build from prerendering the decision.
    expect(marker).toBeLessThan(flagRead);

    // Scoped to the pilot on purpose. It no longer buys static rendering for the
    // other tool slugs (3.2's root layout made them all dynamic) — it buys the pilot
    // independence from that decision, so this page renders per request even if the
    // layout's `force-dynamic` is ever removed.
    expect(src).toMatch(/if \(slug === PILOT_TOOL_SLUG\) await connection\(\)/);
  });
});
