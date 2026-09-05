# Stage 13 — manual decision register

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b`
**Sources:** `09-static-harness.json` (85 rows) · [§35, §36 and §37](../../FINAL_PRELAUNCH_AUDIT.md) · [rollback-runbook.md](../final-prelaunch/rollback-runbook.md) · [erasure-export-j3.md](../final-prelaunch/erasure-export-j3.md) · Stages 4, 7, 8, 11 and 12 of this acceptance
**Code changed by this stage:** one test assertion, in an existing file. No product code.

> **THIS FILE DECIDES NOTHING.** Every row below is either a choice that belongs to the
> owner or a check only a human — or another host — can make. Where the evidence
> supports a recommendation it is labelled as one, and a recommendation is not a
> decision: no row is closed by this document. The two legal rows (account erasure and
> export; whether first-party measurement needs consent) are recorded and **not
> answered**, and no consent banner was added to make one of them disappear.

## What Stage 13 has to answer

1. Which rows still need a human — stated **once each**, rather than four times across
   four documents that each know about some of them?
2. Which are **decisions** (both answers are supported; the difference is business or
   operations) and which are **verifications** (there is one right answer, and this host
   cannot produce it)?
3. Which rows that earlier documents list as open are **no longer true** at this branch
   tip? A register that carries a phantom row makes Stage 14's count wrong.
4. What does each row cost if it is answered wrong, or not at all?

## 0. How to read a row

Every row has an id, a class, a gate and a source.

| Field | Values |
| --- | --- |
| **Class** | `DECISION` — the owner picks, and the code supports either answer. `VERIFY` — one right answer; a human, or a host this one is not, has to produce it |
| **Gate** | `BEFORE GO-LIVE` — the answer has to exist before the first real user. `SCHEDULABLE` — record the answer, act on it later |
| **Rec.** | present only where the evidence in this branch supports one. It is advice, not a closure |

Two things the classes do **not** mean. A `SCHEDULABLE` row is still an open row: Stage 14
classifies every row here as `OWNER APPROVAL REQUIRED` or `MANUAL REVIEW` and **none of
them as PASS**, per the brief. And `BEFORE GO-LIVE` is about the *answer*, not the *work*:
"we accept this limitation" is a complete answer to most of them.

## 1. Four rows earlier documents call open, that are not open any more

Checked because a register is only useful if its rows are live. Each of these was
measured at this tree, not reasoned about.

| Row | Earlier state | Measured now | Disposition |
| --- | --- | --- | --- |
| **P2-1** nine npm advisories in `next`, `prisma`, `pdfjs-dist`, `postcss`, `nanoid`, `brace-expansion`, `deepmerge-ts`, `@prisma/config` ([§35](../../FINAL_PRELAUNCH_AUDIT.md)) | "a scheduled-maintenance item"; 9 distinct production advisories and 11 in the full graph, recorded 2026-09-04 | `npm audit` → **0 of 486**; `npm audit --omit=dev` → **0** (158 prod deps). The upgrades landed in `77d45b1`, *before* this branch's base: `next` 16.2.12→16.3.4, `pdfjs-dist` 6.1.200→6.3.289, `postcss` 8.4.31/8.5.18→8.5.23/8.5.28, `nanoid` 3.3.16→3.3.18, `brace-expansion` 5.0.8→5.0.9, `deepmerge-ts` 7.1.5→8.0.2 (by `overrides`), `sharp` 0.34.5→0.35.4, `browserslist` 4.28.4→4.28.9 | **CLOSED, and pinned.** [finalReconciliation.test.ts](../../../finalReconciliation.test.ts) R1–R3 re-derive the inventory from npm's own JSON, assert no installed copy sits inside any advisory's vulnerable window, and carry an anti-vacuity check that each pre-fix version *did* fall inside it. 18/18 green today. A silent revert is a red test, not a returning advisory |
| **P2-5** `Dockerfile` has CRLF line endings — "the only deploy-critical file that does" | left unchanged deliberately: the container path was NOT EXERCISED and a blind edit to an unbuildable artifact was judged worse | **88 of 88 lines were CRLF at `388e8af`; 0 of 119 are today.** `docker-compose.yml`, `.dockerignore`, `ingress/*.mjs`, `SERVER_SETUP.md` and `.env.example`: 0 each | **CLOSED — but it was closed by accident**, by an edit with another purpose, which is precisely the state that regresses on the next edit from a Windows checkout. Pinned by a new assertion; see §5 |
| **F5** a cross-tenant read is refused end-to-end (harness `NOT EXERCISED` — "needs two provisioned accounts") | delegated to a runtime probe | Exercised in **Stage 7** of this acceptance: [10-workspace-reliability.log](10-workspace-reliability.log) rows 12 and 13 — **29/29**, two real accounts in one browser. The outsider gets the same controlled 404 for a Workspace that rendered for its owner seconds earlier, and their own picker does not list it | **PASS.** The row's own instruction ("run `scripts/phase1-workspace-reliability-probe.mjs` with `--auth`") is what was run |
| **R2** 111 rendered-layout assertions across 9 viewports | `NOT EXERCISED`, delegated | Retired in **Stage 12**: 125 premium gates + 63 responsive measurements, reported under their own counts as the row instructed | **PASS** (recorded here only so the count reconciles) |

**Net effect on Stage 14: four fewer rows, and one new test.** The open-P2 set is
**P2-2, P2-3, P2-4, P2-6** — four, not six.

## 2. Verification rows — a human, or another host, has to look

| id | Row | Source | Gate | What the human actually does |
| --- | --- | --- | --- | --- |
| **V1** | No secret **value** is committed anywhere in the tree | harness `A3` | BEFORE GO-LIVE | Read the 2 matches. Both are in `src/infrastructure/billing/stripeProbeSecretHygiene.test.ts` — synthetic fixtures whose current contents the harness pins by sha256, so any edit to that file turns the row red again. Stage 1 independently found that of 1 692 tracked files only `.env.example` and `data/admin/store.json` match secret-shaped patterns, and the latter's `settings.adminPasswordHash` is `""`. **A machine can find the shape; only a person can affirm no string is a live credential** |
| **V2** | No secret value is reachable in local Git history | harness `A4` | BEFORE GO-LIVE | Same two matches, same file, across **1 806 historical blobs**; no other path matched in any revision. Same affirmation as V1 |
| **V3** | No default admin password ships, and an initialized deployment cannot be re-setup | harness `E6` | BEFORE GO-LIVE | Confirm the shipped `data/admin/store.json` seeds no hash (it is `""`), then confirm on the **live** deployment that `/admin/setup` is closed once a password is set. The stake is not content: with no hash, setup re-opens to whoever reaches it first, rate-limited 10/min and nothing else |
| **V4** | Hostile document fixtures — zip bomb, encrypted, malformed xref, embedded JS | harness `G6` | BEFORE GO-LIVE | **The fixtures do not exist in this repository and were not synthesized** ([§36](../../FINAL_PRELAUNCH_AUDIT.md)); the brief forbids running unsafe payloads outside controlled ones. Partial coverage exists and is not a substitute: `unlock-pdf` processed a real encrypted PDF (`docs/qa/final-prelaunch/encrypted-fixture.pdf`, [10-tool-runtime-matrix.log](10-tool-runtime-matrix.log)), `repair-pdf` ships for damaged files, a 300-page document is refused with its page ceiling rather than a damage message, and the pdf.js advisory's precondition (`enableScripting` with no `script-src`) is absent on both counts. **Zip bomb and malformed xref are unexercised** |
| **V5** | No migration is destructive without an explicit statement of intent | harness `K3` | BEFORE GO-LIVE | One data-losing statement in 24 migrations: `20260802175053_autosave_snapshot_metadata` does `ALTER TABLE "autosave_drafts" DROP COLUMN "payload"`. Its own header states the intent and the precondition — *"not applied to an existing deployment with data in `autosave_drafts`"*. **On a first deploy to an empty volume the row is vacuous**: the table is created and altered with zero rows, which is exactly what Stage 4 measured (24 migrations, 43 tables, `integrity_check ok`). It becomes live only if this schema is ever applied over a database that predates the correction — then the pre-migration drafts must be exported or discarded first |
| **V6** | No route opts out of static rendering without a reason to | harness `N2` | SCHEDULABLE | Five routes opt out, and each reason is in the file. `server-status` — `force-dynamic` for a live dependency probe, plus `robots: index:false`. `tools/[slug]` — `await connection()` for the pilot tool, with a comment saying why: without it `generateStaticParams` would freeze the pipeline flag at build time and report a completed job as "Processing failed". `login`, `register`, `signup` — each awaits `searchParams` (`returnTo`/`next`), which is per-request by definition. **Affirm, do not investigate** |
| **V7** | Visual acceptance of the rendered screenshots **by a human** | harness `R3`, [§36 X-1](../../FINAL_PRELAUNCH_AUDIT.md), Stage 12 | BEFORE GO-LIVE | Open the five contact sheets in [visual/](visual/) and accept or reject. Stage 12 proved the pixels did not move (**156/156**, 14 px of 124 482 826); it proved nothing about whether they are right. `VISUAL ACCEPTANCE PENDING` |
| **V8** | The image actually builds | harness `C7`, [§36 E-2](../../FINAL_PRELAUNCH_AUDIT.md) | BEFORE GO-LIVE | `docker build` on a host with a container runtime, then record the digest. This machine has none — docker, podman, nerdctl, finch, colima, lima, buildah and kubectl are all absent. Stage 3 validated the file statically and Stage 4 ran the container's **commands** on the host; neither is a build |
| **V9** | The built image migrates a fresh volume and serves | harness `C8` | BEFORE GO-LIVE | Same host as V8: `docker compose up`, then `docker compose exec app ls -l /app/data/db /app/data/storage /app/data/admin` and `docker volume inspect` after the first upload. **Nothing in the process can tell a typo'd absolute path from a first deploy** — Prisma creates the directory, applies 24 migrations, exits 0 and serves ([07-database-storage.md](07-database-storage.md) §7). The gate checks a path's *shape*; only a person can check that it is a mount |
| **V10** | Memory **ceiling** under concurrency | harness `N3` | SCHEDULABLE | Stage 11 answered two thirds of this row: sustained load **15 896 requests / 265 per second / all 200** at concurrency 4, cold start **393 ms** to a 200. Memory was measured as a **peak** (171 → 543 → 322 MB; a second run 334 → 652 → 369; floor rises ~35 MB then stops — not a leak), never as a ceiling: nothing here was run against a container memory limit until it died. **Stage 14 must not record N3 as a clean PASS.** *Rec.* — set the limit to **1 GB** and treat the ceiling as unmeasured; `WORKER_CONCURRENCY` multiplies real memory on top of page serving |
| **V11** | One unexplained `Uncaught` page exception | Stage 7, [10-user-acceptance.md:171](10-user-acceptance.md#L171) (**S1**) | SCHEDULABLE | Seen once on the previous artifact, non-reproducing in three subsequent runs, and *"a probe that cannot reproduce a fault has not proved the fault absent"*. There is nothing to decide and nothing to fix; it is carried so it is not silently dropped. **It is also the best argument for D16**: with no error-monitoring backend, a recurrence in production produces no alert and no stack |

## 3. Decision rows — the owner picks

### 3.1 Launch shape (D1–D6)

| id | Decision | Gate | What turns on it |
| --- | --- | --- | --- |
| **D1** | **Domain, DNS and TLS.** `https://pdfdadi.com` is configured intent only | BEFORE GO-LIVE | And **before the image is built**, not just before it runs: `NEXT_PUBLIC_SITE_URL` is the one variable that is both build-time and runtime, because `next.config.mjs` bakes the CSP `report-to` endpoint for `/_next/static/*` from it and the proxy deliberately does not run for those paths. A runtime value cannot supply it afterwards. It also builds every signed download and multipart-upload URL, so a loopback value hands clients links to their own machine — which is why the production gate refuses `localhost`, `127.0.0.1`, `0.0.0.0` and `::1`. Stage 5 established that TLS termination in front of the origin is the supported shape, and that `TRUSTED_PROXY_SECRET` must be set if a proxy is used or every caller shares one rate-limit key |
| **D2** | **Are Stripe keys set at launch?** | SCHEDULABLE | *No recommendation — this is a billing decision.* The technical half is settled and tested: with none of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO` set, billing is **off as a coherent state**, not half-working. Stage 8 measured it: an owner on a billing-absent deployment is offered no purchase at all (`configured=false action=unavailable price=null`), the checkout POST answers `503 BILLING_NOT_CONFIGURED`, no currency amount is fabricated anywhere, and no entitlement can change without a signature-verified webhook ([11-billing.log](11-billing.log) §18). All three are runtime-only, so they can be added later with a restart — no rebuild |
| **D3** | **Does the free tier stay free?** | SCHEDULABLE | *No recommendation — business.* Copy deliberately says "$0 today". `USAGE_LIMIT_MODE` ships as `observe`: consumption is recorded and never refused. Turning it to `enforce` makes the plan ceilings in `src/domain/metering/plans.ts` real |
| **D4** | **Markets, languages, currency** | BEFORE GO-LIVE | *No recommendation — business.* One language, `$` implied, no stated market. **It gates D7 and D8**: whether erasure/export and consent are obligations or features depends entirely on which jurisdictions are served, so this row has to be answered first |
| **D5** | **Launch without password recovery?** | BEFORE GO-LIVE | There is no reset flow. An operator can reset a hash by hand; a locked-out user's only route is D6's inbox. Both answers are supported — the decision is whether that route is acceptable, and it cannot be answered separately from D6 |
| **D6** | **Is the single support inbox monitored?** | BEFORE GO-LIVE | It is the entire support plan, and `/contact` has no mail transport behind it — the audit fixed the copy that claimed otherwise, and adding a transport is feature work no acceptance stage may do. So the inbox is reached by the address in the copy, not by the form |

### 3.2 Legal — recorded, not answered (D7, D8)

Both rows are stated and neither is decided. This acceptance has no standing to answer
them, and the brief forbids trying.

| id | Decision | Gate | The facts, and only the facts |
| --- | --- | --- | --- |
| **D7** | **Account erasure and data export** | Conditional on D4 | harness `J3` and §37 #9. Nothing user-facing exists: no delete-account route, no export route, no admin route that removes a user. **`model User` has no relations at all** — eight scalar fields — while a user id appears in **23 columns across 22 models**, every one a plain `String` with no foreign key and therefore no cascade. Deleting a `users` row today succeeds and orphans all 23 references, because nothing stops it. So this is not a small feature: it has to be written by hand against 22 models, and it has to decide what happens to **shared** content (a `DocumentVersion` created by a departing member is part of a workspace others still use, and the content-addressed store deliberately keeps bytes alive while any reference remains). Full analysis: [erasure-export-j3.md](../final-prelaunch/erasure-export-j3.md). **The smallest thing that closes the gap without new code is a written manual procedure, and it does not exist today** |
| **D8** | **Does first-party measurement need a consent banner?** | Conditional on D4 | harness `Q4`. Measurement is first-party and self-hosted (`POST /api/analytics/events`), with no third-party script and no cross-site identifier; the only cookie is the session cookie. The subject pseudonym is a daily-rotated HMAC. Whether that is "strictly necessary" under the applicable rules is a legal question. **No consent system was added.** Inventing one would answer an audit row rather than a legal requirement, and the brief names this row specifically |

### 3.3 Data, backup and rollback (D9–D14)

| id | Decision | Gate | What turns on it |
| --- | --- | --- | --- |
| **D9** | **`audit_logs` retention** | SCHEDULABLE | The only table with no expiry and deliberate append-only growth. On single-writer SQLite unbounded growth is a disk question, and the disk is the same volume as the database |
| **D10** | **Backup schedule, and an off-host copy** | BEFORE GO-LIVE | The **procedure** is proven and the **policy** does not exist. `node scripts/migration-restore-drill.mjs` → **PASS 16/16**: the backup is taken with `node:sqlite`'s online `backup()` while the database is open, rows are then destroyed, and the restore reproduces them byte-for-byte with the file at migration head. Also measured: `journal_mode` is **`delete`**, not WAL — so a hot `cp` is not a backup, and not for the reason the runbook originally gave (a copy taken mid-transaction can capture a database whose rollback journal is not copied with it). A schedule with no off-host copy protects against deletion, not against losing the host |
| **D11** | **Does the storage volume need a restore drill of its own?** | SCHEDULABLE | The drill covers the database only. Object storage has none: the documents are immutable blobs whose keys the database references, so the procedure is a volume snapshot taken **with** the database snapshot — restoring one without the other yields records whose bytes are gone. That pairing is written in the runbook and has never been exercised. *Rec.* — one drill, once, on the host that has a container runtime (V8/V9): snapshot both, destroy a stored object, restore, open the document. It is the same shape as the database drill and would catch a mount that is snapshotted but not restored |
| **D12** | **Who authorizes a restore that loses data, and what loss window is acceptable?** | BEFORE GO-LIVE | §37 #12 and the runbook's own `LAUNCH DECISION REQUIRED`. Case B — the release added a migration — requires rolling the image back **and** restoring the pre-deploy snapshot, and *everything written between the deploy and the restore is lost*: accounts, documents, versions, jobs. The runbook's own advice is that rolling *forward* with a fix is usually cheaper. **The decision has to be made in minutes, which means the authority has to exist before the incident** |
| **D13** | **Image and artifact retention for rollback** | BEFORE GO-LIVE | §37 #11, and today's answer is *zero*: there is no remote, no registry and no container runtime, so no previous image exists anywhere to roll back **to**. Case A ("roll the image back on its own") presupposes a recorded digest and a registry that still has it. `docker compose down` — **never `down -v`**, which destroys the volumes |
| **D14** | **SQLite now, or PostgreSQL before launch?** | BEFORE GO-LIVE | Three things are downstream of this one row, and all three are declarations today rather than tuning knobs: `DEPLOYMENT_TOPOLOGY=single-instance` is the only accepted value; the upload rate limiter counts in **one process's** memory, so N instances each admit the full budget; and `journal_mode=delete` means writers block readers for the duration of a write. Moving to PostgreSQL is a schema-provider change **plus a regenerated migration history**, which is cheap now and a data migration after launch. Scaling out is a shared rate-limit store, then PostgreSQL, then the topology variable — in that order |

### 3.4 Operations (D15–D18)

| id | Decision | Gate | What turns on it |
| --- | --- | --- | --- |
| **D15** | **Upload rate-limit numbers, and whether a second limit belongs in front of the app** | SCHEDULABLE | §37 #14, now a *tuning* decision rather than a *whether* decision: the limiter shipped and is on by default — `UPLOAD_RATE_LIMIT_PER_MIN` 120 per authenticated user, `UPLOAD_ANON_RATE_LIMIT_PER_MIN` 20 per client address, `UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN` 240 as the ceiling rotation cannot escape, 60 s window, counted **before** the multipart body is read. Stage 11 measured the refusal for real: a one-IP burst of 25 gave 20×202 and **5×429** with `retry_after 10`. What is open is the numbers, and whether a proxy-layer limit should exist as well — which is the same question as D14, since a per-process limiter is only sound while there is one process |
| **D16** | **Where stdout is collected and for how long — and the two adapters waiting on that answer** | BEFORE GO-LIVE | Four source rows, one decision; see below |
| **D17** | **Readiness semantics: accept presence-only, or split per-subsystem** | SCHEDULABLE | harness `L3`; see below |
| **D18** | **Admin session revocation** | SCHEDULABLE | harness `E5`. The admin session is a stateless HMAC with a 7-day max age, so **an individual token cannot be revoked**; rotating `ADMIN_SECRET` invalidates all of them at once, which works and is blunt. Accept it, or schedule server-side session state. Note the coupling: `ADMIN_SECRET` also signs local storage download URLs unless `STORAGE_SIGNING_SECRET` is set separately, so a rotation done as an incident response also invalidates every outstanding download link — setting the second variable now is what decouples them later |

**D16 in full.** These four rows are one decision wearing four hats, and answering the
first makes the other three either cheap or unnecessary:

- harness `M3` — log aggregation, alerting and an on-call route: *"no aggregation target
  is configured in this tree; a single-container deployment logs to stdout only"*.
- §37 #6 — where stdout is collected and for how long: *"decides whether 'was there an
  error last Tuesday' is answerable"*.
- **P2-3** — no error-monitoring backend (`ConsoleErrorReporter`): a production incident
  produces no alert. One adapter, loses no data.
- **P2-4** — metrics exist but never leave the process: no time series for an incident.
  One adapter.

What Stage 10 measured, which is what makes this row concrete rather than a best
practice: **20 requests added 0 log lines**, and `/api/metrics` and `/metrics` are both
404. So request rate, latency and HTTP error rate must come from the reverse proxy or the
platform — there is no application-side source for them today. Stage 10 delivered
provider-neutral templates in [docs/ops/MONITORING.md](../../ops/MONITORING.md) and
invented no provider, DSN, ingest key or dashboard: `MONITORING: NOT EXERCISED — NO
PROVIDER`. *Rec.* — choose the destination first (it is one owner decision), then wire
the two adapters to it; writing either adapter before the destination is known is how a
codebase acquires an integration nobody reads. V11 is the standing example of what the
gap costs.

**D17 in full.** `toolchainOk` is `Object.values(deps).every(Boolean)` over
`soffice`, `gs`, `qpdf`, `pdftoppm`, `pdfinfo`, `tesseract` and `ocrmypdf`. All seven back
shipping tools and the `Dockerfile` installs all seven, so the container path is
satisfiable — this is not a latent 503. Two consequences the owner is choosing between:

- A host missing **one** binary answers 503 **forever** while 30 of 32 tools work. That is
  this very machine (`soffice` absent), and it is the truthful answer to "is everything I
  advertise available", not a bug.
- Readiness **never writes** to the storage volume, and never touches the database volume:
  its `dataDir` check is `fs.access(path.dirname(STORE_PATH))` — the presence of
  `/app/data/admin` and nothing more. **A read-only or unmounted storage volume leaves
  readiness reporting 200.**

*Rec.* — accept presence-only for launch, and record it, rather than change it during
acceptance: readiness decides when a load balancer drains an instance, so widening it is a
behaviour change that wants its own measurement. If it is changed later, the shape that
pays is per-subsystem (`toolchain` degraded vs `storage` unwritable), because "one missing
converter" and "the disk is gone" deserve different answers.

### 3.5 Rows this acceptance opened (D19–D22)

| id | Decision | Gate | What turns on it |
| --- | --- | --- | --- |
| **D19** | **The lease-503 blind spot, and what the container healthcheck should target** | BEFORE GO-LIVE | Stage 12; see below |
| **D20** | **The console error every anonymous visitor prints** | SCHEDULABLE | Stage 12, P3; see below |
| **D21** | **Workspace Editor CLS 0.212** — fix before launch, or accept | SCHEDULABLE | **P2-2**, reproduced in Stage 11 byte-for-byte on a payload 8 KB *smaller* than prelaunch's: LCP 408 ms, CLS **0.212** against a 0.1 threshold, 913 KB / 449 KB JS. A visible quality defect on the authenticated workbench, not a functional failure; the fix is a reserved-height container. It is product code, so no acceptance stage may change it silently |
| **D22** | **Accept the recommendation to close P2-6** | SCHEDULABLE | The ≈3 s `server_processing` was an observation, not a diagnosis. Stage 11 diagnosed it: 500 ms poll granularity plus contention with the Chrome instance the probe drives on the same machine. Re-measured with a 25 ms poll on an idle host the same inputs take **512 ms** (5 KB) and **1 010 ms** (22.7 MB / 340 pages) and both scale with size, of which Ghostscript is 80 ms and 490 ms; the user-facing path streams progress at 400 ms rather than polling. §35's row is amended in place with that finding. **Closing it is a bookkeeping decision, and it is the owner's** |

**D19 in full.** With an unusable `DATABASE_URL` the ingress guard now answers **503 on
every path** — `/`, `/workspaces`, `/api/health` *and* `/api/health/ready` — and the Next
app is never invoked. [instanceLease.ts:95-170](../../../src/infrastructure/config/instanceLease.ts#L95-L170)
keeps the lease status `pending`, and [guard.mjs:107-129](../../../ingress/guard.mjs#L107-L129)
serves only `held` and `disabled`. That is the correct refusal — a process that cannot
prove it is the single writer must not serve — and it has two costs:

- **The guard's own advice is unreachable in exactly the states that need it.** It tells
  the operator to read `/api/health/ready`'s `instance` field; that path is one of the ones
  refused. Stage 12 also could not capture the `19-app-error` surface for the same reason:
  a broken database no longer reaches the error boundary.
- **[Dockerfile:105-106](../../../Dockerfile#L105-L106) healthchecks `/api/health`** with
  `--interval=30s --timeout=5s --start-period=20s --retries=3`, so a container *correctly*
  waiting for a lease is marked unhealthy, and an orchestrator that restarts unhealthy
  containers will restart-loop a healthy standby. [docker-compose.yml](../../../docker-compose.yml)
  defines no healthcheck of its own, so this bites plain `docker run`, Swarm and any
  platform that reads the image's own probe.

Stage 9 measured what the wait actually costs: after **SIGKILL** the standby takes over in
**11 731 ms** (TTL 10 s + 2 s grace + 3 s beat); after **SIGTERM** the lease is released and
the successor serves **428 ms** from spawn. *Rec.* — a `start_period` that comfortably
exceeds the TTL path (**45 s**, not 20 s) and treat 503-on-everything as "not my turn"
rather than "broken". No path can distinguish the two states, because by design nothing is
served without a lease — so this is a probe-configuration decision, not a code fix, and it
is why it is a decision and not a defect.

**D20 in full.** Every anonymous page load prints a console error, and every first open of
an unsaved document prints another. Both are designed answers: `GET /api/auth/me` → **401**
for a signed-out visitor (fetched after hydration by `hooks/usePublicSession.ts:51` so a
server-side cookie read does not opt ~30 static routes out of prerendering), and
`GET …/editor-state` → **404 `EDITOR_STATE_UNAVAILABLE`** for a version with no saved
scene. Measured **36×** (4 pages × 9 widths) and **1×**. Chrome files them under
`Log.entryAdded` source `network`, which is why Stage 11's "0 JS errors" and these 36 red
lines are both true, and why three earlier probes could not see them. Neither is
suppressible from JavaScript. The three options, unchanged from Stage 12:

1. Leave it. It is cosmetic, costs a visitor nothing, and every status code stays honest.
2. Answer `200 {"user":null}` for the anonymous session probe. The console goes quiet and
   an auth endpoint stops distinguishing "no session" from "a session I could not read" —
   a change to an authentication contract, which is not a low-risk acceptance-time edit.
3. Same for `editor-state`: `200` with an empty scene. Same objection, smaller surface.

*Rec.* — option 1 for launch, with the row recorded, and revisit only if console noise
starts masking a real error during an incident.

## 4. Every source row lands somewhere, and the count reconciles

The point of this table is that nothing was dropped in the merge. Four documents each knew
about some of these rows; several knew about the same row under different names.

| Source | Rows | Where each goes |
| --- | --- | --- |
| Harness `MANUAL REVIEW REQUIRED` | 11 | A3→V1 · A4→V2 · E5→D18 · E6→V3 · G6→V4 · J3→D7 · K3→V5 · L3→D17 · N2→V6 · Q4→D8 · R3→V7 |
| Harness `NOT EXERCISED` | 4 | F5→**retired PASS** · M3→D16 · N3→V10 · R2→**retired PASS** |
| Harness `ENVIRONMENTAL` | 2 | C7→V8 · C8→V9 |
| §37's fourteen owner decisions | 14 | 1→D3 · 2→D2 · 3→D5 · 4→D1 · 5→D4 · 6→D16 · 7→D10 · 8→D6 · 9→D7 · 10→D9 · 11→D13 · 12→D12 · 13→D14 · 14→D15 |
| §35 open P2 | 6 | P2-1→**retired CLOSED** · P2-2→D21 · P2-3→D16 · P2-4→D16 · P2-5→**retired CLOSED + pinned** · P2-6→D22 |
| Rollback runbook `LAUNCH DECISION REQUIRED` | 1 | Case B→D12 |
| Stage 12 | 4 | console noise→D20 · lease-503→D19 · healthcheck target→D19 · storage-volume drill→D11 |
| Stage 7 | 1 | S1→V11 |
| **Total sources** | **43** | |

43 sources → 37 destinations, because six rows merge into four: `J3` + §37 #9 → **D7**;
§37 #12 + the runbook's Case B → **D12**; `M3` + §37 #6 + P2-3 + P2-4 → **D16**; the
lease-503 gap + the healthcheck target → **D19**. 43 − 6 = 37 = **33 open rows + 4
retired**.

| | Verify | Decision | Total |
| --- | --- | --- | --- |
| `BEFORE GO-LIVE` | 8 | 10 | **18** |
| Conditional on **D4** | 0 | 2 | **2** |
| `SCHEDULABLE` | 3 | 10 | **13** |
| **Total** | **11** | **22** | **33** |

## 5. The one code change this stage made

P2-5 was closed by accident — an edit with another purpose rewrote the `Dockerfile` from
88 CRLF lines to 119 LF lines — and an accident is not a guard. The brief permits a test
for *deployment configuration that previously had no guard*, so one assertion was added to
the existing [deploymentArtifact.test.ts](../../../deploymentArtifact.test.ts):

```
it("has LF line endings in every deploy-critical file", …)
  Dockerfile · docker-compose.yml · .dockerignore · ingress/server.mjs
```

Verified to bite rather than assumed: with the `Dockerfile` converted back to CRLF,
`× has LF line endings in every deploy-critical file → Dockerfile has CRLF line endings`;
restored, **17/17 green** (was 16). No product code was touched, and no new file was added.

The comment in the test says why CRLF matters at all, since `docker build` tolerates it:
the hazard is a trailing `\r` joining the next line as part of a shell word in a `RUN`
continuation, and landing inside the argv the `CMD` execs.

## 6. What Stage 13 does not establish

- **It does not answer any of the 33 rows.** It states them once each, with what each
  costs. Stage 14 classifies them; the owner closes them.
- **It is not legal advice.** D7 and D8 are recorded exactly as far as the facts go and no
  further, and nothing was implemented to make either row disappear.
- **`BEFORE GO-LIVE` is a classification, not a defect count.** Eighteen rows carry it and
  most are satisfied by a recorded decision rather than by work — "we accept this" closes
  V1, V2, V3, V6, D5, D18 and others in a sentence each.
- **The retirements are measurements, not opinions.** `npm audit` was run at this tree
  (0 of 486, and 0 prod-only), the `Dockerfile` was counted line by line at `388e8af` and
  at HEAD, and F5's rows were read out of Stage 7's own probe log. What none of them
  establishes is the container path: V8 and V9 stay open, so P2-5's guard is still pinning
  a file no build on this host has consumed.
- **No secret value was requested, echoed or written.** Where a decision needs a
  credential, the register names the **variable** — `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `TRUSTED_PROXY_SECRET`,
  `STORAGE_SIGNING_SECRET`, `ADMIN_SECRET` — and says which subsystem it switches on. The
  consolidated table of every input the owner still has to supply belongs to the Stage 14
  report, and is not duplicated here.

## Files changed by this stage

| File | Change |
| --- | --- |
| `docs/evidence/production-acceptance/16-manual-decision-register.md` | This register: 33 open rows, 4 retired, the source→row mapping |
| `deploymentArtifact.test.ts` | One assertion: no CRLF in the four deploy-critical files (pins P2-5, which was closed incidentally) |
| `docs/FINAL_PRELAUNCH_AUDIT.md` | P2-1 and P2-5 amended in place with the measurement that retires each; §37 #9 and #12 cross-referenced to D7 and D12 |
| `docs/PRODUCTION_ACCEPTANCE_PROGRESS.md` | Stage 13 section; stage-status row; remaining actions rewritten for Stage 14 |
| `docs/PDFDADI_FEATURE_LEDGER.md` | The retirement of two P2 rows, and the guard that keeps one retired |

**33 ROWS OPEN — 22 OWNER DECISIONS, 11 VERIFICATIONS, 0 DECIDED HERE**
