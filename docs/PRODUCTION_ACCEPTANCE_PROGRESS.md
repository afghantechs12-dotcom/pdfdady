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
| 4 | Persistent database and storage | NOT STARTED |
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
7. Update `docs/PDFDADI_FEATURE_LEDGER.md` for the changes made in Stage 2
   (CLAUDE.md requirement).

**Not to be done without explicit owner authorization:** deploying to production,
changing production DNS, running migrations against a production database,
enabling live Stripe charges, rotating secrets, merging into `main`, configuring or
pushing to a remote.
