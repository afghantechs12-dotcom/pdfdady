# Stage 6 — staging deployment

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b` · **Stage 5:** `cdb6f59`
**Measurements:** `09-surrogate-runtime.log` (this directory)
**There is no staging host.** No hosting provider, no container runtime, no
credentials, no DNS. What Stage 6 stands up instead is a **local production-mode
surrogate**, and every claim below is scoped to it.

## 1. What the surrogate is

| Piece | Value |
|-------|-------|
| Origin | `http://127.0.0.1:3002`, `scripts/restart-origin.sh` → `node ingress/server.mjs` |
| Front | `https://192.168.0.175:3001`, `scripts/tls-front.mjs` (throwaway self-signed cert) |
| Artifact | `BUILD_ID U1Tagyyl2WuT2jmfk2Tvm`, `NODE_ENV=production`, `DEPLOYMENT_TOPOLOGY=single-instance` |
| Database | `file:/tmp/pa-stage6-db.db` — throwaway, migrated with `migrate deploy` |
| Storage | `/tmp/pa-stage6-storage` — throwaway |

`NEXT_PUBLIC_SITE_URL=https://192.168.0.175:3001` was exported **at build time as
well as run time**: `next.config.mjs` bakes the static-asset CSP report-to group
from it, and `/_next/static/*` does not pass through the proxy that could supply
it later. So the accepted cold artifact `98appVCcbyMxzlhk26zya` is **superseded**
for this stage — not because it was wrong, but because the origin is a build
input and this stage needed a different origin. The final candidate is rebuilt
and re-measured in Stage 14.

The LAN address in Stage 5's notes (`172.20.10.2`) is stale; this machine is
`192.168.0.175`. Both are throwaway values that appear only in probe arguments
and in a self-signed certificate.

## 2. The two runtime rows Stage 5 deferred

Stage 5 changed `clientIp()` so the rate-limit key cannot be chosen by the
caller, and proved it in unit tests and by mutation. Two claims could only be
answered by a running process, because they depend on Next 16.3.4's own request
adapter passing a header the ingress guard stamps:

| Row | Result |
|-----|--------|
| Rotating `X-Forwarded-For` against `/api/admin/login` (5/min) buys no bucket | 409 × 5, then **429**, then 429 — with a different forged address each attempt |
| The same through the TLS front | **429** × 3 |
| The audit row records the peer, not the sent header | `user.register ip=127.0.0.1`; **0 rows** carry the forged `9.9.9.9` |

`HOSTNAME=127.0.0.1` was also confirmed to be a real bind boundary: the origin
port is refused on the LAN address (`curl` exit 7) while the front answers on it.

## 3. Probes against the surrogate

| Probe | Result |
|-------|--------|
| `scripts/ingress-probe.mjs` | **25/25** — the 28 × 100 MiB anonymous burst bounded to 26.5 MiB read of 2800 offered, RSS peak +0 |
| `scripts/upload-abuse-probe.mjs` | **32/32** (see §4 — a cold run first reported 27/32) |
| `scripts/singleton-probe.mjs --entry ingress/server.mjs` | **8/8** — S6 takeover after SIGKILL in **12.09 s**, S7 release-then-acquire in **0.43 s** |
| `scripts/csp-probe.mjs --url https://192.168.0.175:3001` | see `09-csp.log` |

S5 of the singleton probe reads `checks.instance = true` on an HTTP **503**, which
is correct and is the subject of §6.

## 4. The defect Stage 6 found: one anonymous caller could spend the whole upload budget

`checkUploadLimit` charges three buckets — per user, per client address, and a
global ceiling. The per-address bucket was keyed on `trustedClientAddress()`,
which returns an address **only when a proxy vouched for it** with
`TRUSTED_PROXY_SECRET`. In the topology this build actually ships — no proxy
secret set, `docs/adr/ADR-M7-009` single instance — that key was always absent,
so every unauthenticated caller fell through to the global ceiling alone: one
address could consume all **240/min** and refuse uploads for everyone else. The
upload-abuse probe recorded exactly that as "429 on attempt 227".

Fixed by keying the anonymous bucket on `clientIp()` — the three-source identity
Stage 5 built, whose second source is the peer address `ingress/guard.mjs` stamps
and a client cannot set. `"unknown"` is **skipped rather than keyed**: collapsing
unidentifiable callers into one 20/min bucket would be tighter than the global
ceiling it stands in for, and would let one caller refuse work for all of them.

Severity **P2**: a single anonymous caller could deny uploads to every other
anonymous caller on the instance, with no authentication and no forged header —
but it costs no data and no privilege, and the global ceiling still bounded the
work the server did.

Guarded by two new tests in `lib/server/uploadRateLimit.test.ts` (now 12). The
existing ten all passed with the fix *and* with it reverted, because their `req()`
helper stamps no peer header, so `clientIp()` returned `"unknown"` for every one
of them — the same fixture-inert shape recorded in earlier phases. Mutation
**M7**: restore `trustedClientAddress(...) ?? "unknown"` → 1 of 12 fails.

### The cold run, recorded rather than smoothed over

Immediately after the rebuild and restart, the same probe binary reported
**27/32**: the control row L0 ("a signed-in 8 MiB upload IS parsed") read
`0 in 30233ms`, L1 and L5 saw status 0, L13 found one extra `document_versions`
row, and L3 got its 413 but no RSS reading. None of those are rate-limit-shaped
and the four rate-limit rows (L8, L8b, L8c, L9) passed in both runs. After
warming the routes with one empty multipart POST and 13 GETs and letting the 60 s
windows drain, the same command returned **32/32**. The probe assumes a warm
origin; that is a property of the probe, not of the fix, and it is written down
here so a future 27/32 is not read as a regression.

## 5. The second defect: the gate grew a requirement and three launchers rotted

Stage 4 made `STORAGE_LOCAL_ROOT` required in production. Nothing shipped broke —
`docker-compose.yml` sets it, and Stage 4 added it to the documented `docker run`
and to `scripts/restart-origin.sh`. But **every other place that hand-writes a
production environment** silently stopped being able to boot, and the acceptance
tooling is where they live:

| Place | What it did |
|-------|-------------|
| `scripts/singleton-probe.mjs` | Both instances were refused at boot. S1 waited out 90 s for a process that had exited; S2 and S4 — "the second instance does not serve", "the standby discloses nothing" — **passed on a dead process**, which is the expensive kind of green |
| `scripts/final-prelaunch-audit.mjs` group B | **B4 went red** ("a good secret is accepted" — it no longer was), and B2 became vacuous: it asserts a postgres URL is refused, and by then any environment was |
| `scripts/tls-front.mjs`, `csp-probe.mjs`, `processing-pilot-probe.mjs`, `workflow-completeness-probe.mjs` headers | Printed a `cd .next/standalone && … node server.js` recipe that cannot boot for two reasons: the missing variable, and the unguarded entry that Phase 6 made exit 1 |

Fixed at the cause in each case rather than by adding the variable four more times:

- The harness gets one `VALID_PROD_ENV` fixture, and B1's expected set is
  **derived from it** (`REQUIRED_PROD_KEYS`) instead of being a hand-written list
  of four names — so the next requirement changes one place and B1 grows with it.
- The probe composes its environment once: `start(port, entry)` takes the entry,
  and S8 (the unguarded baseline) goes through it instead of holding the second
  copy that rotted. S8's own comment had warned that a config refusal would make
  the row unattributable — which is precisely what happened.
- `deploymentArtifact.test.ts` now feeds **both** launchers to `productionProblems`
  (`it.each`), so a launcher that cannot boot fails in the suite in 5 ms instead
  of at the start of an audit run. Mutation **M8**: remove the storage root from
  the probe's environment → 1 of 14 fails.
- The four stale recipes point at `scripts/restart-origin.sh`, which is the
  launcher that test guards.

Severity **P3**: no shipped deployment path was affected, and the fix is in
acceptance tooling and comments. Recorded because its *effect* was a false pass,
not a failure.

## 6. Readiness on this host is `degraded`, and correctly so

```
{"ok":false,"status":"degraded","dataDir":true,"toolchain":false,"database":true,"instance":true}
```

`toolchain` is `false` because `soffice` is absent from this machine; the other
six binaries readiness requires are present. The image installs LibreOffice
(`Dockerfile:43`), and `deploymentArtifact.test.ts` already pins a package for
every binary in `binaryInfo`, so this is **ENVIRONMENTAL** — a property of the
surrogate host, not of the build. It also means office-format conversion cannot
be exercised in Stage 7; that tool is `NOT EXERCISED` there for the same reason.

Two facts worth an operator's attention, both unchanged by this stage:

- Liveness is `GET /api/health` → `{"ok":true,"status":"up"}`. There is no
  `/api/health/live`; a probe configured for that path gets a 404 and would
  restart a healthy container.
- Readiness returning 503 on a host missing one optional-looking binary is
  deliberate (a load balancer must not send conversion traffic to it), and is why
  the `dataDir` writability question is manual row **L3** rather than a silent
  edit — see `07-database-storage.md` §7.

## 7. What Stage 6 does NOT establish

- **Nothing about a hosting provider.** No staging environment exists to deploy
  to. TLS here is a self-signed certificate in front of a loopback origin; there
  is no CDN, no load balancer, no managed database, no DNS.
- **No container was run.** Unchanged from Stage 3:
  `CONTAINER EXECUTION: NOT EXERCISED — NO CONTAINER RUNTIME`.
- **Not a soak.** The surrogate ran for the duration of the probes, not for days.
  Stage 9 covers restart and recovery; nothing here speaks to memory or disk
  drift over time.
- **The proxy is a stand-in.** `scripts/tls-front.mjs` adds `x-forwarded-proto`
  and `x-forwarded-host` and passes other headers through. It is not nginx and
  does not apply the documented body caps; the caps are guarded statically
  (Stage 5) and unexercised here.

## Files changed by this stage

| File | Change |
|------|--------|
| `lib/server/uploadRateLimit.ts` | The anonymous bucket is keyed on `clientIp()`, skipping `"unknown"` |
| `lib/server/uploadRateLimit.test.ts` | Two cases: the stamped peer keys a bucket; nothing identifiable falls back to the ceiling |
| `deploymentArtifact.test.ts` | Both launchers are fed to `productionProblems`, not just the shell one |
| `scripts/singleton-probe.mjs` | One environment composition, used by `start()` and by S8; `STORAGE_LOCAL_ROOT` in it |
| `scripts/final-prelaunch-audit.mjs` | One `VALID_PROD_ENV`; B1's expected names derived from it |
| `scripts/tls-front.mjs`, `scripts/csp-probe.mjs`, `scripts/processing-pilot-probe.mjs`, `scripts/workflow-completeness-probe.mjs` | The documented origin recipe points at the guarded launcher |
