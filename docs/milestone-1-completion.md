# Milestone 1 — P0 Security & Deployment (Completion Report)

**Status:** Complete — all items implemented, verified, and documented.
**Date:** 2026-07-27

Milestone 1 closes the five convergent P0 security/deployment findings from the
Phase 1 audit (the "Phase 2a" cluster): the default admin password, the
prod-only `ADMIN_SECRET` guard, ephemeral admin state, the unrate-limited
buffered public tool API, and the missing usable health probe — plus atomic
store writes, mutex locking, and Docker network isolation for the conversion
SSRF vector. No existing functionality was removed; all 32 PDF tools, the
admin panel, the blog/SEO system, and the public site behave as before.

## Completed tasks

| # | Item | How |
|---|------|-----|
| 1 | Remove default admin password | `defaultStore.settings.adminPasswordHash` and `data/admin/store.json` set to `""`; no `admin1234` anywhere in source. |
| 2 | Forced first-run setup | New `/admin/setup` page + `POST /api/admin/setup` (no auth, atomically sets password only if none exists). Login page + login API redirect/refuse (409) until setup is done. `isAdminPasswordSet()` gate in `lib/admin/passwords.ts`. |
| 3 | Require `ADMIN_SECRET` in every environment | `lib/admin/session.ts getSecret` throws unless set (≥8 chars), with an explicit `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1` dev opt-in. `docker-compose.yml` refuses to start without it. |
| 4 | Persistent admin storage | `docker-compose.yml` mounts the `pdfdadi-data` named volume at `/app/data/admin` (seeded from the image on first attach). |
| 5 | Docker volume | `pdfdadi-data` volume declared + mounted; admin edits (and the set password) survive redeploy/restart. |
| 6 | Network isolation for conversion | App attaches to an `internal: true` network (no external egress) — blocks the LibreOffice/`soffice` SSRF vector while keeping inbound port 3000. Egress caveat documented. |
| 7 | Public API rate limiting | New `lib/server/rateLimit.ts` (reusable fixed-window per-IP limiter); applied to `app/api/tools/[slug]/route.ts` (`TOOLS_RATE_LIMIT_PER_MIN`, default 20). |
| 8 | Upload body-size limit | `Content-Length` checked against `TOOLS_MAX_BODY_BYTES` (default 110MB) before buffering; 413 on oversized. |
| 9 | Upload size validation before buffering | The concurrency slot is now acquired **before** `formData()` (was after) so the memory-heavy parse phase is bounded by `TOOLS_MAX_CONCURRENCY`. Per-file `validateUpload` remains the authoritative check. |
| 10 | Atomic file writes | `writeStore` writes a temp file + `fs.rename` (atomic) and keeps a `.bak` of the previous good file. |
| 11 | Locking around admin store writes | New `lib/server/storeLock.ts` (`AsyncMutex`); `updateStore` runs its read-modify-write under `storeMutex`. `readStore` falls back to `.bak` on corruption. |
| 12 | Health checks | New public `GET /api/health` (liveness) + `GET /api/health/ready` (readiness: data dir + toolchain, dep check cached 30s). `Dockerfile` `HEALTHCHECK` added. |
| 13 | Verify security | Reviewed below; tests + tsc + lint + build all green. |

## Files modified

**New files (10):**
- `lib/admin/passwords.ts` — pure password hash/verify/first-run helpers (node:crypto).
- `lib/server/storeLock.ts` — in-process async mutex.
- `lib/server/rateLimit.ts` — reusable per-IP fixed-window rate limiter + `clientIp`.
- `app/admin/setup/page.tsx` — first-run setup page (server component, `force-dynamic`).
- `app/api/admin/setup/route.ts` — first-run setup API (mutex check-and-set).
- `app/api/health/route.ts` — public liveness probe.
- `app/api/health/ready/route.ts` — public readiness probe.
- `components/admin/SetupForm.tsx` — setup form (matches `LoginForm` styling).
- `.env.example` — documented env vars.
- `vitest.config.ts` + `eslint.config.mjs` — new tooling configs.

**New tests (4):**
- `lib/admin/passwords.test.ts`, `lib/admin/session.test.ts`,
  `lib/server/rateLimit.test.ts`, `lib/server/storeLock.test.ts` — 19 tests total.

**Edited files (12):**
- `data/admin/index.ts` — removed default hash; re-exports password helpers; atomic `writeStore`; mutex `updateStore`; `.bak`-aware `readStore`.
- `data/admin/store.json` — `adminPasswordHash` → `""`.
- `lib/admin/session.ts` — `ADMIN_SECRET` required everywhere + dev opt-in.
- `app/api/admin/login/route.ts` — first-run 409; uses shared `RateLimiter`.
- `app/admin/login/page.tsx` — removed `admin1234` hint; first-run redirect to `/admin/setup`; `force-dynamic`.
- `app/api/tools/[slug]/route.ts` — rate limit + body-size pre-check + slot-before-buffer.
- `app/api/health/dependencies/route.ts` — unchanged (still admin-gated; documented).
- `proxy.ts` — allows `/admin/setup` + `/api/admin/setup` without a session.
- `next.config.mjs` — unchanged (body size handled in-route; security headers deferred to a later milestone).
- `docker-compose.yml` — `ADMIN_SECRET` required env + `pdfdadi-data` volume + `internal: true` network + tuning env vars.
- `Dockerfile` — `HEALTHCHECK` added.
- `package.json` — `lint`/`lint:fix`/`typecheck`/`test`/`test:watch` scripts; `eslint`/`@eslint/js`/`typescript-eslint`/`vitest` devDeps.
- `README.md` + `SERVER_SETUP.md` — updated for the new security/deploy model.
- `lib/server/tempFiles.ts`, `components/tools/runners/SignTool.tsx` — minor lint cleanup (unnecessary regex escape; removed an obsolete `@next/next` directive).

## Verification (all green)

| Gate | Command | Result |
|------|---------|--------|
| TypeScript | `npm run typecheck` | exit 0, no errors |
| ESLint | `npm run lint` | exit 0 — **0 errors**, 16 warnings (pre-existing unused imports in admin components; `no-unused-vars` set to `warn` for baseline adoption, documented as follow-up) |
| Tests | `npm run test` | 19/19 passed (4 files) |
| Build | `npm run build` | exit 0 — standalone build succeeds; tool pages SSG; admin pages dynamic |

## Performance impact

- **Public tool API:** adds a per-IP rate-limit map lookup + a `Content-Length` header read before buffering (both O(1), negligible). Acquiring the concurrency slot before `formData()` slightly reduces peak throughput under load but bounds memory (the intended tradeoff — closes the OOM vector).
- **Admin store writes:** atomic write (temp + rename + copyFile for `.bak`) adds one extra file copy per write; admin writes are low-frequency, so negligible. The mutex serializes concurrent admin saves (was racy before).
- **Health readiness:** `checkAllDependencies` (6 `which` calls) cached for 30s — a frequent LB probe forks at most once per 30s.
- **No impact** on the 18 client-side tools, page rendering, or bundle size (no new client JS except the small `SetupForm`).

## Security impact (the point of the milestone)

- **Admin takeover via known default password: eliminated.** No `admin1234` in source; first-run setup required.
- **Forgeable admin cookies without `ADMIN_SECRET`: eliminated.** Required in every environment; compose refuses to start without it.
- **Admin state loss on redeploy: eliminated.** Persistent volume.
- **Public tool API OOM/abuse: mitigated.** Per-IP rate limit + body-size pre-check + slot-before-buffer. (Full streaming-multipart mitigation is Milestone 2 with R2.)
- **LibreOffice SSRF external vector: blocked** at the network layer (`internal: true`). Definitive per-subprocess isolation lands with the M2 worker.
- **Store corruption/cross-write data loss: eliminated.** Atomic writes + `.bak` + mutex.
- **No usable health probe: resolved.** Public liveness + readiness + Dockerfile `HEALTHCHECK`.
- **Dep audit note:** `npm install` for the new dev tooling reported 3 high-severity vulnerabilities in transitive devDeps (eslint/vitest toolchain), not in production deps. Not force-fixed (would risk the toolchain). Recommend a separate `npm audit` review.

## SEO impact

None. No public URLs, metadata, sitemap, robots, or structured data changed.
`/admin/setup` and the new `/api/health*` routes are noindex/not-discoverable
(admin pages carry `robots: noindex`; health routes return JSON and are not
linked from the site). `/api/health` and `/api/health/ready` are public but
return only `{ok, status}` — no content to index.

## Breaking changes

One **operator-facing** breaking change (by design, security):

- **The default admin password `admin1234` no longer exists.** Every deployment
  must now set `ADMIN_SECRET` and complete first-run setup at `/admin/setup`.
  - Existing operators who already changed their password **and** persist
    `store.json` via the new volume keep their existing password (the volume
    preserves it).
  - Existing operators who never changed it / run without a volume will be
    forced into first-run setup on the next deploy (the intended outcome).

No **code-level** breaking changes for callers of `@/data/admin`:
`hashPassword`/`verifyPassword` are re-exported from the same path; the
`verifyPassword` signature widened to accept `string | undefined | null` (safe).

## Tests executed

`npm run test` → `vitest run`:
- `lib/admin/passwords.test.ts` — 5 tests (round-trip, wrong password, empty/malformed hash, first-run detection, unique salts).
- `lib/admin/session.test.ts` — 7 tests (verify, tamper, expiry, future, malformed, throws-when-unset, dev opt-in).
- `lib/server/rateLimit.test.ts` — 4 tests (limit, window reset, per-key, isLimited).
- `lib/server/storeLock.test.ts` — 3 tests (serialization/no-overlap, failure isolation, return values).

**Total: 19 passed.** (Integration testing of the full HTTP routes + Docker
runtime is out of scope for the unit suite and is covered by the build + manual
deploy verification; an end-to-end harness is Milestone 10.)

## Remaining work (deferred, not M1 scope)

- **Streaming multipart upload** (abort mid-stream on accumulated bytes) — the
  `Content-Length` pre-check covers the common case; chunked-transfer uploads
  without `Content-Length` rely on the concurrency cap + per-file check. Full
  streaming lands with R2 multipart in Milestone 2.
- **Per-subprocess conversion network isolation** (separate no-egress worker
  container) — the current single-container `internal: true` network blocks the
  external SSRF vector; the definitive worker split is Milestone 2.
- **Shared/Redis-backed rate limiting + concurrency** — in-process in M1
  (single-instance); LB/Redis enforcement for multi-instance is Milestone 2.
- **HTTP security headers / CSP** — not in the M1 list (Phase 2b); `next.config.mjs` unchanged.
- **`X-Forwarded-For` spoofing** in `clientIp` — documented; trusted-proxy-aware
  extractor is M2 hardening.
- **Temp-dir sweeper** for orphaned job dirs on crash — security P2, not in M1 list.
- **Tighten ESLint `no-unused-vars` warn→error** and clean up the 16 pre-existing
  unused imports in admin components — follow-up cleanup.
- **`npm audit` review** of the dev-toolchain transitive vulnerabilities.
