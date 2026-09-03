# R19 / R20 — retention, observed at runtime in a deployed artifact

HEAD `2840bea` artifact (BUILD_ID `Q0Vyn2Fqoa0Yn_j5UK-H-`), audit host,
2026-09-03T22:36:54Z → 22:51:57Z. Script `/tmp/audit-retention-runtime.sh`,
log `/tmp/audit-retention-runtime.log`.

## Why a runtime observation and not another unit test

`mutation-P-retention.md` closes with the one thing its three mutations cannot
reach: *"that a **deployed** process ever calls `ensureWorkerReady`. It is called
lazily from the tool and job routes, so the proof of that is a runtime
observation."* Every unit test in this repository runs in `environment: "node"`
and constructs the handler itself. A deployment where the lazy bootstrap is never
triggered keeps all of them green while nothing expires at all.

So the claim under test was deliberately end-to-end: **in a deployed artifact, the
recurring sweep is registered by real traffic, fires on its own 15 minutes later,
purges an expired `stored_files` row, and re-schedules itself.** Nothing was
called directly and no clock was faked; the only intervention was ageing one row.

## What was run, and what the server said

| Step | Observation |
|---|---|
| Boot | `/api/health` → 200, `LOG_LEVEL=debug` so the sweep's own line is visible |
| One **real** job (`compress-pdf`, 149 102-byte fixture) | `jobId cmtm3uho90004uo8s56o9no9b`, status `completed` after 1 s |
| The bootstrap it triggered | `{"level":"info","msg":"PDF tool worker ready","ts":"2026-09-03T22:36:55.151Z","queueType":"pdf-tool","retentionType":"file-retention"}` |
| One row aged past its expiry | `cmtm3uhvb0005uo8sj899fcv1` → `integer 1788471416249`, asserted `typeof(expiresAt) = integer` before waiting (see below) |
| **900 s later, unprompted** | `{"level":"debug","msg":"Retention sweep complete","ts":"2026-09-03T22:51:55.290Z","purged":325,"intentsPruned":0}` |
| The aged row | **GONE** |
| Rows still expired in the past afterwards | **0** |

`RETENTION_INTERVAL_MS` is 15 min; the sweep landed at 22:51:55 against a worker
ready at 22:36:55 — 900.1 s. Nothing in the probe woke it.

`intentsPruned: 0` is the correct answer, not a miss: `SAVE_INTENT_RETENTION_MS`
is 30 days and every one of the 6 rows present was minutes old. R19's horizon is
proved by mutation P1, not by this run; what this run proves is that the sweep
carrying it actually executes in a deployment.

## The finding this run produced by accident

```
--- sessions (all): 24
--- sessions already expired and still stored: 1
```

An expired authentication session, still in the table, in a live deployment,
after a completed retention sweep. That is §K's second finding observed rather
than argued — the artifact under test predates the fix, so its sweep has no
`sessionsPruned` to report. Fixed at `371f4ef`; mutations P4–P7 red-and-reverted.

## The two probe defects this run had to be rebuilt around

Both are recorded because each produced a plausible, publishable, wrong result.

1. **The server refused to boot** — `[startup] PDFDadi refused to start … NEXT_PUBLIC_SITE_URL points at a loopback host`.
   Not a defect: the production config gate is correct, because it builds signed
   download and upload URLs from that value. Re-run with the LAN origin. This is
   positive evidence for R7.
2. **The forced-expiry sentinel was written as TEXT, not INTEGER.** Prisma stores
   SQLite `DateTime` as INTEGER milliseconds, and a TEXT value sorts *after* every
   integer — so the row meant to be the most expired became the least, and the
   count query called all 336 future-dated rows expired. Caught with
   `select typeof(expiresAt)`, the run killed, its log preserved at
   `/tmp/audit-retention-run1-typedefect.log`, and the rewritten script now
   **asserts** the stored type before it waits. The same fact is asserted in
   `LocalSessionProvider.test.ts`, for the same reason.

## Verdict

**R20 (expired results cleanup): PASS** — observed in a deployed artifact.
**R19 (save-intent retention decision): PASS** — the decision is a 30-day horizon
in this sweep (`1d36b30`), the horizon is guarded by mutation P1, and this run
shows the sweep that carries it runs unprompted in a deployment.
