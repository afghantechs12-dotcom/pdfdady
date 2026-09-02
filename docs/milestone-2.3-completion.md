# Milestone 2.3 — Queue Layer (Completion Report)

**Status:** Complete — implemented, verified, documented.
**Date:** 2026-07-27

M2.3 turns the M2.1 in-memory queue into a provider-agnostic background-job
platform: a `JobContext` (progress + cancellation) threaded into handlers;
`IWorker.cancel/requeue` (cancellation + dead-letter requeue — failed jobs are
the DLQ via `Job.status="failed"`); an `IJobScheduler` port (delayed jobs) with
in-memory + Redis adapters; an `IJobEvents` port (progress streaming) with
in-memory + Redis adapters; and the **Redis queue/worker adapters** (`ioredis`,
reliable BRPOPLPUSH + pub/sub cancel + dead-letter list + sorted-set scheduler).
DI selects Redis vs in-memory via `REDIS_URL`. **Zero Redis required to
build/test** — the Redis adapters are only constructed when `REDIS_URL` is set.

## What landed

**Port extensions:**
- `IWorker` — gained `JobContext` (progress/isCancelled), `cancel(jobId)`, `requeue(jobId)`. `JobHandler` widened to `(job, ctx) => ...` (existing `(job) => ...` handlers stay compatible).
- `IQueue` — gained `requeue(jobId)` (put an existing job id back on the ready queue).

**New ports:** `IJobScheduler` (schedule/cancel delayed jobs), `IJobEvents` (emit/subscribe progress).

**In-memory adapters (testable, dev):**
- `InMemoryWorker` — ctx/cancel/requeue + in-place retry; progress via injected `IJobEvents`; dead-letter = `failed` status.
- `InMemoryJobScheduler` — `setTimeout`-based; creates the job record, makes it eligible at `runAt`.
- `InMemoryJobEvents` — per-job `EventEmitter` channel.
- `InMemoryQueue` — gained `requeue`.

**Redis adapters (prod, only constructed with `REDIS_URL`):**
- `RedisQueue` — reliable queue via `BRPOPLPUSH ready → processing` (crashed jobs recoverable from `processing`).
- `RedisWorker` — drains the Redis queue; cancellation via a `pdfdadi:cancel` pub/sub channel mirrored into a local set; progress via `IJobEvents`; on completion `LREM`s from processing; exhausted jobs `LPUSH` to a `pdfdadi:queue:deadletter` list.
- `RedisJobScheduler` — sorted set (`zadd` by runAt) + a 1s poller that atomically claims due jobs (`zrem`) and requeues them.
- `RedisJobEvents` — progress via Redis pub/sub; a single subscriber connection dispatches to per-job listeners.

**Config:** `env.ts` gained `REDIS_URL` → a `QueueConfig { provider: "memory" | "redis"; redisUrl }`. DI selects the provider from config.

**DI:** `Tokens.JobScheduler | JobEvents` added; `Queue | Worker | JobScheduler | JobEvents` wired to Redis or in-memory adapters based on `config.queue.provider`; the worker receives the `IJobEvents` instance via options.

## Files

**New (8):** `JobScheduler.ts`, `JobEvents.ts` ports; `InMemoryJobScheduler.ts`, `InMemoryJobEvents.ts`; `RedisQueue.ts`, `RedisWorker.ts`, `RedisJobScheduler.ts`, `RedisJobEvents.ts`; 1 test file.
**Edited:** `Worker.ts`, `Queue.ts` (port extensions); `InMemoryWorker.ts` (ctx/cancel/requeue), `InMemoryQueue.ts` (requeue); `tokens.ts`, `container.ts` (wiring); `env.ts` (REDIS_URL/QueueConfig); `package.json` (`ioredis`).

## Tests added

`npm run test` → **59 passed (15 files)**. New M2.3 tests (5), all against the
in-memory path (Redis adapters are exercised only with a live Redis):
- cancellation — `cancel()` mid-run → `status="cancelled"`.
- requeue/DLQ — a failed job is revived by `requeue()` (attempts reset) and succeeds on the second run.
- progress events — handler `ctx.progress(...)` → `onProgress` callback receives `[10,50,100]`.
- scheduler — a job scheduled for +50ms becomes eligible and completes.
- scheduler cancel — a scheduled job cancelled before run → `status="cancelled"`.

## Build verification (all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 16 warnings (pre-existing) |
| `npm run test` | 59/59 passed (15 files) |
| `npm run build` | exit 0 — ioredis bundled; queue adapters compiled |

## Performance / security / SEO impact

- **Performance:** additive — no existing request path changed. The queue is
  not yet driving existing tool routes (M3 wires server tools onto it). Redis
  path: BRPOPLPUSH is O(1) reliable pop; the scheduler poller is a 1s
  `zrangebyscore` (cheap; bounded by the scheduled set size). In-memory path
  unchanged from M2.1.
- **Security:** the cancel channel + DLQ are internal Redis keys
  (`pdfdadi:*`); no user input reaches them directly yet (job types/payloads
  are app-internal until M3+). Cancellation is best-effort by design (handlers
  must check `ctx.isCancelled()`).
- **SEO:** none — no public surface changed.

## Breaking changes

- `JobHandler` widened from `(job) => ...` to `(job, ctx) => ...`. Existing
  handlers that declare only `(job)` remain assignable (TS allows fewer
  params), so no caller breaks — verified by the M2.1 queue tests still
  passing. `IWorker` + `IQueue` gained methods (additive). `REDIS_URL` is
  optional (defaults to in-memory).

## Remaining M2 tasks

- **M2.4 — Authentication:** `IUserProvider`/`ISessionProvider`/`IOrganizationProvider`/`IRoleProvider` interfaces; local auth implementation (email/password on the DB, reusing M1's password helpers) + a Clerk adapter scaffold (no Clerk integration yet); repos for User/Org/Session/AuditLog/ApiKey/Webhook.
- **M2.5 — Observability:** metrics/tracing/analytics/error-reporting interfaces + local implementations; Sentry/PostHog adapters later.
- **Follow-up:** a visibility-timeout reaper for the Redis `processing` list (re-enqueue jobs from crashed workers); recurring-job scheduling (re-schedule on completion); wire real job handlers in M3+; a `/api/jobs/[id]/progress` SSE route consuming `IJobEvents`.
