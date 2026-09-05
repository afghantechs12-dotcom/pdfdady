# Stage 9 — reliability and recovery

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b` (Stage 8 = `209b1ca`)
**Measurements:** `12-singleton.{log,json}`, `12-worker-recovery.log`,
`12-migration-restore-drill.log`, `12-rollback-rehearsal.log` (this directory)
**Artifact:** this stage **rebuilt** the artifact as part of the rollback rehearsal.
`BUILD_ID MniplDUweIbeIPYT_CM5N` is now serving, built from HEAD `209b1ca` with
`NEXT_PUBLIC_SITE_URL=https://192.168.0.175:3001` — the same origin the previous
artifact was baked for, verified in `routes-manifest.json`'s CSP `report-to`. It
supersedes `DIi1m4KbzBmf96popnixW`; nothing between the two commits changes compiled
application code, so Stages 6–8's measurements stand.
Every database, storage root and admin store under `/tmp`.

## What Stage 9 has to answer

1. If two instances are started against one database, does exactly one serve — and
   does the survivor take over unattended when the holder dies?
2. If a worker is killed mid-job, does the job finish, once, without a human?
3. Can the database be restored, and is the restore at migration head?
4. Can a release be rolled back — and does the previous artifact still serve real work?

## 1. Measurements

| Drill | Command | Result | Exit |
|-------|---------|--------|------|
| Single-instance enforcement, live | `node scripts/singleton-probe.mjs --entry ingress/server.mjs` | **8/8** (S1–S8) | 0 |
| Worker killed mid-job | `npx tsx scripts/worker-recovery-probe.mts` | **45/45**, 0 failed | 0 |
| Migrate + online backup + restore | `node scripts/migration-restore-drill.mjs` | **PASS 16/16** | 0 |
| Deploy and rollback rehearsal | `sh scripts/r30-rollback-smoke.sh` | **PASS 8/8** | 0 |
| Bounded drain and stuck-job recovery, unit level | `npx vitest run src/infrastructure/queue/workerShutdown.test.ts src/application/services/StuckJobRecoveryService.test.ts src/infrastructure/queue/DatabaseQueue.test.ts` | 61 tests | 0 |

## 2. Two instances, one database

The declaration `DEPLOYMENT_TOPOLOGY=single-instance` only ever proved that an
operator had typed it. Two production processes were started against one database and
the deployment itself was asked which may serve:

| Row | Measured |
|-----|----------|
| S1 a first instance acquires and serves | 200 |
| S2 a second instance does **not** serve | 503 |
| S3 exactly one is serving | `serving=1 (a=200, b=503)` |
| S4 the standby's refusal discloses nothing | `ready 503, / 503`, body `{"error":"Server is not accepting requests."}` |
| S5 readiness on the holder names the lease | `checks.instance = true` |
| S6 **SIGKILL the holder** — the standby takes over | `:3012 → 200 after 11 731 ms` (TTL 10 s + 2 s grace + 3 s beat) |
| S7 **SIGTERM the holder** — the lease is released | `:3013 → 200 after 428 ms` from spawn, boot included (the expiry path costs ≥ 12 000 ms) |
| S8 the generated `server.js` refuses to start in production without the guard | exit 1, and it names the guard |

S6 and S7 are the two failure modes an operator actually meets, and they cost
different amounts of downtime: a crash waits out the TTL, a clean stop does not. S8 is
why `ingress/server.mjs` is the entrypoint: the unguarded Next entry cannot be started
in production at all, so nothing can accidentally serve without the lease and the
peer-address stamping.

## 3. A worker killed mid-job

A real child worker was `SIGKILL`ed between claim and outcome and the row read back
from SQLite — not simulated by writing the row a crash is assumed to leave. 45/45
across nine sections, of which the load-bearing ones:

- The lease is Prisma's `@updatedAt`, and the claim refreshes it (a column no
  in-memory repository has, so only Prisma can answer it).
- A **fresh** lease is not recovered — the sweep does not steal work from a worker
  that is alive and slow.
- Worker B's **startup sweep** recovers the job and finishes it. This is how a
  restarted deployment reclaims stranded work, unattended.
- One logical job, one customer charge, no stranded work.
- A worker whose attempt was recovered **cannot write to the job**: its `failJob`,
  `markCancelled` and progress writes are all refused, and its progress write does
  not refresh the lease — which is what would hide the job from the sweep. The
  recovery log line is in the evidence: `{"msg":"Recovered stuck jobs","examined":1,"requeued":1,…}`.
- SIGTERM on an idle worker exits **0 through the shutdown handler**, without waiting
  out the grace period.

## 4. Restore

`PASS 16/16` again on this tree (`12-migration-restore-drill.log`): the 23 migrations
before the head migration build a schema without the head table, `migrate deploy`
reaches head with nothing pending and no drift, the backup is taken with `node:sqlite`'s
online `backup()` **while the database is open**, real rows are then destroyed, and the
restore reproduces them byte-for-byte (`content sha256 923f4caa3637ec24…`) at migration
head rather than at the schema it was baselined from.

A hot `cp` of an open database is still not a backup — the deployment runs
`journal_mode=delete`, where a copy taken mid-transaction can capture a database whose
journal is not copied with it (Stage 4, §2). The online API is the procedure.

## 5. Rollback, on the path this host can run

The container path is ENVIRONMENTAL (no daemon), so the rehearsal swaps the standalone
artifact directory — the standalone analogue of rolling an image digest back:

| Leg | Measured |
|-----|----------|
| The artifact now serving is kept aside as the rollback target | `BUILD_ID DIi1m4KbzBmf96popnixW` |
| Build at HEAD | `BUILD_ID MniplDUweIbeIPYT_CM5N` |
| It boots and answers liveness | `/api/health` → 200 |
| Readiness answers, and says which check is false | `503 degraded, toolchain false` (absent `soffice`) |
| A real job completes on the new artifact | compress-pdf, **8 218 bytes of `%PDF-`** over http 200 |
| The **previous** artifact boots again | `BUILD_ID DIi1m4KbzBmf96popnixW`, `/api/health` → 200 |
| A real job completes on the rolled-back artifact | **8 218 bytes of `%PDF-`** — the same bytes, from the artifact that served before |
| Rolling forward leaves HEAD serving | `MniplDUweIbeIPYT_CM5N` |

The two identical byte counts are the point of the drill: "the bytes that served
yesterday serve again" is a measurement here, not a claim.

The database leg is deliberately not repeated — §4 owns it. The runbook's Case A (no
migration) is exactly what this rehearsal exercises; **Case B** (a release that added
a migration, so the old code would meet the new schema) is a restore of the pre-deploy
snapshot with an explicit data-loss window, and it remains an owner decision:
`LAUNCH DECISION REQUIRED — who authorizes a Case B restore, and the acceptable
data-loss window` (`docs/evidence/final-prelaunch/rollback-runbook.md`).

## 6. What Stage 9 does NOT establish

- **Container deploy and rollback.** `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER
  RUNTIME`. The rehearsal ran the equivalent artifact swap on the host.
- **A live busy drain.** The SIGTERM row above is an *idle* worker. A SIGTERM landing
  while Ghostscript is mid-job — in-flight work finishing inside
  `WORKER_SHUTDOWN_GRACE_MS` — is covered by `workerShutdown.test.ts` ("reports zero
  active only after in-flight work finishes") and not by a live drill.
- **Storage-volume restore.** Documents are immutable blobs whose keys the database
  references, so the procedure is a volume snapshot paired with the database snapshot;
  restoring one without the other yields records whose bytes are gone. Stated in the
  runbook, not exercised.
- **Readiness noticing a broken volume.** Unchanged from Stage 4: `dataDir` is
  `fs.access(dirname(STORE_PATH))`, presence only. A read-only or unmounted storage
  volume still reports ready. Manual row **L3**, an owner decision in Stage 13 because
  it changes when a load balancer drains an instance.
- **Multi-instance failover.** There is none to test by design: S2 is a refusal, not a
  second server. Scaling out needs PostgreSQL and a shared rate-limit store first.

## 7. Files changed by this stage

None. Every drill above ran against the shipped code; the only side effect is the
rebuilt artifact, which is the rehearsal's own deploy leg.
