# §1 baseline reproduction — the unguarded artifact

Artifact: `.next/standalone/server.js` (Next 16.3.4, `output: "standalone"`), started by
`scripts/restart-origin.sh` with `NODE_ENV=production DEPLOYMENT_TOPOLOGY=single-instance`,
`DATABASE_URL=file:/tmp/audit-final-db.db`, listening on `127.0.0.1:3002`. No ingress guard:
nothing calls `installIngress()` on this entry, which is the whole point of the run.

Probe: `node scripts/ingress-probe.mjs --label baseline-unguarded`. The expectations in the
probe are the POST-FIX ones, so a red row here is the reproduction and the same probe is the
acceptance instrument afterwards.

`probe-baseline-unguarded.{log,json}` hold the second of two runs. Both are recorded here
because the difference between them is itself the finding.

## RSS across two identical 28 × 100 MiB bursts, same process

| moment | RSS (MiB) |
|---|---|
| process start, before any probe | 141.7 |
| run 1 — baseline sampled just before the burst | 516.5 |
| run 1 — peak during the burst | 3316.7 |
| run 1 — settled, 8 s after the last response | 3145.7 |
| run 2 — baseline sampled just before the burst | 3340.4 |
| run 2 — peak during the burst | 4168.9 |
| run 2 — settled, 8 s after the last response | 4169.8 |

The first burst cost +2800 MiB and gave back 171 MiB. The second, on the same process,
cost another +828 MiB and gave back nothing. RSS is monotonic across bursts: this is not a
transient spike that a GC reclaims, it is retention that survives the requests that caused
it. The originally reported ~301 → 1795 MiB is reproduced and exceeded — the shape is the
same and the magnitude is larger on this artifact.

`offered 2800 MiB of 2800` in both runs: every one of the 28 anonymous 100 MiB bodies was
read in full. **All 28 answered `200`** — the root page rendered for an anonymous 100 MiB
POST, with a per-request nonce CSP on all 28 responses, so `proxy.ts` and the route both ran
after the body had been retained.

## Per-case baseline (run 2)

| id | case | status | offered / total | latency | verdict |
|---|---|---|---|---|---|
| E3a | `POST /` declared 100 MiB | **200** | 100/100 MiB | 9.4 s | page rendered after full retention |
| E3b | `GET /` | 200 | 0 | 16 ms | control, unchanged |
| E2a | `POST /does-not-exist…` declared 100 MiB | **404** | 100/100 MiB | 9.4 s | unrouted path fully read, then 404 |
| E2b | `POST /admin/does-not-exist…` declared 100 MiB | **307** | 100/100 MiB | 9.2 s | fully read, then redirect |
| E5a | `POST /` chunked 100 MiB, no length | **200** | 100/100 MiB | 9.3 s | no declared length, still fully read |
| E5b | `POST /api/csp-report` chunked 100 MiB | **413** | 100/100 MiB | 9.3 s | 413 only AFTER the whole body |
| E4a | `POST /api/csp-report` declared 100 MiB | **413** | 100/100 MiB | 9.2 s | 413 only AFTER the whole body |
| E4b | `POST /api/csp-report` declared 3 MiB | **413** | 3/3 MiB | 276 ms | 413 only AFTER the whole body |
| E4c | valid small csp-report | 204 | 0 | 6 ms | control, unchanged |
| E4d | `POST /api/analytics/events` 64 KiB | 413 | 0.06 MiB | 3 ms | route's own 16 KiB limit, unchanged |
| E6 | understated `Content-Length: 100`, 100 MiB offered | socket error | 0.06/100 MiB | 2 ms | the parser bounds it; the extra bytes never land |
| E12 | 100 MiB + client-supplied proxy-secret / XFF / CSP headers | **200** | 100/100 MiB | 9.2 s | hostile headers change nothing, and nothing bounds the body |
| E3c | `Expect: 100-continue` + 100 MiB | **200** | 100/100 MiB | 9.2 s | Node auto-continued, then the body was read |
| E9a | `POST /api/tools/compress-pdf` 8 MiB multipart, anonymous | 400 | 8/8 MiB | 736 ms | class C control — its own reader, unchanged |
| E9b | `POST /api/jobs` declared 200 MiB multipart | 400 | 0.06/100 MiB | 4 ms | class C control — refused before the body |

`6/18 passed`. Red: E3a, E2a, E2b, E5a, E5b, E4a, E4b, E12, E3c, E10, E7, E8.

## What the baseline establishes

1. **A page URL is an amplifier.** `POST /` with 100 MiB returns 200 after retaining all of
   it. No authentication, no route opt-in, no rate limit involved.
2. **An unrouted path is an amplifier too.** `/does-not-exist…` reads 100 MiB before its 404,
   so protecting only known routes would not close it.
3. **Missing `Content-Length` is not a way out.** E5a offered 100 MiB chunked and it was read
   in full, which is why the fix cannot rest on the declared length alone.
4. **The existing 413s are the forbidden shape.** E4a, E4b and E5b already answer 413 — but
   only after buffering the entire body, which the brief names as a non-solution. The status
   line was right and the memory was still spent.
5. **Nothing here is disclosure-safe either.** The same offer draws 200, 404 and 307 depending
   on the path, so a body-bearing probe can distinguish an existing page from a protected
   route from a nonexistent one.
6. **`Expect: 100-continue` makes it cheaper for the attacker, not dearer.** With no
   `checkContinue` listener Node invites the body itself.

# §1 baseline reproduction — two production processes, one database

Artifact: the same unguarded `.next/standalone/server.js`, started twice by
`scripts/singleton-probe.mjs --entry .next/standalone/server.js` on ports 3011 and 3012 with
`NODE_ENV=production DEPLOYMENT_TOPOLOGY=single-instance` and one shared
`DATABASE_URL=file:/tmp/audit-singleton-db.db`. Evidence:
`singleton-baseline-unguarded.{log,json}`.

| id | claim | baseline result |
|---|---|---|
| S1 | a first instance acquires and serves | PASS — `:3011 /api/health` 200 in 441 ms |
| S2 | a second instance against the same database does **not** serve | **FAIL — `:3012` answered `200 {"ok":true,"status":"up"}`** |
| S3 | exactly one of the two is serving | **FAIL — `serving=2`** |
| S4 | the standby refuses every path identically, disclosing nothing | **FAIL — `/` answered 200; readiness leaked `dataDir`/`toolchain`/`database`** |
| S5 | readiness on the holder reports the lease as a named check | **FAIL — no `instance` field exists** |
| S6 | the standby takes over within the TTL after SIGKILL | PASS **vacuously** — 3 ms, because the second process was already serving |
| S7 | after a clean SIGTERM release a fresh instance acquires quickly | PASS **vacuously** — nothing was ever released, so nothing had to be waited out |
| S8 | the generated `server.js` refuses to start in production without the guard | **FAIL — exit 1, but for an unrelated `NEXT_PUBLIC_SITE_URL` config problem, not the guard** |

`3/8 passed`. Red: S2, S3, S4, S5, S8.

## What this establishes

1. **`DEPLOYMENT_TOPOLOGY=single-instance` excludes nothing.** Both processes read the variable,
   both validated it, both booted, both served `200`. The variable proves only that an operator
   typed it.
2. **The two failures compound.** Each process keeps its own in-memory rate-limit `Map`, so the
   global upload ceiling admits twice its budget; and both are writers against one SQLite file
   (ADR-M7-009 assumes a single writer).
3. **S6 and S7 are green for the wrong reason,** which is why they are recorded rather than
   quietly counted: with no lease there is no takeover to measure. Only the guarded run makes
   those two rows mean anything, and that is exactly what the same probe measures afterwards.
4. **The unguarded entry starts.** It printed `✓ Ready in 0ms` — the port is bound and the
   listener installed — *before* `instrumentation.ts` ran. Anything that must refuse traffic on
   behalf of a not-yet-known lease has to be in place at bind time, not at instrumentation time.
   That is the window `installIngress()` covers.
