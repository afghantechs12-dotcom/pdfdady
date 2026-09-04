# Final pre-launch audit — resume checkpoint

Operational file. Updated after every audit group so an interrupted session can
resume without re-deriving state. No secrets, cookies or document contents here.

## Recovered state (session 2 entry)

| Fact | Value |
|---|---|
| Directory | `/Users/faisalarifi/Downloads/pdfmaster` |
| Branch | `final-prelaunch-audit` |
| HEAD at entry | `79e292e` |
| Baseline it was cut from | `651c8fa` (`phase-6-premium-ui`) |
| Merge/rebase/cherry-pick in progress | none |
| Tracked changes | none — `git diff` and `git diff --cached` both empty |
| Remotes | none configured |
| Worktrees | one (the primary) |
| Commits after baseline | 12 |

**No mutation is left applied.** The tree is clean of tracked modifications, and
`data/admin/store.json.bak` (mutation A2's gitignored subject) is absent.

### Commits already made on this branch

| Commit | Claim |
|---|---|
| `97b8110` | P0 — the shipped admin store no longer carries a password hash |
| `7facfae` | P1 — `Save to Workspace` works on a legacy server-tool result |
| `28e377b` | P0 — the container deployment path can build, boot and keep its data |
| `b6e3961` | P0 — the production gate stops asking for a database it cannot open |
| `0d13da2` | P1 — `SERVER_SETUP.md` describes the build that actually ships |
| `9d91ab5` | the audit harness `scripts/final-prelaunch-audit.mjs` + Gate A logs |
| `285e08c` | harness: history scan reads blobs; D2 finds the tool pages |
| `2a25bf9` | `finalPrelaunchRegression.test.ts` (its own R1..R30) + post-fix Phase 5 log |
| `8f00ed0` | mutation O1 found R24 asserting the wrong gate; R24 strengthened |
| `0f45669` | mutation record for A and E–O + `mutation-results.json` |
| `46baf5e` | P1 — `ocr-pdf` passed `--psm`, which `ocrmypdf` rejects |
| `79e292e` | probe fix: journey I′ called its own blind spot a product failure |
| `438e800` | committed the interrupted session's harness, probes, fixtures and evidence |
| `1d36b30` | K — `workspace_save_intents` grew forever; the recurring sweep now bounds it |
| `1ba3a84` | mutation P1 — the sweep's three other retention tests stay green while the table grows |
| `2cb2467` | K — `ensureWorkerReady` had no test, so nothing asserted the sweep is wired (P2, P3) |
| `2cb8173` | M — the readiness probe's toolchain gate was asserted by nothing (Q1, Q2) |
| `c1bc852` | progress checkpoint |
| `450657d` | R24/R25 — the Workspace file manager was the one indexable private page |
| `3be5379` | mutations S1–S3 — the sitemap's availability gate is load-bearing (13 slugs) |
| `72c9630` | R17 — `lib/server/cleanup.ts` had no test, nor did the two guards around `rm` (T1–T3) |
| `a14e7c1` | P1 — every advertised upload ceiling was unreachable (Next clones API bodies at 10 MiB) |

### Stale audit processes found and stopped

| PID | What | Owner check |
|---|---|---|
| 58307/58308 | standalone server on `127.0.0.1:3022` | cwd `pdfmaster/.next/standalone` |
| 58310 | `tls-front.mjs --listen 3021 --target 3022` | cwd `pdfmaster` |
| 64002 | `tls-front.mjs --listen 3001 --target 3002` | cwd `pdfmaster` |
| 83221 | standalone server on `:3002` | cwd `pdfmaster/.next/standalone` |

Left running (not ours): `cricket-api` on 5000/5055, a `next dev` on 3000 from
`Downloads/cricket-live-audit-hardening-baseline/admin-panel`.

## Recovery table

| Audit area | Existing evidence | Status | Rerun? | Remaining action |
|---|---|---|---|---|
| A Phase 5 reconciliation | 4 probe logs; audit doc Gate A | COMPLETE — FINAL EVIDENCE VALID | no | none |
| B Visual acceptance | 156 captures / 18 surfaces + 19 in its own run; 5 sheets; `visual/GATE-B-VISUAL-ACCEPTANCE.md`; mutation N red-and-reverted; **rerun at final HEAD: `visual/gate-b-compare-FINALHEAD.log` — 156/156 exercised, all 5 contact sheets regenerated** | COMPLETE — FINAL EVIDENCE VALID | no | verdict held at **`VISUAL ACCEPTANCE PENDING`** — the pixels did not move and mutation N proves the gate can see a real regression, but no human approval is recorded. Baselines (41 MB) are gitignored, so the compare reproduces on this host only |
| C Launch profile | `evidence/final-prelaunch/LAUNCH-PROFILE.md` | COMPLETE — FINAL EVIDENCE VALID | no | 7 `LAUNCH DECISION REQUIRED` rows stand; they are the operator's, not the audit's |
| D Fresh environment | `fresh-env-final.log` — **at final HEAD `eb8f7fa`**: `npm ci` exit 0, `prisma generate` exit 0, `migrate deploy` onto an EMPTY db exit 0 (23 migrations, 42 tables), `npm run build` exit 0 (`BUILD_ID ru-Ap-qQ5xfFzGqKIfgYn`), then BOTH legs booted and probed **155/156 `PROBE_EXIT=0`** | COMPLETE — FINAL EVIDENCE VALID | no | none. R4+R5 satisfied at final HEAD; exit codes read with `${PIPESTATUS[0]}` after an earlier script recorded `tail`'s status |
| E Tool runtime matrix | `tool-matrix-FINALHEAD.{log,json}` — **29/29 exercised at final HEAD, 0 product failures** | COMPLETE — FINAL EVIDENCE VALID | no | rerun done after the ocr fix; 2 ENVIRONMENTAL (soffice), 3 NOT EXERCISED (no Office fixtures) |
| F Core workflows | `workflow-probe-final-default.log` — **155/156 at HEAD `371f4ef`, BUILD_ID `Y8FTkWwDAOHlzSbHMICnZ`, PROCESSING_PIPELINE unset**; earlier Phase 5 probe logs; `saveToWorkspaceRoute.test.ts`; **rerun at final HEAD: `workflow-probe-FINALHEAD.log` 155/156** | COMPLETE — FINAL EVIDENCE VALID | no | **0 product failures, 0 probe failures, 1 ENVIRONMENTAL** (soffice, journey I). Two PROBE DEFECTS fixed first: N3 raced the asynchronous first-save ingestion (the 409 body's own `preparation: "processing"` was being discarded) and journey I' armed NOTHING on the shipped default — the SSE terminal frame names the mime `result.mimeType` and carries no `resultAvailable`, so the retype guard could never fire. I' now exercises the default: `rewrites=1`, Download offered, `Open in Editor` nowhere, no Workspace save, no handoff written |
| G–J security | `audit-final.json` + `audit-static-final.log` — **at final HEAD on a clean tree, not `--offline`**: PASS 66/67 exercised, **1 PRODUCT FAILURE (I3, the advisory count)**, 2 ENVIRONMENTAL, 4 NOT EXERCISED, 12 MANUAL REVIEW REQUIRED, 85 assertions, `HARNESS_EXIT=1` | COMPLETE — FINAL EVIDENCE VALID | no | I3 resolved to reachability in `dependencies-secrets-i3.md` → **P2, not a blocker** (only `sharp` and the client `pdfjs-dist` are in the shipped artifact at all; pdf.js needs `enableScripting` + no `script-src`, and both are absent). F5 cross-tenant runtime matrix still owed by the workspace probe |
| K Retention | `1d36b30`, `2cb2467`, **`371f4ef`**; `PdfToolWorkerHandler.test.ts`, `workerBootstrap.test.ts`, **`LocalSessionProvider.test.ts`** (real SQLite), `saveIntentIdentity.test.ts` D24; `erasure-export-j3.md`; `mutation-P-retention.md` P1–P3 **+ P4–P7** | COMPLETE — MUST RERUN AFTER LATER CHANGES | yes | intent pruning RESOLVED (30-day horizon in the recurring sweep). **SECOND FINDING, FIXED: `sessions` was never pruned** — a row per login, removed only by an explicit logout, in an authentication table; `get` already refuses an expired token so it was unbounded growth rather than an access risk, which is why nothing surfaced it. `ISessionProvider.pruneExpired` made REQUIRED (5 tsc errors across 4 doubles — the point), riding the existing 15-min sweep. **`audit_logs` is unpruned BY DESIGN and is reported, not fixed.** P4–P7 red-and-reverted; P7 compiles clean (tsc exit 0) and only the behavioural wiring test sees it. Rerun row: the RUNTIME sweep observation is the one thing no mutation reaches — **observed: sweep fired on its own 15 min after boot, purged 325 expired rows, 0 left expired** (`retention-sweep-selfscheduled.log`)
| L DB/backup/restore | `migration-restore-drill.log` — **16/16** (blank chain R5 + populated upgrade R6 + backup/restore R22) | COMPLETE — FINAL EVIDENCE VALID | no | none |
| M Reliability | harness group L/M at final HEAD (L1,L2,L4,L5 PASS; L3 MANUAL REVIEW; M1,M2 PASS; M3 NOT EXERCISED); `readyRoute.test.ts` (7); `readiness-r23.log`; `retention-sweep-selfscheduled.log` | COMPLETE — FINAL EVIDENCE VALID | no | §16/§17 written. Runtime sweep observed firing on its own 15 min after boot and purging 325 expired rows |
| N Performance | `perf-load.log` + `perf-load.json` — one complete run (7 pages ×3, 6 shapes ×2, 11 fan-outs); §18 written | COMPLETE — FINAL EVIDENCE VALID | no | **P2: Workspace Editor CLS 0.212** (structural, twice the 0.1 threshold, largest payload at 921 KB); server processing ≈3 s independent of size (observation, not diagnosed — no retries in the log); three probe defects fixed before the run, all numbers post-fix |
| O Browser + a11y | `keyboard-r28.log` (13 gates signed out + 13 signed in), `cross-browser.log` | COMPLETE — FINAL EVIDENCE VALID | no | R28 PASS with M5b NOT EXERCISED (OS file dialog); R29 Chromium exercised, Firefox ENVIRONMENTAL, WebKit + screen reader NOT EXERCISED; **§19 and §20 written**; the one engine-gated API (`EyeDropper`) is feature-detected, `navigator.clipboard` optional-chained, no `oklch`/`:has()`/`@container` anywhere |
| P SEO/pricing | harness groups O (3/3), P (4/4), Q (3/4 + 1 MANUAL REVIEW) at final HEAD; `seoIndexingTruth.test.ts` (5) | COMPLETE — FINAL EVIDENCE VALID | no | §21/§22/§23 written; Q4 consent question is legal, not code |
| Q Deployment/rollback | `r30-deploy-rollback.log` — **8/8 PASS**; `rollback-runbook.md`; `deploymentArtifact.test.ts`; mutation C; §26 written | COMPLETE — FINAL EVIDENCE VALID | no | standalone deploy+rollback rehearsed for real (both artifacts booted, both completed a real job); container path ENVIRONMENTAL; **PROBE DEFECT** — the first run's job smoke polled without the submitter's session and read R12's correct 404 as a deployment blocker |
| R1–R30 (brief topics) | `finalPrelaunchRegression.test.ts` (own R1..R30) + `seoIndexingTruth.test.ts` (R24/R25), `tempFileLifecycle.test.ts` (R17) | COMPLETE — FINAL EVIDENCE VALID | no | brief R1–R30 mapped to evidence in **§27**; every topic has a named test, probe or log. No test duplicated under a new name |
| Mutations | A–O, P1–P3, Q1–Q2, S1–S3, T1–T3 (35 rows) + N (visual) recorded RED-and-reverted | COMPLETE — FINAL EVIDENCE VALID | no | brief A–O all fifteen mapped in §29; none rerun without cause; tree clean of every mutation |
| Final verification | `final-gates-static.log`, `final-gates-runtime.log`, `final-gates-fidelity-visual.log`, `FINAL-VERIFICATION-COMMANDS.md`, `audit-static-FINALHEAD.{log,json}`, `tool-matrix-FINALHEAD.{log,json}`, `workflow-probe-FINALHEAD.log`, `workspace-probe-FINALHEAD.log`, `job-ownership-FINALHEAD.log`, `export-fidelity-FINALHEAD.log`, `visual/gate-b-compare-FINALHEAD.log` | COMPLETE — FINAL EVIDENCE VALID | no | **at HEAD `9389da3`, BUILD_ID `_DzYjfCuvno7KJhZM8SWY`; `git diff --name-only 9389da3..HEAD` = 0 non-docs paths, so the artifact IS final HEAD.** build 0 · tsc 0 · eslint 0 errors (13 warnings) · prisma validate 0 + migrate status up to date · vitest **7283/7283** (377 files) · workflow 155/156 · workspace 29/29 (+2 not exercised) · tool matrix 29/29 exercised, 0 product failures · job ownership 25/25 · fidelity 35/35 · Gate B 156/156 compared clean, held at `VISUAL ACCEPTANCE PENDING`. Static harness `HARNESS_EXIT=1` preserved: 1 PRODUCT FAILURE (I3, a P2). **0 product failures in all four runtime probes.** Boot-script defect noted in §30: it polls `/api/ready`; the route is `/api/health/ready` (503 degraded, truthful) |

## Known findings so far

P0 (all fixed on this branch): shipped admin password hash; container artifact
could not build/boot/persist; production gate demanded a database the shipped
Prisma provider cannot open.

P1 (all fixed on this branch): legacy `Save to Workspace` 404; `ocr-pdf --psm`;
`SERVER_SETUP.md` stale. Probe defect: journey I′ misclassification.

Resolved in session 2: `workspace_save_intents` was unbounded — one row per
save-to-workspace operation, no delete anywhere, no cascade reaching it. Now
pruned by `updatedAt` past a 30-day horizon inside the sweep that already recurs
(`1d36b30`), with the Prisma adapter proved against real SQLite rather than only
the in-memory twin. Two adjacent gaps closed by the same group: nothing asserted
the sweep is *registered* (`ensureWorkerReady` had no test at all — every test
that touches it mocks it away), and nothing made a missing toolchain binary
affect `/api/health/ready`.

Found and fixed in session 2, group R: `app/workspaces/[workspaceId]/page.tsx` —
the Workspace file manager, the page a signed-in user lives on — exported no
`metadata` at all and has no `app/workspaces/layout.tsx` above it, so it inherited
the root layout's indexable defaults while all three of its siblings declared
`robots:{index:false,follow:false}`. Fixed in `450657d`. The test derives the
private-route set from the tree and from `sitemap()`'s own output rather than
listing it, because a hardcoded list is exactly what would have stayed green.
Mutation S2 also corrected a claim in `app/sitemap.ts`'s own comment: its
availability gate is not belt-and-braces behind `getToolsList`, it is the only
thing keeping 13 unavailable slugs (5 `planned`, 8 `coming-soon-ai`) out of the
sitemap. And `lib/seo/adminRuntime.ts`'s `import "server-only"` — a Next-supplied
package absent from `node_modules` — is why nothing in this repository had ever
*called* `sitemap()` or `robots()`; stubbed in `test/stubs/server-only.ts`.

Found and fixed in session 3: every advertised upload ceiling (100 MiB Workspace,
110 MiB jobs) was unreachable past 10.004 MiB, because `proxy.ts`'s `/api/*` matcher
makes Next clone every API body and the clone is capped at 10 MiB — truncated
silently, so the route answered `400 Malformed multipart body.` about a valid PDF.
`experimental.proxyClientMaxBodySize: "120mb"` (`a14e7c1`), pinned by `proxy.test.ts`
against both ceilings, re-proved at runtime in `upload-ceiling.log` (22 and 60 MiB
now parse; 101 MiB gets the honest 413).

Open, not yet resolved: no account deletion or data export exists (J3); SQLite vs
PostgreSQL for launch is LAUNCH DECISION REQUIRED.

## Environmental blockers (host)

`soffice` absent → `pdf-to-word`, `html-to-pdf` unrunnable here. No `.docx`/
`.pptx`/`.xlsx` fixture → 3 office tools NOT EXERCISED. Playwright Firefox and
WebKit builds absent from `~/Library/Caches/ms-playwright` (chromium only).
No production credentials, no Docker daemon check yet, no human visual approval.

## Report skeleton — recovered from the brief, not re-derived

The brief is quoted in the session that opened this audit; a working copy is at
`/tmp/audit-brief.md` (untracked). The final report uses exactly these sections:

1 Launch profile · 2 Baseline reproduced · 3 Phase 5 reconciliation (all seven) ·
4 Visual acceptance · 5 Fresh-environment reproducibility · 6 Tool runtime matrix
(all 32) · 7 Core workflow acceptance · 8 Authentication and sessions ·
9 Authorization and tenant isolation · 10 File and processing security ·
11 Web security · 12 Dependencies and secrets · 13 Privacy and retention ·
14 Database and migrations · 15 Backup and restore · 16 Reliability and lifecycle ·
17 Observability · 18 Performance and load · 19 Browser compatibility ·
20 Accessibility · 21 SEO and route truth · 22 Pricing and commercial truth ·
23 Analytics and cookies · 24 Email and support · 25 Deployment artifact ·
26 Deployment and rollback rehearsal · 27 Tests added (map R1–R30) ·
28 Final audit probe (A–R, separate totals) · 29 Mutation testing (A–O) ·
30 Verification (exact results and exit codes) · 31 Files changed ·
32 Commits and working tree · 33 P0 · 34 P1 · 35 P2 ·
36 Environmental / not exercised · 37 Release decision, ending in exactly one verdict.

Harness scenario groups for §28 are A–R (A public routes/SEO, B auth/session,
C local tool workflow, D tool dependencies, E job/result ownership, F Workspace
authorization, G save intent/retry, H editor/publication, I conflict, J trash/
deletion, K pricing truth, L visual, M responsive/a11y, N headers/hostile metadata,
O retention/cleanup, P health/readiness, Q browser compatibility, R deployment smoke
and rollback). Required mutations are A–O as lettered in the brief §26.

## Next action

Group B is closed: `docs/evidence/final-prelaunch/visual/GATE-B-VISUAL-ACCEPTANCE.md`
records 156 captures over 18 surfaces (plus 19 in its own broken-`DATABASE_URL` run,
NOT EXERCISED against a healthy server), the four-run cross-build compare, the
mask-binding table (including `time`, which binds nothing), four PROBE DEFECT records
(13, 14, 16, 17), the mobile-editor resize artifact with its 390x844 counter-proof,
and mutation N — homepage `<h1> mt-4 -> mt-16`, built and served, `PASS 0/9` at
23-36% of pixels against a 0.1% threshold, reverted through Git, rebuilt, `PASS
156/156`. Verdict `VISUAL ACCEPTANCE PENDING`; no human approval exists and none is
claimed. Baselines stay under gitignored `docs/screenshots/final-prelaunch/` (41 MB),
so the compare is reproducible on this host only.

Group C is closed: `evidence/final-prelaunch/LAUNCH-PROFILE.md`. Free-only or paid is
three environment variables and the code refuses to show a price it cannot charge;
registration is open with **no email verification and no password recovery**; SQLite is
enforced at boot (Postgres means regenerating the migration history, not a config
change); storage `local|r2` with half-configured refused; queue `memory|redis`;
first-party analytics only and **no error monitoring** (`ConsoleErrorReporter`);
retention 1h outputs / 15min sweep / 30-day save intents; support is one mailto.
Seven rows are `LAUNCH DECISION REQUIRED` and stay that way.

Groups G–J are recorded: `docs/evidence/final-prelaunch/audit-static.{log,json}`,
**PASS 66/66 exercised, 0 PRODUCT FAILURE**, 3 ENVIRONMENTAL (no Docker daemon; npm
audit offline), 4 NOT EXERCISED, 12 MANUAL REVIEW REQUIRED, 85 assertions. Two
findings came out of the run: G2, a P3 in `sanitizeBaseName` (a file named `..pdf`
came back out named `...pdf`) fixed in `d84ed4a` with the R11 test that had pinned the
old residue rewritten; and a PROBE DEFECT in the harness itself — `--url` advertised
"live checks" and the `live()` helper was called zero times, so `--url` only changed
F5's skip reason (fixed in `71f9bf5`). **The harness is static. No report line may
call it a live run.** Runtime behaviour comes from the six driving probes.

Group O is closed (`b5b6bc8`): **R28 keyboard workflow passes both signed out and
signed in** — 13 gates each, 0 product failures, one row NOT EXERCISED (M5b, the OS
file dialog, which no CDP client can drive). The four failures the first run showed
were the probe's own: `tabThrough(n)` leaves focus on the nth stop, so Enter went to
a footer link instead of the dropzone. Diagnosed with a separate CDP run and
recorded in `keyboard-r28.log`. **R29**: Chromium EXERCISED, Firefox ENVIRONMENTAL
(absent three ways), WebKit NOT EXERCISED (safaridriver refuses without
`safaridriver --enable`), screen reader NOT EXERCISED — `cross-browser.log`.

Brief mutations closed (`f75aac1`): the brief's A-O list is a different scheme from
this repo's ledger letters, so it was mapped by behaviour. **Ten executed this
session — A, B, D, E, F, G, H, I, K, O — every one RED then reverted through
`git checkout --` and green again**; C, J, L, M, N already had valid evidence and
were not rerun. Combined gate rerun after all ten reverts: **15 files, 288 tests,
all passing at `f75aac1`** (`/tmp/mut-gate-rerun.log`). Three of the ten had no
behavioural gate at all and would have stayed green under mutation, so the missing
coverage was written first, run green and committed before the mutation: the argv
seam `runCommand` (`runCommandInjection.test.ts`), the product's only
`dangerouslySetInnerHTML` (`jsonLdEscape.test.ts`) - both `2940696` - and the
404-not-403 job rule, which had only a source scan behind it (`b05108a`).
Mutation I did more than fail an assertion: with `shell: true` the child really
did execute a redirection out of a test argument and create the file.

Perf/load at HEAD is **partial**: the page part (7 rows) and 5 of 6 workflow shapes
completed, then the run died on the malformed shape with `CDP Runtime.evaluate timed
out` (exit 2). A complete run exists from earlier today but predates `297c776`,
which changed shipped editor code, so it cannot be the final evidence. The malformed
shape and the load/capacity part are being re-run separately. The editor refusal now
reads honestly in the numbers - `refused after 30830ms - "This PDF has too many
pages to edit It has 340 pages, and the Editor supports up to 200."` where the old
run said only `no page was painted within 30s`.

Group Q rollback (`d6dbf79`): the runbook is written from the entrypoint that
actually ships (`docs/evidence/final-prelaunch/rollback-runbook.md`), not a
template. Two facts drive it. `CMD` migrates before it serves and exits non-zero on
a migration failure, so a bad schema never serves; but Prisma applies **forward
only** and this repo has no reverse SQL, so rolling the image back does not roll the
schema back. A release that added a migration therefore needs image-plus-snapshot,
and everything written since the deploy is lost - which is why the runbook says roll
forward with a fix where the release is merely imperfect. `pdfdadi:latest` is a
mutable tag and no git tag exists, so the previous digest is the only way back and
nothing in the repo stores it: **LAUNCH DECISION REQUIRED** for digest retention and
for who authorizes a data-losing restore. The container path is NOT EXERCISED here
(no Docker daemon, ENVIRONMENTAL); the standalone equivalent is what ran.

Load probe PROBE DEFECT, found and fixed while reading its own output (`13dd074`):
`uploadToWorkspace` deduplicates on `(workspaceId, sha256)` and returns the existing
document, so the probe's 14 uploads of one buffer created **one** document. The row
labelled "publishes x4 (distinct documents)" was consequently a second run of the
same-document CAS race, and the capacity table turned its correct `1x201 3x409` into
a shedding threshold that does not exist. Uploads now carry unique bytes and the row
records how many distinct documents it used. The load part is being re-measured; the
earlier upload and publish numbers must not be quoted.

R23 has live evidence now, not only unit tests (`ab490fe`): on this host
`/api/health` answers 200 while `/api/health/ready` answers **503 with
`toolchain:false`**, because LibreOffice genuinely is not installed here
(ENVIRONMENTAL). That is the liveness/readiness split behaving correctly and is
what brief mutation O attacked. Two operator notes came out of it: the container
HEALTHCHECK asks `/api/health`, which never looks at the toolchain, so the deploy
signal to watch is readiness; and the dependency probe caches for 30 s, so a fixed
dependency still reads false for up to half a minute.

Reading that led to a real coverage gap, now closed (`04e380f`): **nothing tied the
image's installed packages to the binaries readiness requires.** Add a binary to
`dependencyCheck.ts` and the image silently lacks it - container boots, HEALTHCHECK
green, every load balancer drains it, nothing in the deploy output explains why. The
gate walks `binaryInfo` and asserts the Dockerfile installs each `apt` package (the
same string shown to self-hosting users as an install hint). Mutation: remove
`libreoffice` from the install block -> RED on *soffice needs libreoffice*, reverted
byte-identical through git -> 8/8 green.

Two probe defects found by reading the probe's own output rather than trusting it,
both fixed and both re-measured (see the N row): the one-document upload collapse
(`13dd074`) and **the refusal clock** (`6b2a201`) - the editor's error panel was read
only after the 300x100ms paint poll gave up, so every refusal was dated at the
deadline and a document declined in about two seconds was reported as *refused after
30830ms*. Paint and panel are now polled in one predicate.

Observed and NOT fixed: `Dockerfile` has CRLF line endings (the only deploy-critical
file that does; `restart-origin.sh` is clean). BuildKit tolerates them and the
container path is NOT EXERCISED here, so this is recorded as P2 hygiene rather than
changed blind in an artifact no build on this host can verify.

J3 is answered (`9ac95a4`): there is **no** delete-account route, no export route
and no admin route that removes a user - and the reason it is not a small feature is
in the schema. `model User` has no relations at all, while a user id appears in **23
columns across 22 models**, every one a plain `String` with no foreign key and so no
cascade. Deleting a `users` row today succeeds and orphans all 23. Recorded as
`LAUNCH DECISION REQUIRED` with the framing (EU/UK subjects make it an obligation; a
closed audience can defend a written manual procedure, which also does not exist yet)
and deliberately not decided here.

R30 plan, to run once the perf probe releases the origin (it needs the live server):
one `npm ci && npm run build` in a clean worktree at final HEAD serves Group D's
rerun too; keep the current `.next/standalone` aside first, so the rollback leg can
boot the PREVIOUS artifact - the same steps an operator takes with an image digest,
minus the daemon this host does not have - and finish by restoring the pre-deploy
database snapshot and showing it still serves.

Session 4 status. The three reruns at final HEAD are done and their evidence is
filed: **D** (`fresh-env-final.log`, both legs 155/156 on a from-scratch install),
**F** (`workflow-probe-final-default.log`, 155/156 on the shipped default with journey
I' armed there for the first time) and **G–J** (`audit-final.json`, 66/67 exercised).
The harness's single PRODUCT FAILURE is I3 and it is a count, not a defect: all nine
advisories are traced to reachability in `dependencies-secrets-i3.md`, and the
decisive measurement is the standalone dependency trace — only `sharp` (server) and
`pdfjs-dist` (client bundle) are in the shipped artifact at all, and pdf.js needs
`enableScripting` plus no `script-src`, both absent here. Recorded **P2**.
Report sections written so far: Gate A, 1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 15,
16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26.

Next: E tool matrix rerun at final HEAD, Gate B `--auth` compare, F5 cross-tenant
runtime matrix; then §7/§8/§9; then §27–§37 and the final regression gates
(vitest, tsc, eslint, prisma, the six probes, fidelity) at final HEAD.

Command to resume the harness leg:
`node scripts/final-prelaunch-audit.mjs --offline --json /tmp/audit-offline.json`

## Session 3 close-out

Report complete: all **37** sections written in [FINAL_PRELAUNCH_AUDIT.md](FINAL_PRELAUNCH_AUDIT.md),
§36 environmental/not-exercised and §37 the release decision last.

Verdict recorded: **PDFDADI CODE READY — PRODUCTION ACCEPTANCE NOT EXERCISED**.
No P0 and no P1 open (3 P0 + 6 P1 all fixed with commits cited in §33/§34); 6 P2 open
with reasons in §35; 13 `LAUNCH DECISION REQUIRED` items consolidated in §37; 12
MANUAL REVIEW REQUIRED rows in §36. Nothing was deployed, merged, pushed, or reset;
no remote is configured.

## Session 4 close-out — R13 exercised for real, and what it cost

| Item | Status | Rerun needed |
|---|---|---|
| R13 hostile filenames, **live** on both pipeline configurations | COMPLETE — FINAL EVIDENCE VALID | no |
| the malformed-body finding, fixed at `388e8af` | COMPLETE — FINAL EVIDENCE VALID | no |
| mutation **U1–U3** on that fix, against the committed baseline | COMPLETE — FINAL EVIDENCE VALID | no |
| all five runtime probes re-measured at `388e8af` | COMPLETE — FINAL EVIDENCE VALID | no |

R13 was the one behavioural row still resting on unit coverage alone. Exercising it
live (`hostile-filename-r13.log`) confirmed the inertness claim — a name carrying
`` `id`$(whoami)&&rm -rf ~ `` became `_id_whoami_rm_-rf_-compressed.pdf`, `....//....//etc/passwd.pdf`
became `passwd-compressed.pdf`, no storage key or path held anything hostile, and
`/etc/passwd` was untouched — and found a **P2 the unit tests could not see**: a
filename with a raw `"` makes the multipart body unparseable, so the `TypeError`
reached the route's generic catch as an **unlogged HTTP 500**. Fixed at the root, in
the two shared submit paths, reusing the `UploadValidationError` → 400 mapping the
Workspace upload routes already had; plus a log line at each of the two
unclassified-500 sites, carrying error name and message only — never the filename,
per R18. Reachability is stated honestly in §35: a browser escapes the quote as `%22`
and is unaffected, so only the public API reaches it.

Two evidence citations in the report pointed at `/tmp` files that were never
committed. Both are now filed (`retention-sweep-selfscheduled.log`,
`fresh-env-first-run-2840bea.log`) and every evidence name cited by the report and by
this file resolves to a committed file. `retention-sessions-postfix.log`'s
"FINAL-HEAD ARTIFACT" heading was corrected: it records `6e09c28`, and the three files
implementing the sweep are byte-identical there and at final HEAD.
