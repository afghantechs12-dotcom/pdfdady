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
    alias: { "@": process.cwd() },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    // `.billing-backup-*` is a hand-made snapshot of an older tree (this repo is
    // not Git-backed, so a slice that rewrites billing files keeps one). Its
    // stale copies of `*.test.ts` are not source and must not be collected —
    // otherwise a snapshot of yesterday's assertions fails today's suite.
    exclude: ["node_modules/**", ".next/**", ".kiro/**", ".billing-backup-*/**"],
  },
});
