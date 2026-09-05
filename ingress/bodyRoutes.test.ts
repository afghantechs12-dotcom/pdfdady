import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BODY_ROUTES } from "./bodyRoutes.mjs";
import { classifyPath, CLASS_B_MAX_BYTES } from "./policy.mjs";

/**
 * E1 — the ledger in `bodyRoutes.mjs` is checked against the filesystem.
 *
 * The requirement this satisfies: a new body-consuming route must not be able to
 * appear without a body policy assigned to it. A path-shaped class rule cannot
 * catch that on its own — `classifyPath` gives every new `/api/*` route a
 * ceiling automatically, which is safe but silent. These assertions are the
 * noise.
 *
 * They are deliberately source-text assertions and not behavioural ones. What is
 * being protected is the act of having decided, and the only durable witness to
 * a decision is that the decided-upon symbol is still called. A behavioural test
 * for 98 routes would be a second application; this is 60 lines and fails for the
 * one reason that matters.
 */

const APP = path.join(process.cwd(), "app");

/** Every `route.ts` under `app/`, as its URL path. */
function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

/**
 * Built fresh at each use, never shared. A `/g` regex carries `lastIndex` between
 * calls, so one module-level instance used for both `.test()` and `.matchAll()`
 * skips half the files and reports them as missing — which is exactly how this
 * test first failed.
 */
const MUTATING_SOURCE = "export\\s+(?:async\\s+function|const)\\s+(POST|PUT|PATCH|DELETE)";
const mutating = () => new RegExp(MUTATING_SOURCE, "g");
const READS_BODY =
  /\b(?:req|request|_req|_request)\s*\.\s*(?:formData|json|text|arrayBuffer|blob|bytes)\s*\(/;

/** The routes that can receive a body, discovered rather than declared. */
const discovered = routeFiles(APP)
  .map((file) => ({ file, source: readFileSync(file, "utf8") }))
  .filter(({ source }) => mutating().test(source) || READS_BODY.test(source))
  .map(({ file }) => "/" + path.relative(APP, path.dirname(file)));

const ledger = new Map(BODY_ROUTES.map((r) => [r.route, r]));

/** `[workspaceId]` → a concrete segment, so `classifyPath` sees a real path. */
const concrete = (route: string) => route.replace(/\[\.\.\.[^\]]+\]/g, "x/y").replace(/\[[^\]]+\]/g, "x");

describe("body policy ledger", () => {
  it("lists every route that can receive a request body", () => {
    const missing = discovered.filter((r) => !ledger.has(r));
    expect(missing, "add these to ingress/bodyRoutes.mjs with an assigned policy").toEqual([]);
  });

  it("lists no route that no longer exists", () => {
    const stale = [...ledger.keys()].filter((r) => !discovered.includes(r));
    expect(stale, "remove these from ingress/bodyRoutes.mjs").toEqual([]);
  });

  it("records the methods each route actually exports", () => {
    for (const entry of BODY_ROUTES) {
      const source = readFileSync(path.join(APP, entry.route.slice(1), "route.ts"), "utf8");
      const exported = [...source.matchAll(mutating())].map((m) => m[1]);
      expect([...entry.methods].sort(), entry.route).toEqual([...new Set(exported)].sort());
    }
  });

  it("still contains the evidence each entry claims", () => {
    for (const entry of BODY_ROUTES) {
      const source = readFileSync(path.join(APP, entry.route.slice(1), "route.ts"), "utf8");
      for (const symbol of entry.evidence) {
        expect(source, `${entry.route} no longer references ${symbol}`).toContain(symbol);
      }
    }
  });

  it("gives every streaming (class C) route a ceiling of its own", () => {
    for (const entry of BODY_ROUTES) {
      if (classifyPath(concrete(entry.route)) !== "C") continue;
      expect(entry.limit, `${entry.route} is class C and must own its ceiling`).not.toBeNull();
    }
  });

  it("keeps the canonical table in the evidence directory in step with the ledger", () => {
    const table = readFileSync(
      path.join(process.cwd(), "docs/evidence/final-prelaunch/ingress/BODY-ROUTES.md"),
      "utf8",
    );
    const absent = BODY_ROUTES.filter((r) => !table.includes(`\`${r.route}\``));
    expect(absent.map((r) => r.route), "regenerate the §2 table").toEqual([]);
  });

  it("keeps the class B ceiling above every per-route ceiling it must not pre-empt", () => {
    // The largest of them; if one of these grows past the class ceiling, the route
    // starts answering 413 from the ingress and its own error never runs.
    const largest = 1_056_768; // MAX_AUTOSAVE_BODY_BYTES: 1 MiB payload + 8 KiB envelope
    expect(CLASS_B_MAX_BYTES).toBeGreaterThan(largest);
  });
});
