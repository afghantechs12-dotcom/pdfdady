# PDFDadi — production go-live checklist

**Stage 14 of production acceptance.** Filled in at the release candidate below, on
2026-09-05. Every row carries one of six classifications and **no row is a PASS on
someone's intention**: `ENVIRONMENTAL`, `NOT EXERCISED`, `FAIL` and unresolved
launch-critical `MANUAL REVIEW` rows are counted as *not passed*, which is why the
verdict at the end of this file is what it is.

| | |
| --- | --- |
| Release commit | `1b45f1b` on `production-acceptance` (base `3e4ac8b`, `main` untouched, no remote) |
| Artifact | `.next/BUILD_ID` = `LK-prgSvGFf1hyM1etdkD`, built at this commit |
| Image digest | **none — no container runtime on the acceptance host** |
| Full suite | 393 files, 7 556 tests, **0 failures**, exit 0 |
| Dependency audit | `npm audit` **0 of 486**; `--omit=dev` **0 of 158** |
| Static harness | PASS **68/68 exercised**, PRODUCT FAILURE **0** (85 rows) |
| Open P0 / P1 | **none** |
| Owner rows still open | **33** — 22 decisions, 11 verifications ([register](evidence/production-acceptance/16-manual-decision-register.md)) |

**Classification legend.** `PASS` measured and green · `FAIL` measured and broken ·
`ENVIRONMENTAL` blocked by this host, not by the product · `NOT EXERCISED` never run ·
`MANUAL REVIEW` needs a human to look and affirm · `OWNER APPROVAL REQUIRED` needs a
decision only the owner can make.

## Code

| # | Row | Class | Evidence and what remains |
| --- | --- | --- | --- |
| C-1 | **Exact release commit** | PASS | `1b45f1b`, branch `production-acceptance`, cut from `ingress-memory-safety-closeout` at `3e4ac8b`. 139 commits ahead of `main`; nothing merged, tagged or pushed |
| C-2 | **Image digest recorded** | **NOT EXERCISED** | No `docker`/`podman`/`nerdctl`/`finch`/`buildah` on this host — re-verified at Stage 3 and unchanged. `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME`. Register **V8**/**V9**: build the image on a host that has one, record the digest here, and deploy *that* digest |
| C-3 | **Clean tree** | PASS | `git status --porcelain` empty at the commit above; harness `A1` re-asserts it (evidence paths excluded by design) |
| C-4 | **Full suite at the candidate** | PASS | `node scripts/suite-evidence.mjs --label pa-final` → 393 files / 7 556 tests / 0 failures / 9.9 s, exit 0. Baseline at `3e4ac8b` was 389 / 7 487; the four new files are `envContract`, `processorRegistry`, `storeLocation` and `monitoringSignals`. Log, JSON, JUnit and summary in [suite/](evidence/production-acceptance/suite/) |
| C-5 | **Build result** | PASS | `NEXT_PUBLIC_SITE_URL=… npm run build` exit 0, 63 static pages, `BUILD_ID LK-prgSvGFf1hyM1etdkD`. Served: `/api/health` 200, `/` 200 on origin and through TLS, readiness `degraded` for the host's missing converters only. The baked `reporting-endpoints` on `/_next/static/*` carries the origin passed at build time — **the production image must be built with the production `NEXT_PUBLIC_SITE_URL`**, it cannot be supplied at runtime |
| C-6 | **Dependency audit** | PASS | `npm audit` 0 vulnerabilities of 486; `npm audit --omit=dev` 0 of 158. Pinned by `finalReconciliation.test.ts` R1–R3 against npm's own JSON, with an anti-vacuity check |
| C-6b | **Image CVE scan** | **NOT EXERCISED** | No `trivy`/`grype`/`syft`/`docker-scout`. `npm audit` covers the dependency tree, **not** the base image's OS packages. Scan the image on the host that builds it |
| C-7 | **No open P0 or P1** | PASS | 0 P0, 0 P1. This acceptance found and fixed **1 P1** (`X-Forwarded-For` trusted from anyone, Stage 5), **3 P2** and **10 P3**, and found one more P3 it deliberately did not fix (the 401/404 console noise — changing an auth endpoint's status code is not a low-risk acceptance-time edit). Open lower-severity rows: **P2-2** Editor CLS 0.212, **P2-3**/**P2-4** observability, **P2-6** recommended closed — all register rows |
| C-8 | **Migrations known** | PASS | 24 migrations; `migrate deploy` (never `dev`, never `reset`) reaches head on an empty volume and is a no-op immediately after, exit 0 both times, `integrity_check ok`. One destructive statement in the 24, with its precondition in its own header and vacuous on a first deploy — register **V5** |
| C-9 | **Rollback known** | PASS | [rollback runbook](evidence/final-prelaunch/rollback-runbook.md), rehearsed in Stage 9: the previous artifact returned the same 8 218 bytes of `%PDF-` as the new one, 8/8. A **restore that loses data** needs a named authorizer and an acceptable loss window — register **D12** |
| C-10 | **Backup/restore verified** | PASS | `migration-restore-drill.mjs` 16/16: online `backup()` **while the database is open**, rows destroyed, byte-for-byte content restore, restored file at head. Object storage has **no drill of its own** — register **D11** |

## Infrastructure

Everything in this section is owner-supplied. Nothing here was configured by this
acceptance, because none of it exists yet.

| # | Row | Class | Evidence and what remains |
| --- | --- | --- | --- |
| I-1 | **Domain and DNS** | **OWNER APPROVAL REQUIRED** | `https://pdfdadi.com` appears in `.env.example` and SEO metadata as *intent*; no zone, no records, no registrar in this repository. Register **D1** |
| I-2 | **TLS** | **NOT EXERCISED** | Every HTTPS measurement used a throwaway self-signed cert on `192.168.0.175:3001`. HSTS `max-age=63072000; includeSubDomains` is emitted in production mode — which is a **two-year commitment on the real domain**, so verify the certificate chain and renewal before the first production response |
| I-3 | **Reverse proxy** | **NOT EXERCISED** | The documented nginx caps are pinned against `STREAMING_ROUTE_PATTERNS` in the suite, but no nginx ran: `scripts/tls-front.mjs` is a stand-in. Two settings are not optional — the body caps in [SERVER_SETUP.md](../SERVER_SETUP.md), and `TRUSTED_PROXY_SECRET` (below) |
| I-4 | **Hidden origin** | PASS *for the pattern*, **NOT EXERCISED** for the deployment | `HOSTNAME=127.0.0.1` is a real bind boundary: the origin port is refused on the LAN address (`curl` exit 7) while the front answers on it. In the shipped container the isolation is the published-port list instead, and that is a deployment-time fact |
| I-5 | **Single instance** | PASS | `DEPLOYMENT_TOPOLOGY=single-instance` is required at boot, and the lease makes it real: 8/8 singleton, takeover **11 731 ms** after SIGKILL, **428 ms** after SIGTERM. Two consequences for the platform: **no horizontal scaling** (SQLite single-writer, per-process rate limits), and the healthcheck must tolerate a lease wait — register **D19**, recommended `start_period=45s` |
| I-6 | **Persistent database** | **MANUAL REVIEW** | The gate refuses a relative or non-`file:` `DATABASE_URL`, but **it cannot see a mount point**: an absolute path with a typo applies all 24 migrations to a brand-new empty database and serves. Verify at first boot (I-10) |
| I-7 | **Persistent storage** | **MANUAL REVIEW** | Same shape, and the gate now refuses a relative *or empty* `STORAGE_LOCAL_ROOT` — the P2 this acceptance found. `LocalFileStorage` creates a missing root, so an unmounted volume looks like a first deploy. Verify at first boot (I-10). R2 is optional and unset; if it is used, **all four** variables or none |
| I-8 | **Backups scheduled, with an off-host copy** | **OWNER APPROVAL REQUIRED** | The *mechanism* is verified (C-10). Nothing schedules it, nothing copies it off the host, and nothing alerts when it stops. Register **D10** |
| I-9 | **Monitoring** | **NOT EXERCISED** | `MONITORING: NOT EXERCISED — NO PROVIDER`. [docs/ops/MONITORING.md](ops/MONITORING.md) is provider-neutral and its 22 alertable messages are pinned by `monitoringSignals.test.ts`, so a rename cannot silently disarm an alert. Two facts to design around: **there is no access log** (20 requests → 0 lines; `/api/metrics` is 404), so request rate, latency and HTTP error rate come from the proxy; and **two log shapes coexist**, so a JSON-only parser drops the refusal-to-boot line. Register **D16** |
| I-10 | **First boot: the mounts are actually mounted** | **MANUAL REVIEW** | Once, at first boot, before the first real upload: `docker compose exec app ls -l /app/data/db /app/data/storage /app/data/admin`, then `docker volume inspect pdfdadi-db pdfdadi-storage pdfdadi-data` after one upload. Nothing in the process can distinguish a missing mount from a first deploy — this row is why it is a human's job |
| I-11 | **Container memory limit ≥ 1 GB** | **OWNER APPROVAL REQUIRED** | Measured: RSS 171 MB idle → **peak 543 MB** at concurrency 4 on *page serving alone* → 322 MB ten seconds later (a second run: 334 → 652 → 369). Not a leak; a transient peak before any Ghostscript. **1 GB is the smallest limit that is not a gamble**, and `WORKER_CONCURRENCY` multiplies real memory on top of it. `docker-compose.yml` sets no limit today |
| I-12 | **Email** | **OWNER APPROVAL REQUIRED** | There is **no transactional email at all** — no verification, no password reset, no sender configured. The only support channel is `mailto:hello@pdfdadi.com`. Nothing in the product promises otherwise, so this is scope, not a defect: register **D5** (launch without recovery?) and **D6** (is that inbox monitored, by whom?) |
| I-13 | **Processing binaries** | **ENVIRONMENTAL here, MANUAL REVIEW there** | Readiness requires **all seven** — `soffice`, `gs`, `qpdf`, `pdftoppm`, `pdfinfo`, `tesseract`, `ocrmypdf` — as `every(Boolean)`, so **one missing binary answers 503 forever while 30 of 32 tools work**. `soffice` is absent on this host, which is why readiness reads `degraded` in every log here and why office conversion is `NOT EXERCISED`. The image installs all seven; confirm in the running container and decide the semantics — register **D17** |
| I-14 | **Secrets configured** | **OWNER APPROVAL REQUIRED** | Names only, set through the hosting provider or secret manager — never in the repository, never in this chat. **Required:** `DATABASE_URL`, `ADMIN_SECRET` (≥16 chars, and *not* the dev fallback), `NEXT_PUBLIC_SITE_URL` (**build-time as well as runtime**), `DEPLOYMENT_TOPOLOGY=single-instance`, `STORAGE_LOCAL_ROOT` (unless all four R2 variables), `ADMIN_STORE_DIR`. **Strongly recommended:** `TRUSTED_PROXY_SECRET` (without it every caller behind the proxy shares one rate-limit key). **Optional:** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` + `STRIPE_PRICE_PRO` (all three or billing stays off), the four `R2_*`, `REDIS_URL`, `STORAGE_SIGNING_SECRET`, `ANALYTICS_SUBJECT_SECRET`. The boot gate prints every problem at once and exits non-zero, so a missing one fails visibly rather than serving broken |

## Acceptance

| # | Row | Class | Evidence and what remains |
| --- | --- | --- | --- |
| A-1 | **Staging journeys** | PASS *against a local production-mode surrogate*; **NOT EXERCISED** against a staging host | There is no staging provider, host or DNS. Against the built standalone artifact behind real TLS: capability truth **49/49**, tool matrix **29/29 exercised / 0 product failures**, processing pilot **41/41**, Workspace reliability **29/29**, usage analytics **83/83**, workflow completeness **155/156**. Office conversion is `NOT EXERCISED` (no `soffice`, no fixtures) |
| A-2 | **Security** | PASS | Legacy job ownership **25/25**, proxy parity **37/37**, CSP **118/118**, upload abuse **32/32**, billing trust boundary **78/78** (3 environment-limited), usage ceiling in a browser **45/45**, ingress **25/25** — 28 × 100 MiB anonymous burst bounded to **26.5 MiB read of 2 800 MiB offered**, RSS peak +0. Billing is **off** and coherently so: `configured=false action=unavailable price=null`, POST 503, no fabricated amount |
| A-3 | **Recovery** | PASS | Worker killed mid-job **45/45**, singleton **8/8**, restore drill **16/16**, deploy-and-rollback rehearsal **8/8**. Container rollback itself is `NOT EXERCISED` (C-2) |
| A-4 | **Performance** | PASS, with one open row | 60 s at concurrency 4: **15 896 requests, 265/s, all 200**, p50 10 ms / p95 41 / p99 43. Cold start **393 ms** to a 200. Pages LCP 36–108 ms, CLS ≤ 0.017 — **except Workspace Editor: CLS 0.212** against a 0.1 threshold, register **D21**. Memory as in I-11. Every latency here is a **floor** (loopback and LAN, one machine, no CDN); throughput under saturation is unmeasured — register **V10** |
| A-5 | **Human visual acceptance** | **OWNER APPROVAL REQUIRED** | **`VISUAL ACCEPTANCE PENDING`.** A machine proved the pixels did not move (**156/156**, 14 px of 124 482 826 = 0.000011 %, both nonzero captures anti-aliasing on the tool-rail icons) — that is not approval. Five contact sheets in [visual/](evidence/production-acceptance/visual/); the checklist with Accept / Reject / Notes is [15-visual-acceptance.md](evidence/production-acceptance/15-visual-acceptance.md). One browser, emulated viewports, one machine: **no** iOS Safari, Android Chrome, Firefox, real DPR-3 device, screen reader, reduced-motion, forced-colors, print or 200 %-zoom pass, and no colour-contrast measurement anywhere. Register **V7** |
| A-6 | **Manual decisions** | **OWNER APPROVAL REQUIRED** (22) + **MANUAL REVIEW** (11) | [The register](evidence/production-acceptance/16-manual-decision-register.md), 33 open rows, **0 decided**. **18 are marked `BEFORE GO-LIVE`**; two more (**D7** erasure/export, **D8** consent) are legal questions conditional on **D4** (markets) and were deliberately left unanswered — **no consent banner was added**. Six of the 18 need *work*, not an answer: **V7** visual acceptance · **V8**/**V9** a real container build and first boot · **V4** the zip-bomb and malformed-xref fixtures, which **do not exist in this repository** · **D13** artifact retention for rollback (today: nothing is retained) · **D16** the log destination |

## What must be true before the first production request

Nine rows, in the order they have to happen. This is the go-live sequence, not a
restatement of the table above.

1. **Answer the 18 `BEFORE GO-LIVE` register rows.** Ten are owner decisions; eight are
   verifications a human performs.
2. **Build the image on a host with a container runtime**, with the production
   `NEXT_PUBLIC_SITE_URL` as a `--build-arg`, and **record the digest** (C-2, V8).
3. **Scan that image** for OS-package CVEs (C-6b).
4. **Boot it on the real volumes and verify the mounts** before the first upload (I-10).
5. **Configure the secrets by name** through the provider (I-14). The gate prints every
   missing one at once.
6. **Set a memory limit of at least 1 GB** and a healthcheck `start_period` that
   tolerates a lease wait — 45 s, not 20 s (I-11, D19).
7. **Schedule backups with an off-host copy**, and alert when they stop (I-8).
8. **Choose where logs and errors go** before writing either adapter (I-9, D16).
9. **Accept the visual package** (A-5). Only the owner can.

## Verdict

Code readiness and infrastructure readiness are not the same thing, and this checklist
separates them deliberately. **The code is a credible release candidate**: 7 556 tests
green at the commit named above, zero P0/P1, zero dependency vulnerabilities, a
build that serves, a rehearsed rollback, and a restore drill that destroys real rows and
puts them back byte-for-byte. **The deployment does not exist yet**: no image has ever
been built, no container has ever run, no domain, no TLS, no proxy, no monitoring, no
scheduled backup, and no human has approved a single screenshot.

`NOT READY FOR PRODUCTION — ACCEPTANCE BLOCKERS REMAIN`
