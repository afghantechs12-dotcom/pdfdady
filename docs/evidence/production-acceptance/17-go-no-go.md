# Stage 14 — go/no-go checkpoint

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Release commit:** `1b45f1b`
**Deliverable:** [`docs/PRODUCTION_GO_LIVE_CHECKLIST.md`](../../PRODUCTION_GO_LIVE_CHECKLIST.md)
**Measurements below ran at the release commit, on the artifact this stage built.**
**No product code changed in this stage. No test was added.**

## 1. What was re-measured, and why at all

Stages 6–12 measured a running surrogate built in Stage 9 (`MniplDUweIbeIPYT_CM5N`,
from `209b1ca`). Five commits landed after it. Before reusing any of those
measurements, the question is whether they still describe this tree:

```
git diff --stat 209b1ca..HEAD -- app lib src ingress next.config.mjs proxy.ts \
  instrumentation.ts prisma package.json package-lock.json data      # empty
```

**Empty.** The five commits touched documentation, evidence, three probe scripts and
two root-level test files (`monitoringSignals.test.ts`, `deploymentArtifact.test.ts`).
No compiled application code, no schema, no dependency. So the surrogate's numbers
stand for this tree — and the rebuild below is a fresh artifact of the *same*
application code, not a new subject.

## 2. The final candidate

| Command | Exit | Result |
| --- | --- | --- |
| `node scripts/suite-evidence.mjs --label pa-final --out docs/evidence/production-acceptance/suite` | 0 | **393 files, 7 556 tests, 0 failures**, 9.9 s. `GREEN`, 0 failures recorded |
| `NEXT_PUBLIC_SITE_URL=https://192.168.0.175:3001 npm run build` | 0 | 63 static pages, `BUILD_ID` **`LK-prgSvGFf1hyM1etdkD`** |
| `scripts/restart-origin.sh` then `curl` | 0 | `/api/health` **200** `{"ok":true,"status":"up"}` in 30 ms; origin `/` **200**; front `/` **200**; `/tools` **200** |
| `curl /api/health/ready` | — | **503 `degraded`** — `dataDir:true toolchain:false database:true instance:true`; the host's missing `soffice`, unchanged since Stage 6 |
| `npm audit` | 0 | **0 vulnerabilities**, 486 dependencies |
| `npm audit --omit=dev` | 0 | **0 vulnerabilities**, 158 production dependencies |
| `node scripts/final-prelaunch-audit.mjs --json 17-static-harness.json` | 0 | **PASS 68/68 exercised**, PRODUCT FAILURE **0**, ENVIRONMENTAL 2, NOT EXERCISED 4, MANUAL REVIEW 11, 85 rows |

Suite evidence: [`suite/pa-final.log`](suite/pa-final.log), `.json`, `.junit.xml`,
[`.summary.json`](suite/pa-final.summary.json). Harness:
[`17-static-harness.json`](17-static-harness.json), [`.log`](17-static-harness.log).

**Suite delta from the accepted baseline** (389 files / 7 487 tests at `3e4ac8b`):
four new files, all from this acceptance — `src/infrastructure/config/envContract.test.ts`,
`src/infrastructure/processing/processorRegistry.test.ts`,
`data/admin/storeLocation.test.ts`, `monitoringSignals.test.ts` — plus cases added to
`deploymentArtifact.test.ts` and `env.test.ts`. **No file disappeared.**

**The rebuild proves one deployment fact, not just a green build.** The
`reporting-endpoints` header on `/_next/static/chunks/*.js` came back as
`csp-endpoint="https://192.168.0.175:3001/api/csp-report"` — the origin passed at
*build* time. `/_next/static/*` bypasses the proxy that could add it later, so the
production image must be built with the production `NEXT_PUBLIC_SITE_URL`. It is the
only variable in `.env.example` that is both build-time and runtime, and
`docker-compose.yml` already passes it as a `--build-arg`.

## 3. The consolidated table of everything this acceptance could not supply

One table, as the brief requires, rather than a missing item announced per stage.
**Secret names only — no value was requested, echoed or written at any point in this
acceptance.** Set each through the hosting provider or secret manager.

| # | Missing input | Blocks | Consequence today |
| --- | --- | --- | --- |
| 1 | A **container runtime** (`docker`/`podman`/`nerdctl`/`finch`/`buildah`) | C-2, V8, V9, container rollback | The image has **never been built or run**. Every container claim in this acceptance is a static relationship between the deployment files and the tree |
| 2 | An **image scanner** (`trivy`/`grype`/`syft`/`docker-scout`) | C-6b | Base-image OS packages are unscanned. `npm audit` covers only the dependency tree |
| 3 | A **staging host**, provider credentials and DNS | A-1 at staging, I-1, I-2, I-3 | Stages 6–12 ran against a local production-mode surrogate behind a self-signed cert on `192.168.0.175:3001` |
| 4 | The **production domain and TLS certificate** | I-1, I-2 | `https://pdfdadi.com` is intent in `.env.example` and SEO metadata; nothing is provisioned. HSTS is a two-year commitment once served |
| 5 | The **reverse proxy** (nginx or platform equivalent) | I-3, and all request telemetry | The body caps are pinned in the suite but never applied; the app writes **no access log**, so rate, latency and HTTP error rate have no source without the proxy |
| 6 | `TRUSTED_PROXY_SECRET` | I-3, I-14 | Without it `X-Forwarded-For` is ignored (correctly), so **every caller behind the proxy shares one rate-limit key** and one of them can spend the credential endpoints' budget for everyone. The server warns once per process |
| 7 | `soffice` / LibreOffice on the acceptance host | 5 office tools, 1 workflow row | `pdf-to-word` and `html-to-pdf` are ENVIRONMENTAL; `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` are NOT EXERCISED (no fixtures either). Readiness answers 503 `toolchain:false` here because the check requires **all seven** binaries |
| 8 | **Stripe test-mode credentials** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`) | 3 billing rows | A real checkout URL, a real portal URL and a real price rendered as an amount are unexercised. Billing-off is verified as a **coherent** state: `configured=false`, POST 503, no fabricated amount |
| 9 | A **monitoring provider** (and DSN/ingest key) | I-9, D16 | `MONITORING: NOT EXERCISED — NO PROVIDER`. No provider, endpoint or dashboard was invented |
| 10 | A **backup destination** off the host, and a scheduler | I-8, D10 | The restore mechanism is verified 16/16; nothing runs it, copies it away, or alerts when it stops |
| 11 | **Hostile document fixtures** — zip bomb, malformed xref | V4 | They **do not exist in this repository** and were not synthesized. An encrypted fixture, `repair-pdf` and the page ceiling are covered; those two shapes are not |
| 12 | A **second browser engine and a real device** | A-5 | 156 captures and 63 responsive measurements are Chrome with emulated viewports on one machine. No iOS Safari, Android Chrome, Firefox, DPR-3 device, screen reader, reduced-motion, forced-colors, print or 200 % zoom; no colour-contrast measurement |
| 13 | A **Git remote** | nothing shippable leaves this machine | Nothing pushed, nothing tagged, `main` untouched — as instructed |
| 14 | **The owner** | A-5, A-6 | `VISUAL ACCEPTANCE PENDING` and 33 open register rows, 18 of them `BEFORE GO-LIVE` |

Rows 1–3 and 14 are the load-bearing ones: **1–3 are why "the deployment does not
exist yet" is a measurement rather than a caution, and 14 is why no verdict here can
be READY.**

## 4. How every row was classified

The brief forbids counting `ENVIRONMENTAL`, `NOT EXERCISED`, `FAIL` or an unresolved
launch-critical `MANUAL REVIEW` row as a PASS. Applied literally to the 29 checklist
rows:

| Class | Count | Rows |
| --- | --- | --- |
| PASS | **12** | C-1, C-3, C-4, C-5, C-6, C-7, C-8, C-9, C-10, A-2, A-3, A-4 |
| PASS *for the pattern*, not for the deployment | **2** | I-4, A-1 |
| NOT EXERCISED | **4** | C-2, C-6b, I-2, I-3 |
| MANUAL REVIEW | **4** | I-6, I-7, I-10, I-13 |
| OWNER APPROVAL REQUIRED | **7** | I-1, I-8, I-11, I-12, I-14, A-5, A-6 |
| FAIL | **0** | — |

The two "PASS for the pattern" rows are deliberately not counted as clean passes:
`HOSTNAME=127.0.0.1` was proved to be a real bind boundary *here*, and the shipped
container achieves the same isolation by a different mechanism (the published-port
list), which is a deployment-time fact; and A-1's journeys passed against a surrogate,
not a staging host.

Two rows carried forward from earlier stages keep their qualification, as those stages
demanded:

- **N3** is `NOT EXERCISED` in the harness and *partly* answered by Stage 11 — sustained
  load and cold start measured, memory measured as a **peak**, not a **ceiling**. It is
  register **V10** and is **not** recorded as a clean PASS.
- **R3** / visual acceptance stays `VISUAL ACCEPTANCE PENDING`. A 156/156 pixel compare
  is not approval.

## 5. What Stage 14 does NOT establish

- **That any of this works in a container.** Unchanged since Stage 3, re-verified: no
  runtime, no scanner. `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME`.
- **That the production environment is correct**, because it does not exist. The gate
  checks the *shape* of a path, never whether it is a mount point.
- **Any register row.** Stage 14 classifies them; it decides none. The two legal rows
  (**D7** erasure/export, **D8** consent) stay unanswered and **no consent banner was
  added**.
- **That the numbers reused from Stages 6–12 would hold on real hardware.** They were
  measured on one machine over loopback and LAN, with no CDN, no throttling and no other
  tenants. Every latency is a floor.
- **Production readiness of the operational routine.** Backups are verified as a
  mechanism, not as a schedule; monitoring is a document, not a destination.

## Files changed by this stage

| File | Change |
| --- | --- |
| `docs/PRODUCTION_GO_LIVE_CHECKLIST.md` | **New.** The checklist, 29 classified rows, the nine-step go-live sequence, the verdict |
| `docs/evidence/production-acceptance/17-go-no-go.md` | **New.** This file |
| `docs/evidence/production-acceptance/17-static-harness.{json,log}` | **New.** The harness at the release commit |
| `docs/evidence/production-acceptance/suite/pa-final.{log,json,junit.xml,summary.json}` | **New.** The full suite at the release commit |
| `docs/PRODUCTION_ACCEPTANCE_PROGRESS.md` | Stage 14 section; stage-status row; artifact header updated to the final candidate |
| `docs/PDFDADI_FEATURE_LEDGER.md` | The final-candidate verification, and why the verdict is not READY |

**NOT READY FOR PRODUCTION — ACCEPTANCE BLOCKERS REMAIN** — no P0/P1 and nothing red in
the code; the deployment, and the owner's decisions, are what is missing.
