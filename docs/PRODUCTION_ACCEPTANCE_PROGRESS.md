# PDFDadi — production acceptance progress

**Read this file first.** It exists so an interrupted session resumes without
repeating destructive or expensive work. Every stage below records what was run,
what it produced, and what is still owed.

| | |
| --- | --- |
| Last updated | 2026-09-05T20:05:00Z (UTC) |
| Branch | `production-acceptance` (cut from `ingress-memory-safety-closeout`) |
| Base commit | `3e4ac8bdf2e8fe8548270db1582546a41c5c0e3b` |
| Build artifact | `.next/BUILD_ID` = `DIi1m4KbzBmf96popnixW` — rebuilt in Stage 7 because the admin-store fix changes compiled application code. Supersedes `U1Tagyyl2WuT2jmfk2Tvm` (Stage 6, rebuilt because `NEXT_PUBLIC_SITE_URL` is a build input) and the accepted cold artifact `98appVCcbyMxzlhk26zya`; the final candidate is rebuilt and re-measured in Stage 14. |
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
| No image scanner (trivy, grype, syft, snyk, docker-scout) | Stage 8 records `IMAGE CVE SCAN: NOT EXERCISED — NO SCANNER`; `npm audit` covers the dependency tree (0 vulnerabilities of 486) but not the base image's OS packages |
| `soffice`/`libreoffice` absent | `pdf-to-word` and `html-to-pdf` are ENVIRONMENTAL and `word-to-pdf`/`powerpoint-to-pdf`/`excel-to-pdf` are NOT EXERCISED (no fixtures either); one workflow-probe row (the 415 `UNSUPPORTED_OUTPUT` branch) is unreachable for the same reason; `/api/health/ready` correctly answers 503 `toolchain:false` here |
| No Stripe test credentials | 3 billing rows are ENVIRONMENT-LIMITED (a real checkout URL, a real portal URL, a real price rendered as an amount); `scripts/stripe-testmode-probe.mjs` is the probe that needs them |
| No staging target, no hosting credentials | Stages 6–11 run against a local production-mode surrogate (`scripts/restart-origin.sh` + `scripts/tls-front.mjs`, throwaway DB and storage root) |
| No monitoring provider selected | Stage 10 delivers metrics, thresholds and provider-neutral templates, marked `MONITORING: NOT EXERCISED` |
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

## Remaining actions

1. Stages 8–11 — the surrogate is **already running** and is what these stages
   measure: origin `http://127.0.0.1:3002` (`BUILD_ID DIi1m4KbzBmf96popnixW`)
   behind `https://192.168.0.175:3001`. Restart it with

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
   default. Stage 8 is done; Stage 9 is reliability and recovery, Stage 10
   observability (`MONITORING: NOT EXERCISED`, provider-neutral templates, no
   invented provider), Stage 11 the bounded performance smoke test.
2. Stage 12 — visual package at 320/360/390/412/768/1024/1440/1920, marked
   `VISUAL ACCEPTANCE PENDING`.
3. Stage 13 — decision register from the manual rows (11 harness rows plus **S1**,
   the unexplained page exception from Stage 7) and 14 owner decisions.
4. Stage 14 — `docs/PRODUCTION_GO_LIVE_CHECKLIST.md`, the full suite re-run at the
   final candidate, and the 26-section report.
5. `docs/PDFDADI_FEATURE_LEDGER.md` is up to date through Stage 8; update it again
   if a later stage changes behaviour (CLAUDE.md requirement).

**Not to be done without explicit owner authorization:** deploying to production,
changing production DNS, running migrations against a production database,
enabling live Stripe charges, rotating secrets, merging into `main`, configuring or
pushing to a remote.
