# PDFDadi — production environment contract (Stage 2)

Captured: 2026-09-05T12:54:38Z (UTC)
Branch: `production-acceptance` — base commit `3e4ac8b`

No secret **value** appears in this file, and none was requested in chat. Every
row below names a variable; what goes in it is the owner's to place in the
hosting provider's secret manager.

## Method

The contract was derived from the code, not from the previous example file:

```
git ls-files | grep -E '\.(ts|tsx|mjs|mts|js)$' | grep -v '\.test\.' \
  | xargs grep -ohE 'process\.env(\.[A-Z][A-Z0-9_]*|\[["'"'"'][A-Z][A-Z0-9_]*["'"'"']\])'
```

plus the keys of the zod schema in `src/infrastructure/config/env.ts`, which are
invisible to that grep because `getConfig()` parses `process.env` **wholesale** —
`DEPLOYMENT_TOPOLOGY` and the three `UPLOAD_*` limits are read that way, and they
are among the variables an operator is most likely to get wrong.

That produced 14 variables the application or the platform reads and `.env.example`
did not document. They are now documented, and
`src/infrastructure/config/envContract.test.ts` fails the suite if it happens again.

`scripts/` is excluded from the contract on purpose: the probe fleet reads its own
harness variables (`CHROME_PATH`, `QA_URL`, `QA_PAGES`, `QA_SHOTS`, `QA_SHOT_DIR`,
`NODE_TLS_REJECT_UNAUTHORIZED`, and `STRIPE_*` in the test-mode probe) which no
deployment sets.

## Variables added to `.env.example` in this stage

| Variable | Class | Default | Note |
| --- | --- | --- | --- |
| `NODE_ENV` | platform, build **and** runtime | `development` | `production` is what arms the config gate, the Secure cookie flag, HSTS and the non-dev CSP |
| `PORT` | platform, runtime | 3000 in Docker | port `ingress/server.mjs` binds |
| `HOSTNAME` | platform, runtime | all interfaces | set `127.0.0.1` behind a reverse proxy |
| `NEXT_PHASE` | platform, set by Next | — | read only to exempt `next build` from the gate |
| `NEXT_RUNTIME` | platform, set by Next | — | read so the boot gate runs once, on Node |
| `NEXT_TELEMETRY_DISABLED` | platform, build-time | Dockerfile sets `1` | — |
| `VIPS_CONCURRENCY` | platform, build-time | `scripts/next-build.js` pins `1` | — |
| `LOG_LEVEL` | optional, runtime | `info` | **validated enum**: an unrecognised value fails the whole parse and the process refuses to start |
| `PROCESSING_PIPELINE` | feature flag, runtime | unset → database flag | the documented rollback lever; pilot slug `compress-pdf` only |
| `PDF_TO_IMAGES_MAX_PAGES` | optional, runtime | 200 | bounds worst-case time, temp disk and zip size |
| `PROCESSING_COMPRESS_TIMEOUT_MS` | optional, runtime | 180000 | see the defect below |
| `PROCESSING_EXPIRY_SWEEP_MS` | optional, runtime | 300000 | retention sweep interval |
| `WORKER_CONCURRENCY` | optional, runtime | 2 | multiplies real CPU/memory, not just concurrency |
| `WORKER_SHUTDOWN_GRACE_MS` | optional, runtime | 20000 | keep below the orchestrator's stop timeout |
| `WORKER_STALE_JOB_AFTER_MS` | optional, runtime | 600000 | must stay above the longest processor ceiling |
| `WORKER_STALE_JOB_SWEEP_MS` | optional, runtime | 60000 | reaper interval |
| `WORKER_NO_AUTOSTART` | **test-only** | unset | `1` stops the worker self-starting; never set in production |

`STRIPE_PRICE_BUSINESS` is absent from the contract and correctly so: Business is a
real plan an operator can grant by hand, with no price slot, so no Stripe payload
can map to it. Adding the variable would document a lever that does nothing.

## Secrets — names only, to be supplied through the provider's secret manager

Required in production:

| Secret | What it signs / opens | Consequence if weak or absent |
| --- | --- | --- |
| `ADMIN_SECRET` | admin session cookies, and local storage download URLs unless `STORAGE_SIGNING_SECRET` overrides it | admin takeover with no password; arbitrary reads of stored files. Gate refuses < 16 chars, the repo's public dev fallback, and any value while `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1` |

Optional, and only when the feature is switched on:

| Secret | Feature | Notes |
| --- | --- | --- |
| `STORAGE_SIGNING_SECRET` | local download URL signing | falls back to `ADMIN_SECRET`; gate refuses < 16 chars if set |
| `ANALYTICS_SUBJECT_SECRET` | analytics subject pseudonym | falls back to `ADMIN_SECRET`; absent from the validated schema so a missing value degrades reporting instead of refusing boot |
| `TRUSTED_PROXY_SECRET` | trusting `X-Forwarded-For` | without it every anonymous caller is keyed as one untrusted client; ≥ 16 chars |
| `STRIPE_SECRET_KEY` | billing | server-only; can move money and read every customer |
| `STRIPE_WEBHOOK_SECRET` | billing | server-only; without it no subscription is ever applied — paid entitlement changes only through signature-verified webhooks |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | object storage | all four R2 variables or none; the gate refuses the half-configured state |
| `DATABASE_URL` | database location | not a credential for SQLite, but a path: it must be absolute and on a persistent volume |

None of these has a `NEXT_PUBLIC_` prefix and none may be given one — Next inlines
`NEXT_PUBLIC_*` into the client bundle, which would publish the value to every
visitor. Verified: the only `NEXT_PUBLIC_*` variable in the tree is
`NEXT_PUBLIC_SITE_URL`, and `src/infrastructure/config/billingSecretConfig.test.ts`
already asserts no source file contains `NEXT_PUBLIC_STRIPE`.

## Requirement verification

| # | Requirement | Verdict | How it was checked |
| --- | --- | --- | --- |
| 1 | Every variable the application reads is documented | PASS | reader grep + schema keys vs `.env.example`, now pinned by `envContract.test.ts` (3 tests; verified to fail when a documented name is removed) |
| 2 | Required vs optional is stated, and optional means optional | PASS | `productionProblems()` in `src/infrastructure/config/env.ts` is the only gate; billing/R2/Redis absence disables the feature and never blocks boot |
| 3 | Unsafe production values are refused at boot, not per request | PASS | gate refuses missing/non-`file:`/relative `DATABASE_URL`, missing/dev-fallback/short `ADMIN_SECRET`, `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1`, short `STORAGE_SIGNING_SECRET`, non-http(s) or loopback `NEXT_PUBLIC_SITE_URL`, `DEPLOYMENT_TOPOLOGY != single-instance`, half-configured R2; reported all at once, `process.exit(1)` |
| 4 | No error or log line prints a secret value | PASS | every interpolation in `productionProblems()` is a constant, a non-secret numeric limit, or a **variable name** (the missing R2 keys). `startupSummary()` emits provider selections only (`env=`, `db=`, `storage=`, `queue=`, `billing=`, `usageLimits=`, `logLevel=`) |
| 5 | Session cookies are Secure under HTTPS | PASS | `src/application/services/authHttp.ts:46,57` — `secure: process.env.NODE_ENV === "production"` on both cookies; off in dev on purpose, since `next dev` is plain http |
| 6 | The site origin matches the deployed HTTPS origin | PASS (config) | gate refuses non-https-capable and loopback origins in production; the value itself is an owner input, and Stage 6/7 exercise it against the staging surrogate |
| 7 | Build-time and runtime variables are separated | PASS, one defect fixed | `NEXT_PUBLIC_SITE_URL` is the only variable that is both: `next.config.mjs:41` bakes the CSP `report-to` endpoint for `/_next/static/*` from it. The Dockerfile took no build arg — fixed below |
| 8 | Numeric/enum readers cannot become NaN or silently disable a safety limit | PASS, one defect fixed | audited every numeric reader; `PROCESSING_COMPRESS_TIMEOUT_MS` was unguarded — fixed below. `LOG_LEVEL` fails loudly by design and is now documented as doing so |
| 9 | One canonical example file, not competing copies | PASS | `.env.example` extended in place (188 → 284 lines); no second example file created |
| 10 | Secrets are named for a secret manager, never requested or committed | PASS | table above; `.env` untracked, and of 1692 tracked files only `.env.example` and `data/admin/store.json` match secret-shaped patterns (the latter's `settings.adminPasswordHash` is `""`) |

## Defects found and fixed in this stage

**P3 — `PROCESSING_COMPRESS_TIMEOUT_MS` was parsed unguarded.**
`Number(process.env.PROCESSING_COMPRESS_TIMEOUT_MS ?? 180_000)` flows into
`LegacyToolProcessor.timeoutMs` and then straight into `setTimeout` in
`src/infrastructure/jobs/ProcessingJobHandler.ts`. `""` → 0, `3m` → NaN, and a
negative all mean "fire on the next tick", so every pipeline compress job would
abort instantly and be reported as a timeout — pointing the investigation at
Ghostscript rather than at the env file. Fixed with the guard shape already used by
`lib/server/concurrency.ts`, `src/workers/processingWorker.ts` and
`StuckJobRecoveryService.ts` (the repo duplicates that four-line guard rather than
extracting it; the local convention was matched). Pinned by
`src/infrastructure/processing/processorRegistry.test.ts` — 9 tests, verified to
fail against the pre-fix code (`expected NaN to be 180000`).

**P3 — the image did not receive the public origin at build time.**
`next.config.mjs` bakes the CSP `report-to` endpoint into the static response
headers for `/_next/static/*`, the one route group `proxy.ts` deliberately does not
run for. The Dockerfile declared no `ARG NEXT_PUBLIC_SITE_URL` and docker-compose
set the value only under `environment:`, so an image built by
`docker compose up --build` shipped documents with a reporting endpoint and assets
without one — violations on the asset routes indistinguishable from silence, and
unfixable by runtime configuration. Fixed in `Dockerfile` (builder stage `ARG`/`ENV`)
and `docker-compose.yml` (`build.args`, same default as the runtime value). Pinned
by a new case in `deploymentArtifact.test.ts`, verified to fail when the `ARG` is
removed.

**Housekeeping — `package.json` declared no `engines.node`.** Added `">=24"`,
matching the `node:24-bookworm-slim` base image. This closes static-harness row I4,
which was `MANUAL REVIEW REQUIRED`.

## Gates run at this point

| Command | Exit | Result |
| --- | --- | --- |
| `npx prisma validate` | 0 | schema valid, provider `sqlite` |
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | 0 errors, 13 pre-existing warnings, none in the files touched here |
| `npx vitest run src/infrastructure/config/envContract.test.ts` | 0 | 3 passed |
| `npx vitest run src/infrastructure/processing/processorRegistry.test.ts` | 0 | 9 passed |
| `npx vitest run deploymentArtifact.test.ts deploymentTopology.test.ts` | 0 | 22 passed |

The full suite is re-run once at the final candidate, per the acceptance testing
policy; the baseline run is `suite/pa-baseline.*` in this directory.
