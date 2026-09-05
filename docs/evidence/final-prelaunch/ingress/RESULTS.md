# §9 guarded acceptance — the same probes, the supported entry

Artifact: the same `.next/standalone/server.js` (Next 16.3.4, `output: "standalone"`), rebuilt
from this tree, but reached through `ingress/server.mjs` — the entry that calls
`installIngress()` before Next creates its `http.Server`. Same launcher
(`scripts/restart-origin.sh`), same `NODE_ENV=production DEPLOYMENT_TOPOLOGY=single-instance`,
same `DATABASE_URL=file:/tmp/audit-final-db.db`, same `127.0.0.1:3002`, same probe with the
same expectations. Nothing about the offer changed: 28 clients, 100 MiB each, 2800 MiB total.

Evidence: `probe-guarded.{log,json}` is the final run against this tree.
`probe-guarded-run1.log` and `probe-guarded-repeat.{log,json}` are the two earlier runs on the
same process, kept because the RSS series across them is the finding.

## RSS across three identical 28 × 100 MiB bursts, one process

| moment | RSS (MiB) | baseline for comparison |
|---|---|---|
| process start | 161.0 | 141.7 |
| burst 1 — before / peak / settled | 199.3 / 199.3 / 201.1 | 516.5 / 3316.7 / 3145.7 |
| burst 2 — before / peak / settled | 202.4 / 202.4 / 202.6 | 3340.4 / 4168.9 / 4169.8 |
| burst 3 — before / peak / settled | 207.1 / 207.1 / 207.1 | not run — the process was already at 4.1 GiB |

`peak +0` in all three: the sampler never caught a single MiB of growth during the burst.
Across three bursts the process moved 199.3 → 207.1 MiB, +7.8 MiB total, against +2800 then
+828 unguarded. Of the 2800 MiB offered, 14.75–18.25 MiB was read — the request lines and
headers, plus whatever was already in flight on the socket when the refusal closed it.

`csp on 0/28` in all three runs: no response carried a CSP, so none of the 28 was produced by
Next. Every one was written by the guard on the request line.

## Per-case, final run

| id | case | status | offered / total | latency | CSP | verdict |
|---|---|---|---|---|---|---|
| E3a | `POST /` declared 100 MiB | 413 | 0.06/100 MiB | 3 ms | absent | guard, on the request line |
| E3b | `GET /` | 200 | 0 | 15 ms | nonce | control, unchanged |
| E2a | `POST /does-not-exist…` 100 MiB | 413 | 0.06/100 MiB | 0 ms | absent | unknown path protected too |
| E2b | `POST /admin/does-not-exist…` 100 MiB | 413 | 0.06/100 MiB | 0 ms | absent | identical to E2a — no disclosure |
| E5a | `POST /` chunked, no length | 411 | 0.06/100 MiB | 0 ms | absent | length required, not assumed |
| E5b | `POST /api/csp-report` chunked | 411 | 0.06/100 MiB | 0 ms | absent | same for API paths |
| E4a | `POST /api/csp-report` 100 MiB | 413 | 0.06/100 MiB | 0 ms | absent | was 413-after-buffering |
| E4b | same, 3 MiB | 413 | 0.06/3 MiB | 0 ms | absent | over class B, far under 120 MB |
| E4c | valid small csp-report | 204 | 0 | 2 ms | nonce | control, unchanged |
| E4d | `POST /api/analytics/events` 64 KiB | 413 | 0.06 MiB | 1 ms | nonce | the route's own 16 KiB limit still first |
| E6 | understated `Content-Length: 100` | socket error | 0.06/100 MiB | 1 ms | — | parser bounds it; extra bytes never land |
| E12 | 100 MiB + proxy-secret / XFF / CSP headers | 413 | 0.06/100 MiB | 0 ms | absent | hostile headers raise nothing |
| E3c | `Expect: 100-continue` + 100 MiB | 413 | **0**/100 MiB | 0 ms | absent | refused before the body was invited |
| E9a | `POST /api/tools/compress-pdf` 8 MiB multipart | 400 | 8/8 MiB | 737 ms | nonce | class C — its own reader, untouched |
| E9b | `POST /api/jobs` declared 200 MiB | 400 | 0.06/100 MiB | 4 ms | nonce | class C — its own 110 MiB ceiling |
| E13a | 2 MiB − 1 B to `/api/csp-report` | 413 | 2/2 MiB | 183 ms | nonce | under the ceiling → the route answers |
| E13b | exactly 2 MiB | 413 | 2/2 MiB | 182 ms | nonce | at the ceiling → still the route's |
| E13c | 2 MiB + 1 B | 413 | 0.06/2 MiB | 1 ms | absent | one byte over → the guard's |
| E14a | 8-byte chunks, 300 ms apart | 204 | 0 | 3018 ms | nonce | slow ≠ hostile |
| E14b | client aborts mid-body | aborted | 0.04 MiB | — | — | next `GET /` answered 200 |
| E15 | malformed sub-ceiling JSON | 204 | 0 | 2 ms | nonce | the route's own contract, unchanged |
| E16 | the five controls vs the recorded baseline | — | — | — | — | 5/5 identical in status, CSP source, body |

`25/25 passed`, exit 0.

## What the guarded run establishes

1. **The amplifier is closed at the request line.** E3a, E2a, E2b, E4a, E4b, E12 and E3c all
   answer before the body: 0.06 MiB read of 100 MiB offered, 0–3 ms, no CSP.
2. **413 is no longer paid for.** E4a and E4b answered 413 at baseline too — after buffering
   the whole body. The status line is the same; the memory is not.
3. **Unknown paths are protected identically.** E2b's answer is byte-identical to E2a's, so a
   body-bearing probe cannot tell a protected route from a nonexistent one.
4. **No length is not a loophole.** E5a and E5b answer 411 rather than reading a chunked body.
5. **The ceiling is exact, and ownership flips at it.** E13a/E13b (at and below) reach the
   route and carry a nonce; E13c (one byte over) is the guard's and carries none.
6. **Legitimate traffic is untouched.** E16 compares the five controls against the recorded
   unguarded run: same statuses, same CSP source, same bodies. HTML is not compared byte for
   byte — the nonce is per-request by design — so `/` is checked as still-an-HTML-document
   from middleware.
7. **`Expect: 100-continue` is now the cheapest case, not the dearest.** E3c reads **0** bytes
   of body: the guard answers the expectation instead of letting Node invite the payload.

# §6 guarded acceptance — two production processes, one database

Same probe, same shared `file:/tmp/audit-singleton-db.db`, `--entry ingress/server.mjs`.
Evidence: `singleton-guarded.{log,json}`.

| id | claim | baseline | guarded |
|---|---|---|---|
| S1 | a first instance acquires and serves | PASS | PASS — `:3011` 200 in 440 ms |
| S2 | a second instance does not serve | **FAIL — 200** | PASS — `:3012` 503 `{"error":"Server is not accepting requests."}` |
| S3 | exactly one is serving | **FAIL — serving=2** | PASS — `serving=1` |
| S4 | the standby discloses nothing | **FAIL — `/` 200, readiness leaked internals** | PASS — `/` and `/api/health/ready` both 503, identical body |
| S5 | readiness names the lease | **FAIL — no field** | PASS — `checks.instance = true` |
| S6 | takeover within the TTL after SIGKILL | PASS vacuously (3 ms) | PASS — 11 789 ms, TTL 10 s + 2 s grace + 3 s beat |
| S7 | clean SIGTERM release beats expiry | PASS vacuously | PASS — 435 ms from spawn, boot included, against ≥12 000 ms for the expiry path |
| S8 | the unguarded entry refuses to start | **FAIL — exit 1 for an unrelated config error** | PASS — exit 1 naming the guard |

`8/8 passed`, exit 0. S6 and S7 now measure something: at baseline there was no lease, so
there was no takeover to time. S7 in particular was red once on this branch at 12 547 ms,
which is how the skipped release was found — see `ingress/guard.test.ts`, `describe("shutdown")`.

# §9 repeat at the FINAL artifact — the build the closeout ends on

The artifact above was rebuilt once more, for a reason that has nothing to do with the
ingress work and everything to do with not claiming a baseline that was not re-run:
`next.config.mjs` bakes the static-asset CSP's `report-to` group from
`NEXT_PUBLIC_SITE_URL` **at build time**, `.env` carries `http://localhost:3000`, and
`scripts/restart-origin.sh` exports the https origin only at *runtime*. So the first
csp-probe run of this session read `108/110` with two rows red — a build input, not a
regression, and the probe's own comment says which command fixes it. It was rebuilt with
`NEXT_PUBLIC_SITE_URL=https://172.20.10.2:3001` exported to the build, which is what a real
production build does anyway.

Final artifact: **`BUILD_ID 98appVCcbyMxzlhk26zya`**, entry `node ingress/server.mjs`, pid
sampled from `lsof -nP -iTCP:3002 -sTCP:LISTEN -t`. Every live row in §10 is from this
artifact. Evidence: `probe-guarded-final.{log,json}`,
`probe-guarded-final-repeat.{log,json}`, `singleton-guarded-final.{log,json}`,
`upload-abuse-final.{log,json}`, `proxy-parity-final.{log,json}`, `tool-matrix-final.*`,
`job-ownership-final.log`, `phase1-reliability-final.log`, `workflow-completeness-final.log`,
`export-fidelity-final.log`.

| burst on the final artifact | before | peak | settled | offered of 2800 MiB | statuses | CSP |
|---|---|---|---|---|---|---|
| §9 run | 238.4 | 238.4 | 238.4 | **15.75** | 413 ×28 | 0/28 |
| §9 repeat, same process | 241.3 | 241.3 | **238.0** | **17.5** | 413 + closed socket | 0/28 |

`25/25 passed`, exit 0, both runs. The repeat is the row that answers the original finding
directly: at baseline a second identical burst on the same process cost another +828 MiB and
gave back nothing, so RSS was monotonic across bursts. Here the second burst ends **3.3 MiB
below where it started**. Singleton on the final artifact: **8/8**, exit 0, S6 12 107 ms and
S7 433 ms.

## Two things this rebuild established that the earlier runs could not

1. **An unmeasured memory row used to pass.** The first two probe runs on this artifact were
   invoked without `--pid`, and E7/E8 printed `RSS null → peak 0 → settled null` under a
   **PASS**: `peakOk` read `baseline === null || …`. A memory claim that was never measured
   is worse than a red row, because it looks like evidence. `scripts/ingress-probe.mjs` now
   fails those two rows and prints `RSS NOT SAMPLED — rerun with --pid <server pid>`. The
   numbers in the table above are from runs that could not have passed vacuously.
2. **A database with no schema fails closed.** `singleton-probe.mjs` was run once against a
   freshly deleted `/tmp/audit-singleton-db.db`: `instance_leases` did not exist, no process
   could acquire, and **both** answered 503 (`serving=0`, 3/8). That is the correct direction
   — a lease that cannot be verified must not be assumed — but it is indistinguishable from a
   dead deployment, so `SERVER_SETUP.md` now says to apply migrations before starting and
   why the Docker `CMD` runs `migrate deploy` first.
