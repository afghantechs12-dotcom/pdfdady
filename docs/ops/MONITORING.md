# PDFDadi — monitoring and alerting

**No provider is configured, and this file names none.** It says what the deployment
emits, which signals are worth waking someone for, and what to do when one fires. Wire
it into whatever the operator already runs; every row is a condition over a log stream
or an HTTP probe, which every provider can express.

`MONITORING: NOT EXERCISED` — nothing below has been connected to a real provider,
because doing so needs an account this acceptance run does not have. The *sources* are
measured: see `docs/evidence/production-acceptance/13-observability.md`.

## 1. What the deployment emits today

| Source | Shape | Notes |
|--------|-------|-------|
| stdout / stderr | One JSON object per line: `{level, msg, ts, …fields}` | `warn`/`error` go to stderr, `debug`/`info` to stdout (`ConsoleLogger`). `LOG_LEVEL` filters (`debug`\|`info`\|`warn`\|`error`, default `info`) — an unrecognised value **refuses to boot**, by design |
| `GET /api/health` | `200 {"ok":true,"status":"up"}` | Liveness. What the Dockerfile `HEALTHCHECK` calls. There is **no** `/api/health/live` — that path is a 404 |
| `GET /api/health/ready` | `200` ready, `503 degraded` with `{dataDir, toolchain, database, instance}` | Readiness. Public. `instance` is the single-instance lease |
| `GET /api/health/dependencies` | Per-binary detail | **Admin-gated** — `401 {"error":"Unauthorized"}` unauthenticated, so it cannot be a machine probe |
| `POST /api/csp-report` | Violations, logged as `warn "csp violation blocked"` | Exercised end to end in Stage 8 |
| `audit_logs` table | Rows in SQLite | Queryable by the operator; not a log stream |
| Usage counters | Rows, written in `observe` mode (the default) | Consumption without refusal |

### Two line shapes, and a parser that must accept both

Application logs are JSON. **Process-lifecycle logs are not** — the boot gate, the
single-instance lease, the ingress guard and the rate-limit key warning use
`console.*` with a `[bracket]` prefix and plain prose, because they run before and
around the DI container that owns the logger. Measured on this deployment's own log:
27 lines across three boots and two completed jobs, of which **two** were JSON.

    [startup] PDFDadi configuration OK — env=production db=sqlite storage=local …
    [instance] single-instance lease acquired by host:80320:1d6bb095-….
    [rate-limit] Requests are arriving with X-Forwarded-For but TRUSTED_PROXY_SECRET is …
    {"level":"info","msg":"PDF tool worker ready","ts":"2026-09-05T18:05:52.724Z",…}

A rule set that parses JSON and drops the rest silently loses every one of the
lifecycle signals — including the refusal to boot and the "one rate-limit key for
every caller" warning. Match those as plain substrings.

**There is no access log and no metrics endpoint.** The app writes no line per request,
and neither `/api/metrics` nor `/metrics` exists (both 404, measured). Request rate,
latency and HTTP error rate must come from the **reverse proxy or platform**, not from
PDFDadi. That is the single most important fact on this page: an operator who ships only
the container's stdout will have no idea how many requests the site is serving.

## 2. Alerts worth waking someone for

Every `msg` below is a literal string the code emits; `monitoringSignals.test.ts` pins
them against the source, so a rename fails the suite instead of silently disarming an
alert. Thresholds assume the supported topology — ONE instance — so no aggregation
across replicas is implied.

### Page immediately

| Signal | Condition | Why |
|--------|-----------|-----|
| Process will not start | Container restarts with `[startup] PDFDadi refused to start` on stderr, or a crash loop with no port open | The configuration gate refused. It prints every problem at once; the log line names them. Nothing is serving |
| Liveness fails | `GET /api/health` non-200 twice, 30 s apart | The process is gone or wedged |
| Stranded work | any `error` with `msg` = `Queue handoff failed and rollback failed; job is stranded` | A customer's job exists and nothing will ever run it |
| Upload accepted, never ingested | any `error` with `msg` = `Upload stored but ingestion job could not be queued` | Bytes are stored, the document will not appear |
| Version written, pointer lost | any `error` with `msg` = `Version created but document pointer update failed` | The document's current version is wrong |
| Worker dead | any `error` with `msg` in `Worker loop crashed`, `Redis worker loop crashed`, `Unhandled rejection in worker` | Every queued job stops moving |
| Money failed | any `error` with `msg` in `Billing webhook processing failed`, `Billing webhook claim could not be released; its retry will be skipped` | A paid subscription may not be applied, or a retry will be skipped |
| Cross-tenant billing attempt | any `error` with `msg` = `Billing webhook metadata names a different organization than its customer` | Refused by design — but someone tried |

### Ticket within the day

| Signal | Condition | Why |
|--------|-----------|-----|
| Readiness degraded | `GET /api/health/ready` ≠ 200 for 5 minutes | Read the named check: `toolchain` false means a converter binary is missing (Office conversions fail); `database` false is the datastore; `dataDir` is the admin-store directory; `instance` false is the standby (normal on a standby, an outage on a solo instance) |
| Jobs are dying | rate of `Recovered stuck jobs` with `requeued > 0` rising above its baseline | Recovery works — that is the point — but a rising rate means jobs keep dying. Read `examined`/`requeued`/`failed` on the same line |
| Deploys strand work | any `warn` with `msg` = `Shutdown grace expired with work in flight` | `WORKER_SHUTDOWN_GRACE_MS` (default 20 000) is shorter than the work, or the orchestrator's stop timeout is shorter than the grace. Raise the grace **below** the platform's SIGKILL deadline |
| Retention not running | any `warn` starting `Retention:` or `msg` in `Expiry sweep failed`, `Version retention sweep failed` | Expired documents keep occupying the volume; a disk-full outage starts here |
| Degraded reads | any `warn` with `msg` in `DB health check failed`, `Analytics read degraded`, `Billing summary degraded`, `Entitlement lookup failed; defaulting to the free plan` | Each is a fallback that hides a fault. The last one bills a paying customer as free |
| Job failures | rate of `warn` `Job attempt failed` / `Processing attempt failed` / `Tool job failed` above baseline | One is a bad input; a spike is the toolchain or the volume |
| Forged webhooks | any `warn` with `msg` = `Rejected billing webhook with an invalid signature` | Working as designed. A sustained rate is someone trying |
| CSP violations | rate of `warn` `csp violation blocked` above baseline | Either a real injection attempt or a regression in the app's own asset loading |
| Rate-limit keys collapsed | `[rate-limit] Requests are arriving with X-Forwarded-For` — plain text, once per process | Behind a proxy, every caller shares one key: one client can spend everyone's budget. Set the secret and have the proxy send `x-pdfdadi-proxy-secret` |

### Lifecycle lines — plain text, matched as substrings

| Signal | Line contains | Meaning |
|--------|---------------|---------|
| Refused to boot | `[startup] PDFDadi refused to start` | The configuration gate rejected the environment and listed every problem. Page — nothing is serving |
| Booted | `[startup] PDFDadi configuration OK` | Use as the deploy marker: it names the provider selections actually in force (db, storage, queue, billing, usage limits, log level) |
| Took the lease | `[instance] single-instance lease acquired` | Expected once per boot. Twice with no restart between means two processes are contending |
| Released the lease | `single-instance lease released` | A clean SIGTERM. Its **absence** before a restart means the instance was killed, and the next one waits out the lease TTL before serving |
| Lease release failed | `lease release failed` | The next boot will wait out the TTL instead of starting immediately. Ticket |
| Would have served unguarded | `[ingress] the request guard was never installed` or `expected exactly one 'request' listener` | Thrown, so the process dies rather than serving without the guard. Page — it is a crash loop, and it means the artifact and the ingress wrapper disagree |

### Infrastructure, from the platform rather than the app

| Signal | Condition | Why |
|--------|-----------|-----|
| Disk on the data volumes | > 80 % on the volume holding `DATABASE_URL`, `STORAGE_LOCAL_ROOT`, `ADMIN_STORE_DIR` | SQLite writes fail hard when the volume is full; uploads fail after the bytes are read |
| Backup freshness | no online backup newer than the agreed window | `journal_mode` is `delete`, so a hot `cp` is **not** a backup. Use the online backup API — `scripts/migration-restore-drill.mjs` is the reference procedure |
| HTTP 5xx rate, latency, request rate | from the proxy | The app emits none of it |
| Certificate expiry | from the platform | Nothing in the app watches it |

## 3. A dashboard that fits on one screen

1. Liveness and readiness over time, with the four readiness checks broken out.
2. HTTP status classes and p50/p95 latency **from the proxy**.
3. Log volume by level, with `error` on its own axis.
4. Job outcomes: submitted, completed, failed, recovered (`Recovered stuck jobs`).
5. Disk used on each of the three data paths.
6. Rate-limit refusals (429) and upload refusals (413/415/401) from the proxy.

## 4. What monitoring needs configured in PDFDadi

Nothing. There is no monitoring variable, no DSN and no ingest key in this
application's environment — log shipping is a platform concern, and
`docs/evidence/production-acceptance/13-observability.md` explains why that is
deliberate rather than missing. `LOG_LEVEL` is the only knob that changes what a
shipper receives; leave it at `info` unless diagnosing something specific, because
`debug` is verbose enough to cost money at a per-GB provider.

Replacing the log sink is an adapter, not a rewrite: `ConsoleLogger` implements
`ILogger`, so a Sentry/Datadog/OTel adapter is a new class registered in the DI
container with no application-layer change.
