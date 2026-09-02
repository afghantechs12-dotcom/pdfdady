# Milestone 2.1 — Core Foundation (Completion Report)

**Status:** Complete — implemented, verified, seeded.
**Date:** 2026-07-27

M2.1 stands up the Clean Architecture core that every later sub-phase (M2.2
storage, M2.3 queue, M2.4 auth, M2.5 observability) and every later milestone
(AI, search, enterprise) plugs into. It requires **zero external credentials**
— local dev runs on a file-based SQLite DB; production swaps to PostgreSQL by
changing `DATABASE_URL` (+ the schema `provider`). No existing functionality
was touched: the admin panel, all 32 PDF tools, the blog/SEO system, and the
public site behave exactly as before.

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION  (root: app/, components/, lib/, data/)        │
│  Next.js routes · React components · API handlers            │
│  depends on Application via the DI container (resolve ports) │
└───────────────────────────┬─────────────────────────────────┘
                            │ uses ports
┌───────────────────────────▼─────────────────────────────────┐
│  APPLICATION  (src/application/)                             │
│  ports/    — interfaces: ILogger, IHealthCheck,              │
│              IFeatureFlagRepository, IJobRepository,         │
│              IQueue, IWorker, IFeatureFlagService            │
│  services/ — use cases: FeatureFlagService                   │
│  di/       — tokens + Container (singleton wiring)           │
│  depends on Domain only                                      │
└───────────────────────────┬─────────────────────────────────┘
                            │ uses entities
┌───────────────────────────▼─────────────────────────────────┐
│  DOMAIN  (src/domain/)                                       │
│  entities/ — FeatureFlag, Job (+ JobStatus)                  │
│  errors/   — DomainError, NotFoundError, ConfigurationError… │
│  no external dependencies                                    │
└──────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  INFRASTRUCTURE  (src/infrastructure/)  implements ports     │
│  config/      — env.ts (lazy zod-validated AppConfig)        │
│  db/          — prisma.ts (PrismaClient singleton)           │
│  logging/     — ConsoleLogger (structured JSON)              │
│  persistence/ — Prisma{FeatureFlag,Job}Repository            │
│                 InMemory{FeatureFlag,Job}Repository          │
│  featureflags — InMemoryFeatureFlagRepository                │
│  queue/       — InMemoryQueue + InMemoryWorker               │
│  health/      — DbHealthCheck                                │
│  depends on Application ports + external libs (Prisma)       │
└──────────────────────────────────────────────────────────────┘
```

**Dependency rule:** Presentation → Application → Domain; Infrastructure →
Application (it implements the ports). Domain depends on nothing. Business
logic never imports Prisma / Redis / R2 / Clerk / Sentry / PostHog — only
interfaces. Swapping a provider = registering a different adapter for the same
token in `container.ts`.

## Folder structure (new)

```
src/
  domain/
    entities/FeatureFlag.ts
    entities/Job.ts
    errors/index.ts
  application/
    ports/
      Logger.ts
      HealthCheck.ts
      repositories/FeatureFlagRepository.ts
      repositories/JobRepository.ts
      queue/Queue.ts
      queue/Worker.ts
      featureflags/FeatureFlagService.ts
    services/FeatureFlagService.ts
    di/
      tokens.ts
      container.ts
  infrastructure/
    config/env.ts
    db/prisma.ts
    logging/ConsoleLogger.ts
    persistence/
      PrismaFeatureFlagRepository.ts
      PrismaJobRepository.ts
      InMemoryJobRepository.ts
    featureflags/InMemoryFeatureFlagRepository.ts
    queue/
      InMemoryQueue.ts
      InMemoryWorker.ts
    health/DbHealthCheck.ts
prisma/
  schema.prisma
  seed.ts
  migrations/20260727091322_init/migration.sql
  dev.db                       # local SQLite (gitignored-equivalent; dev only)
.env                           # local dev env (DATABASE_URL, ADMIN_SECRET, …)
```

## Database schema (provider-agnostic)

Eleven models in `prisma/schema.prisma`, all SQLite+Postgres portable (no Prisma
`enum`, no `Json` column — status/role/scope fields are `String`; JSON payloads
are `String` (de)serialized in the repository layer; `cuid()` ids):

| Model | Used in | Notes |
|---|---|---|
| `FeatureFlag` | M2.1 | key, enabled, value?, updatedAt |
| `AppSetting` | M2.1 | generic KV store |
| `Job` | M2.1 (queue) | type, status (queued/running/completed/failed/cancelled), payload(JSON string), attempts, maxAttempts, timestamps |
| `StoredFile` | M2.2 (forward) | ownerType/ownerId tenant scope, key, sha256, size, mimeType, expiresAt |
| `User` | M2.4 (forward) | email, provider (local/clerk) |
| `Organization` | M2.4 (forward) | name, slug, plan |
| `OrganizationMembership` | M2.4 (forward) | userId × orgId, role |
| `Session` | M2.4 (forward) | userId, token, expiresAt |
| `AuditLog` | M2.4 (forward) | actor, action, resource, metadata |
| `ApiKey` | M2.4 (forward) | keyPrefix, keyHash, scopes |
| `Webhook` | M2.4 (forward) | orgId, url, secret, events |

Forward-looking tables are present so the schema is "Postgres-ready" in one
shot; repositories for them ship in their respective sub-phases.

## Migration summary

- `prisma/migrations/20260727091322_init/migration.sql` — creates all 11 tables
  + indexes (`jobs.status`, `jobs.type`, `stored_files` tenant + sha256,
  `sessions.userId`, `audit_logs.org+createdAt`, `api_keys.keyPrefix`) + the
  `organization_memberships` unique pair.
- Applied to the local SQLite dev DB (`prisma/dev.db`) via
  `prisma migrate dev`. The same migration applies to PostgreSQL by switching
  the datasource `provider` to `postgresql` and running `prisma migrate deploy`.
- Seed (`prisma/seed.ts`, run via `npm run db:seed` / `tsx`) is idempotent and
  seeds default feature flags (`new_architecture=true`, `ai_tools=false`).

## Files modified

**New (src/ + prisma/):** 22 source files (see folder structure above) + 5 test
files + `prisma/schema.prisma`, `prisma/seed.ts`, `prisma/migrations/…`,
`.env`.

**Edited:**
- `app/api/health/ready/route.ts` — now also runs the DI-registered health
  checks (DB ping) and aggregates `dataDir` + `toolchain` + `database`.
- `next.config.mjs` — added `outputFileTracingIncludes` for the Prisma generated
  client + engine so the standalone production image can query the DB.
- `package.json` — `predev: prisma generate`, `build: prisma generate && next
  build`, `db:migrate`/`db:deploy`/`db:seed`/`db:studio`/`db:reset` scripts,
  `prisma.seed` config; added `@prisma/client`, `prisma`, `tsx` devDeps.
- `vitest.config.ts` — added the `@` → project-root alias so tests can import
  `@/src/...` exactly as the app does.

Existing app code (`lib/`, `data/admin/`, `components/`, `app/tools/*`, …) is
untouched — the new architecture is purely additive.

## Tests added

`npm run test` → **41 passed (9 files)**. New M2.1 tests (22):

- `src/infrastructure/config/env.test.ts` (5) — dev defaults, prod requires
  `DATABASE_URL`, prod accepts a Postgres URL, numeric coercion, invalid
  `LOG_LEVEL` rejected.
- `src/infrastructure/logging/ConsoleLogger.test.ts` (3) — level filtering,
  structured JSON + child-field merge, Error serialization.
- `src/application/services/FeatureFlagService.test.ts` (6) — unknown flag,
  enabled, JSON value, disabled-with-value, cache + refresh, graceful
  degradation when the repo throws.
- `src/infrastructure/queue/InMemoryQueue.test.ts` (4) — enqueue/pull,
  worker processes + records result, retry up to maxAttempts then failed,
  no-handler → failed.
- `src/application/di/container.test.ts` (4) — resolves a service, caches
  singletons, wires dependencies, throws for unknown tokens.

The DI/queue tests wire a **test container with only in-memory adapters** — no
Prisma, no external services — proving the wiring works against the same
interfaces the production container uses.

## Build verification (all green)

| Gate | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | exit 0, no errors |
| ESLint | `npm run lint` | exit 0 — **0 errors**, 16 warnings (pre-existing unused imports, unchanged from M1) |
| Tests | `npm run test` | 41/41 passed (9 files) |
| Build | `npm run build` (`prisma generate && next build`) | exit 0 — standalone build succeeds; `outputFileTracingIncludes` accepted |
| Seed | `npm run db:seed` | exit 0 — default flags seeded |

## Performance impact

- **Additive only.** No existing request path changed. The 18 client-side tools,
  admin panel, and public pages are unaffected.
- **Readiness probe:** now issues one `SELECT 1` per probe (DbHealthCheck) in
  addition to the cached toolchain check; the DB ping is a single round-trip
  (sub-ms on local SQLite, single-digit ms on Postgres). Toolchain dep check
  remains 30s-cached.
- **Feature flags:** 15s in-process cache → no DB hit per flag read in steady
  state; graceful degradation (default-disabled) if the DB is unreachable.
- **Build time:** `prisma generate` adds ~1s before `next build`. The generated
  client + engine are traced into the standalone output
  (`outputFileTracingIncludes`) so the production image is self-contained.
- **Bundle:** no new client JavaScript (the architecture is server-side; only
  the existing app ships to the browser).

## Security / SEO impact

- **Security:** positive — the DB layer is wired through interfaces (no raw SQL
  in business logic); Prisma parameterizes all queries. `getConfig()` validates
  env lazily (never at build). No new attack surface; existing M1 controls
  intact. Forward-looking `ApiKey.keyHash`, `Session.token`, `Webhook.secret`
  fields are present for M2.4.
- **SEO:** none. No public URLs, metadata, sitemap, or structured data changed.
  The readiness endpoint shape changed slightly (added `database` + `checks`)
  but remains a noindex JSON probe.

## Breaking changes

None. The new `src/` tree is additive; the existing app is untouched. The
readiness JSON gained fields (additive). `npm run build` now runs `prisma
generate` first (transparent). Operators who had no `DATABASE_URL` get a
local SQLite dev DB automatically; production requires `DATABASE_URL` (enforced
at runtime via `getConfig()`, not at build).

## Remaining M2 tasks

- **M2.2 — Storage Layer:** `IObjectStorage` / `IUploadService` /
  `IDownloadService` / `ISignedUrlService` / multipart interfaces; Local
  filesystem adapter + Cloudflare R2 adapter; business logic depends only on
  the interface.
- **M2.3 — Queue Layer:** `IQueue`/`IWorker` already defined; add Redis adapter
  (BRPOPLPUSH), job scheduler, dead-letter queue, progress events, cancellation.
- **M2.4 — Authentication:** `IUserProvider`/`ISessionProvider`/
  `IOrganizationProvider`/`IRoleProvider` interfaces; Local auth implementation
  + Clerk adapter (no Clerk integration yet). Repos for User/Org/Session/
  AuditLog/ApiKey/Webhook.
- **M2.5 — Observability:** metrics/tracing/analytics/error-reporting interfaces
  + local implementations; Sentry/PostHog plug in via adapters.
- **Follow-up (non-blocking):** migrate `prisma.seed` to `prisma.config.ts`
  before upgrading to Prisma 7 (the deprecation warning is cosmetic on v6);
  optionally migrate the file-backed admin store onto the DB; wire real job
  handlers in M3+; tighten ESLint `no-unused-vars` warn→error.
