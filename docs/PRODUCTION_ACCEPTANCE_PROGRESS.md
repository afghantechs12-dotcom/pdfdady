# PDFDadi — production acceptance progress

**Read this file first.** It exists so an interrupted session resumes without
repeating destructive or expensive work. Every stage below records what was run,
what it produced, and what is still owed.

| | |
| --- | --- |
| Last updated | 2026-09-05T17:15:00Z (UTC) |
| Branch | `production-acceptance` (cut from `ingress-memory-safety-closeout`) |
| Base commit | `3e4ac8bdf2e8fe8548270db1582546a41c5c0e3b` |
| Build artifact | `.next/BUILD_ID` = `98appVCcbyMxzlhk26zya` (accepted cold artifact; **not** rebuilt yet in this acceptance) |
| `package-lock.json` | sha256 `43558cef02ddf3ed8a579b82a995bb8e080e29c26da50ef2a91da1119a9fd039` |
| Production deployment | **NOT AUTHORIZED.** Stage 15 requires explicit owner authorization and has not begun. |
| Remote | none configured. Nothing pushed. `main` untouched. |

## Stage status

| # | Stage | Status |
| --- | --- | --- |
| 1 | Repository and release-candidate safety | **DONE** |
| 2 | Production environment contract | **DONE** |
| 3 | Container build | **DONE (static)** — `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME` |
| 4 | Persistent database and storage | **DONE** — 1 P2 and 1 P3 found and fixed |
| 5 | Network and proxy topology | NOT STARTED |
| 6 | Staging deployment (local production-mode surrogate) | NOT STARTED |
| 7 | Production-like user acceptance | NOT STARTED |
| 8 | Security acceptance | NOT STARTED |
| 9 | Reliability and recovery | NOT STARTED |
| 10 | Observability and operations | NOT STARTED — no provider selected; provider-neutral templates only |
| 11 | Bounded performance smoke test | NOT STARTED |
| 12 | Human visual acceptance package | NOT STARTED — will be marked `VISUAL ACCEPTANCE PENDING` |
| 13 | Manual decision register | NOT STARTED |
| 14 | Go/no-go checkpoint | NOT STARTED |
| 15 | Production deployment | **BLOCKED — OWNER AUTHORIZATION REQUIRED** |

## Stage 1 — repository and release-candidate safety (DONE)

Verified rather than assumed: branch `ingress-memory-safety-closeout` at
`3e4ac8b`, clean tree, no remotes, 0 tags, exactly 10 commits after `478e111`,
125 commits ahead of `main`, merge-base `5a4adca`. Two prunable
`/private/tmp/audit-wt-final*` worktrees exist and were left alone.

Both accepted gates reproduced on the acceptance branch:

| Command | Exit | Result |
| --- | --- | --- |
| `npx vitest run` (full suite) | 0 | 389 files, 7,487 tests, 0 failures, 10.3 s |
| `node scripts/final-prelaunch-audit.mjs --json` | 0 | PASS 67/67 exercised, PRODUCT FAILURE 0, ENVIRONMENTAL 2, NOT EXERCISED 4, MANUAL REVIEW 12, 85 assertions |

Nothing sensitive is tracked: `.env` untracked, `prisma/dev.db` untracked; of 1692
tracked files only `.env.example` and `data/admin/store.json` match secret-shaped
patterns, and the latter's `settings.adminPasswordHash` is `""`. No secret value
was echoed at any point — only variable names.

Evidence: `docs/evidence/production-acceptance/01-baseline.md`,
`02-static-harness.{log,json}`, `suite/pa-baseline.{log,json,junit.xml,summary.json}`,
`04-release-candidate-manifest.md`.

## Stage 2 — production environment contract (DONE)

Audited every environment-variable reader in the deployed application (`app/`,
`lib/`, `src/`, `ingress/`, `next.config.mjs`, `instrumentation.ts`, `proxy.ts`)
plus the zod schema keys, which no grep for `process.env.X` can see because
`getConfig()` parses `process.env` wholesale. 14 variables were undocumented and
are now in `.env.example`, which was extended in place (188 → 284 lines) rather
than duplicated.

Two real defects found and fixed, both deployment configuration with no prior
guard:

1. **P3** `PROCESSING_COMPRESS_TIMEOUT_MS` was parsed unguarded and flows into
   `setTimeout`; `""`/NaN/negative meant every pipeline compress job aborted on
   the first tick and was reported as a timeout.
   `src/infrastructure/processing/processorRegistry.ts`.
2. **P3** the image never received `NEXT_PUBLIC_SITE_URL` at build time, so the
   CSP `report-to` endpoint baked into `/_next/static/*` headers was null while
   proxy-served documents had one. `Dockerfile`, `docker-compose.yml`.

Also `package.json` gained `engines.node >= 24`, closing static-harness row I4.

| Command | Exit | Result |
| --- | --- | --- |
| `npx prisma validate` | 0 | schema valid, provider `sqlite` |
| `npm run typecheck` | 0 | clean |
| `npm run lint` | 0 | 0 errors, 13 pre-existing warnings, none in the touched files |
| `npx vitest run src/infrastructure/config/envContract.test.ts` | 0 | 3 passed (new) |
| `npx vitest run src/infrastructure/processing/processorRegistry.test.ts` | 0 | 9 passed (new) |
| `npx vitest run deploymentArtifact.test.ts deploymentTopology.test.ts` | 0 | 22 passed (1 new case) |

Each new guard was verified to **fail** when the property it protects is removed —
the env contract with a documented name deleted, the timeout guard against the
pre-fix code, the build arg with the `ARG` line removed.

Evidence: `docs/evidence/production-acceptance/03-environment-contract.md`.

## Stage 3 — container build (DONE, static only)

## CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME

Re-verified on this host at the time of writing, not assumed from an earlier
stage: `docker`, `podman`, `nerdctl`, `finch`, `colima`, `lima`, `limactl`,
`buildah`, `kubectl`, `skaffold` all absent; `trivy`, `grype`, `syft`,
`docker-scout`, `dockle`, `hadolint` all absent. **No image was built and no
container was started.** Nothing in Stage 3 may be read as evidence that the image
builds or serves.

What was checked instead is every relationship between the deployment files and
the tree they deploy — a `COPY` source against the path it names, a variable the
boot gate requires against the compose file that supplies it, a mount point
against the value that resolves inside it, the container's Prisma CLI path against
the package's own `bin` field, and the `.dockerignore` entries that keep a
developer database and `.env*` out of the build context.

| Command | Exit | Result |
| --- | --- | --- |
| `npx vitest run deploymentArtifact.test.ts` | 0 | 11 passed (2 added in this acceptance) |
| `npx vitest run deploymentTopology.test.ts` | 0 | 12 passed |

Evidence: `docs/evidence/production-acceptance/05-container-static.md`.

## Stage 4 — persistent database and storage (DONE)

All measurements on throwaway paths under `/tmp`; no real database, no real
storage root, and not the repository's own `prisma/dev.db`.

| Command | Exit | Result |
| --- | --- | --- |
| `DATABASE_URL="file:$TMP/db/pdfdadi.db" node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma` | 0 | `All migrations have been successfully applied.` — 24 rows in `_prisma_migrations`, 43 tables, `integrity_check ok` |
| the same command, immediately again | 0 | `No pending migrations to apply.` |
| `node -e '<node:sqlite pragmas>'` | 0 | `journal_mode = delete` (not WAL), 4096 × 234 = 958 464 bytes |
| `npx tsx <storage probe> $TMP/storage` | 0 | put/get round trip, nested-key mkdir, mode `0644`, traversal key refused, delete — all PASS |
| the same probe on a **non-existent** root | 0 | the adapter creates it — a freshly attached empty volume works |
| `DATABASE_URL="file:$TMP/absent2/pdfdadi.db" … migrate deploy` | 0 | **prisma creates the directory**: a typo'd absolute path boots healthy on a new empty database |
| `node scripts/migration-restore-drill.mjs` | 0 | **PASS 16/16** — online `backup()` while open, rows destroyed, byte-for-byte content restore, restored file at head |
| `npx vitest run` (full suite, interim) | 0 | 391 files, 7 503 tests, 0 failures, 10.0 s |
| `npm run typecheck` | 0 | clean |
| `npx eslint <touched files>` | 0 | clean |

Two defects found, both deployment configuration with no prior guard:

1. **P2** the production gate refused a relative `DATABASE_URL` and refused
   half-configured R2 — both because live data would land in the container's
   writable layer — but had **no check on `STORAGE_LOCAL_ROOT`**, whose
   `.storage/local` default resolves to `/app/.storage/local` for exactly the same
   reason. `docker-compose.yml` sets an absolute root, so this repo's own
   deployment was safe; any non-compose deployment was not. Now refused, empty
   values included. `src/infrastructure/config/env.ts`.
2. **P3** `SERVER_SETUP.md`'s compose-free `docker run` omitted
   `DEPLOYMENT_TOPOLOGY`, so the documented command exited 1 before serving.
   Both deployment paths — the compose `environment:` block and that `docker run` —
   are now handed to `productionProblems` itself by `deploymentArtifact.test.ts`,
   replacing a hand-written list of three variable names that had gone stale twice.

Also fixed: `scripts/migration-restore-drill.mjs` compared the dynamically derived
head migration against a **hardcoded** table name, so once
`20260905090000_add_instance_lease` became head one row failed and its companion
passed vacuously. The head table is now derived from the head migration's SQL.

Corrected in accepted evidence: `rollback-runbook.md` attributed the "a file copy
of an open database is not a backup" hazard to WAL mode specifically. This
deployment runs the default rollback journal, where the hazard is the same, and
"we are not on WAL" must not read as permission to `cp`.

Not established here, carried forward: that the **mounts are mounted** (a shape
check cannot see a mount point — operator verification at first boot, now a go-live
checklist row); that readiness notices a broken volume (`dataDir` is
`fs.access(dirname(STORE_PATH))` — presence of `/app/data/admin` only, manual row
**L3**, an owner decision because it changes when a load balancer drains); restore
of the **storage volume**, which has no drill and must be snapshotted with the
database.

Evidence: `docs/evidence/production-acceptance/07-database-storage.md`,
`07-database-storage.log`, `06-migration-restore-drill.log`.

## Environmental limitations (consolidated)

These are host facts, not product defects. They determine which stages can be
exercised at all; the full consolidated table of missing owner inputs goes in the
Stage 14 report.

| Limitation | Consequence |
| --- | --- |
| No container runtime (docker, podman, nerdctl, finch, colima, lima, buildah, kubectl all absent) | Stage 3 is static validation only: `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME` |
| No image scanner (trivy, grype, syft, docker-scout) | no image CVE scan in Stage 8 |
| `soffice`/`libreoffice` absent | `pdf-to-word` and `html-to-pdf` are ENVIRONMENTAL; `/api/health/ready` correctly answers 503 `toolchain:false` here |
| No staging target, no hosting credentials | Stages 6–11 run against a local production-mode surrogate (`scripts/restart-origin.sh` + `scripts/tls-front.mjs`, throwaway DB and storage root) |
| No monitoring provider selected | Stage 10 delivers metrics, thresholds and provider-neutral templates, marked `MONITORING: NOT EXERCISED` |
| No Git remote | nothing can be pushed; `main` stays untouched |

Available: node v26.7.0, npm 11.19.0, gs, qpdf, pdftoppm, pdfinfo, tesseract,
ocrmypdf, python3, openssl, sqlite3, Playwright chromium-1234, Chrome, LAN IP
`172.20.10.2`.

## Remaining actions

1. Stage 5 — proxy topology validation (`TRUSTED_PROXY_SECRET`,
   `X-Forwarded-For`, `HOSTNAME` binding, proxy body limits).
3. Stages 6–11 — stand up the production-mode surrogate on
   `https://172.20.10.2:3001` and re-run the probe fleet against it.
4. Stage 12 — visual package at 320/360/390/412/768/1024/1440/1920, marked
   `VISUAL ACCEPTANCE PENDING`.
5. Stage 13 — decision register from the 12 manual rows and 14 owner decisions.
6. Stage 14 — `docs/PRODUCTION_GO_LIVE_CHECKLIST.md`, the full suite re-run at the
   final candidate, and the 26-section report.
7. `docs/PDFDADI_FEATURE_LEDGER.md` is up to date through Stage 4; update it again
   if a later stage changes behaviour (CLAUDE.md requirement).

**Not to be done without explicit owner authorization:** deploying to production,
changing production DNS, running migrations against a production database,
enabling live Stripe charges, rotating secrets, merging into `main`, configuring or
pushing to a remote.
