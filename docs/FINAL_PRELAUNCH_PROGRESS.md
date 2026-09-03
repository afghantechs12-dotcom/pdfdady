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
| B Visual acceptance | 138 baseline shots / 16 surfaces; 4 contact sheets from a 1-surface rerun | PARTIAL | yes | baseline 13/14/19, full compare, regenerate 5 sheets |
| C Launch profile | none | NOT STARTED | — | document decisions; invent nothing |
| D Fresh environment | `clean-worktree-5a4adca-npm-ci-build-probe.log` (at `5a4adca`) | COMPLETE — MUST RERUN AFTER LATER CHANGES | yes | rerun at final HEAD |
| E Tool runtime matrix | `tool-matrix.log/json` — 29/29, 2 env, 3 not exercised | COMPLETE — MUST RERUN AFTER LATER CHANGES | yes | rerun at final HEAD (ocr fix landed after) |
| F Core workflows | Phase 5 probe logs; `saveToWorkspaceRoute.test.ts` | PARTIAL | yes | final-HEAD probe run |
| G–J security | harness groups B,E,F,G,H,I | PARTIAL | yes | harness has never been run to a log |
| K Retention | `1d36b30`, `2cb2467`; `PdfToolWorkerHandler.test.ts`, `workerBootstrap.test.ts`, `saveIntentIdentity.test.ts` D24 | PARTIAL | yes | intent pruning RESOLVED (30-day horizon in the recurring sweep); J3 account deletion / data export still unresolved |
| L DB/backup/restore | `migration-restore-drill.log` — 13/13 | COMPLETE — FINAL EVIDENCE VALID | no | blank-chain leg still to record |
| M Reliability | harness group L/M; `readyRoute.test.ts` (7) | PARTIAL | yes | run harness; readiness toolchain gate now asserted (Q1/Q2) |
| N Performance | `perf-load-wf.json` (full), `perf-load.log` (truncated earlier run) | PARTIAL | no | document; log lags the JSON |
| O Browser + a11y | none beyond Phase 6 | NOT STARTED | — | Firefox/WebKit availability, keyboard pass |
| P SEO/pricing | harness groups O,P,Q | PARTIAL | yes | run harness |
| Q Deployment/rollback | `deploymentArtifact.test.ts`; mutation C | PARTIAL | yes | rollback rehearsal |
| R1–R30 (brief topics) | `finalPrelaunchRegression.test.ts` uses its OWN R1..R30 numbering | PARTIAL | — | map brief topics → tests, add missing |
| Mutations | A–O, P1–P3, Q1–Q2 (29 rows) recorded RED-and-reverted | COMPLETE — MUST RERUN AFTER LATER CHANGES | no | visual mutation still owed |
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

Open, not yet resolved: the `22 MB` upload leg of the perf probe answered
`400 Malformed multipart body.`; no account deletion or data export exists (J3);
SQLite vs PostgreSQL for launch is LAUNCH DECISION REQUIRED.

## Environmental blockers (host)

`soffice` absent → `pdf-to-word`, `html-to-pdf` unrunnable here. No `.docx`/
`.pptx`/`.xlsx` fixture → 3 office tools NOT EXERCISED. Playwright Firefox and
WebKit builds absent from `~/Library/Caches/ms-playwright` (chromium only).
No production credentials, no Docker daemon check yet, no human visual approval.

## Next action

Brief-R coverage gaps still open, in order: R24 (private routes not indexed — 11
route files declare `robots:{index:false}`, no test), R25 (sitemap registry
truth — only the harness reads source), R17 (`lib/server/cleanup.ts` has no
test). Then group B (visual), then the 21-step final verification.

Command to resume the harness leg:
`node scripts/final-prelaunch-audit.mjs --offline --json /tmp/audit-offline.json`
