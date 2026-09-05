# Stage 11 — bounded performance smoke test

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b`
**Measurements:** `14-performance.log`, `14-performance.json` (this directory)
**Target:** the staging surrogate — pages `https://192.168.0.175:3001`, origin
`http://127.0.0.1:3002`, `BUILD_ID MniplDUweIbeIPYT_CM5N`, throwaway
`file:/tmp/pa-stage6-db.db` / `/tmp/pa-stage6-storage` / `/tmp/pa-stage6-admin`.
**One machine ran Chrome, the TLS front and the origin.** Every latency here is a
floor, not a forecast: no CDN, no network throttling, no other tenants.

## What Stage 11 has to answer

1. How fast do the pages a visitor lands on actually load?
2. How long does one complete workflow take, across input shapes that behave differently?
3. How wide a fan-out is accepted before something sheds, and is the shedding the designed kind?
4. Does memory come back down after sustained load, or only go up?
5. How long is a deploy's blind window — the interval between `exec` and a served request?

Questions 1–3 are `scripts/perf-load-probe.mjs`, which already existed. Questions 4
and 5 had no instrument, so this stage adds one: `scripts/perf-soak-probe.mjs`.

## 1. Page load — 3 runs each, cold cache

| Route | LCP | FCP | TTFB | CLS | KB | JS KB | Req | JS errors |
|-------|-----|-----|------|-----|-----|-------|-----|-----------|
| Homepage | 100 | 100 | 17 | 0.005 | 387 | 150 | 38 | 0 |
| Tools directory | 60 | 60 | 14 | 0.005 | 310 | 186 | 41 | 0 |
| Merge (tool page) | 44 | 44 | 10 | 0.005 | 273 | 175 | 26 | 0 |
| Pricing | 36 | 36 | 10 | 0.005 | 274 | 149 | 56 | 0 |
| Editor (standalone) | 76 | 76 | 16 | 0.001 | 386 | 300 | 23 | 0 |
| Workspace | 108 | 60 | 19 | 0.017 | 280 | 185 | 33 | 0 |
| **Workspace Editor** | **408** | 40 | 16 | **0.212** | **913** | **449** | 40 | 0 |

Medians; the log carries the min–max for each. **Zero JavaScript errors on every
route**, which is the row that would have blocked the stage.

## 2. The one number that is not fine: Workspace Editor CLS 0.212

Twice the 0.1 threshold, on the heaviest route. It is not measurement noise and it is
not new:

| | prelaunch (`final-prelaunch/perf-load.log:49`) | Stage 11 |
|---|---|---|
| CLS | 0.212 | **0.212** |
| LCP | 412 | 408 |
| KB / JS KB | 921 / 459 | 913 / 449 |

The payload shrank 8 KB between the two runs and the layout shift did not move a
digit. This is open **P2-2** (`docs/FINAL_PRELAUNCH_AUDIT.md:1897`), whose stated fix
is a reserved-height container. Stage 11 **reproduces** it; it does not find it, and
it does not fix it — a layout change in the authenticated workbench is product work,
not acceptance work, and the brief's testing policy does not license it. It stays P2:
a visible quality defect on a signed-in surface, not a functional failure.

## 3. One complete workflow, six input shapes — 2 runs each

Medians in ms. `local_merge` is pdf-lib in the tab with no server involved.

| Shape | local_merge | upload | server_processing | result_dl | ws_save | editor_load | publish |
|-------|------------|--------|-------------------|-----------|---------|-------------|---------|
| tiny 2 KB | 514 | 14 | 1583 (510–2656) | 16 | 10 | 241 | 7 |
| ordinary 5 KB | 519 | 8 | 3004 | 12 | 12 | 352 | 5 |
| large 22 778 KB | 516 | 42 | 2970 | 8 | 9 | refused 234 | 37 |
| many-page 104 KB | 515 | 10 | 3001 | 10 | 10 | refused 133 | 5 |
| encrypted 6 KB | 13 | 9 | 2673 | 9 | 10 | refused 238 | 6 |
| malformed 3 KB | 517 | 10 | 2785 | 8 | 10 | refused 133 | 5 |

**Every refusal is the product working.** Quoted from the run:

- large / many-page → *"This PDF has too many pages to edit — It has 340 pages, and
  the Editor supports up to 200."* The document still uploaded, processed, saved to
  the workspace and published; only the **Editor** declines it, and it says the limit
  and the actual count.
- encrypted / malformed → *"We couldn't open this PDF — The file may be damaged,
  unsupported, or outside the Editor's supported limits."*
- The encrypted shape's `local_merge=13` against ~515 elsewhere is the browser
  refusing an encrypted file immediately rather than working on it.

## 4. The ≈3 s of `server_processing` is the probe, not the server

Open **P2-6** records "≈3 s largely independent of input size" as *"an observation
from §18, not a diagnosis."* Stage 11 supplies the diagnosis. The load probe sleeps
500 ms between job-status polls **and** drives a Chrome instance on the same laptop.
Re-measured with a 25 ms poll and no browser running (§5 of the log):

| Input | end to end | Ghostscript alone | output |
|-------|-----------|-------------------|--------|
| 4 888 bytes (`ordinary`) | **512 ms** | 80 ms | 8 218 bytes |
| 23 325 045 bytes, 340 pages (`large`) | **1 010 ms** | 490 ms | 181 469 bytes |

Both scale with input size — 6× the Ghostscript time for 4 700× the bytes, which is
what a page-count-bound rasteriser should do. The ≈3 s figure is 500 ms poll
granularity plus contention with the browser the probe itself drives.

And the path a user actually takes does not poll: `app/api/jobs/[id]/progress/route.ts`
streams progress from a 400 ms server-side poller, so the user-visible floor is the
job plus ≤400 ms, not 3 s.

**Recommendation: close P2-6 as a measurement artifact**, on this evidence. The row is
amended with a pointer rather than deleted — the observation was correctly recorded,
it was the cause that was open.

Compress ran on a **real Ghostscript**: `gs` is installed here, and so are `qpdf`,
`pdftoppm`, `pdfinfo`, `tesseract` and `ocrmypdf`. `soffice` is the single missing
binary of the seven, and `/api/health/ready` ANDs all seven
(`app/api/health/ready/route.ts:62`), which is the entirety of this machine's
`503 degraded`. Office conversions are therefore unmeasured, here and in every earlier
stage.

## 5. Fan-out: what is accepted, and what sheds

| Ladder | Accepted | Statuses | Latency (median) | Wall |
|--------|----------|----------|------------------|------|
| anonymous server jobs ×2 / ×4 / ×8 / ×16 | all | 2/4/8/16 × 202 | 9 / 30 / 40 / 57 | 82 ms at ×16 |
| **one-IP burst ×25** | 20/25 | 20×202 **5×429** `retry_after 10` | 66 | 110 ms |
| workspace uploads ×2 / ×4 / ×8 | all | ×201 | 9 / 16 / 36 | 78 ms at ×8 |
| document opens ×4 / ×8 / ×16 | all | ×200 | 8 / 13 / 13 | 16 ms |
| publishes ×4, distinct documents | 4/4 | 4×201 | 10 | 19 ms |
| **revision conflict ×4, one revision** | 1/4 | 1×201 **3×409** | 6 | 14 ms |
| anonymous browser workflows ×3 | 3/3 | 3×200 | 7162 | 7231 ms |

**MEASURED CAPACITY (fully accepted fan-out):** anonymous server jobs 16 · workspace
uploads 8 · document opens 16 · publishes 4 · anonymous browser workflows 3.

The two rows that shed are the two that are supposed to. 20 per 60 s per IP is the
declared ceiling on `/api/jobs`, so the 5×429 with `retry_after: 10` at ×25 is the
correct answer, not a failure — and the same limiter is what `11-upload-abuse.log`
tests deliberately. The 3×409 is the revision compare-and-swap under contention:
`cas = held — one winner, the rest refused`, which is the invariant the workspace
depends on to not lose an edit.

The 7 162 ms browser-workflow row measures **this laptop**, not the server: merge
happens entirely in the tab, so three concurrent workflows are three Chrome instances
competing for the same CPU while the origin sees only page loads.

**Accepted is not completed.** The ×16 row means the limiter and the queue admitted 16
jobs in 82 ms. It does not mean 16 Ghostscript processes ran at once: `WORKER_CONCURRENCY`
defaults to 2, so the rest queued. Throughput under saturation was not measured.

## 6. Sustained load: 15 896 requests, no errors, and memory that comes back

`node scripts/perf-soak-probe.mjs --seconds 60 --concurrency 4 --idle 30 --cold-start`
over `/`, `/tools`, `/api/health`, `/pricing` — unauthenticated GETs, none of them rate
limited, so the soak measures the server rather than the limiter.

| | |
|---|---|
| requests | **15 896 in 60 s (265/s)** |
| statuses | **15 896 × 200** — no 5xx, no 429, no dropped connection |
| latency | p50 **10 ms** · p95 **41 ms** · p99 43 ms · max 88 ms |
| RSS | start 171 MB → **peak 543 MB** → 322 MB ten seconds after load stopped, then flat |

The `end` sample is taken the instant load stops, before V8 releases; the `+10s` row is
the same process ten seconds later. An earlier identical run against the *previous*
process — which had already served every Stage 7–11 probe — measured start 334 MB, peak
652 MB, settling to 369 MB and flat for 70 s. Two runs, same shape: **the peak is
transient and the settled floor rises ~35 MB and stops.** Not a leak.

What that means for a deployment, and it is the number this stage exists to produce: a
container memory limit has to be sized to the **peak**, not the idle. ~550–650 MB at
concurrency 4 on page serving alone, before any Ghostscript, means **1 GB is the
smallest limit that is not a gamble**, and `WORKER_CONCURRENCY` multiplies real memory
on top of it (`.env.example` says so; this soak ran with the in-process queue, so the
worker was inside the measured process).

## 7. Cold start: the deploy's blind window

| | |
|---|---|
| SIGTERM → port free | **67 ms** (graceful; the lease is released, `[ingress] SIGTERM` line written) |
| `exec` → listening | 206 ms (includes the `.next/static` copy `restart-origin.sh` does first) |
| `exec` → `/api/health` 200 | **393 ms** |
| first `GET /` (cold render) | 56 ms → 200 |
| second `GET /` (warm) | 20 ms → 200 |
| RSS at fresh boot | 216 MB |

`BUILD_ID` is identical before and after: the restart is the same artifact, not a
rebuild. The relaunched process wrote exactly the two lifecycle lines Stage 10 pinned —
`[startup] PDFDadi configuration OK …` and `[instance] single-instance lease acquired
by …` — and nothing else (§3 of the log).

Two operator consequences. A platform health check with a 5 s initial delay is
generous against a 393 ms boot, so a slow first probe is a configuration choice rather
than a constraint. And graceful shutdown is fast enough that an orchestrator stop
timeout is never the binding constraint on an idle instance —
`WORKER_SHUTDOWN_GRACE_MS` (20 s default) is, and only with jobs in flight.

## 8. Defects found

**None new. No P0 and no P1.** Two open P2s were re-measured:

| Finding | Stage 11's contribution |
|---------|------------------------|
| **P2-2** Workspace Editor CLS 0.212 | reproduced byte-for-byte on a payload 8 KB smaller. Stays P2, unfixed, product work |
| **P2-6** ≈3 s processing independent of size | **diagnosed**: 500 ms poll granularity plus browser contention. The same inputs complete in 512 ms and 1 010 ms on an idle machine, and both scale with size. Recommend closing |

## 9. What Stage 11 does NOT establish

- **Nothing here is a forecast.** One laptop ran Chrome, the TLS front and the origin,
  over loopback and LAN with no CDN, no throttling and no other tenants. Every latency
  is a floor; real TTFB and LCP will be worse by the network.
- **No sustained *write* load.** The soak is GETs. Sixty seconds of uploads would
  exercise the single-writer SQLite path under contention, which is the interesting
  question for `DEPLOYMENT_TOPOLOGY=single-instance` — and the per-IP limiter would
  shed it long before saturation, which is why the burst ladder tests that instead.
- **No memory ceiling.** The peak is page serving at concurrency 4. RSS during a
  22.7 MB compress was not sampled, and the point at which the process fails was not
  sought: finding it means driving it to OOM, which is outside a bounded smoke test.
- **No throughput under saturation.** Fan-out measures what is *accepted* (§5).
- **Office conversions.** `soffice` is absent on this host, so `word-to-pdf` and its
  siblings have never run in any stage. Readiness is `503 degraded` for that reason
  alone.
- **No baseline over time.** These are first measurements on this branch; the only
  drift comparison available is the prelaunch run, which §2 uses for the CLS
  cross-check. Nothing watches for regression between deploys.
- **Harness row N3** ("sustained load, cold-start, memory ceiling") is now
  *partly* answered: sustained load and cold start are measured, memory is measured as
  a **peak** rather than a **ceiling**. It is not a clean PASS and Stage 14 should not
  record it as one.

## Files changed by this stage

| File | Change |
|------|--------|
| `scripts/perf-soak-probe.mjs` | **New.** Sustained load with RSS sampling, idle sampling, and an opt-in `--cold-start` that SIGTERMs and relaunches the origin |
| `docs/evidence/production-acceptance/14-performance.{log,json,md}` | **New.** Redacted for repo path, home path and hostname |
| `docs/FINAL_PRELAUNCH_AUDIT.md` | P2-6's row gains the diagnosis and a pointer to this evidence |
| `docs/PRODUCTION_ACCEPTANCE_PROGRESS.md`, `docs/PDFDADI_FEATURE_LEDGER.md` | Stage 11 recorded |
| `deploymentArtifact.test.ts` | `\n  \};` → `\n {2}\};` in one regex. `eslint .` had **1 error**, introduced on this branch by `209b1ca` (Stage 8) and not noticed then: `no-regex-spaces`. Same match, and the gate is clean again |

No test was added. A probe is an instrument, not an assertion: its output *is* the
evidence, and the brief's testing policy licenses tests for a defect, an unguarded
deployment config, backup correctness, entrypoint/volume correctness or a
readiness/rollback invariant — none of which this stage touched.
