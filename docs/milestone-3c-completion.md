# Milestone 3.c — Server Tools Through the M2 Queue + Storage (Completion Report)

**Status:** Complete — implemented, verified, documented.
**Date:** 2026-07-27

M3.c routes every server-side PDF tool through the M2 platform: the **M2 storage
layer** (input + output live in object storage, streamed — never buffered whole
in the app server) and the **M2 job queue** (a `pdf-tool` job is enqueued and
drained by a worker; the processor is invoked in exactly one place). It adds
**real-time progress** (SSE), **cancellation** (pre-pull + mid-run via an
AbortSignal that SIGKILLs the running binary), and **correct temporary-resource
cleanup** (temp dir per job + a recurring retention sweep that purges expired
tool files). The legacy synchronous `/api/tools/[slug]` contract is preserved as
a thin wrapper that enqueues + awaits + streams; a new async surface
(`/api/jobs*`) drives the upgraded client UI with a progress bar and cancel
button. Optimized for large files (streaming get/put, on-the-fly sha256) and
high concurrency (worker concurrency = `TOOLS_MAX_CONCURRENCY`; the queue
absorbs bursts beyond that).

## What landed

### 3.c.1 — Storage streaming extensions
- `IObjectStorage` port gained `getStream(key)` (Web `ReadableStream` — bytes
  out, never materialized whole) and `putStream(key, stream, opts)` (bytes in,
  with on-the-fly sha256 + size returned in a `StreamPutResult`).
- `LocalFileStorage`: `getStream` via `Readable.toWeb(createReadStream)`; `putStream`
  via `pipeline` through a hashing `Transform` into a write stream.
- `R2ObjectStorage`: `getStream` via the S3 body's `transformToWebStream`;
  `putStream` tees chunks through a hash/counter `Transform` passed as the upload
  `Body` (R2 streaming PUT, chunked transfer-encoding).
- `IUploadService` gained `uploadStream` (explicit key, no dedup, streaming) for
  large job-scoped outputs; `upload` (buffered, content-addressed, dedup) stays
  for inputs. `UploadService` implements both; the application never touches
  storage/meta directly.

### 3.c.2 — Tool job service + worker handler + bootstrap
- `runCommand` gained an optional `AbortSignal`: on abort the child is SIGKILLed
  and the promise rejects with `CommandAbortedError` (distinct from
  `CommandError`). Every processor in `toolProcessing.ts` threads `ctx.signal`
  through to its `runCommand` call; the `unlock`/`repair` fallback catches
  re-throw `CommandAbortedError` so cancellation isn't masked as a wrong
  password or triggers an unwanted gs fallback.
- `PdfToolJobService` (application) owns the `pdf-tool` job contract
  (`PdfToolJobPayload` / `PdfToolJobResult` / `ToolJobErrorType`) and provides
  `enqueue` (maxAttempts = 1 — tool failures aren't transient), `getStatus`,
  `awaitCompletion` (provider-agnostic polling of the job repo), and `cancel`
  (delegated to `IWorker.cancel`). Tracks last-seen progress per job for polling
  clients.
- `PdfToolWorkerHandler` (infrastructure) is the **single** processor invocation
  site. It streams the input from storage to a temp file, runs the processor
  with an `AbortController` wired to `ctx.isCancelled()` (a short poller
  translates a cancel request into an abort of the running binary), streams the
  output back to storage via `uploadStream` (job-scoped key + 1h expiry),
  records the result, reports progress (`5/15/90/100`), categorizes failures
  into `job.result.errorType`, and always removes the temp dir.
- `createFileRetentionHandler` purges expired tool files (`listExpired` →
  `storage.delete` for `tool-inputs/`+`jobs/` keys + metadata delete) and
  re-schedules itself (recurring-via-reschedule, the scheduler's one-shot
  pattern). Content-addressed `ca/` objects are left to their own lifecycle.
- `workerBootstrap.ensureWorkerReady()` lazily (idempotent) registers both
  handlers, starts the worker, and kicks off the first retention sweep — called
  from the tool/job routes, not at boot, so a no-tool-traffic deployment runs no
  background loop. `PdfToolJobService` wired in DI (`Tokens.PdfToolJobService`).
- `InMemoryWorker` gained a concurrency semaphore (`concurrency` option, default
  1 = sequential for test parity; the bootstrap passes
  `config.toolsMaxConcurrency`) so jobs drained from the queue run in parallel —
  without it the synchronous route awaiting a job through the queue would
  serialize every conversion. Cancellation flag cleanup moved from
  `process()`-start to a `finally` + `requeue()` so a **pre-pull cancel** now
  survives into the handler (previously the flag was wiped when the job started
  processing) without leaking the set.

### 3.c.3 — API routes
- Legacy `POST /api/tools/[slug]` rewritten as a synchronous wrapper: rate
  limit + body-size pre-check + slot (unchanged), then `submitToolJob`
  (validate → stage input → enqueue) → `awaitCompletion` → on completion stream
  the output straight from storage (`getStream`) with the exact pre-M3 response
  headers (`Content-Type`, `Content-Disposition`, `Content-Length`,
  `X-Original-Size`, `X-Result-Size`, `Cache-Control: no-store`). Failed jobs
  map `errorType` back to the legacy HTTP statuses (422 processing/command, 503
  missing-dependency, 500 unexpected); cancelled → 422.
- `POST /api/jobs?slug=<slug>` — async submit: stage + enqueue, return
  `{ jobId }` (202). The slot is held only for the buffer+stage phase and
  released before returning — the connection never waits on processing.
- `GET /api/jobs/[id]` — status (polling): `{ id, status, progress, result,
  error, errorType }`; 404 if unknown.
- `GET /api/jobs/[id]/progress` — SSE: subscribes to `IJobEvents` for live
  progress + polls the repo for terminal, sends a final `{ terminal: true }`
  event, closes; tears down on client disconnect.
- `POST /api/jobs/[id]/cancel` — 404 unknown / 409 already terminal / 202
  cancel requested.
- `GET /api/jobs/[id]/download` — 302 to a time-limited signed URL
  (`DownloadService`); 410 if the output expired (retention sweep).
- Shared `lib/server/toolJobSubmit.ts` centralizes parse → validate → stage →
  enqueue so both routes stay thin and the staging logic is in one place.

### 3.c.4 — Client upgrade
- `ServerToolRunner` now uses the async path: `POST /api/jobs?slug=` →
  `EventSource(/api/jobs/[id]/progress)` driving an accessible progress bar
  (`role="progressbar"`, `aria-valuenow`) + phase label → on terminal
  `completed`, fetches `/api/jobs/[id]/download` (follows the 302) and shows the
  existing result screen; a **Cancel** button posts to `/cancel`. Teardown
  closes the SSE + aborts the download on unmount/reset. The error-to-message
  mapping mirrors the server.

## Files

**New (12):**
- `src/application/services/PdfToolJobService.ts` (service + job contract types)
- `src/infrastructure/jobs/PdfToolWorkerHandler.ts` (pdf-tool + retention handlers)
- `src/infrastructure/jobs/workerBootstrap.ts` (lazy worker start + handler registration)
- `src/infrastructure/jobs/PdfToolWorkerHandler.test.ts`
- `lib/server/toolJobSubmit.ts` (shared stage + enqueue)
- `app/api/jobs/route.ts`, `app/api/jobs/[id]/route.ts`,
  `app/api/jobs/[id]/progress/route.ts`, `app/api/jobs/[id]/cancel/route.ts`,
  `app/api/jobs/[id]/download/route.ts`
- `docs/milestone-3c-completion.md` (this file)

**Edited:**
- `src/application/ports/storage/ObjectStorage.ts` (`getStream`/`putStream` +
  `StreamPutOptions`/`StreamPutResult`)
- `src/infrastructure/storage/LocalFileStorage.ts`, `R2ObjectStorage.ts`
  (streaming impls)
- `src/application/ports/storage/UploadService.ts` + `UploadService.ts`
  (`uploadStream`)
- `src/infrastructure/queue/InMemoryWorker.ts` (concurrency semaphore; cancel
  flag lifecycle)
- `src/application/di/tokens.ts` + `container.ts` (`PdfToolJobService` token +
  wiring; worker `concurrency` = `toolsMaxConcurrency`)
- `lib/server/runCommand.ts` (`AbortSignal` + `CommandAbortedError`)
- `lib/server/toolProcessing.ts` (`signal` on `ProcessContext`, threaded to every
  `runCommand`; abort-aware fallbacks)
- `lib/server/validateUpload.ts` (`mimeType` on `ValidatedUpload`)
- `app/api/tools/[slug]/route.ts` (synchronous streaming wrapper)
- `components/tools/runners/ServerToolRunner.tsx` (async path + progress + cancel)
- `UploadService.test.ts`, `LocalFileStorage.test.ts` (streaming coverage + fakes)

## Build verification (all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 16 warnings (pre-existing baseline) |
| `npm run test` | 91/91 passed (19 files) — +15 new (3.c.1: 7, 3.c.2: 7, concurrency: 1) |
| `npm run build` | exit 0 — new `/api/jobs*` routes compiled; client bundles |

## Performance impact

- **Memory:** the pre-M3 peak — reading the whole output into memory
  (`readBuffer`) and returning it as the response body — is gone. The output is
  streamed from storage (`getStream`) to the response, and from the processor's
  output file to storage (`putStream` with on-the-fly sha256), so neither the
  HTTP path nor the worker holds a full output buffer. The input is still
  buffered once by Next's `formData()` (the acknowledged "where practical"
  limit — true streaming multipart remains deferred), then streamed to storage
  and streamed to the temp file. Net: per-request memory drops from
  ~input+output to ~input (formData) only.
- **Concurrency:** worker concurrency = `TOOLS_MAX_CONCURRENCY` matches the
  route slot count, so the synchronous path preserves pre-M3 parallelism (no
  queue-induced serialization). The async path decouples submission from
  processing — a burst beyond `TOOLS_MAX_CONCURRENCY` queues (in-memory or
  Redis) rather than 503ing, with inputs durable in storage.
- **Provider-agnostic:** local-fs/in-memory-queue for dev+test (no cloud/Redis);
  R2/Redis drop in via env + DI. `putStream` on R2 uses streaming PUT (chunked
  transfer-encoding) so large outputs upload without buffering.

## Security impact

- **SSRF (LibreOffice):** unchanged from M1 (per-job hardened LO profile +
  no-egress env; the definitive no-egress conversion worker is still the M2+
  follow-up). The handler reuses the existing hardened `officeToPdf`/`pdfToWord`
  unchanged.
- **Temp resources:** the per-job temp dir is removed in the handler's `finally`
  (success, failure, cancel). Orphaned outputs/inputs in storage are purged by
  the recurring retention sweep (1h TTL); the sweep only deletes objects under
  `tool-inputs/`+`jobs/` prefixes (content-addressed `ca/` objects are shared
  and left alone).
- **Job id enumeration:** the async `/api/jobs/[id]` endpoints return job state
  to anyone holding the id. In prod the Prisma-backed job id is an unguessable
  cuid; the in-memory dev id (`inmem-job-N`) is guessable (dev-only). No auth on
  the public tool API (unchanged from M1); auth-scoped jobs are M2.4+.
- **Cancellation:** best-effort by design — `IWorker.cancel` sets a flag; the
  handler's poller aborts the running binary (SIGKILL). A cancelled job's
  partial output (if any) is never stored (the handler throws before
  `uploadStream`).

## UX impact

- Live progress bar + phase label ("Preparing input" → "Processing" → "Saving
  result") replaces the indeterminate spinner for server tools.
- Cancel button aborts a running conversion (the binary is killed, not just
  ignored) and returns the user to the form.
- The result screen (download, size comparison, result note) is unchanged.
- Backward compatible: the legacy synchronous `/api/tools/[slug]` contract
  (headers + body) is preserved, so any non-app client or test still works.

## Breaking changes / deployment prerequisites

- **The tool API now depends on the M2 database.** Pre-M3 the tool route used
  only temp files and worked without a DB. Routing tools through the M2 job repo
  + file-metadata repo means `prisma migrate deploy` must have run (already a
  requirement for the M2 storage/auth routes). Dev: `DATABASE_URL` defaults to
  `file:./prisma/dev.db`; run `npm run db:migrate` once.
- `IObjectStorage` + `IUploadService` gained methods (additive). Any external
  `IObjectStorage` implementor must add `getStream`/`putStream` (the test fake
  was updated). `JobHandler` is unchanged. `ProcessContext` gained an optional
  `signal` (additive). `InMemoryWorker` gained an optional `concurrency`
  (default 1 = previous behavior). `runCommand` gained an optional `signal`.
- No client-breaking change: `ServerToolRunner` switched to `/api/jobs*`, but the
  legacy `/api/tools/[slug]` route is retained.

## Remaining work / risks

- **True streaming multipart input:** `formData()` still buffers the whole
  request body; a chunked multipart parser that aborts mid-stream on accumulated
  bytes is the remaining "where practical" item (deferred from M1).
- **SSE retry flapping:** `EventSource` auto-reconnects; the client intentionally
  does not flap to an error on a transient reconnect (it relies on the terminal
  event). A dropped long-running job with no reconnect could leave the UI
  "processing" — mitigated by the client being able to re-poll
  `/api/jobs/[id]` (not yet wired into the UI; a fallback poll would harden it).
- **Multi-instance rate limit + concurrency:** still single-instance/in-process
  (M1/M2 limitation). The Redis queue/worker adapters are provider-agnostic and
  ready; LB/Redis enforcement is the deployment follow-up.
- **Dedicated worker process:** the worker runs in the app process (started
  lazily on first tool/job request). For Redis prod with heavy load, run
  dedicated worker processes against the shared queue (the handlers register the
  same). Not a code change — a deployment concern.
- **Direct browser download filename:** `/api/jobs/[id]/download` 302s to a
  signed URL; the storage serving route (local) doesn't set
  `Content-Disposition`, so a direct browser download uses a generic name. The
  app client names the file from the job status. Setting `Content-Disposition`
  on the local serving route (from a signed query param) is a small follow-up.
- **Fine-grained progress:** phase-level only (the native binaries don't report
  progress); per-page progress for image extraction is future work.
- **Route unit tests:** the new routes aren't unit-tested (they resolve the
  Prisma-backed `appContainer` directly, matching the existing M2 route pattern);
  coverage is via the handler/service tests + manual verification. A
  container-overridable route test harness is a future improvement.

## Test results

`npm run test` → **91 passed (19 files)**. New M3.c tests (15):
- `LocalFileStorage`: `putStream` computes sha256+size; caller-supplied sha256;
  `getStream` round-trips + throws on missing; `putStream`+`getStream` large
  multi-chunk round-trip.
- `UploadService`: `uploadStream` records explicit key + sha256 + size (no
  dedup); records retention expiry.
- `PdfToolWorkerHandler` + `PdfToolJobService`: end-to-end success (output
  streamed to storage under a `jobs/` key, result sizes, progress includes
  terminal 100%); cancel before pull → cancelled; cancel mid-run via signal →
  cancelled; `ProcessingError` → `errorType="processing"`; `MissingDependencyError`
  → `errorType="missing-dependency"`; `getStatus` 404 path; concurrency
  processes up to the limit in parallel.
- `FileRetentionHandler`: purges expired tool file (object + metadata), leaves
  content-addressed object, re-schedules itself.

## Manual verification

The four automated gates pass (typecheck, lint, test, build). Runtime behavior
of the routes is covered by the handler/service integration tests (which wire
the real `LocalFileStorage` + `UploadService` + in-memory queue/worker/events
end-to-end) and by the preserved legacy contract. A live smoke test against a
migrated DB (e.g. `compress-pdf` via both `/api/tools/compress-pdf` and
`/api/jobs?slug=compress-pdf` + the SSE stream) is recommended before deploy.

Related: [[platform-architecture]], [[pending-security-hardening]].
