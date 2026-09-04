import { defineConfig } from "vitest/config";

/**
 * Vitest configuration.
 *
 * The `@` alias mirrors the tsconfig `paths` mapping (`@/*` → project root) so
 * tests can import application modules via `@/src/...` exactly as the app does.
 * The unit tests target self-contained security + architecture primitives; a
 * plain Node environment suffices (no DOM, no Next runtime).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": process.cwd(),
      // See test/stubs/server-only.ts — the guard package ships with Next, not npm.
      "server-only": `${process.cwd()}/test/stubs/server-only.ts`,
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // `.billing-backup-*` is a hand-made snapshot of an older tree (this repo is
    // not Git-backed, so a slice that rewrites billing files keeps one). Its
    // stale copies of `*.test.ts` are not source and must not be collected —
    // otherwise a snapshot of yesterday's assertions fails today's suite.
    exclude: ["node_modules/**", ".next/**", ".kiro/**", ".billing-backup-*/**"],
    // An explicit per-test budget, because the default one was never chosen.
    //
    // Vitest's default is 5000ms. `app/seoIndexingTruth.test.ts` derives the
    // private-route rule by importing every `app/**/page.tsx` — 55 modules today,
    // one more with every page added — so its cost scales with the app, not with
    // anything the test controls. Measured on this machine: 1591ms run alone,
    // 4263ms under the CPU contention of the other 379 test files. 85% of a budget
    // nobody set. It crossed once, at the branch tip, and the report recorded
    // `1 failed | 7375 passed` with no name attached to the failure.
    //
    // 30s is ~7x the measured worst case, which is margin for a slower machine and
    // for the pages this tree has not grown yet. The assertions are untouched: the
    // failure was wall-clock, not a property. Raising a budget does cost the
    // accidental "something got 10x slower" signal that a tight default gives for
    // free, so `scripts/suite-evidence.mjs` records the 15 slowest tests of every
    // run instead — a measurement, rather than an ambush.
    testTimeout: 30_000,
  },
});
