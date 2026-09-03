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
| B Visual acceptance | 156 captures / 18 surfaces + 19 in its own run; 5 sheets; `visual/GATE-B-VISUAL-ACCEPTANCE.md`; mutation N red-and-reverted | COMPLETE — MUST RERUN AFTER LATER CHANGES | yes | rerun compare at final HEAD; verdict is `VISUAL ACCEPTANCE PENDING` |
| C Launch profile | `evidence/final-prelaunch/LAUNCH-PROFILE.md` | COMPLETE — FINAL EVIDENCE VALID | no | 7 `LAUNCH DECISION REQUIRED` rows stand; they are the operator's, not the audit's |
| D Fresh environment | `clean-worktree-5a4adca-npm-ci-build-probe.log` (at `5a4adca`) | COMPLETE — MUST RERUN AFTER LATER CHANGES | yes | rerun at final HEAD |
| E Tool runtime matrix | `tool-matrix.log/json` — 29/29, 2 env, 3 not exercised | COMPLETE — MUST RERUN AFTER LATER CHANGES | yes | rerun at final HEAD (ocr fix landed after) |
| F Core workflows | Phase 5 probe logs; `saveToWorkspaceRoute.test.ts` | PARTIAL | yes | final-HEAD probe run |
| G–J security | harness groups B,E,F,G,H,I | PARTIAL | yes | harness has never been run to a log |
| K Retention | `1d36b30`, `2cb2467`; `PdfToolWorkerHandler.test.ts`, `workerBootstrap.test.ts`, `saveIntentIdentity.test.ts` D24 | PARTIAL | yes | intent pruning RESOLVED (30-day horizon in the recurring sweep); J3 account deletion / data export still unresolved |
| L DB/backup/restore | `migration-restore-drill.log` — 13/13 | COMPLETE — FINAL EVIDENCE VALID | no | blank-chain leg still to record |
| M Reliability | harness group L/M; `readyRoute.test.ts` (7) | PARTIAL | yes | run harness; readiness toolchain gate now asserted (Q1/Q2) |
| N Performance | `perf-load-wf.json` (full), `perf-load.log` (truncated earlier run) | PARTIAL | no | document; log lags the JSON |
| O Browser + a11y | none beyond Phase 6 | NOT STARTED | — | Firefox/WebKit availability, keyboard pass |
| P SEO/pricing | harness groups O,P,Q; `seoIndexingTruth.test.ts` (5) | PARTIAL | yes | run harness; noindex + sitemap truth now asserted (S1–S3) |
| Q Deployment/rollback | `deploymentArtifact.test.ts`; mutation C | PARTIAL | yes | rollback rehearsal |
| R1–R30 (brief topics) | `finalPrelaunchRegression.test.ts` (own R1..R30) + `seoIndexingTruth.test.ts` (R24/R25), `tempFileLifecycle.test.ts` (R17) | PARTIAL | — | map brief topics → tests for §28 |
| Mutations | A–O, P1–P3, Q1–Q2, S1–S3, T1–T3 (35 rows) + N (visual) recorded RED-and-reverted | COMPLETE — MUST RERUN AFTER LATER CHANGES | no | none owed |
| Final verification | none at final HEAD | NOT STARTED | — | suite, tsc, eslint, prisma, 6 probes, fidelity |

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

Next: the reruns at final HEAD (D fresh environment, E tool matrix, F core
workflows, G-J harness + offline leg), L blank-chain leg, M readiness, N perf
write-up, O browser/a11y, P SEO/pricing, Q rollback rehearsal; then the R1-R30 map,
the final regression gates at final HEAD, and the 37-section report.

Command to resume the harness leg:
`node scripts/final-prelaunch-audit.mjs --offline --json /tmp/audit-offline.json`
