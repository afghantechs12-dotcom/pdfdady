# Stage 7 — production-like user acceptance

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b`
**Artifact:** `BUILD_ID DIi1m4KbzBmf96popnixW` — rebuilt during this stage, superseding
`U1Tagyyl2WuT2jmfk2Tvm`, because the fix below changes compiled application code.
**Surrogate:** the Stage 6 topology unchanged — `ingress/server.mjs` on
`127.0.0.1:3002` behind `scripts/tls-front.mjs` on `https://192.168.0.175:3001`
with a throwaway self-signed certificate.
**Everything ran against throwaway state under `/tmp`**: `file:/tmp/pa-stage6-db.db`
(and a second virgin `file:/tmp/pa-stage7-analytics-db.db` for the one probe that
requires a zero-data start), storage roots `/tmp/pa-stage6-storage` and
`/tmp/pa-stage7-analytics-storage`, admin store `/tmp/pa-stage6-admin`. No real
customer document, no production database, and not the repository's `prisma/dev.db`.
**Measurements:** the `10-*.log` files in this directory.

## What Stage 7 has to answer

Whether a person using the built artifact over real HTTPS gets the product the
pages promise: the tools run and deliver the bytes they advertise, the local tools
keep the document in the browser, a Workspace survives concurrency and refuses
strangers, the admin surface is reachable and guarded, and the funnel that reports
all of it is measuring the thing it names.

## 1. The defect this stage found: the admin store lived in the build output

`data/admin/index.ts` resolved its store with
`path.join(process.cwd(), "data", "admin")`. In production the working directory is
**the build output**: `.next/standalone/server.js` chdirs into its own directory
before any application module or `instrumentation.ts` loads. So a deployment that
is not the shipped compose file wrote `store.json` — all CMS content **and**
`settings.adminPasswordHash` — to `.next/standalone/data/admin/store.json`, which
the next `next build` or deploy replaces.

Losing that file is not only lost content. With no hash, `isAdminPasswordSet()` is
false and **`/admin/setup` re-opens to whoever reaches it first** (rate-limited
10/min, no other barrier), so the next visitor could take the admin surface.
Severity **P2**.

This is the third instance of one defect class, and the first two were already
refused by the gate: a relative `DATABASE_URL` (Stage 4) and a relative
`STORAGE_LOCAL_ROOT` (Stage 4) both resolve against the same working directory.
The admin store had no guard.

**Fixed in the gate, not in a document.** `ADMIN_STORE_DIR` is now read by
`data/admin/index.ts`, and `productionProblems` refuses a value that is relative or
inside a `.next` directory. Falsified end to end on the built artifact: with
`ADMIN_STORE_DIR` unset, `node ingress/server.mjs` in production mode printed one
problem naming the exact file and **exited 1**
(`10-admin-store-gate-refusal.log`) — the same path a planted-marker experiment had
already proved the running server reads.

Then measured the other way round, against the running server:

| Observation | Result |
|---|---|
| `POST /api/admin/setup` with a throwaway password | `200 {"ok":true}` |
| `/tmp/pa-stage6-admin/store.json` → `settings.adminPasswordHash` | **set** (97 chars) |
| repository `data/admin/store.json` → `adminPasswordHash` | still empty — the audit never touched the shipped store |
| `.next/standalone/data/` | **does not exist** — nothing wrote into the build output |

Before the fix the same request would have written that hash into the third row.
The password itself was generated locally into a `/tmp` file, never echoed, and
appears in no log copied here (each `10-*.log` was checked against it).

## 2. Two smaller ones in the same area

- **The documented `docker run` had two mounts for three pieces of live state**
  (P3). It mounted `pdfdadi-db` and `pdfdadi-storage`; the admin password hash
  stayed in the container's writable layer. The gate cannot see a missing mount —
  `/app/data/admin` is a perfectly good absolute path whether or not a volume is
  there — so `deploymentArtifact.test.ts` now parses the documented command's `-v`
  targets and requires all three. `SERVER_SETUP.md` gained the volume, the
  variable and the prose.
- **Four launchers boot the standalone entry under `NODE_ENV=production`** and each
  hand-writes a production environment, so all four would have started failing the
  new requirement: `restart-origin.sh`, `singleton-probe.mjs`, `billing-probe.mjs`,
  `usage-quota-browser-probe.mjs`. All four set it now; the first two are handed to
  `productionProblems` itself by `deploymentArtifact.test.ts`, whose fixture now
  injects **the launcher's** cwd — a fixture that inherits vitest's cwd cannot see a
  launcher's chdir, and would have passed while the launcher was broken.

## 3. A probe defect, not a product one

`scripts/usage-analytics-probe.mjs` reported the Merge tool producing no result and
no download control — a funnel of `[1,1,0,0,0]`, which reads exactly like "merge is
broken in production". It is not, and two things in the same run said so: the two
other local tools it drives (`remove-pdf-metadata`, `add-page-numbers`) walked
open → select → process → download successfully, and `processing-pilot-probe.mjs`
merged in a real browser with byte-count equality on the same artifact.

The difference was the click. The probe already has a `clickByLabel` helper whose
own comment documents the hazard — scroll and rect read must be separate turns, or
the coordinates are pre-scroll and the click lands on empty space below a 1000px
viewport. Section 3 predated the helper and hand-rolled a same-turn rect read.
It now uses the helper, and the probe reports **83/83**, the figure the feature
ledger records for it. Severity **P3**, acceptance tooling.

The same file was also the only browser probe in `scripts/` without
`--ignore-certificate-errors` for an `https:` target, so against the surrogate every
one of its checks failed on Chrome's interstitial (`Proceed to … (unsafe)`) before
reaching the product at all. Both fixes are in this branch.

## 4. Measurements on the rebuilt artifact

Every row below ran against `https://192.168.0.175:3001` — the built standalone
artifact behind real TLS, which is what the production gate and `Secure` cookies
require. All were re-run after the rebuild; none is carried over from the
pre-fix build.

| Probe | Result | Log |
|---|---|---|
| `product-capability-truth-probe.mjs` | **49/49** | `10-capability-truth.log` |
| `tool-runtime-matrix-probe.mjs` | **PASS 29/29 exercised**, PRODUCT FAILURE **0**, ENVIRONMENTAL 2, NOT EXERCISED 3 (34 rows for 32 tools) | `10-tool-runtime-matrix.log` |
| `processing-pilot-probe.mjs`, `PROCESSING_PIPELINE=on` | **41/41 — PILOT BROWSER VERIFICATION: PASS** | `10-processing-pilot-flag-on.log` |
| `processing-pilot-probe.mjs`, shipped default (flag off) | 30 passed / 3 failed — **by design**, see below | `10-processing-pilot-flag-off.log` |
| `phase1-workspace-reliability-probe.mjs` | **29/29**, 2 NOT EXERCISED | `10-workspace-reliability.log` |
| `usage-analytics-probe.mjs` (virgin database, flag on, `--admin-pw`) | **83/83** | `10-usage-analytics.log` |
| `workflow-completeness-probe.mjs` | see §6 | `10-workflow-completeness.log` |

The capability probe's `H4` row matters more than its number: it is the positive
anchor that proves the editorial override *is* rendered, i.e. that the store the
server reads is the store the fix points at. Its earlier 48/49 was the probe
editing a different file than the server read; both now agree, and the store was
restored byte-for-byte (1787 b).

**The flag-off pilot run is not a defect.** Three of its checks are pipeline-shaped
by construction, and the probe's own docblock names `PROCESSING_PIPELINE=off` as one
of the mutations that must fail it: the page mounts `ServerToolRunner` rather than
`PipelineToolRunner` (no `Idempotency-Key`), a legacy job carries no `stage`, and
`/api/jobs/:id/result` is pipeline-only — `isProcessingJob(row)` is false for a
legacy row, so it 404s and the download comes over `/api/jobs/:id/download`. The
legacy path's user-visible claim is covered by the tool matrix row for
`compress-pdf`, which downloaded a real output on the default configuration. Both
configurations are therefore measured, and the shipped default is the one with the
larger evidence base.

## 5. What the ENVIRONMENTAL and NOT EXERCISED rows are

`soffice` is absent on this host. That accounts for every non-pass in the matrix and
for readiness reporting `degraded`:

- **2 ENVIRONMENTAL** — `pdf-to-word`, `html-to-pdf` cannot run here. Both were
  still exercised for the thing that *can* be checked without the binary: each
  reports a server-side unavailability that blames no file and leaks no path or
  command.
- **3 NOT EXERCISED** — `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` have no
  fixture in the repository; their dependency was checked anyway (absent).
- `/api/health/ready` answers `503 degraded` with `toolchain: false` and
  `dataDir: true`, `database: true`, `instance: true`. That is the readiness
  contract working, not a failure — and it is the same observation Stage 6 recorded.

These five rows are the reason Stage 14 cannot count Office conversion as PASS. They
need a host with LibreOffice, which the shipped image has and this machine does not.

## 6. `workflow-completeness-probe.mjs` — 155/156, and the one open observation

**155/156, 1 ENVIRONMENTAL, 0 PRODUCT** (`10-workflow-completeness.log`). The single
non-pass is the same absent `soffice`: the server's own 415 `UNSUPPORTED_OUTPUT`
branch cannot be *reached* on this host because no tool here can produce a genuinely
non-PDF result. The probe classifies it itself, and names where the branch is covered
instead (`saveToWorkspaceRoute.test.ts`, plus journey I' in the same run).

**The open observation, now closed as non-reproducing.** The first run on the
previous artifact failed `no uncaught exception or console error surfaced in the
page` with a detail that was the bare word `Uncaught` — the collector recorded the
CDP event's type and threw the description away, so there was nothing to diagnose.
That was fixed first (`exceptionDetails.exception.description` is recorded now), and
the exception has not recurred in **three subsequent runs**, one of them on the
rebuilt artifact with the collector able to describe it. Recorded as an unexplained
single occurrence rather than as a pass: a probe that cannot reproduce a fault has
not proved the fault absent. It is manual review row **S1** for Stage 13, and it is
not launch-critical — the same run asserts no 5xx, no hydration mismatch and a
byte-identical stored object.

## 7. What Stage 7 does NOT establish

- **Container execution.** No container runtime on this machine:
  `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME` (Stage 3,
  [05-container-static.md](05-container-static.md)). Every measurement above ran the
  artifact the image ships, on the host, started by the launcher whose environment
  the deployment tests hand to the gate.
- **Office conversion.** Absent `soffice`: five matrix rows and one workflow row, all
  classified, none a product pass.
- **That the volumes are mounted.** Unchanged from Stage 4: the gate checks the
  *shape* of a path, and an absolute path with a typo in it is a brand-new empty
  directory that boots and serves. First-boot verification stays a go-live checklist
  row, and it now covers three directories rather than two —
  `/app/data/db`, `/app/data/storage`, `/app/data/admin`.
- **That readiness would notice a broken volume.** `dataDir` is
  `fs.access(path.dirname(STORE_PATH))` — presence only, no writability, and nothing
  about the database directory or the storage root. Manual row **L3**, an owner
  decision for Stage 13, because changing it changes when a load balancer drains an
  instance.
- **Real customer documents.** Every document in every run was synthesised in the
  browser or is a repository fixture.
- **`/api/health/live`.** Still 404 — there is no such route, only `/api/health/ready`
  — as [09-staging-surrogate.md](09-staging-surrogate.md) records. A liveness probe
  configured for that path fails; the checklist names `/api/health/ready`.

## 8. Files changed by this stage

| File | Change |
|---|---|
| [data/admin/index.ts](../../../data/admin/index.ts) | `ADMIN_STORE_DIR` is read; `STORE_PATH` no longer resolves against the working directory |
| [src/infrastructure/config/env.ts](../../../src/infrastructure/config/env.ts) | Schema gains `ADMIN_STORE_DIR`; the gate refuses a relative one or one inside `.next` |
| [src/infrastructure/config/env.test.ts](../../../src/infrastructure/config/env.test.ts) | Two cases for it; the key is cleared-and-restored; the valid-production fixture names a store directory |
| [data/admin/storeLocation.test.ts](../../../data/admin/storeLocation.test.ts) | New — the reader half: honours the variable, falls back to cwd when empty |
| [deploymentArtifact.test.ts](../../../deploymentArtifact.test.ts) | The documented `docker run` must mount all three state directories; launcher fixtures inject the launcher's own cwd; compose must set the variable |
| [docker-compose.yml](../../../docker-compose.yml) | `ADMIN_STORE_DIR=${ADMIN_STORE_DIR:-/app/data/admin}`, so variable and mount cannot drift |
| [SERVER_SETUP.md](../../../SERVER_SETUP.md) | Required-table row; the `docker run` gains the volume and the variable; systemd recipe for `/var/lib/pdfdadi/admin`; sample refusal shows six problems |
| [.env.example](../../../.env.example) | `ADMIN_STORE_DIR` documented as required-in-production and why |
| [scripts/restart-origin.sh](../../../scripts/restart-origin.sh), [scripts/singleton-probe.mjs](../../../scripts/singleton-probe.mjs), [scripts/billing-probe.mjs](../../../scripts/billing-probe.mjs), [scripts/usage-quota-browser-probe.mjs](../../../scripts/usage-quota-browser-probe.mjs) | All four production-mode launchers set the new variable |
| [scripts/product-capability-truth-probe.mjs](../../../scripts/product-capability-truth-probe.mjs) | Edits the store the server actually reads |
| [scripts/usage-analytics-probe.mjs](../../../scripts/usage-analytics-probe.mjs) | Cert bypass for an `https:` target; section 3 uses the scrolling click helper |
| [scripts/workflow-completeness-probe.mjs](../../../scripts/workflow-completeness-probe.mjs) | Page exceptions are recorded with their description |

## 9. Verified to bite

Six mutations, each reverted afterwards: the gate branch removed → 2 env tests fail;
the reader back to `process.cwd()` → `storeLocation.test.ts` fails; the launcher
export removed → its deployment row fails; the singleton export removed → its row
fails; the `docker run` volume removed → *"the documented `docker run` stores live
state in /app/data/admin without a volume"*; the compose variable removed → the
volume test fails. Restored tree: **51/51** across the three files; the targeted gate
(16 files, 187 tests) green; `tsc --noEmit` and eslint clean.
