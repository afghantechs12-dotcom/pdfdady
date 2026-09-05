# Stage 10 — observability and operations

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `7e3878c`
**Measurements:** `13-observability.log` (this directory)
**Origin measured:** `http://127.0.0.1:3002`, `BUILD_ID MniplDUweIbeIPYT_CM5N`, the
same throwaway state as Stages 6–9 (`file:/tmp/pa-stage6-db.db`,
`/tmp/pa-stage6-storage`, `/tmp/pa-stage6-admin`).

**MONITORING: NOT EXERCISED — NO PROVIDER.** No monitoring account, no log shipper
and no alerting destination exists for this project, and this stage invents none:
no provider name, no DSN, no ingest key, no dashboard URL. What it produces is a
provider-neutral template, [docs/ops/MONITORING.md](../../ops/MONITORING.md), whose
every row is a condition over a log line or an HTTP probe the deployment actually
emits — verified by measurement, and pinned by a test.

## 1. What Stage 10 has to answer

1. What does a running PDFDadi actually emit, and in what shape?
2. Can an operator tell, from outside, that it is alive and ready?
3. Which signals mean "wake someone", and what is the first action for each?
4. Is any of that documented, and can the documentation rot silently?

## 2. The HTTP surface, measured

| Path | Result | Use |
|------|--------|-----|
| `GET /api/health` | `200 {"ok":true,"status":"up"}` | Liveness. What the Dockerfile `HEALTHCHECK` calls |
| `GET /api/health/ready` | `503 {"ok":false,"status":"degraded","dataDir":true,"toolchain":false,"database":true,"instance":true,…}` | Readiness, with the four checks named |
| `GET /api/health/dependencies` | `401 {"error":"Unauthorized"}` | Admin-gated — cannot be a machine probe |
| `GET /api/health/live` | `404` (the app's HTML 404) | Does not exist |
| `GET /api/metrics`, `GET /metrics` | `404` | **No metrics endpoint of any kind** |

`toolchain:false` is this host's missing converter binaries, unchanged since Stage 6
and already recorded there; it is the reason readiness is 503 rather than a new
finding. The `/api/health/live` 404 is **not** a defect: `SERVER_SETUP.md` never
claimed that path, and the Dockerfile probes `/api/health`.

## 3. The log surface, measured

`ConsoleLogger` emits one JSON object per line — `{level, msg, ts, …fields}` — with
`warn`/`error` on stderr and `debug`/`info` on stdout. `LOG_LEVEL` filters, and is a
validated enum: `LOG_LEVEL=verbose` makes `getConfig()` throw
`ConfigurationError: … Expected 'debug' | 'info' | 'warn' | 'error', received 'verbose'`
and the process refuses to start (§5 of the log). That is intended, and documented,
because the failure otherwise reads as an unexplained boot loop.

**There is no access log.** 20 requests (10 `GET /`, 10 `GET /api/health`) added
**zero** lines to the origin's combined stdout/stderr file. Across three boots and
two completed compress jobs that file holds 27 lines, of which **two** are JSON.
`grep` finds no request logging in `ingress/server.mjs` or `ingress/guard.mjs`.

The operational consequence is the headline of the monitoring document: **request
rate, latency and HTTP error rate must come from the reverse proxy or platform.**
An operator who ships only the container's stdout gets no traffic telemetry at all —
not a low-resolution version of it, none.

### A second shape, easy to lose

The process-lifecycle lines are **not** JSON. The boot gate, the single-instance
lease, the ingress guard and the rate-limit key warning use `console.*` with a
`[bracket]` prefix and plain prose, because they run before and around the DI
container that owns the logger. A rule set that parses JSON and discards the rest
silently drops the refusal-to-boot line, the lease transitions and the "one
rate-limit key for every caller" warning. The document says to match those as plain
substrings and quotes each one.

Worth noting from the measured log: line 8 is that rate-limit warning, live. This
acceptance environment runs `scripts/tls-front.mjs` in front of the origin with no
`TRUSTED_PROXY_SECRET`, which is exactly the state the document tells an operator to
alert on — the warning fired on the real deployment shape it exists for, once per
process as designed.

## 4. What Stage 10 produced

| File | What it is |
|------|-----------|
| [docs/ops/MONITORING.md](../../ops/MONITORING.md) | Provider-neutral: what is emitted, page-now vs ticket-today vs platform-level signals, a one-screen dashboard, and the fact that PDFDadi needs nothing configured for monitoring |
| `monitoringSignals.test.ts` | Pins every message the document alerts on against its call site **and its level** |
| `SERVER_SETUP.md` | One paragraph under "Health endpoints": no `/live`, no `/metrics`, no access log, and a pointer to the monitoring document |

### Why the alert set is a test

An alert keyed to a log message is a string match against another file's string
literal with nothing in between. Rename `logger.error("Worker loop crashed")` and the
provider-side rule still exists, still evaluates, and still reports healthy —
permanently, because "no matches" and "nothing wrong" are indistinguishable from
outside. That is the worst failure shape available: silent, and discovered during the
incident the alert was for.

`monitoringSignals.test.ts` (34 assertions) therefore checks, in both directions:

- each of the 22 alertable messages is still emitted, **at the level the document
  tells the operator to expect** — a message demoted from `error` to `info` changes
  who is woken *and* moves the line from stderr to stdout, which some shippers
  collect separately;
- the eight plain-text lifecycle lines still exist in the files that write them, and
  are still quoted verbatim in the document;
- every backticked span in the document's alert tables is either a message the test
  pins or a listed non-message, so adding a row to the document without pinning it
  fails here;
- the three health paths the document tells the operator to probe still exist, and
  `/api/metrics` still does not — if a metrics endpoint ever appears, the sentence
  sending the operator to the proxy needs revisiting.

Verified to bite, three ways: renaming `Worker loop crashed` in
`InMemoryWorker.ts` → `no logger call emits "Worker loop crashed"`; demoting
`logger.info("Recovered stuck jobs")` to `debug` → `expected [ 'debug' ] to include
'info'`; adding an unpinned row to the document → `add these to ALERTS or to
NOT_A_MESSAGE: expected [ 'A row nobody pinned' ] to deeply equal []`. All three
restored; 34/34 green.

## 5. Defects found

**None.** No product defect, and nothing at the guard level either. The absence of an
access log and of a metrics endpoint is a **documented limitation**, not a bug: the
proxy in the supported topology already sees every request, and adding a second
request log inside the app would duplicate it at the cost of a hot path. It is
recorded as a manual row rather than fixed, because the decision — proxy log format,
retention and where it ships — is the operator's and depends on infrastructure this
repository does not own.

## 6. What Stage 10 does NOT establish

- **That any alert exists.** Nothing is configured anywhere. Every row of the
  document is a template until an operator wires it up.
- **That log shipping works.** The container writes to stdout/stderr; whether the
  platform collects it, and whether a JSON parser survives the plain-text lifecycle
  lines, is a property of the platform.
- **Log volume or cost at real traffic.** Measured at `LOG_LEVEL=info` with a
  handful of jobs: two JSON lines. `debug` is verbose enough to matter at a per-GB
  provider and was not measured.
- **That readiness detects a broken volume.** Unchanged from Stage 4: the `dataDir`
  check is `fs.access` on the admin store's directory only — presence, not
  writability, and nothing about the database or storage volumes. Manual row **L3**,
  an owner decision because it changes when a load balancer drains an instance.
- **Alert thresholds.** "Above baseline" is written literally, because no baseline
  exists yet. The first week of real traffic sets them; the document says which
  quantity to threshold, not what number.
- **Dependency and CVE monitoring.** `npm audit` was clean in Stage 8 (0 of 486) but
  no scheduled scan exists, and there is still no image scanner on this machine
  (`IMAGE CVE SCAN: NOT EXERCISED`, Stage 8).

## 7. Files changed by this stage

| File | Change |
|------|--------|
| `docs/ops/MONITORING.md` | NEW — the provider-neutral template |
| `monitoringSignals.test.ts` | NEW — 34 assertions pinning the alert set to the code |
| `SERVER_SETUP.md` | The health-endpoint list now says what does not exist, and points at the monitoring document |
