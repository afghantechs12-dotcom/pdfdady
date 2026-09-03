/**
 * `server-only` is supplied by the Next compiler, not by npm: it is not in
 * `node_modules`, so any module importing it is unimportable under plain vitest.
 *
 * Empty on purpose. Aliased in `vitest.config.ts` so a module carrying the guard
 * (today: `lib/seo/adminRuntime.ts`, which `app/sitemap.ts` and `app/robots.ts`
 * both read) can be CALLED by a test instead of only having its source grepped.
 * The guard itself still works where it matters — a real client bundle resolves
 * the real package and fails the build.
 */
export {};
