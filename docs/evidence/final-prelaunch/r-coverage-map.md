# The brief's R1–R30 → what actually exercises each one

Two numbering schemes exist and they do **not** correspond: this table uses the
launch brief's R1–R30, while `finalPrelaunchRegression.test.ts` carries its own
R1..R30 for different guarantees. Rows below cite the covering test by file and
title, or the probe/log that exercised it at runtime. "Added this session" marks
coverage that did not exist before — each was written, run green, and committed
*before* its mutation was applied, so the red is a gate and not a fitted test.

`git status --porcelain` is clean and no mutation is applied at the HEAD this
table describes.

| # | Requirement | What exercises it | Status |
|---|---|---|---|
| R1 | Every Phase 5 non-pass classified | four `phase5-probe-*.log` runs + the reconciliation table; every non-pass carries `PRODUCT FAILURE`, `ENVIRONMENTAL`, `NOT EXERCISED` or `PROBE DEFECT` | PASS |
| R2 | Canonical tool list equals deployment capability | `lib/tools/capability.test.ts` (*counts the list it is given, not a frozen module-load snapshot*), `finalPrelaunchRegression.test.ts` R26, `app/seoIndexingTruth.test.ts:126`, mutation `O3` | PASS |
| R3 | A missing runtime dependency cannot look available | `app/api/health/readyRoute.test.ts` (7 assertions incl. the cache-lag one), `PdfToolWorkerHandler.test.ts` *categorizes a MissingDependencyError as missing-dependency*, `tool-matrix.log` live `which`; `deploymentArtifact.test.ts` *installs a package for every binary readiness requires* (`04e380f`, mutation: drop `libreoffice` → RED); brief mutations **B**, **O** | PASS |
| R4 | Clean install and build | `clean-worktree-5a4adca-npm-ci-build-probe.log` (fresh worktree, `npm ci`, `next build`), `deploymentArtifact.test.ts` | PASS |
| R5 | Blank-database migration | `prisma/saveIntentMigration.test.ts` (*started from a database that genuinely predates the migration*), `migration-restore-drill.log` blank leg | PASS |
| R6 | Populated-database migration preserves data | `prisma/saveIntentMigration.test.ts` (*keeps every document, including the archived and the trashed one*; *keeps every ingestion, version and stored file, unchanged*; *adds the operation table empty — no history is invented for it*) | PASS |
| R7 | Secure production configuration | `src/infrastructure/config/env.test.ts`, `instrumentation.test.ts:73`, `proxy.test.ts`, `mutation-D-config-truth.md`, `LAUNCH-PROFILE.md` | PASS |
| R8 | Login `next` cannot redirect externally | `src/application/services/authValidation.test.ts` (*rejects absolute URLs*), `components/auth/returnTo.test.ts` (*neutralises a hostile returnTo — absolute / scheme-relative*); brief mutation **D** | PASS |
| R9 | Sessions rotate and expire | `app/api/auth/authRoutes.test.ts` — *marks the session cookie HttpOnly, SameSite=Lax and Path=/*; *adds Secure to the cookie in production*; *invalidates the server-side session, not just the cookie*; *clears the cookie with Max-Age=0 and matching flags*; *returns 401 and clears the cookie for an expired or forged token*; `finalPrelaunchRegression.test.ts` R22; mutations `M1`, `M2` | PASS |
| R10 | CSRF / origin gates | `src/application/services/workspaceHttp.test.ts` (13 rejection cases), `workspaceCsrfProxyOrigin.test.ts`, `scripts/csp-probe.mjs` live leg; brief mutation **E** | PASS |
| R11 | Cross-tenant access fails | `workspaceAuthorization.test.ts` (*7: a same-organization non-member is refused as ACCESS_DENIED*), `workspaceLifecycleReliability.test.ts:220`, `saveTargetRoute.test.ts:262`; brief mutation **F** | PASS |
| R12 | Foreign job / result non-disclosing | `lib/server/jobErrorDisclosure.test.ts` — *answers 404 for a job the caller does not own*; *is byte-identical to the answer for a job that does not exist*; *never distinguishes the two with a status code* — plus the older source scan `legacyJobOwnershipWiring.test.ts` *answers 404, never 403*; brief mutation **G** | PASS (added this session) |
| R13 | Hostile filenames inert | `finalPrelaunchRegression.test.ts` R9/R10/R11/R11b/R29/R30, `MetadataService.test.ts:1077`, `components/seo/jsonLdEscape.test.ts` for the one `dangerouslySetInnerHTML`; mutations `G1`, `G2`, `H1`, brief **H** | PASS (raw-HTML half added this session) |
| R14 | Processing args cannot become shell syntax | `lib/server/runCommandInjection.test.ts` — three real child processes through `execFile`; `lib/server/toolProcessing.test.ts` for the arg list; brief mutation **I** (which, applied, actually executed a redirection) | PASS (added this session) |
| R15 | MIME / content mismatch rejected | `finalPrelaunchRegression.test.ts` R19 (*a claimed extension is checked against the actual leading bytes*), R11b; mutation `J1` | PASS |
| R16 | Request and file ceilings | `finalPrelaunchRegression.test.ts` R20, `proxy.test.ts:519` (*above the 100 MiB Workspace ingestion ceiling and the 110 MiB jobs ceiling*), `upload-ceiling.log`, fix `a14e7c1`; mutations `K1`, `K2` | PASS |
| R17 | Temp files cleaned | `lib/server/tempFileLifecycle.test.ts` (*removes the directory and every user file inside it*; *does nothing at all when the job never got a directory*), mutations `T1`–`T3` | PASS |
| R18 | Logs exclude private content | `workspaceLifecycleReliability.test.ts:283` (*a refusal logs ids and stages, never a secret or a name*), `cspReportRoute.test.ts:78` (*logs one sanitized line per request*), `finalPrelaunchRegression.test.ts` R24 (*a failure event carries its category and nothing about the document*) | PASS |
| R19 | Save-intent retention decision | `1d36b30` recurring sweep + `mutation-P-retention.md`; 30-day horizon at the constant; `LAUNCH-PROFILE.md` records it as resolved policy, not an open question | PASS |
| R20 | Expired results cleanup | `finalPrelaunchRegression.test.ts` R6, `tempFileLifecycle.test.ts`, `PdfToolWorkerHandler.ts:64,67` (1 h TTL, 15 min sweep) | PASS |
| R21 | Shared content survives deleting one reference | `VersionService.test.ts` *keeps bytes a stored-file row outside this Workspace still points at*; brief mutation **K** | PASS |
| R22 | Backup / restore | `migration-restore-drill.log` — `node:sqlite` online `backup()` while open, 950272 bytes / 232 pages, restored to a byte-for-byte content match. **Schedule and off-host destination do not exist in the repository** | PASS (procedure) · `LAUNCH DECISION REQUIRED` (policy) |
| R23 | Health / readiness truthful | `app/api/health/readyRoute.test.ts` (incl. *reports ready only when EVERY binary resolves*), live on this host, captured in `readiness-r23.log`: `/api/health` 200 while `/api/health/ready` → 503 `toolchain:false` with `soffice` genuinely absent; brief mutation **O** | PASS |
| R24 | Private routes not indexed | `app/seoIndexingTruth.test.ts`, fix `450657d` (the Workspace file manager was the one indexable private page), `mutation-S-indexing.md` | PASS |
| R25 | Sitemap registry-derived | `app/seoIndexingTruth.test.ts:73,126`, mutations `S1`–`S3` (13 slugs) | PASS |
| R26 | Pricing matches available commercial behaviour | `finalPrelaunchRegression.test.ts` R25 (*a plan that cannot be bought shows no price and no checkout*), `data/pricing.ts` tests, mutation `O2` | PASS |
| R27 | Screenshot baselines | Entry Gate B, 156/156 compared, masks limited to genuinely dynamic regions, one visible-regression mutation | `VISUAL ACCEPTANCE PENDING` — no human approval exists and none is claimed |
| R28 | Keyboard workflow completes | `keyboard-r28.log` — 13 gates signed out, 13 signed in, 0 product failures; M5b (the OS file dialog) NOT EXERCISED because no CDP client can drive it | PASS · one row NOT EXERCISED |
| R29 | Firefox / WebKit exercised or explicitly unexercised | `cross-browser.log` — Chromium EXERCISED; Firefox ENVIRONMENTAL (absent three ways); WebKit NOT EXERCISED (safaridriver refuses without `--enable`); screen reader NOT EXERCISED | ENVIRONMENTAL / NOT EXERCISED, stated |
| R30 | Deployment / rollback smoke | `mutation-C-deployment.md`, `deploymentArtifact.test.ts`, `rollback-runbook.md`; `28e377b` REMOVED four defects that each stopped a build or a boot, but proved no build — its own test docstring says so, and no Docker daemon exists here | `PARTIAL`: procedure written, container path `ENVIRONMENTAL`, standalone rehearsal owed |
