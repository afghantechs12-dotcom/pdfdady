# PDFDadi — production acceptance progress

**Read this file first.** It exists so an interrupted session resumes without
repeating destructive or expensive work. Every stage below records what was run,
what it produced, and what is still owed.

| | |
| --- | --- |
| Last updated | 2026-09-05T23:05:00Z (UTC) |
| Branch | `production-acceptance` (cut from `ingress-memory-safety-closeout`) |
| Base commit | `3e4ac8bdf2e8fe8548270db1582546a41c5c0e3b` |
| Build artifact | `.next/BUILD_ID` = `LK-prgSvGFf1hyM1etdkD` — **the final candidate**, rebuilt in **Stage 14** from `1b45f1b` with `NEXT_PUBLIC_SITE_URL=https://192.168.0.175:3001` (verified in the baked CSP `report-to`, on a page **and** on `/_next/static/chunks/*.js`, which the proxy does not serve). Supersedes `MniplDUweIbeIPYT_CM5N` (Stage 9), `DIi1m4KbzBmf96popnixW` (Stage 7), `U1Tagyyl2WuT2jmfk2Tvm` (Stage 6) and the accepted cold artifact `98appVCcbyMxzlhk26zya`. `git diff 209b1ca..HEAD` over `app lib src ingress next.config.mjs proxy.ts instrumentation.ts prisma package.json package-lock.json data` is **empty**, so Stages 6–12's measurements describe this tree and this artifact is a refresh, not a new subject. |
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
| 5 | Network and proxy topology | **DONE** — 1 P1 and 1 P3 found and fixed |
| 6 | Staging deployment (local production-mode surrogate) | **DONE** — 1 P2 and 1 P3 found and fixed |
| 7 | Production-like user acceptance | **DONE** — 1 P2 and 3 P3 found and fixed |
| 8 | Security acceptance | **DONE** — 2 P3 found and fixed; `IMAGE CVE SCAN: NOT EXERCISED — NO SCANNER` |
| 9 | Reliability and recovery | **DONE** — 0 defects; container rollback `NOT EXERCISED` |
| 10 | Observability and operations | **DONE** — 0 defects; `MONITORING: NOT EXERCISED — NO PROVIDER`; template + alert-set test |
| 11 | Bounded performance smoke test | **DONE** — 0 new defects; P2-2 reproduced, **P2-6 diagnosed**; memory peak and cold start measured |
| 12 | Human visual acceptance package | **DONE (machine half)** — compare **PASS 156/156**; 1 P3 found; `VISUAL ACCEPTANCE PENDING` — owner approval not recorded |
| 13 | Manual decision register | **DONE** — 33 open rows (22 owner decisions, 11 verifications), **0 decided**; 4 earlier rows retired by measurement; 1 guard added |
| 14 | Go/no-go checkpoint | **DONE** — 0 new defects; 29 rows: **12 PASS**, 2 PASS-for-the-pattern, 4 NOT EXERCISED, 4 MANUAL REVIEW, 7 OWNER APPROVAL REQUIRED, **0 FAIL**; verdict **NOT READY FOR PRODUCTION — ACCEPTANCE BLOCKERS REMAIN** |
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
| No image scanner (trivy, grype, syft, snyk, docker-scout) | Stage 8 records `IMAGE CVE SCAN: NOT EXERCISED — NO SCANNER`; `npm audit` covers the dependency tree (0 vulnerabilities of 486) but not the base image's OS packages |
| `soffice`/`libreoffice` absent | `pdf-to-word` and `html-to-pdf` are ENVIRONMENTAL and `word-to-pdf`/`powerpoint-to-pdf`/`excel-to-pdf` are NOT EXERCISED (no fixtures either); one workflow-probe row (the 415 `UNSUPPORTED_OUTPUT` branch) is unreachable for the same reason; `/api/health/ready` correctly answers 503 `toolchain:false` here |
| No Stripe test credentials | 3 billing rows are ENVIRONMENT-LIMITED (a real checkout URL, a real portal URL, a real price rendered as an amount); `scripts/stripe-testmode-probe.mjs` is the probe that needs them |
| No staging target, no hosting credentials | Stages 6–11 run against a local production-mode surrogate (`scripts/restart-origin.sh` + `scripts/tls-front.mjs`, throwaway DB and storage root) |
| No monitoring provider selected | Stage 10 delivered `docs/ops/MONITORING.md` (provider-neutral) and marked `MONITORING: NOT EXERCISED — NO PROVIDER`. No provider, DSN, ingest key or dashboard was invented. Wiring it up is an operator action |
| No access log, no metrics endpoint | Measured in Stage 10: 20 requests added 0 log lines; `/api/metrics` and `/metrics` are 404. Request rate, latency and HTTP error rate must come from the reverse proxy or platform — not a defect, a documented limitation, and a go-live checklist row |
| One machine runs Chrome, the TLS front and the origin | Stage 11's latencies are **floors**, not forecasts: loopback and LAN, no CDN, no throttling, no other tenants. The ≈3 s `server_processing` of earlier stages was traced to this contention plus a 500ms poll (`14-performance.md` §4) |
| One browser, emulated viewports, no real device | Stage 12's 156 captures and 63 responsive measurements are Chrome with CDP-emulated widths on one machine. **No** iOS Safari, Android Chrome, Firefox, real DPR-3 phone, screen reader, reduced-motion, forced-colors, print or 200%-zoom pass. `VISUAL ACCEPTANCE PENDING` is the owner-facing half of the same limitation |
| No Git remote | nothing can be pushed; `main` stays untouched |

Available: node v26.7.0, npm 11.19.0, gs, qpdf, pdftoppm, pdfinfo, tesseract,
ocrmypdf, python3, openssl, sqlite3, Playwright chromium-1234, Chrome, LAN IP
`192.168.0.175` (Stage 5's notes said `172.20.10.2`; that lease is stale).

## Stage 5 — network and proxy topology (DONE)

Found and fixed a **P1**: `lib/server/rateLimit.ts`'s `clientIp()` trusted
`X-Forwarded-For` from anyone, so the key for **thirteen** call sites — eight rate
limiters (admin login 5/min, admin setup 10/min, user login 10/min, signup
10/hour, billing session 6/min, csp-report 60/min, analytics 120/min, tools and
jobs 20/min) and five audit `ip` fields — was a string the caller writes. Only the
upload limiter checked `x-pdfdadi-proxy-secret` first.

The inversion is the severity: a browser sends no `X-Forwarded-For`, so honest
callers shared one bucket while a caller sending a counter got a fresh bucket per
request. A password attempt costs a measured **22.2 ms median** of blocked event
loop (`scryptSync`), and `lib/admin/passwords.ts` justifies that blocking call by
citing the bypassable limit.

Fixed at the root: `ingress/guard.mjs` deletes any client-sent `x-pdfdadi-peer`
and stamps the socket's peer address; `clientIp()` resolves a **verified** proxy's
hop → the stamped peer → `"unknown"`. Production cannot serve without the guard
(`assertInstalled()` + the startup gate), so the third source is always there.
Also fixed a **P3**: the nginx caps documented in `SERVER_SETUP.md` had no guard
against `STREAMING_ROUTE_PATTERNS` drifting; they are now pinned in both
directions. `SERVER_SETUP.md` and `.env.example` said forwarding headers were
never trusted, which was true only of the upload limiter.

| Command | Exit | Result |
| --- | --- | --- |
| `npx vitest run ingress lib/server app/api deploymentArtifact.test.ts deploymentTopology.test.ts src/infrastructure/config` | 0 | 38 files, 458 tests, 0 failures |
| `npx tsc --noEmit` | 0 | clean |
| `npx eslint` (changed files) | 0 | clean |
| 6 mutations, each restored | 1 each | every new guard fails when its property is removed (M1 3/9, M2 2/13, M3 1/13, M4 1/13, M5 1/13, M6 1/13) |

M3 is worth remembering: over TCP the `delete` in the stamp is inert, because the
assignment overwrites the client's copy anyway. It only bites on a Unix domain
socket, so the test that covers it connects over one — without that test the
security half of the stamp was unguarded.

**Deferred to Stage 6, deliberately:** runtime confirmation that the stamped
header reaches a route handler. The link is verified statically in Next 16.3.4's
`NextRequestAdapter`; the accepted cold artifact predates these route changes, so
only a rebuilt surrogate can prove it end to end.

Evidence: `docs/evidence/production-acceptance/08-network-proxy-topology.md`,
`08-network-proxy-topology.log`.

## Stage 6 — staging deployment (DONE, against a local surrogate)

**There is no staging host** — no provider, no credentials, no DNS, no container
runtime. Stage 6 stood up a **local production-mode surrogate** instead and every
claim is scoped to it: origin `http://127.0.0.1:3002` (`scripts/restart-origin.sh`
→ `node ingress/server.mjs`) behind `https://192.168.0.175:3001`
(`scripts/tls-front.mjs`, throwaway self-signed cert), `NODE_ENV=production`,
throwaway `file:/tmp/pa-stage6-db.db` and `/tmp/pa-stage6-storage`.

A **rebuild was required and the accepted cold artifact is superseded**:
`next.config.mjs` bakes the static-asset CSP report-to group from
`NEXT_PUBLIC_SITE_URL`, and `/_next/static/*` bypasses the proxy that could supply
it later, so the origin is a build input. `HOSTNAME=127.0.0.1` was confirmed to be
a real bind boundary — the origin port is refused on the LAN address (`curl` exit
7) while the front answers on it.

The two runtime rows Stage 5 deferred are now answered: rotating a forged
`X-Forwarded-For` against `/api/admin/login` buys no bucket (409 × 5, then **429**,
and 429 × 3 through the TLS front), and the audit row records the peer —
`user.register ip=127.0.0.1`, **0 rows** carrying the forged address.

| Command | Exit | Result |
| --- | --- | --- |
| `scripts/ingress-probe.mjs` | 0 | **25/25** — 28 × 100 MiB anonymous burst bounded to 26.5 MiB read of 2800 offered, RSS peak +0 |
| `scripts/upload-abuse-probe.mjs` | 0 | **32/32** (a cold run first reported 27/32 — see below) |
| `scripts/singleton-probe.mjs --entry ingress/server.mjs` | 0 | **8/8** — takeover after SIGKILL 12.09 s, release-then-acquire 0.43 s |
| `scripts/csp-probe.mjs --url https://192.168.0.175:3001` | 0 | **118/118** |
| `npx vitest run` (4 targeted files) | 0 | 68 tests, 0 failures |
| `npx tsc --noEmit`; `npx eslint` (changed files) | 0 | clean |
| 2 mutations, each restored | 1 each | M7 1/12, M8 1/14 |

Found and fixed a **P2**: `checkUploadLimit`'s per-address bucket was keyed on
`trustedClientAddress()`, which yields an address only when a proxy vouched for it
with `TRUSTED_PROXY_SECRET`. In the topology this build ships that key was always
absent, so every anonymous caller fell through to the global 240/min alone and one
of them could spend it for everyone — the upload-abuse probe had measured exactly
that as "429 on attempt 227". Now keyed on `clientIp()`, whose second source is the
peer address `ingress/guard.mjs` stamps; `"unknown"` is **skipped rather than
keyed**, because one shared 20/min bucket for unidentifiable callers would be
tighter than the ceiling it stands in for. The ten existing tests passed with the
fix *and* with it reverted — their `req()` helper stamps no peer header — so two
cases were added; mutation **M7** fails 1 of 12.

Found and fixed a **P3 of my own making**: Stage 4 made `STORAGE_LOCAL_ROOT`
required, and **every place that hand-writes a production environment** silently
stopped being able to boot. Nothing shipped broke (compose and the documented
`docker run` both set it) — the damage was in the acceptance tooling, and it was a
*false pass*: the singleton probe's S2 and S4 ("the second instance does not
serve", "the standby discloses nothing") passed on a **dead process**, and harness
row B4 went red while B2 went vacuous. Fixed at the cause: one `VALID_PROD_ENV`
fixture in the harness with B1's expected names derived from it, one environment
composition in the probe (`start(port, entry)`, so S8 stops holding a second
copy), four documented recipes pointed at the guarded launcher, and
`deploymentArtifact.test.ts` now hands **both** launchers to `productionProblems`
itself so a launcher that cannot boot fails in 5 ms instead of mid-audit. Mutation
**M8** fails 1 of 14.

Readiness on this host is `degraded` (`toolchain:false`) because `soffice` is
absent — ENVIRONMENTAL, and the reason office conversion is `NOT EXERCISED` in
Stage 7. Worth an operator's attention: liveness is `GET /api/health`; there is no
`/api/health/live`, and a probe configured for that path gets a 404 and would
restart a healthy container.

Not established here: anything about a hosting provider, container execution
(unchanged from Stage 3), soak behaviour, or the documented nginx body caps — the
TLS front is a stand-in, not nginx.

Re-run on the committed tree after this stage: `node scripts/final-prelaunch-audit.mjs`
→ **PASS 68/68 exercised, PRODUCT FAILURE 0**, ENVIRONMENTAL 2, NOT EXERCISED 4,
MANUAL REVIEW 11, 85 assertions. The only verdict that differs from the accepted
baseline is **I4** (the image's runtime engine vs `engines.node`), which Stage 3
closed from MANUAL REVIEW to PASS; the two failures seen mid-stage (A1 uncommitted
paths, B4) are cleared.

Evidence: `docs/evidence/production-acceptance/09-staging-surrogate.md`,
`09-surrogate-runtime.log`, `09-csp.log`, `09-static-harness.json`.

## Stage 7 — production-like user acceptance (DONE)

Six browser probes against the surrogate — the built standalone artifact behind real
TLS, which is what the production gate and `Secure` cookies require. Full write-up:
`docs/evidence/production-acceptance/10-user-acceptance.md`.

**Rebuilt during this stage.** `BUILD_ID DIi1m4KbzBmf96popnixW` (was
`U1Tagyyl2WuT2jmfk2Tvm`): the fix below changes compiled application code, and the
first restart proved it — the running server still resolved the old path and
readiness reported `dataDir: false` until the rebuild.

| Probe | Command (all with `NODE_TLS_REJECT_UNAUTHORIZED=0`) | Result | Exit |
| --- | --- | --- | --- |
| Capability truth | `node scripts/product-capability-truth-probe.mjs --url https://192.168.0.175:3001` | **49/49** | 0 |
| Tool runtime matrix | `node scripts/tool-runtime-matrix-probe.mjs --url …` | **PASS 29/29 exercised**, PRODUCT FAILURE **0**, ENVIRONMENTAL 2, NOT EXERCISED 3 | 0 |
| Processing pilot (`PROCESSING_PIPELINE=on`) | `node scripts/processing-pilot-probe.mjs --url …` | **41/41 PASS** | 0 |
| Processing pilot (shipped default) | same | 30/33 — the three pipeline-shaped rows, which the probe documents as the flag-off mutation | 0 |
| Workspace reliability | `node scripts/phase1-workspace-reliability-probe.mjs https://…` | **29/29**, 2 NOT EXERCISED (`--dev-log-forwarding` needs `next dev`) | 0 |
| Usage analytics | `node scripts/usage-analytics-probe.mjs --url … --admin-pw …` | **83/83** | 0 |
| Workflow completeness | `node scripts/workflow-completeness-probe.mjs --url …` | **155/156**, 1 ENVIRONMENTAL, 0 PRODUCT | 0 |

**P2, fixed: the admin store lived in the build output.** `data/admin/index.ts`
resolved `store.json` against `process.cwd()`, which in production is
`.next/standalone` — so a non-compose deployment lost all CMS content **and**
`settings.adminPasswordHash` on every deploy, and a lost hash re-opens `/admin/setup`
to an unauthenticated visitor. Now `ADMIN_STORE_DIR`, refused by the production gate
when relative or inside `.next`. Falsified: the gate printed the exact file and
exited 1 (`10-admin-store-gate-refusal.log`); with it set, `POST /api/admin/setup`
put the hash in the configured directory, the repository's shipped store stayed
empty, and `.next/standalone/data/` was never created.

**P3 ×3, fixed:** the documented `docker run` mounted two of the three state
directories (now three, and `deploymentArtifact.test.ts` parses its `-v` targets);
`scripts/usage-analytics-probe.mjs` had no `--ignore-certificate-errors` and a
same-turn rect read in one hand-rolled click, which made a working Merge tool look
broken (`[1,1,0,0,0]`) — it now uses the file's own scrolling helper and reports
83/83; and the four production-mode launchers each needed the new variable.

Open observation (**S1**, not launch-critical): one `Uncaught (in promise)` in the
first workflow run on the previous artifact, with no description recorded. The
collector now records descriptions, and it has not recurred in three runs since.

Secrets: none requested, echoed or written. The throwaway admin password was
generated locally into `/tmp`, and every log copied into evidence was checked
against it before being written.

Throwaway state used by this stage: `file:/tmp/pa-stage6-db.db`,
`file:/tmp/pa-stage7-analytics-db.db` (virgin, for the zero-data section),
`/tmp/pa-stage6-storage`, `/tmp/pa-stage7-analytics-storage`, `/tmp/pa-stage6-admin`.

## Stage 8 — security acceptance (DONE)

Six probes plus the dependency audit, all against `BUILD_ID DIi1m4KbzBmf96popnixW`
(no rebuild — nothing this stage changed is compiled into the app). Full write-up:
`docs/evidence/production-acceptance/11-security-acceptance.md`.

| Probe | Command | Result | Exit |
| --- | --- | --- | --- |
| Legacy job ownership (pipeline **off**, the shipped default) | `node scripts/legacy-job-ownership-probe.mjs` | **25/25**, 0 failed, 0 skipped | 0 |
| Proxy parity | `node scripts/proxy-parity-probe.mjs` | **37/37** | 0 |
| CSP end to end | `node scripts/csp-probe.mjs --server-log /tmp/pa-stage8-origin.log` | **118/118** | 0 |
| Upload abuse (L0–L13) | `node scripts/upload-abuse-probe.mjs` | **32/32** | 0 |
| Billing trust boundary | `node scripts/billing-probe.mjs` | **78/78**, 3 ENVIRONMENT-LIMITED | 0 |
| Usage ceiling in a browser | `node scripts/usage-quota-browser-probe.mjs` | **45/45** | 0 |
| Dependency vulnerabilities | `npm audit`, `npm audit --omit=dev` | **0 vulnerabilities**, 486 dependencies (158 prod) | 0 |

`--server-log` matters on the CSP probe: without it the run is 110/110 rather than
118/118, because the eight report-endpoint rows read the server's own log.

**P3, fixed: the fourth launcher rotted the same way as the first three.**
`scripts/billing-probe.mjs` exited 2 — its spawned server refused to boot for a
missing `DEPLOYMENT_TOPOLOGY`, required since Phase 6.
`scripts/usage-quota-browser-probe.mjs` had the identical gap. The gate worked; the
guard did not reach these two, because `deploymentArtifact.test.ts` fed only the two
*shell*-shaped launchers to `productionProblems`. It now feeds all **four**, via a
third extractor that reads a JS `const env = {…}` literal. 16 tests (was 14).
Verified to bite: removing the variable again fails the new row with the gate's own
message.

**P3, fixed: the billing probe's caller isolation was inert.** With the server
booting, two rows answered `429 RATE_LIMITED` where they assert `403 FORBIDDEN` — and
a throttle cannot show that a non-owner is refused *for not owning*. `nextIp()` sends
a distinct `X-Forwarded-For` per call, but `clientIp()` reads that header only when
the request also presents `TRUSTED_PROXY_SECRET`, so the whole run shared one 6/min
billing budget. The probe now generates a per-run secret, passes it to the servers it
spawns and sends `x-pdfdadi-proxy-secret` → 78/78. Corroboration: §15, which
deliberately exhausts the limiter, was passing on luck and now reports `limited on
attempt 7` — exactly `max = 6` admitted. Probe-only; no product code changed.

Also carried in this commit: the L13 sampling settle in
`scripts/upload-abuse-probe.mjs` found in Stage 7, now measured 32/32 twice.

Secrets: none requested, echoed or written. The one synthetic canary in the CSP log
(`sk_live_…`, planted by the probe to prove it would be caught) is redacted as
`[probe-canary-token-redacted]` in the evidence copy.

## Stage 9 — reliability and recovery (DONE)

Four live drills plus a unit-level gate, no defects found, no product code changed.
Full write-up: `docs/evidence/production-acceptance/12-reliability-recovery.md`.

| Drill | Command | Result | Exit |
| --- | --- | --- | --- |
| Single-instance enforcement | `AUDIT_SITE_URL=… node scripts/singleton-probe.mjs --entry ingress/server.mjs --label guarded --json …` | **8/8** | 0 |
| Worker killed mid-job | `npx tsx scripts/worker-recovery-probe.mts` | **45/45** | 0 |
| Migrate + online backup + restore | `node scripts/migration-restore-drill.mjs` | **PASS 16/16** | 0 |
| Deploy and rollback rehearsal | `NEXT_PUBLIC_SITE_URL=… AUDIT_*=… R30_ORIGIN=https://192.168.0.175:3001 R30_FIXTURE=docs/qa/p1/multipage-fixture.pdf R30_WORK=/tmp/pa-stage9-r30 sh scripts/r30-rollback-smoke.sh` | **PASS 8/8** | 0 |
| Bounded drain + stuck-job recovery | `npx vitest run src/infrastructure/queue/workerShutdown.test.ts src/application/services/StuckJobRecoveryService.test.ts src/infrastructure/queue/DatabaseQueue.test.ts` | 61 tests | 0 |

The two rows an operator meets: **SIGKILL** the holder and the standby serves after
11 731 ms (TTL 10 s + 2 s grace + 3 s beat); **SIGTERM** it and a fresh instance
acquires in 428 ms including boot, because the lease is released rather than expired.
The rollback legs returned the **same 8 218 bytes** of `%PDF-` from the new artifact and
from the previous one.

**R30 needs three inputs on this host** and the defaults are wrong for it: pass
`R30_ORIGIN` (the script's default is the stale `172.20.10.2` lease), `R30_FIXTURE`
(`/tmp/perf-fixtures/manypage-fixture.pdf` is built by the Stage 11 perf probe and did
not exist yet — the committed `docs/qa/p1/multipage-fixture.pdf` was used instead), and
`NEXT_PUBLIC_SITE_URL` **for the build leg**, or the rebuilt artifact bakes a different
CSP report-to endpoint than the origin it will be served on.

## Stage 10 — observability and operations (DONE)

No defects. No product code changed. Full write-up:
`docs/evidence/production-acceptance/13-observability.md`; measurements in
`13-observability.log`.

| Measurement | Result |
| --- | --- |
| `GET /api/health` | `200 {"ok":true,"status":"up"}` |
| `GET /api/health/ready` | `503 degraded` — `dataDir:true toolchain:false database:true instance:true` (the host's missing converters, as in Stage 6) |
| `GET /api/health/dependencies` | `401 Unauthorized` — admin-gated, so not a machine probe |
| `GET /api/health/live`, `/api/metrics`, `/metrics` | `404` — none exists |
| Access log | **None.** 20 requests (10 `GET /`, 10 `GET /api/health`) added **0** lines to the origin's stdout+stderr |
| Log volume for context | 27 lines across three boots and two completed compress jobs, of which **2** are JSON |
| `LOG_LEVEL=verbose` | `getConfig()` throws `ConfigurationError: … received 'verbose'`, exit 1 — the enum refuses boot, as documented |
| `npx vitest run monitoringSignals.test.ts` | **34/34**, exit 0 |

Two facts an operator has to be told, and now is:

1. **Request rate, latency and error rate come from the proxy.** The app writes no
   line per request. Shipping only container stdout gives no traffic telemetry at all.
2. **Two log shapes.** Application logs are JSON; the boot gate, instance lease,
   ingress guard and rate-limit key warning are plain `[bracket]`-prefixed
   `console.*` lines, because they run before and around the DI container. A
   JSON-only parser silently drops the refusal-to-boot line and the "one rate-limit
   key for every caller" warning.

`monitoringSignals.test.ts` pins the alert set both ways: every message at the level
the document promises, the eight plain-text lifecycle lines, and a scan that fails if
the document alerts on anything the test does not pin. Verified to bite by renaming a
message, demoting one from `info` to `debug`, and adding an unpinned document row.

Live corroboration worth keeping: the measured log's rate-limit warning fired for
real, because this acceptance origin sits behind `scripts/tls-front.mjs` with no
`TRUSTED_PROXY_SECRET` — the exact state the document tells an operator to alert on.

Secrets: none requested, echoed or written. The evidence log is redacted for repo
path, home path and hostname.

## Stage 11 — bounded performance smoke test (DONE)

No new defects, no P0, no P1. No product code changed. Full write-up:
`docs/evidence/production-acceptance/14-performance.md`; measurements in
`14-performance.log` and `14-performance.json`.

Two probes, both against the running surrogate:

```sh
node scripts/perf-load-probe.mjs --url https://192.168.0.175:3001 \
  --api-url http://127.0.0.1:3002 --csrf-origin https://192.168.0.175:3001 \
  --json /tmp/pa-stage11-perf.json                                    # exit 0

AUDIT_SITE_URL=… AUDIT_DATABASE_URL=file:/tmp/pa-stage6-db.db \
AUDIT_STORAGE_ROOT=/tmp/pa-stage6-storage AUDIT_ADMIN_STORE_DIR=/tmp/pa-stage6-admin \
  node scripts/perf-soak-probe.mjs --seconds 60 --concurrency 4 --idle 30 --cold-start
```

| Measurement | Result |
| --- | --- |
| Page load, 7 routes × 3 runs | LCP 36–108 ms, CLS ≤ 0.017, **0 JS errors everywhere** — except Workspace Editor |
| **Workspace Editor** | LCP 408, **CLS 0.212**, 913 KB / 449 KB JS — open **P2-2**, reproduced byte-for-byte on a payload 8 KB smaller than prelaunch's |
| Workflow, 6 input shapes × 2 runs | complete end to end; the four Editor refusals are the 200-page limit and the damaged-file message, quoted in the write-up |
| **`server_processing` ≈3 s** | **diagnosed, not reproduced.** With a 25ms poll on an idle host the same inputs take **512 ms** (5 KB) and **1010 ms** (22.7 MB / 340 pp); Ghostscript is 80 ms and 490 ms of that. The 3 s was 500ms poll granularity plus contention with the probe's own browser. The user path streams progress at 400ms. Recommend closing **P2-6** |
| Fan-out accepted | anonymous jobs **16**, uploads **8**, document opens **16**, publishes **4**, browser workflows **3** |
| The two rows that shed | one-IP burst ×25 → 20×202 + **5×429** `retry_after 10`; revision conflict ×4 → 1×201 + **3×409**, `cas held`. Both are the designed answer |
| Sustained load, 60 s at concurrency 4 | **15 896 requests, 265/s, all 200.** p50 10 ms, p95 41 ms, p99 43, max 88 |
| Memory | RSS 171 MB → **peak 543 MB** → 322 MB ten seconds after load stopped, then flat. A second run on a longer-lived process: 334 → 652 → 369. Transient peak, floor rises ~35 MB and stops. **Not a leak** |
| Cold start | SIGTERM → port free **67 ms**; `exec` → `/api/health` 200 **393 ms**; first cold `GET /` 56 ms; warm 20 ms; fresh-boot RSS 216 MB. Same `BUILD_ID` before and after |

Three things an operator has to be told, and now is:

1. **Size the container memory limit to the peak, not the idle.** ~550–650 MB at
   concurrency 4 on *page serving alone*, before any Ghostscript, so **1 GB is the
   smallest limit that is not a gamble** — and `WORKER_CONCURRENCY` multiplies real
   memory on top of that.
2. **A 393 ms boot means a 5 s health-check initial delay is generous.** A slow first
   probe is a configuration choice, not a constraint.
3. **`accepted` is not `completed`.** The ×16 row means the limiter and queue admitted
   16 jobs in 82 ms; `WORKER_CONCURRENCY=2` means the rest queued. Throughput under
   saturation is still unmeasured.

`scripts/perf-soak-probe.mjs` is new — the sustained-load and cold-start numbers had no
instrument. No test was added: a probe's output is the evidence, and none of the
brief's five test-warranting categories was touched.

One unrelated find while running the gates: `eslint .` was carrying **1 error** —
`no-regex-spaces` at `deploymentArtifact.test.ts:124`, introduced on this branch by
`209b1ca` in Stage 8 and missed there. Fixed (`\n  \};` → `\n {2}\};`, same match);
`eslint .` 0 errors, `tsc --noEmit` 0, `deploymentArtifact.test.ts` 16/16.

Harness row **N3** ("sustained load, cold-start, memory ceiling") is now *partly*
answered — sustained load and cold start measured, memory measured as a **peak**, not a
**ceiling**. Stage 14 must not record it as a clean PASS.

Secrets: none requested, echoed or written. Evidence redacted for repo path, home path
and hostname.

## Stage 12 — human visual-acceptance package (DONE, machine half)

**`VISUAL ACCEPTANCE PENDING.`** The pixels were proved not to have moved; nothing in
this branch records an owner approving how they look. Full write-up:
`docs/evidence/production-acceptance/15-visual-acceptance.md`; measurements in
`15-visual-acceptance.log`; the reviewable artifact is
`docs/evidence/production-acceptance/visual/` (five contact sheets, PNG + HTML).

Three probes against the running surrogate, all exit 0:

```sh
node scripts/visual-acceptance-probe.mjs --url https://192.168.0.175:3001 --auth \
  --out docs/screenshots/production-acceptance \
  --baseline-dir docs/screenshots/final-prelaunch/baseline \
  --sheets docs/evidence/production-acceptance/visual        # PASS 156/156, 1 NOT EXERCISED

node scripts/responsive-qa.mjs --url https://192.168.0.175:3001   # 63/63, 0 overflow
node scripts/premium-ui-ux-probe.mjs --url https://192.168.0.175:3001 --auth  # 125 pass
```

| Measurement | Result |
| --- | --- |
| Visual compare vs the accepted Gate B baseline | **PASS 156/156** over 18 surfaces × 9 widths. 154 byte-identical; aggregate **14 px of 124 482 826 = 0.000011%** against a 0.1% threshold |
| The 2 nonzero captures | `12-editor-workspace 1280x800` 5 px and `14-conflict-dialog 1280x800` 9 px. Worst boxes 62×3 at 276,170 and 345×3 at 276,207 — cropped and looked at: anti-aliasing on the editor tool-rail icons. A 3-px band cannot be a moved element |
| What changed under the compare | a rebuild, 12 commits, a different LAN origin (`172.20.10.2` → `192.168.0.175`) and a different throwaway account. Only 8 files under `app/` changed on this branch, all API routes/tests — so a moved pixel would have been a regression, not drift |
| Masks | 214 rects: `[data-relative-time]` 99, `[role="status"]` 90 (2 surfaces), `[data-user-identity]` 25, **`time` 0**. **107 of 156 captures carry no mask at all** |
| Responsive sweep, anonymous | **63/63**, `scrollW <= viewport` everywhere, `hscroll=0` everywhere. `wide` (101 rects) is decorative aura layers; `tiny` (144 rows) is the `sr-only` skip link, an `aria-hidden tabindex=-1` file input, label-wrapped checkboxes and inline links — **no a11y defect**, itemised in the write-up rather than filed as six false bugs |
| Premium UI/UX, authenticated | **125 pass · 0 product failures · 0 environmental · 0 not exercised**, all 13 scenarios. Reconciles the harness's 111 → 125 via M5b |
| `19-app-error` | **NOT EXERCISED.** A broken `DATABASE_URL` no longer reaches the error boundary — see below |

**New P3 (not fixed here).** Every anonymous page load prints a console error, and
every first open of an unsaved document prints another: `GET /api/auth/me` answers
**401** by design (`hooks/usePublicSession.ts:51` fetches it after hydration so a
server cookie read does not opt ~30 static routes out of prerendering) and
`GET …/editor-state` answers **404 `EDITOR_STATE_UNAVAILABLE`** for a version with no
saved scene. Measured 36× (4 pages × 9 widths) and 1× respectively. Invisible to every
prior probe for three separate reasons: `premium-ui-ux-probe.mjs` signs up before its
scenario loop (10 of its 11 console gates ignored **0** network entries),
`responsive-qa.mjs` is always anonymous and had never been in an evidence package, and
`probe-browser.mjs` splits `jsErrors` from `netErrors` — which is why Stage 11's "0 JS
errors" and these 36 lines are both true. Changing an auth endpoint's status code is
not a clearly low-risk acceptance-time edit, so it is a **Stage 13 owner row** with
three options listed in the write-up.

**A measured behaviour change, recorded for Stage 13.** With an unusable database the
ingress guard now answers **503 on every path** — `/`, `/workspaces`, `/api/health`
*and* `/api/health/ready` — and the Next app is never invoked
(`instanceLease.ts:95-170` keeps status `pending`; `guard.mjs:107-129` serves only
`held`/`disabled`). Measured on a throwaway `PORT=3004` origin started by hand so the
live origin's `.next/static` was untouched; both live listeners re-verified 200
afterwards. Two consequences: the guard's own advice to read `/api/health/ready`'s
`instance` field is unreachable in exactly the failing states, and `Dockerfile:105-106`
healthchecks `/api/health`, so a container correctly waiting for a lease is marked
unhealthy (`docker-compose.yml` defines no healthcheck of its own).

**One misstep, recorded because it would otherwise look like a pass.** The first run
used `--out` at a fresh directory with no `--baseline-dir`; since `BASELINE_DIR`
defaults to `join(OUT, "baseline")` that silently *removed* the comparison and printed
**PASS 0/0 with 157 NOT EXERCISED**, exit 0. It also overwrote the prelaunch phase's
10 committed contact sheets, because `contactSheets()` wrote to a hardcoded path;
restored with `git checkout --` and verified 0 modified.

Two measurement-tool fixes committed with the stage, no product code touched:
`visual-acceptance-probe.mjs` gained `--sheets`, and `responsive-qa.mjs` gained
`--ignore-certificate-errors` for an `https` base only — without it the sweep would
have measured Chrome's TLS interstitial instead of the product. No test added: none of
the brief's five test-warranting categories was touched, and a probe's output is its
own evidence.

Harness rows: **R2** ("111 rendered-layout assertions across 9 viewports", NOT
EXERCISED, delegated) → **PASS**, run separately and reporting its own count as the row
instructed: 125 premium gates plus 63 responsive measurements. **R3** ("visual
acceptance … by a human") → **still MANUAL REVIEW REQUIRED**, carried to Stage 13.

Secrets: none requested, echoed or written. The throwaway account is
`gateb.<timestamp>@example.test`; the four source logs were grepped for
`@|cookie|token|secret|password|authorization|bearer|sk_|whsec_` with no matches
before inclusion.

## Stage 13 — manual decision register (DONE)

**Nothing was decided.** Full register:
`docs/evidence/production-acceptance/16-manual-decision-register.md`. No server was
needed and none was used; every number below was measured at this tree.

Four documents each knew about some of the open rows, several under different names, so the
register de-duplicates them: **43 source rows → 37 destinations** (six merge into four)
= **33 open + 4 retired**.

| | Verify | Decision | Total |
| --- | --- | --- | --- |
| `BEFORE GO-LIVE` | 8 | 10 | **18** |
| Conditional on the markets decision (**D4**) | 0 | 2 | **2** |
| `SCHEDULABLE` | 3 | 10 | **13** |
| **Total** | **11** | **22** | **33** |

**Four rows earlier documents call open are not open, and that changes Stage 14's count:**

| Row | Measured now | Disposition |
| --- | --- | --- |
| **P2-1** nine npm advisories | `npm audit` **0 of 486**; `--omit=dev` **0**. Remediated by `77d45b1`, *before* this branch's base (`next` 16.2.12→16.3.4, `pdfjs-dist` 6.1.200→6.3.289, `postcss`, `nanoid`, `brace-expansion`, `deepmerge-ts` 7.1.5→8.0.2 via `overrides`, `sharp` 0.34.5→0.35.4, `browserslist`) | **CLOSED and pinned** — `finalReconciliation.test.ts` R1–R3, 18/18, with an anti-vacuity check |
| **P2-5** `Dockerfile` CRLF | **88 of 88 CRLF lines at `388e8af`; 0 of 119 today.** No deploy-critical file has CRLF | **CLOSED — by accident**, so now pinned (below) |
| **F5** cross-tenant read refused end-to-end | Exercised in **Stage 7**: `10-workspace-reliability.log` rows 12–13, **29/29**, two real accounts in one browser | **PASS** |
| **R2** 111 rendered-layout assertions | Retired in Stage 12 (125 premium + 63 responsive) | **PASS** |

So the open-P2 set is **P2-2, P2-3, P2-4, P2-6** — four, not six.

**One test added, and it bites.** P2-5 was closed by an edit with another purpose, and an
accident is not a guard. One assertion in the existing `deploymentArtifact.test.ts` —
`Dockerfile`, `docker-compose.yml`, `.dockerignore`, `ingress/server.mjs` must have LF
endings. Converted the `Dockerfile` back to CRLF: red, naming the file. Restored: **17/17**
(was 16). No product code touched. This is the brief's "deployment configuration that
previously had no guard" category.

**The rows that need work rather than a recorded answer**, so Stage 14 does not treat all
18 `BEFORE GO-LIVE` rows as equal: **V7** human visual acceptance · **V8/V9** the container
build and a first boot on real mounts · **V4** zip-bomb and malformed-xref fixtures, which
do not exist in the repository · **D13** image retention, whose answer today is *zero
images anywhere* · **D16** the log/metric/error destination, which gates two adapters ·
**D10** a backup schedule with an off-host copy.

**Six recommendations are attached, none of them applied:** 1 GB memory limit (**V10**);
one paired database+storage restore drill on the container host (**D11**); choose the
observability destination before writing either adapter (**D16**); accept presence-only
readiness for launch rather than change it during acceptance (**D17**); a healthcheck
`start_period` of **45 s**, not 20 s, because a `SIGKILL` handover costs 11 731 ms
(**D19**); and leave the 401/404 console noise alone (**D20**).

**Two rows are recorded and deliberately unanswered:** **D7** account erasure and export
(`model User` has no relations; a user id appears in 23 columns across 22 models with no
cascade) and **D8** whether first-party measurement needs consent. Both are conditional on
**D4** (markets), both are legal questions, and **no consent banner was added**.

`docs/FINAL_PRELAUNCH_AUDIT.md` is amended in place — a blockquote retiring P2-1 and P2-5
beside the original rows, and a §37 blockquote mapping all fourteen owner decisions to
their register ids. Neither original row was rewritten.

Secrets: none requested, echoed or written. The register names variables only
(`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `TRUSTED_PROXY_SECRET`,
`STORAGE_SIGNING_SECRET`, `ADMIN_SECRET`) and says which subsystem each switches on; the
consolidated owner-input table belongs to the Stage 14 report.

## Stage 14 — go/no-go checkpoint (DONE)

Deliverable: [`docs/PRODUCTION_GO_LIVE_CHECKLIST.md`](PRODUCTION_GO_LIVE_CHECKLIST.md).
Evidence: [`evidence/production-acceptance/17-go-no-go.md`](evidence/production-acceptance/17-go-no-go.md).
**No product code changed and no test was added in this stage.**

**The final candidate, re-measured at `1b45f1b`:**

| Command | Exit | Result |
| --- | --- | --- |
| `scripts/suite-evidence.mjs --label pa-final` | 0 | **393 files, 7 556 tests, 0 failures** (`GREEN`, 9.9 s) |
| `NEXT_PUBLIC_SITE_URL=… npm run build` | 0 | 63 pages, `BUILD_ID` `LK-prgSvGFf1hyM1etdkD` |
| restart + `curl` | 0 | health **200** 30 ms; origin `/`, front `/`, `/tools` all **200**; static chunk carries the baked `reporting-endpoints` |
| `curl /api/health/ready` | — | **503 `degraded`** — `toolchain:false` only, the host's absent `soffice` |
| `npm audit` / `--omit=dev` | 0 | **0 of 486** · **0 of 158** |
| `final-prelaunch-audit.mjs --json 17-static-harness.json` | 0 | **PASS 68/68 exercised**, PRODUCT FAILURE **0**, 85 rows |

Suite delta from the accepted baseline (389 files / 7 487 tests): **four new files, none
lost** — `envContract.test.ts`, `processorRegistry.test.ts`, `storeLocation.test.ts`,
`monitoringSignals.test.ts`, plus cases inside `deploymentArtifact.test.ts` and `env.test.ts`.

**Classification of the 29 checklist rows** (the brief forbids counting ENVIRONMENTAL,
NOT EXERCISED, FAIL or an unresolved launch-critical MANUAL row as a PASS):

| Class | Count | Rows |
| --- | --- | --- |
| PASS | **12** | C-1, C-3…C-10, A-2, A-3, A-4 |
| PASS for the *pattern*, not the deployment | 2 | I-4, A-1 |
| NOT EXERCISED | 4 | C-2, C-6b, I-2, I-3 |
| MANUAL REVIEW | 4 | I-6, I-7, I-10, I-13 |
| OWNER APPROVAL REQUIRED | 7 | I-1, I-8, I-11, I-12, I-14, A-5, A-6 |
| FAIL | **0** | — |

`N3` stays qualified (peak memory measured, not a ceiling — register **V10**) and
`VISUAL ACCEPTANCE PENDING` stays open: 156/156 pixels is not approval.

**The 14 missing inputs are consolidated into one table** in the evidence file — container
runtime, image scanner, staging host, domain/TLS, proxy, `TRUSTED_PROXY_SECRET`, `soffice`,
Stripe test credentials, monitoring provider, backup destination, two hostile fixtures, a
second browser engine, a Git remote, and the owner. **Secret names only; no value was
requested, echoed or written anywhere in this acceptance.**

**Verdict: `NOT READY FOR PRODUCTION — ACCEPTANCE BLOCKERS REMAIN`.** Nothing is red in the
code — 0 P0/P1, a green suite, 0 vulnerabilities — but the image has never been built, no
container has ever run, there is no domain, TLS, proxy, monitoring or scheduled backup, and
no human has approved a screen.

## Remaining actions

1. The surrogate the browser stages measure is **still running**: origin
   `http://127.0.0.1:3002` (`BUILD_ID MniplDUweIbeIPYT_CM5N`, pid renamed to
   `next-server`, so find it with `lsof -nP -iTCP:3002 -sTCP:LISTEN`) behind
   `https://192.168.0.175:3001`. Restart it with

   ```sh
   AUDIT_SITE_URL=https://192.168.0.175:3001 \
   AUDIT_DATABASE_URL=file:/tmp/pa-stage6-db.db \
   AUDIT_STORAGE_ROOT=/tmp/pa-stage6-storage \
   AUDIT_ADMIN_STORE_DIR=/tmp/pa-stage6-admin \
     scripts/restart-origin.sh > /tmp/pa-origin.log 2>&1 &
   ```

   A **different** origin needs a rebuild, the same one does not.
   `AUDIT_ADMIN_STORE_DIR` is new in Stage 7 and its default (`/tmp/audit-admin`) is
   a *different* store from the one the Stage 7 probes seeded, so pass it. Prefix
   `PROCESSING_PIPELINE=on` for the pilot, workflow and analytics probes; leave it
   off for `legacy-job-ownership-probe.mjs` and for anything measuring the shipped
   default. Stages 8–14 are done. **Stage 15 is the only stage left and it is
   BLOCKED on owner authorization** — nothing further should be run against this
   surrogate; it can be SIGTERM'd (which releases the singleton lease) whenever the
   evidence is no longer being re-read.
   If a visual re-run is ever needed, it MUST pass
   `--baseline-dir docs/screenshots/final-prelaunch/baseline` and
   `--sheets docs/evidence/production-acceptance/visual` — without the first it
   compares against nothing and still exits 0.
2. Re-running Stage 11 is cheap and non-destructive if a later stage changes code:
   `scripts/perf-load-probe.mjs` for pages/workflow/fan-out, `scripts/perf-soak-probe.mjs`
   for sustained load and cold start. `--cold-start` restarts the origin, so pass the
   same four `AUDIT_*` variables or it comes back on different throwaway state.
3. **Stages 13 and 14 are done** — register at
   `docs/evidence/production-acceptance/16-manual-decision-register.md`, **33 open rows,
   0 decided**. Stage 14 must classify all 33 as `OWNER APPROVAL REQUIRED` (22) or
   `MANUAL REVIEW` (11) and **none as PASS**; the 18 marked `BEFORE GO-LIVE` are the
   go/no-go set, and **D4** (markets) gates two of the others. Stage 14 did exactly that
   and decided none of them. Four rows earlier documents called open are retired there —
   **P2-1**, **P2-5**, **F5**, **R2** — so the open-P2 set is **P2-2, P2-3, P2-4, P2-6**.
4. **Stage 14 is done** — [`docs/PRODUCTION_GO_LIVE_CHECKLIST.md`](PRODUCTION_GO_LIVE_CHECKLIST.md)
   carries the first-boot mount-verification row (`I-10`, for `/app/data/db`,
   `/app/data/storage` and `/app/data/admin`) and the **1 GB** memory row (`I-11`), the full
   suite was re-run at the final candidate, and the 26-section report was delivered ending
   `NOT READY FOR PRODUCTION — ACCEPTANCE BLOCKERS REMAIN`. **Stage 15 must not be started**
   without explicit owner authorization *and* an identified production target; when it is
   authorized, its report is a separate one ending with exactly
   `PRODUCTION DEPLOYED — ACCEPTANCE PASS` or
   `PRODUCTION DEPLOYMENT ROLLED BACK — BLOCKER FOUND`. The nine-step sequence the checklist
   ends with is the running order for that stage.

5. `docs/PDFDADI_FEATURE_LEDGER.md` is up to date through Stage 14; update it again
   if a later stage changes behaviour (CLAUDE.md requirement).
6. **P2-6 has a recommendation attached, not a decision.** Stage 11 diagnosed it as a
   measurement artifact and amended its row in `docs/FINAL_PRELAUNCH_AUDIT.md`; it is
   now register row **D22**, `SCHEDULABLE` — closing it is bookkeeping and the
   owner's call, not a silent edit here.

**Not to be done without explicit owner authorization:** deploying to production,
changing production DNS, running migrations against a production database,
enabling live Stripe charges, rotating secrets, merging into `main`, configuring or
pushing to a remote.
