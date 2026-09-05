# PDFDadi Feature Ledger

The living record of what PDFDadi *can do*, one entry per feature or meaningful
infrastructure capability. It is written for the next session: read it to learn
what exists and where the seams are, not to reconstruct how it was built.

**Update this file in the same session as any feature work.** An entry that
lands a week later is archaeology. Keep entries short — the code is the detail,
this is the map.

---

## Unified processing pipeline (async remote tools)

- **Status:** Complete (pilot scope: `compress-pdf` only)
- **Date:** 2026-08-24
- **Purpose:** Run expensive server-side PDF work off the request, so a slow
  Ghostscript run cannot hold an HTTP connection or a Next.js worker.
- **User-visible behavior:** Submitting a remote tool returns a job id
  immediately (HTTP 202). The client polls status, streams progress over SSE,
  can cancel mid-run, and downloads through a signed URL. A failed job shows a
  category-safe sentence, never an internal diagnostic; failures that another
  attempt could fix are retried automatically.
- **Architecture:** `POST /api/jobs` → `submitProcessingJob` validates, stages
  the input to object storage, then creates the job `created` and only queues it
  once the input is durable. A worker (in-process, or `npm run worker`) claims it
  via CAS and runs `createProcessingJobHandler`, which owns the whole outcome:
  it classifies its own failure, decides on a retry, writes the terminal status,
  and returns `{ terminal: true }`. Output is uploaded only after the processor
  resolves, and deleted again if the job became unpublishable meanwhile, so a
  cancelled job never yields bytes. Execution ceiling is enforced by an
  `AbortSignal` that becomes SIGKILL.
- **Key files:** `lib/server/processingJobSubmit.ts`,
  `src/application/services/ProcessingJobService.ts`,
  `src/infrastructure/jobs/ProcessingJobHandler.ts`,
  `src/infrastructure/jobs/processingBootstrap.ts`,
  `src/infrastructure/processing/classifyFailure.ts`, `app/api/jobs/**`
- **Tests/probes:** `src/infrastructure/jobs/ProcessingJobHandler.test.ts` (30),
  `src/infrastructure/jobs/pilotPipeline.integration.test.ts` (27 — real storage,
  real queue, real worker, real Ghostscript; skips with a loud reason if `gs` is
  absent)
- **Feature flags:** `isProcessingPipelineEnabled(slug)`. Off, or any failure
  resolving it, means the legacy synchronous path.
- **Known limitations:** One input per job. Only `compress-pdf` is migrated. A
  worker that dies mid-job no longer needs an operator — see *Worker stuck-job
  recovery* — but the job waits out the stale threshold (10 min) before another
  worker takes it, so a crash costs latency, not the job.
- **Next related step:** Migrate a second remote tool. Metering now covers every
  remote slug either way (*Full server tool metering coverage* below), so the
  migration is a pipeline decision, not a measurement one.

## Job ownership enforcement on legacy endpoints

- **Status:** Complete
- **Date:** 2026-08-24
- **Purpose:** Close a real IDOR: the legacy branch of the job endpoints had no
  ownership check, so anyone who knew a job id could read another user's status
  and download their PDF.
- **User-visible behavior:** A job you do not own answers 404 on status,
  download, cancel and progress — the same answer as a job that does not exist,
  so the endpoints do not confirm ids.
- **Architecture:** Both pipelines resolve the actor server-side from the session
  cookie (`resolveJobActor()`), never from the request. Each of the four legacy
  routes calls `legacyJobAccessDenied(row)` before reading job data and returns
  its response directly.
- **Key files:** `lib/server/jobActor.ts`, `lib/server/processingJobApi.ts`,
  `app/api/jobs/[id]/{route,download,cancel,progress}.ts`,
  `src/application/services/jobOwnership.ts`
- **Tests/probes:** `lib/server/legacyJobOwnershipWiring.test.ts` (asserts the
  gate is *called* and ordered before the read — the predicate was always
  correct, it was never invoked), plus
  `scripts/legacy-job-ownership-probe.mjs` against a running server.
- **Feature flags:** None.
- **Known limitations:** Anonymous ownership is per-cookie; clearing cookies
  loses access to in-flight anonymous jobs.
- **Next related step:** None outstanding.

## Usage metering and plan entitlements

- **Status:** Partial — enforcement is observe-only by default; one tool wired
- **Date:** 2026-08-24
- **Purpose:** Know what server-side work each plan actually consumes, and hold
  the seam that will later refuse work over a limit — without changing anyone's
  experience today.
- **User-visible behavior:** None by default. In `observe` mode an over-limit
  submission is recorded and proceeds. With `USAGE_LIMIT_MODE=enforce`, a refused
  submission answers HTTP 429 with `Retry-After` and never writes the file to
  storage.
- **Architecture:** `UsageMeteringService` is the only entry point. Admission
  (`authorize`) happens in `submitProcessingJob` *after* validation, so the byte
  count is measured rather than claimed, and *before* the upload, so a refusal
  costs no storage write. It resolves the plan, reads counters, runs the pure
  policy in `src/domain/metering`, then reserves by incrementing first and
  re-running the *same* policy against the post-increment total — which is what
  makes two requests racing for the final slot resolve to exactly one admission.
  The reservation instant travels in the job payload; the worker settles it once
  per job (`settleProcessingOutcome`), refunding into the window the charge was
  taken in. Customer meters (`server_operations`, `server_input_bytes`, daily) are
  charged once per job; `compute_units` is charged per *attempt* and is never
  enforceable, so a retry costs us infrastructure without billing the user twice.
  Every call fails open: a metering outage never blocks or fails PDF work, and
  surfaces as `degraded: true`. The event ledger has no `ownerId` field at all,
  so it is anonymous by construction.
- **Key files:** `src/application/services/UsageMeteringService.ts`,
  `src/domain/metering/*` (plans, meters, limits, cost, periods),
  `src/application/ports/metering/*`,
  `src/infrastructure/persistence/{Prisma,InMemory}UsageRepository.ts`,
  `src/infrastructure/metering/OrganizationEntitlementProvider.ts`,
  `lib/server/processingJobSubmit.ts`, `src/infrastructure/jobs/ProcessingJobHandler.ts`
- **Tests/probes:** `src/domain/metering/*.test.ts` (122, pure policy),
  `src/application/services/UsageMeteringService.test.ts` (31, service against a
  real in-memory repository, including a barrier-synchronized reservation race),
  `src/infrastructure/jobs/meteringPipeline.test.ts` (11, worker seam),
  `src/infrastructure/jobs/legacyToolMetering.test.ts` (12, legacy submit path),
  `src/application/services/durableSettlement.test.ts` (10, cross-process claim),
  `src/application/services/usageCalibration.test.ts` (18),
  `src/infrastructure/metering/*.test.ts` (13, entitlement resolution),
  `src/infrastructure/persistence/PrismaUsageRepository.claim.test.ts` (6),
  `lib/server/meteringSubmitWiring.test.ts` (11, admission ordering and identity).
  Mutations verified on 2026-08-25, each restored byte-exact against a recorded
  SHA-256 (this repo is not Git-backed): remove the durable idempotency claim
  (6 fail); defeat the atomic post-increment check (2); drop the `willRetry`
  short-circuit so retries bill the customer (4); read the owner from the
  multipart body (2); make `shouldBlock` ignore the mode so observe blocks (4);
  make `isMetered` true for local tools (2); refund on success as well as failure
  (10). All seven were caught.
- **Feature flags:** `USAGE_LIMIT_MODE` = `observe` (default) | `enforce` | `off`.
  An unrecognized value resolves to `observe`, never to enforcement.
- **Known limitations:** Duplicate-settlement protection is durable and atomic
  (`claimSettlement`, a conditional insert on a unique key — see *Durable usage
  settlement*); the in-process `Set` bounded at 5000 remains only as the
  fail-open fallback when that store is unreachable, and reports
  `degraded: true` when it is used. Plans resolve through billing state when a
  billing repository is wired and fall back to the free-text
  `Organization.plan` column otherwise. Only `compress-pdf` runs on the unified
  pipeline; every other remote tool is metered through the legacy submit path
  (*Full server tool metering coverage*).
- **Next related step:** Done as far as measurement goes — both submit paths are
  metered (*Full server tool metering coverage*), settlement is duplicate-proof
  across workers (*Durable usage settlement*), and readiness for `enforce` is now
  computed rather than guessed (*Limit calibration and enforcement readiness*).
  What remains is entitlement *activation*, which is billing work.

---

## Client product analytics and the usage snapshot API

- **Status:** Partial — ingest is complete; one tool (Merge PDF) is wired
- **Date:** 2026-08-24
- **Purpose:** Learn where visitors fall out of a tool's funnel, and let the app
  read back the allowance it is already metering — without collecting anything
  that could identify a person or reveal a document.
- **User-visible behavior:** None. Beacons are fire-and-forget from the browser;
  `GET /api/usage` returns the caller's own plan and meters (a signed-out caller
  gets their real `guest` allowance, not a 401).
- **Architecture:** `ProductAnalyticsService` is the only path a browser event
  takes into the ledger, and it is a *separate* DI token from
  `UsageMeteringService` because it is the half a browser can reach: it calls
  `recordEvents` and has no code path to `incrementCounters`, so client traffic
  can never move an authoritative quota counter. Order inside `ingest` is the
  contract — drop by name against `CLIENT_INGESTIBLE_EVENTS`, sanitize against the
  per-event allowlist, *then* spread the server-resolved `plan` and `ownerType`
  over the result, so a client claiming `plan: "business"` is overwritten rather
  than merely unstored (both keys are legitimately allowlisted, so the allowlist
  alone does not close that hole). Identity is the pre-existing `subjectHash`
  design, given its first producer: a keyed HMAC salt rotated on the UTC day via
  `periodKeyFor`, truncated to 32 hex. Keyed, because a day key is public and an
  unkeyed hash of an enumerable id space is reversible; rotated, because
  stitching a funnel needs a day, not a history. The route answers **204 to
  almost everything** — unknown name, malformed JSON, a failed write — since a
  beacon's caller must not care, an error invites a retrying client (a renamed
  event would become a retry storm from every stale tab), and a 400 is a validity
  oracle. The two exceptions that must be able to refuse are 413 (body over
  16KB, enforced on the *read* bytes because `content-length` is client-supplied
  and omittable) and 429 (`RateLimiter`, 120/min/IP). On the client, `track`
  returns `void` so no call site can put a beacon in front of a merge; sends use
  `keepalive` so `download` survives the navigation it reports; `trackOnce`
  dedupes on a caller-supplied key so Strict Mode and re-renders do not inflate
  the funnel. Merge PDF emits no `job_submitted` — nothing is submitted, and
  `rollupFunnel` clamps each step to the one before it, so a fabricated zero
  would report a working tool as broken.
- **Privacy invariants:** No filename, no PDF text or page content, no client
  `ownerId`/`userId`, no cookie or token, no signed URL, no document metadata.
  Undeclared properties are dropped, non-primitives are dropped, strings are
  truncated to 120 chars. The actor class is resolved server-side by
  `resolveJobActor` exactly as job ownership is; there is no request parameter
  through which a client could name a subject, and `UsageEventRecord` has no
  `ownerId` field to store one in.
- **Key files:** `src/application/services/ProductAnalyticsService.ts`,
  `src/domain/metering/events.ts` (`CLIENT_INGESTIBLE_EVENTS`,
  `MAX_PROPERTY_VALUE_LENGTH`), `app/api/analytics/events/route.ts`,
  `app/api/usage/route.ts`, `hooks/useAnalytics.ts`,
  `components/tools/runners/MergeTool.tsx`, `components/tools/ResultActions.tsx`
- **Tests/probes:** `src/application/services/ProductAnalyticsService.test.ts`
  (21, against the real in-memory repository — includes a stringify leak sweep and
  an assertion that no counter row exists for any meter in either window after
  client traffic), `app/api/analyticsRoutes.test.ts` (22, HTTP contract for both
  endpoints), `hooks/clientAnalyticsWiring.test.ts` (15, source-text: vitest is
  `environment: "node"`, so the hook cannot be mounted and the tool cannot be
  rendered), `src/domain/metering/events.test.ts` (19, taxonomy). Ten mutations
  were verified to fail these suites: admit a server-authoritative event from the
  client; spread the server dimensions before sanitization; make the subject salt
  unkeyed; make it non-rotating; touch a counter from the ingest path; rethrow
  instead of degrading; fire `onDownload` before `downloadBlob`; advance the run
  counter after state is cleared; cap the body on `content-length` alone; answer
  400 or 500 instead of 204.
- **Feature flags:** `ANALYTICS_SUBJECT_SECRET` — the HMAC key for the subject
  hash, read in the container (falls back to `ADMIN_SECRET`). Unset means no
  subject hash at all: events are still recorded, funnels simply cannot be
  stitched. It is deliberately *not* in `src/infrastructure/config/env.ts`'s zod
  schema, mirroring `USAGE_LIMIT_MODE`, so a missing value degrades instead of
  failing boot.
- **Known limitations:** Rate limiting is the in-process `RateLimiter` (same
  single-instance caveat as every other limiter here). Only Merge PDF is wired —
  the other twelve local tools emit nothing yet. Local `job_failed` carries no
  `errorCategory`, because `usePdfProcessor` exposes a user-facing sentence rather
  than a category and inventing one would put a meaningless number in a
  dashboard.
- **Next related step:** Done. Both follow-ups from this entry shipped: all 18
  local tools now report through shared seams (*Full local tool analytics
  coverage*) and `job_failed` carries a real category (*Local failure
  taxonomy*).

## Usage and analytics read surfaces (user usage view, admin analytics, funnel reporting)

- **Status:** Complete for the three surfaces below; limits remain observe-only.
- **Date:** 2026-08-24
- **Purpose:** Make the metering and analytics data collected by the two previous
  entries *legible*, so plan ceilings can be calibrated from observed numbers
  before enforcement is switched on. Until now every figure the product recorded
  was write-only.
- **User-visible behavior:** A signed-in account sees a **Usage** card on its
  workspace dashboard: plan, heavy operations used of allowance, upload volume,
  remaining, when the allowance resets, and the largest permitted file. While
  `USAGE_LIMIT_MODE` is not `enforce` the card carries a `Monitoring` badge, so a
  number near its ceiling cannot be misread as an imminent block. Anonymous
  visitors get no dashboard (the card is account-scoped). An operator gets a new
  **Analytics** page in the admin area: runs, successes, failures, success rate,
  bytes processed, mean duration, compute units, distinct tools, a local-vs-remote
  split, a top-tools table, the Merge funnel with its worst drop marked, and
  normalized failure categories.
- **Architecture:** One new service, `UsageAnalyticsReadService`, behind its own
  DI token. The token granularity *is* the capability boundary: it resolves only
  `UsageRepository` and `Logger`, so there is no path from a dashboard refresh to
  `incrementCounters` — a read surface that could move a counter would make every
  number it displays evidence of itself. Four properties are load-bearing:
  (1) **no method returns a row.** Every figure is an aggregate produced by
  `toolUsageSummary` / `eventCounts` / `dimensionCounts` in the store, so a busy
  month is a slow query rather than a memory incident, and there is no shape in
  which a raw `UsageEvent` can reach a browser. (2) **The window is bounded
  before it is used,** by `boundReportWindow`: unparseable or absent bounds fall
  back to 7 days, a future `to` is pulled back to now, a reversed range becomes a
  day, and anything over `MAX_REPORT_DAYS` (92) is clamped — with `clamped: true`
  reported, because a silently narrowed window is a wrong number presented as a
  right one. (3) **Nothing throws.** Each of the four queries is wrapped
  individually rather than sharing one `Promise.all` rejection, so a day when the
  tool table times out still renders a funnel; the report says `degraded: true`
  and the logger gets a warning. (4) **The null bucket means different things per
  dimension,** and is handled per dimension: a null `executionMode` is a real
  state and is labelled `unattributed`, while a null `errorCategory` on a
  completion event means the attempt *succeeded* — so that bucket is dropped, and
  the count of local failures with no category is reported separately as
  `uncategorizedLocalFailures` rather than invented. The overall duration mean is
  weighted by `durationSamples`, not `total`: a tool whose attempts mostly
  reported no duration would otherwise drag the figure toward something no
  measurement supports. `topTools` is capped at 8 but `toolCount` reports the true
  distinct count, so a truncated table cannot read as a complete one. The user
  card projects `/api/usage` through a pure module, `usageViewModel.ts`, so
  "never render an internal counter key" and "an unlimited meter must not read as
  out-of-quota" (`limit <= 0` → omitted) are asserted rather than assumed; React
  keys are synthetic `meter-N` ids, never the meter key.
- **Privacy invariants:** `UsageDimension` stays a closed union with no
  `subjectHash` member, so the grouping that would turn an unlinkable pseudonym
  into an enumeration of visitors cannot be *asked for*. No response from either
  surface contains an `ownerId`, a `subjectHash`, or a `properties` blob — pinned
  by a sentinel sweep over the serialized report, which is what caught a mutation
  that cast around the union and typechecked cleanly. The admin API answers 401
  before it reads: the guard runs ahead of `appContainer.resolve`, not merely
  ahead of the response. `ANALYTICS_SUBJECT_SECRET` appears in exactly one source
  file (the container) and in no client bundle; a production build's
  `.next/static` was grepped for it, for `ADMIN_SECRET`, and for `subjectHash`.
- **Key files:** `src/application/services/UsageAnalyticsReadService.ts`,
  `app/api/admin/analytics/route.ts`, `app/admin/analytics/page.tsx`,
  `components/admin/AnalyticsDashboard.tsx`, `components/app/UsageCard.tsx`,
  `components/app/usageViewModel.ts`, `src/domain/metering/funnel.ts`
  (`LOCAL_FUNNEL_STEPS`), `components/workspaces/WorkspaceDashboard.tsx`,
  `components/admin/AdminShell.tsx`, `src/application/di/{tokens,container}.ts`,
  `.env.example`, `SERVER_SETUP.md`
- **Tests/probes:** `UsageAnalyticsReadService.test.ts` (32),
  `app/api/adminAnalyticsRoute.test.ts` (12),
  `components/app/usageViewModel.test.ts` (17),
  `src/domain/metering/funnel.test.ts` (13, extended with a local-spine block that
  pins step order and demonstrates the server spine collapsing the same counts to
  zero), `src/application/services/analyticsSecretConfig.test.ts` (8). Seven
  mutations were verified to fail these suites: remove the admin guard (5 failed);
  run the guard *after* the read, which still returns 401 while having already
  queried for an anonymous caller (3); return raw event rows (1); remove date
  bounding (2); expose `subjectHash` via a cast around `UsageDimension` (2);
  render the meter key as the React id (1); increment a counter during a read (4);
  swap `file_selected` and `tool_start` in the local spine (4, across two files).
  All files were restored to their exact bytes and SHA-256 verified.
  `scripts/usage-analytics-probe.mjs` is the production browser smoke test (44
  checks over CDP): the guard, the zero-data dashboard, a real Merge run on a
  synthetic in-page PDF, the funnel moving `[0,0,0,0,0]` → `[1,1,1,1,1]`, and the
  signed-in card's own subtree matching `/api/usage`.
- **Feature flags:** None new. `ANALYTICS_SUBJECT_SECRET` is now documented in
  `.env.example` and `SERVER_SETUP.md`; its fallback to `ADMIN_SECRET` is
  deliberate and preserved, as is its absence from the validated env schema, so a
  missing value degrades funnel stitching instead of refusing to boot.
- **Known limitations:** The funnel counts **event occurrences**, not distinct
  visitors — deduplicated per visit at the source by `trackOnce` rather than by a
  `COUNT(DISTINCT subjectHash)` — and both the type and the dashboard say so where
  the number is shown. (Two limitations recorded here are now closed: every local
  tool is instrumented, and local failures carry an `errorCategory` — see *Full
  local tool analytics coverage* and *Local failure taxonomy*. The uncategorized
  footnote remains, because a pre-taxonomy row is still uncategorized.) There is
  no time series (the report is one
  window's totals, not a daily curve), no CSV export, and the user card shows no
  storage figure. Neither surface is cached: every load re-aggregates.
- **Next related step:** Done — *Limit calibration and enforcement readiness*
  below turns this data into a machine-checked verdict on whether the ceilings in
  `src/domain/metering/plans.ts` can be enforced yet. As of 2026-08-25 the answer
  is no, for a stated reason.

---

## Local failure taxonomy (browser-side `errorCategory`)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Give a browser-local failure a stable, safe name, so failures can
  be counted by cause without the counting surface ever seeing a filename, a
  message, or a stack.
- **User-visible behavior:** Unchanged on screen — the user still reads the same
  deliberate sentence. What changed is that the same failure now also produces a
  `job_failed` event carrying one of six constants, and the admin failure list
  names causes instead of a single undifferentiated bucket.
- **Architecture:** Six categories (`invalid_input`, `unsupported_format`,
  `password_required`, `corrupt_document`, `processor_failed`, `internal_error`),
  declared as a **subset of the existing server `JobErrorCategory`** and pinned
  with `satisfies readonly JobErrorCategory[]`, so "a local category is also a
  server category" is a compile error to break rather than a comment. The message
  and the category travel together but separately: `PdfProcessingError(message,
  category)` takes the category as a **required** argument with no default, which
  makes an unclassified new throw site a `tsc` failure at the moment it is
  written. `localErrorCategoryOf(err: unknown)` reads *nothing* off the thrown
  value — not its message, name, or stack — so there is no path by which document
  content becomes an analytics property; a non-`PdfProcessingError` is
  `internal_error`, which is the only case where "we do not know" is true.
  `usePdfProcessor` exposes `{ message, errorCategory }` and the provider's
  failure hook is typed `LocalToolErrorCategory`, not `string`: a widened
  parameter is exactly how a raw message becomes a category.
- **Key files:** `src/domain/jobs/jobErrors.ts`
  (`LocalToolErrorCategory`, `ALL_LOCAL_TOOL_ERROR_CATEGORIES`,
  `isLocalToolErrorCategory`), `lib/pdf/types.ts` (`PdfProcessingError`,
  `localErrorCategoryOf`), the `lib/pdf/**` processors, `hooks/usePdfProcessor.ts`,
  `components/tools/ToolAnalyticsProvider.tsx`
- **Tests/probes:** `lib/pdf/localFailureTaxonomy.test.ts` (12 — every throw site
  classified, totality probed with a leaky non-tagged error),
  `src/domain/jobs/jobErrors.test.ts` (12). Mutations verified: widen the provider
  hook to `string`; return `String(err)` as the category; default the constructor
  argument. Each failed, and files were restored byte-exact (SHA-256).
- **Feature flags:** None.
- **Known limitations:** Categories are derived from throw sites, so a processor
  that fails *without* throwing a `PdfProcessingError` lands in `internal_error`
  by design. Rows recorded before this shipped stay uncategorized forever.
- **Next related step:** None outstanding. If a seventh category is ever needed,
  add it to the local union first — the `satisfies` will force the server side to
  agree.

## Full local tool analytics coverage (18 tools, two seams)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Close the measurement gap where Merge was instrumented by hand and
  seventeen other local tools were not. Nothing failed in that state; the
  dashboard simply described a smaller product than the one that shipped.
- **User-visible behavior:** Every local tool now reports the funnel `tool_view →
  file_selected → tool_start → job_succeeded | job_failed → download`. The admin
  Analytics page lists a funnel **per tool** with a selector, reports
  `funnelToolCount` when the table is truncated, and so compares local tools
  against each other rather than showing Merge alone.
- **Architecture:** Coverage comes from two shared seams instead of eighteen call
  sites: `ToolAnalyticsProvider`, mounted by `ToolPageTemplate` with
  `toolSlug={tool.slug}` and `executionModeForTool(tool)` (so a tool promoted from
  local to remote cannot keep reporting itself as local), and `usePdfProcessor`,
  which every local runner already uses to run work and which is therefore where
  the outcome is emitted. `fileCount` is a **required** hook option, so
  `file_selected` cannot be skipped by omission. `download` is emitted by
  `ResultActions`, after a real download, not on render. Dedup scope is per run,
  so a second run in the same visit reports again while one run cannot report
  twice. Analytics is fire-and-forget: an ingest failure or an adblocker cannot
  surface an error or interrupt a tool, and `usePdfProcessor` contains no
  `fetch`/`sendBeacon` at all, which is what keeps the printed privacy claim true.
- **Key files:** `components/tools/ToolPageTemplate.tsx`,
  `components/tools/ToolAnalyticsProvider.tsx`, `hooks/usePdfProcessor.ts`,
  `hooks/useAnalytics.ts`, `components/tools/ResultActions.tsx`,
  `src/application/services/UsageAnalyticsReadService.ts` (`funnels`,
  `funnelToolCount`), `components/admin/AnalyticsDashboard.tsx`
- **Tests/probes:** `lib/tools/localToolAnalyticsCoverage.test.ts` (13 — a
  structural audit over the runner directory and the local slug list, with
  comments stripped so prose cannot stand in for a wrapper),
  `hooks/clientAnalyticsWiring.test.ts` (22). Mutations verified: remove the
  provider from the template; drop a runner's `usePdfProcessor`; give a runner its
  own download button; render `errorCategory` to the user; send `error.message` to
  analytics. All failed; all restored byte-exact.
- **Feature flags:** None.
- **Known limitations:** The structural tests read source text, because vitest here
  is `environment: "node"` with no renderer — they prove a file routes through a
  seam, not that a rendered page emitted an event. The browser probe covers the
  rendered half.
- **Next related step:** None outstanding. A new local tool is covered the moment
  it gets a page and a runner; both audits fail loudly if it is added around the
  seams.

## Full server tool metering coverage (both submit paths)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Make authoritative usage a property of *submitting server work*
  rather than of the one tool that had been wired, without adding a second
  metering integration that could drift from the first.
- **User-visible behavior:** Every remote tool consumes exactly one heavy
  operation per submission. A batch of eight files is one operation, because it is
  one thing the user asked for. A submission refused by validation, or by a
  staging failure, costs nothing. `USAGE_LIMIT_MODE=observe` means the decision is
  recorded and never blocks.
- **Architecture:** There are only two places a server tool can be submitted from
  — `lib/server/toolJobSubmit.ts` (serving both the legacy synchronous
  `/api/tools/[slug]` and the async `/api/jobs`) and `lib/server/processingJobSubmit.ts`
  (the unified pipeline) — so those two functions are the whole seam, and both
  `authorize()` at the same point: **after** validation, so byte counts are real
  rather than a header's claim, and **before** staging, so a refused submission
  never costs a write to storage. The actor comes from the session cookie in the
  route, never from the body, so no client can charge another owner. Past
  admission the reservation is held and every exit either hands it to the worker
  through the job payload or gives it back via `release()`. Settlement belongs to
  the two worker handlers (`PdfToolWorkerHandler`, `ProcessingJobHandler`) through
  one method, `settleProcessingOutcome`, which keeps the two counter families
  distinct: `server_operations` per **customer operation**, `compute_units` per
  **attempt**. A retry therefore costs us more compute and the customer nothing.
- **Key files:** `lib/server/toolJobSubmit.ts`, `lib/server/processingJobSubmit.ts`,
  `src/application/services/UsageMeteringService.ts`,
  `src/infrastructure/jobs/PdfToolWorkerHandler.ts`,
  `src/infrastructure/jobs/ProcessingJobHandler.ts`, `src/domain/metering/cost.ts`
- **Tests/probes:** `lib/server/meteringSubmitWiring.test.ts` (11),
  `lib/tools/serverToolMeteringCoverage.test.ts` (18 — every remote slug has a
  processor and a cost profile, and both submit paths authorize before staging).
  Mutations verified: authorize after staging; take the owner from the request
  body; count a batch per file; settle per attempt instead of per operation. All
  failed; all restored byte-exact.
- **Feature flags:** `USAGE_LIMIT_MODE` (default `observe`).
- **Known limitations:** Metering is per submission, so a tool that internally
  fans out to several processes still reports one operation — correct for billing,
  coarse for capacity planning. `compute_units` is not published to the user API.
- **Next related step:** None outstanding for coverage. Enforcement is gated on
  *Limit calibration and enforcement readiness*.

## Durable usage settlement (exactly-once across workers and restarts)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Close the known limitation that duplicate-settlement protection was
  an in-process `Set`: two workers settling the same job each had their own, and a
  restart forgot every settlement it had ever made.
- **User-visible behavior:** A customer's usage changes exactly once per
  operation, whichever worker settles it and however many times the settlement is
  attempted. A double-settled job no longer double-charges, and a redelivered
  message after a restart no longer charges again.
- **Architecture:** A one-column table, `usage_settlements`, keyed by the job id.
  `claimSettlement(key, at)` is an insert that returns `false` on a unique-key
  collision — atomic in the database rather than in a process — and it runs
  **before** any counter mutation, so losing the race means doing nothing rather
  than undoing something. The asymmetry between the two meters is deliberate and
  asserted: the customer settlement is claimed, while attempt telemetry is not, so
  two attempts still both appear in `compute_units`. One is a bill, the other is a
  measurement of what the work cost us. A failure to reach the claim store is
  reported as `degraded` rather than treated as a successful claim.
- **Key files:** `src/application/services/UsageMeteringService.ts`
  (`settleProcessingOutcome`, `claimSettlement`),
  `src/application/ports/metering/UsageRepository.ts`,
  `src/infrastructure/persistence/PrismaUsageRepository.ts`,
  `src/infrastructure/persistence/InMemoryUsageRepository.ts`,
  `prisma/schema.prisma` (`model UsageSettlement`)
- **Tests/probes:** `src/application/services/durableSettlement.test.ts` (10 — two
  services over one repository is two workers over one database; a fresh service
  over a pre-marked repository is a restart). Mutations verified: claim after
  mutating counters; treat a claim-store error as claimed; claim the attempt
  telemetry too (which correctly *lost* an attempt). All failed; all restored
  byte-exact. Browser-verified via the retry walk described below.
- **Feature flags:** None.
- **Known limitations:** Markers are keyed by job id, so the legacy synchronous
  route — which has no job id — relies on its single-shot request instead. Old
  markers are indexed by `claimedAt` but not yet pruned by the cleanup job.
- **Next related step:** Add `usage_settlements` to the retention sweep when the
  table's growth becomes visible.

## Limit calibration and enforcement readiness

- **Status:** Complete — and the verdict it computes is **not ready**, on purpose.
- **Date:** 2026-08-25
- **Purpose:** Replace "the numbers look about right, flip it to enforce" with a
  verdict a reader can check. A ceiling calibrated from a week of pre-launch
  traffic is calibrated against almost nobody, and the first thing it does at
  scale is refuse work from the users who matter most.
- **User-visible behavior:** Nothing for end users — `USAGE_LIMIT_MODE` stays
  `observe` by default. The admin Analytics page gains a **Limits & enforcement
  readiness** panel: the mode the deployment is actually running in, a
  ready/not-ready verdict, and when not ready, the named gaps
  (`observed N of 14 required days`, `of 500 required operations`, `of 3 required
  tools`).
- **Architecture:** The judgement is pure and lives in
  `src/domain/metering/readiness.ts` with declared thresholds
  (`MIN_OBSERVATION_DAYS = 14`, `MIN_OBSERVED_OPERATIONS = 500`,
  `MIN_OBSERVED_TOOLS = 3`); the observation is assembled from the ledger by
  `UsageAnalyticsReadService.calibration(window)`. The two are separate fields in
  the payload because one is measurement and one is a judgement over it.
  `LimitRecommendation` is a **discriminated union with an `insufficient_data` arm
  carrying no number at all**, so there is no field a caller could read and
  mistake for a calibrated figure — the alternative shape, a number plus
  `confidence: "low"`, is the one that ships anyway when someone is in a hurry. A
  recommendation, when data does justify one, is `ceil(basisPerDay × 10)`
  (`RECOMMENDATION_HEADROOM_FACTOR`) and says so. `operationsPerDay` is named and
  typed as a **mean**, because the ledger is aggregated by tool and dimension, not
  by day, and a p95 fabricated from a mean is exactly the invented number this
  module exists to refuse. The admin route resolves the report and the calibration
  over the **same** bounded window in one request, so a readiness verdict can
  never be read beside totals from a different range.
- **Key files:** `src/domain/metering/readiness.ts`,
  `src/application/services/UsageAnalyticsReadService.ts` (`calibration`),
  `app/api/admin/analytics/route.ts`, `components/admin/AnalyticsDashboard.tsx`,
  `src/domain/metering/plans.ts` (unchanged — no ceiling was guessed)
- **Tests/probes:** `src/domain/metering/readiness.test.ts` (22 — the verdict as
  arithmetic), `src/application/services/usageCalibration.test.ts` (18 — the
  observation as assembled from the real repository, including a degraded query
  that must not silently shrink the basis a limit would be picked from).
  Mutations verified: return `ready_for_enforcement: true` when thresholds are
  unmet; emit a recommended number in the `insufficient_data` arm; default the
  mode to `enforce`; let a failed query narrow the observation silently. All
  failed; all restored byte-exact.
- **Feature flags:** `USAGE_LIMIT_MODE` — default `observe`, unchanged and
  asserted.
- **Known limitations:** Per-day distribution is unavailable from the current
  aggregation, so no percentile is offered (deliberately). Readiness is global,
  not per plan or per meter. **The current verdict on this deployment is
  `ready_for_enforcement: false`, `reason: "insufficient_observation_data"` — the
  correct answer for a product with no production traffic yet.**
- **Next related step:** Re-read the panel after real traffic accumulates. Only
  when it reports ready should `USAGE_LIMIT_MODE` move to `enforce`, behind a
  guarded rollout.

## Usage, limits and analytics milestone — completion and coverage audit

- **Status:** Complete. This closes the milestone.
- **Date:** 2026-08-25
- **Purpose:** Answer the one question no seam test can answer — *is there a tool
  nobody is measuring?* A tool added outside every seam is absent from every list
  those tests scan, and absence is precisely what none of them can see.
- **User-visible behavior:** None; this is an operator/CI capability.
- **Architecture:** `lib/tools/measurementCoverage.ts` walks the **authoritative
  registry** (`data/tools.ts` — the same table the pages, the job allowlist and
  the cost model derive from) and emits one row per tool with three verdicts:
  `analyticsCoverage`, `authoritativeMeteringCoverage`, `failureTaxonomyCoverage`.
  A new tool therefore appears the moment it is registered, with whatever coverage
  it actually has, which is what makes the audit fail *for* the new tool instead
  of omitting it. Rows are emitted for non-executable tools too (`planned`,
  `coming-soon-ai`), because a tool that vanished from the audit on becoming
  planned would vanish again on the day it ships. Two verdicts are deliberately
  inverted from the naive reading: a **local** tool with a server processor is
  `missing`, not extra-covered — that is a browser-only privacy claim with a
  server path behind it — and taxonomy coverage is *probed* by passing a
  deliberately untagged error carrying a filename, so "returns a category" is
  distinguished from "returns whatever it was given". `measurementCoverageGaps()`
  returning `[]` is the invariant, in the same shape as `costProfileGaps`. The
  module reads the filesystem and imports server registries, so it is build/test
  tooling and no request path calls it.
- **Current audit result:** 45 registered tools — **18 local**, **14 remote**,
  13 not yet executable. **Zero gaps.**
- **Key files:** `lib/tools/measurementCoverage.ts`,
  `lib/tools/measurementCoverage.test.ts`
- **Tests/probes:** `lib/tools/measurementCoverage.test.ts` (13). Whole suite at
  close of milestone: **292 files / 5999 tests / 0 failed**; typecheck clean; lint
  0 errors / 8 pre-existing warnings; production build clean; export fidelity
  32/32. Production browser probes, all against a real built server over CDP:
  `scripts/usage-analytics-probe.mjs` **83/83** (Ghostscript present,
  `PROCESSING_PIPELINE=on`: three local tools run open → select → process →
  download with the funnel advancing and remote quota untouched; a corrupt-PDF
  walk producing `job_failed` with a normalized category and no internal string in
  the UI; `compress-pdf` on the pipeline and legacy `repair-pdf` each charging
  exactly one operation; the usage card matching `/api/usage`) and **91/91** with
  `--retry-walk` on a Ghostscript-less host (3 attempts, `dependency_unavailable`,
  one charge reserved and refunded exactly once, attempt ledger showing
  `total=6 costUnits=18` — retry visible in compute, invisible in the bill);
  `scripts/processing-pilot-probe.mjs` **41/41**;
  `scripts/legacy-job-ownership-probe.mjs` **25/25** (needs
  `PROCESSING_PIPELINE=off`); `scripts/editor-persistence-probe.mjs` all checks
  passed.
- **Feature flags:** None new. Defaults unchanged: `USAGE_LIMIT_MODE=observe`,
  `isProcessingPipelineEnabled` off except for the pilot slug.
- **Known limitations:** The audit proves a tool is *wired to* a measurement seam,
  not that a given production request was measured — that is what the probes are
  for. `remote_sync` is currently an empty class (every remote tool is a job), so
  that branch is exercised only by unit tests. The retry walk needs a host without
  Ghostscript and is therefore a flagged run, not part of the default probe pass.
- **Next related step:** Done for the subscription half — see *Billing
  subscription foundation*, *Pro checkout*, *Stripe webhook as the entitlement
  source of truth* and *Billing portal* below. Still outstanding, in order: the
  pricing/upgrade UI, then `USAGE_LIMIT_MODE=enforce` behind the readiness
  verdict (still `insufficient_observation_data`), then launch readiness, then
  OCR/document ingestion, then Dadi AI.

---

## Test collection scope excludes hand-made tree snapshots

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Stop a snapshot of an older tree from failing the current suite.
  This repo is not Git-backed, so a slice that rewrites a subsystem keeps a
  timestamped copy (`.billing-backup-20260825-163010/`, pointed to by
  `.billing-backup-latest`). Vitest's `include: ["**/*.test.ts"]` collected the
  stale `*.test.ts` files inside it, so **yesterday's assertions ran against
  today's source** — 4 files / 2 tests failing, every one of them a snapshot
  disagreeing with a deliberate later change, and none of them a real defect.
- **User-visible behavior:** None. CI/dev only.
- **Architecture:** One entry added to `exclude` in `vitest.config.ts`:
  `".billing-backup-*/**"`. The glob is deliberately a pattern rather than the
  one dated directory name — the next backup will carry a different timestamp,
  and a literal path would silently stop matching. Backups are not deleted:
  without version control they are the only way back, so the fix scopes
  *collection*, not the files.
- **Key files:** `vitest.config.ts`
- **Tests/probes:** The suite itself is the check — 301 files / 6155 tests / 0
  failed after the change, against 4 files / 2 tests failing before it. Verified
  the exclusion is load-bearing and not merely cosmetic: no `src/` or `lib/`
  test is dropped by it (301 collected files, all outside the backup).
- **Feature flags:** None.
- **Known limitations:** A future backup taken under a differently-named prefix
  would need its own exclude entry. The pattern covers `.billing-backup-*` only.
- **Next related step:** None. If backups become routine, standardize one prefix
  (e.g. `.snapshot-*`) and exclude that instead.

---

## Billing subscription foundation (Stripe, Pro only)

- **Status:** Complete for Pro. Business billing deliberately deferred.
- **Date:** 2026-08-25
- **Purpose:** Give the product one place where paid entitlement changes, before
  any pricing UI exists to pressure it. Every other arrangement ends with two
  answers to "is this org Pro?" — one on the redirect path and one on the webhook
  path — and the redirect one is the one an attacker controls.
- **User-visible behavior:** None yet by itself; no purchase UI ships in this
  slice. An organization's plan can now come from a real subscription, and a
  cancelled one loses Pro allowances at the next request.
- **Architecture:** Pure domain in `src/domain/billing/subscription.ts` —
  `entitledPlanFor` is the only entitlement answer, and it returns `free` three
  ways: a non-entitling status, a non-paid stored plan, or a `currentPeriodEnd`
  that has passed. That last one makes a **missed webhook downgrade rather than
  extend**, so a lost `subscription.deleted` costs a resync, not an unpaid Pro
  account. `past_due` deliberately does not entitle (no grace period; the
  upgrade path is a `graceUntil` column, not a wider status list).
  `BillingService` holds the flow, `IBillingProvider` the port,
  `StripeBillingProvider` the adapter (form-encoded `fetch`, pinned
  `Stripe-Version: 2025-04-30.basil`, no `stripe` SDK dependency),
  `PrismaBillingRepository` the persistence. **Pro is the only purchasable plan:**
  `PURCHASABLE_PLAN_IDS = ["pro"]` and `BillingPriceMap` has a single `pro` slot,
  so there is nowhere to configure a Business price and `planForPriceId` cannot
  return `"business"` for any price id — configured, unknown or forged. Business
  stays in `PlanId`, `PLAN_ENTITLEMENTS` and `isPaidPlan`, because an
  operator-set Business org must keep working; only *purchasability* is withheld.
- **Key files:** `src/domain/billing/subscription.ts`,
  `src/application/services/BillingService.ts`,
  `src/application/ports/billing/{BillingProvider,BillingRepository}.ts`,
  `src/infrastructure/billing/{StripeBillingProvider,stripeSignature}.ts`,
  `src/infrastructure/persistence/PrismaBillingRepository.ts`,
  `prisma/migrations/20260825120000_add_billing_subscriptions/`,
  `src/infrastructure/config/env.ts` (`BillingConfig`), `src/application/di/`
- **Tests/probes:** 9 billing test files / 157 tests. `npx vitest run` overall:
  301 files / 6156 tests / 0 failed. Runtime: `node scripts/billing-probe.mjs`
  (47 checks, production build, real HTTP + Prisma).
- **Feature flags:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_PRO`. `billing.enabled` is **derived**, never set: all three must
  be present. A key without a webhook secret would take money it could never
  confirm; a key without a price has nothing to sell. There is no
  `STRIPE_PRICE_BUSINESS` — the price map has no slot to put it in.
- **Known limitations:** Business billing (seats, per-seat pricing, org
  invoicing) is not built. No invoices, history, coupons or taxes. **Usage limits
  are untouched: `USAGE_LIMIT_MODE` stays `observe` and no ceiling changed.**
- **Next related step:** The pricing/upgrade UI, which is the first thing that
  will want a "confirm my checkout" endpoint. There must not be one — see the
  Pro checkout entry.

## Pro checkout (server-resolved price, grants nothing)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Sell Pro without letting the browser name anything that costs
  money or grants anything.
- **User-visible behavior:** `POST /api/billing/checkout` with `{ plan: "pro" }`
  returns `{ url }`, a Stripe-hosted checkout page. `"business"` gets one 400,
  before any Stripe call, exactly like `"enterprise"` would.
- **Architecture:** The body may contain a plan **name** and an optional
  `organizationId`, and nothing else is read. The price comes from server config
  via `priceIdForPlan`; success and cancel URLs are built from the configured
  origin plus fixed paths, so there is no redirect to poison; the customer is the
  stored one, created only if absent. `organizationId` is a **filter, not an
  assertion** — it can only `find` within the caller's own memberships, so a
  guessed id is inert, and `billing:manage` (owner-only, already in
  `ROLE_PERMISSIONS`) is then required on the resolved org. Authorization is
  checked **before** the price is resolved, so an unauthorized caller learns
  nothing about what a deployment sells. **Creating a session writes no plan and
  no status**, and `BillingService.prototype` has no `confirm`/`success`/`grant`
  method for one to be added to quietly — `?checkout=success` is a page render
  with no API behind it.
- **Key files:** `app/api/billing/checkout/route.ts`,
  `src/application/services/BillingService.ts` (`startCheckout`),
  `src/application/services/billingHttp.ts`
- **Tests/probes:** `app/api/billing/billingRoutes.test.ts`,
  `src/application/services/BillingService.test.ts` (sections 4–5). Runtime probe
  §2–4: anonymous → 401, cross-origin → 403, Business → 400, forged
  `priceId`/`amount`/`successUrl`/`customerId`/`userId` → 400 with no echo,
  `/pricing?checkout=success` → still `free`. Mutations verified: route accepts
  any plan string; service uses a client-supplied price when it looks like one;
  `startCheckout` writes an active Pro row. All three failed the focused tests;
  all restored byte-exact (SHA-256 verified).
- **Feature flags:** As above; unconfigured → 503, never an invented price.
- **Known limitations:** No UI, no plan-change/proration path, no seat picker.
  Rate limited per client IP at 6/min, in-process. That is the whole limit,
  because `DEPLOYMENT_TOPOLOGY=single-instance` is required in production and a
  second process against the same database is now refused by the instance lease
  before it serves anything — there is no second process to multiply it by.
  (This sentence read "enforced at boot" when the boot gate only checked that the
  variable was TYPED; two processes both booted and both served. What makes it true
  is `src/infrastructure/config/instanceLease.ts`, measured 8/8 in
  `docs/evidence/final-prelaunch/ingress/RESULTS.md`.) Scaling out
  needs a shared limiter store and PostgreSQL first; see
  `docs/adr/ADR-M7-009-sqlite-operations.md`.
- **Next related step:** Pricing UI calls this endpoint and reads `url` only. If
  a future session wants faster feedback after the redirect, poll
  `/api/usage` — do **not** add an endpoint that trusts the redirect.

## Stripe webhook as the entitlement source of truth

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** One signed, ordered, idempotent path for plan changes. Everything
  else in the app reads entitlement; only this writes it.
- **User-visible behavior:** Paying makes the org Pro within a webhook delivery;
  cancelling or lapsing removes it. Nothing a user can click changes a plan.
- **Architecture:** Order of operations *is* the security design.
  1. **Verify the signature on the raw bytes** — `verifyStripeSignature` runs
     before `JSON.parse`, so an unsigned body is never parsed at all. HMAC-SHA256
     over `${t}.${rawBody}`, 300s **absolute** tolerance (a future-dated
     signature never expires otherwise), length-checked constant-time compare.
     The route reads `req.text()` and hands the bytes over unparsed.
  2. **Ignore untargeted event types** before claiming, so the idempotency table
     holds only events that were acted on.
  3. **Claim the event id durably** — a unique insert on `BillingEvent.id`.
     Insert-wins, so a redelivery stops here having done nothing. `claimEvent`
     answers "duplicate" **only** for `P2002`; every other Prisma or network
     failure propagates and the route returns a retryable 500. A catch-all
     `return false` would turn a database outage into "already delivered" and
     silently drop the delivery that mattered. The claim is released if applying
     throws, so a transient fault does not permanently skip the event.
  4. **Resolve the organization from the stored customer/subscription id** —
     values *we* wrote. `metadata.organizationId` is a **cross-check only**: a
     mismatch is refused (`ownership_mismatch`), never resolved in metadata's
     favour, and an unknown customer is refused rather than reconciled (no row is
     minted for a tenant that never opened checkout).
  5. **Drop strictly older events** by their own `created` timestamp, then write.
     Equal seconds are accepted — duplicates are already stopped by (3), which is
     a stronger guard than a timestamp.
  An **unmapped price stores `free`** and logs the price id: the subscription is
  real and worth recording, but a price this deployment cannot map must not grant
  a paid plan. `subscription.deleted` is authoritative regardless of the status on
  the object. HTTP contract: 400 invalid signature; 200 for
  duplicate/stale/ignored/unknown-customer/no-subscription (so Stripe stops
  retrying what will never change); 500 unexpected (retry); 503 unconfigured; 413
  oversize. The endpoint is **not** rate limited — Stripe bursts on retry.
- **Key files:** `app/api/billing/webhook/route.ts`,
  `src/application/services/BillingService.ts` (`handleWebhook`, `applyEvent`,
  `resolveOwner`), `src/infrastructure/billing/stripeSignature.ts`,
  `src/infrastructure/billing/StripeBillingProvider.ts` (`parseWebhook`),
  `src/infrastructure/persistence/PrismaBillingRepository.ts` (`claimEvent`)
- **Tests/probes:** `stripeSignature.test.ts` (12),
  `BillingService.test.ts` (webhook sections + spoofing),
  `PrismaBillingRepository.test.ts` (claim/release), and runtime probe §5–11 with
  synthetic **signed** deliveries through the real parser, service and
  repository. Mutations verified: accept every signature; ignore the duplicate
  claim; `claimEvent` catch-all `return false`; unknown price → `pro`; stale event
  overwrites newer state; resolve ownership from metadata. All failed; all
  restored byte-exact. The metadata one **survived at first** — see limitations.
- **Feature flags:** `STRIPE_WEBHOOK_SECRET`; absent → 503, never "accept all".
- **Known limitations:** **Live Stripe E2E has not been run** — no test
  credentials in this environment. Synthetic signed deliveries exercise the real
  verification, service and persistence path, but they are not proof that a real
  Stripe account is wired to this endpoint; that is a launch step. The mutation
  that made webhook metadata the ownership authority initially passed every test:
  both spoofing fixtures named an organization with *no* billing row, so a
  metadata-first resolver found nothing and fell through by accident.
  `BillingService.test.ts` now has the cross-tenant case (both orgs have rows) and
  the probe has §16; the mutation now fails both. Retention: `BillingEvent` rows
  are never pruned.
- **Next related step:** `scripts/stripe-testmode-probe.mjs` now exists to do
  exactly this and reports ENVIRONMENT-LIMITED until credentials and the Stripe
  CLI are present — see *Stripe test-mode verification* below. Add `BillingEvent`
  to the retention sweep when one exists.

## Billing portal (stored customer only)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Let an owner manage their own card and cancellation without the
  product having to build any of it — and without a request being able to name
  whose billing account is opened.
- **User-visible behavior:** `POST /api/billing/portal` returns `{ url }` for the
  caller's own organization. An org with no billing account gets 409
  `NO_BILLING_CUSTOMER`, not a portal for whatever id was sent.
- **Architecture:** Same owner-only `billing:manage` check and same
  filter-not-assertion `organizationId` as checkout. The customer id is read from
  our row; **the method has no parameter for one**, so a `customerId` in the body
  is unreachable code away from mattering. The return URL is the configured
  origin plus a fixed `/pricing` path.
- **Key files:** `app/api/billing/portal/route.ts`,
  `src/application/services/BillingService.ts` (`createPortalSession`)
- **Tests/probes:** `billingRoutes.test.ts` ("never forwards a client-supplied
  customer id"), `BillingService.test.ts` (portal section). Runtime probe §12: an
  org with no stored customer sending `{"customerId":"cus_probe_org1"}` gets 409
  and no echo; an owner sending a forged id gets a provider failure with no URL,
  proving the sent value never became a portal session.
- **Feature flags:** As above.
- **Known limitations:** A successful portal URL needs a live Stripe call, so
  that one assertion is **ENVIRONMENT-LIMITED / not run**; every refusal is
  verified. No in-product cancellation UI — the portal is the cancellation UI.
- **Next related step:** Done — see *Billing management UI (the manage state)*
  below. Remaining: a real portal session against Stripe test mode, which
  `scripts/stripe-testmode-probe.mjs` §5 performs when credentials exist.

## Pro pricing and upgrade UX

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Give the Pro plan a control that can actually take money, without
  the marketing page ever making a claim the deployment cannot honour.
- **User-visible behavior:** The `/pricing` Pro card and the workspace usage card
  both render one control whose state comes from `/api/billing/summary`:
  *Upgrade to Pro* (owner, free), *Manage billing* (paid), *Current plan*, *Only
  an owner can manage billing*, or *Sign in* — and on a deployment with no Stripe
  configuration, the approved server-rendered copy, unchanged. The pricing card's
  "Coming later" badge and price both swap to live values only once a summary
  proves Pro is purchasable, so an unconfigured deployment is byte-identical to
  before this slice. **Business stays non-purchasable** and keeps its
  *Contact us* CTA.
- **Architecture:** `data/pricing.ts` copy is the fallback, not the primary: the
  Pro card renders `plan.cta` / `plan.price` as `children` until a summary
  arrives. **The display price is provider-derived or absent.** `formatPlanPrice`
  / `formatPlanPeriod` return `null` on any uncertainty (unreadable price, missing
  amount, unknown currency, non-recurring), the minor-unit divisor comes from
  `Intl` rather than a hand-kept currency table, and the locale is pinned
  `en-US` so the server and the client format identically. There is no amount
  literal anywhere in the billing UI — `ProPriceLabel` contains no digit at all —
  so a fabricated price is not a bug that can be introduced by editing a default.
  Every live control sits inside the `plan.id === "pro"` branch of the plan loop.
- **Key files:** `src/domain/billing/proOffer.ts` (`proOffer`, `offerPosts`,
  `formatPlanPrice`, `formatPlanPeriod`), `components/billing/ProUpgradeAction.tsx`
  (`ProUpgradeAction`, `ProConfigured`, `ProPriceLabel`),
  `components/billing/proSummaryClient.ts`, `app/(marketing)/pricing/page.tsx`,
  `components/app/UsageCard.tsx`, `data/pricing.ts` (copy unchanged)
- **Tests/probes:** `proOffer.test.ts` (25), `upgradeSurfaces.test.ts` (21),
  `proSummaryClient.test.ts` (29) — 216 billing tests across 9 files in total.
  `upgradeSurfaces.test.ts` asserts the `.tsx`-only properties vitest cannot
  render under `environment: "node"`: no currency amount in any surface, no digit
  in the price label, no `fetch` outside the shared client, every live control
  inside the Pro branch. Runtime probe §18 (free owner is offered checkout only
  where the deployment can sell Pro; a billing-absent server reports
  `configured:false`, `action:unavailable`, `priceLabel:null` and 503s the POST)
  and §19 (a non-owner **admin** — every privileged permission except
  `billing:manage` — is told `owner_only` and gets 403). Mutations verified:
  a live Pro control moved out of the Pro branch onto every card (so Business
  gets a checkout button); the browser sending a `priceId`; the checkout route
  forwarding a browser `priceId` to the service. All three failed; all restored
  byte-exact and re-verified by SHA-256.
- **Feature flags:** `STRIPE_SECRET_KEY` + `STRIPE_PRICE_PRO`. Absent → the
  summary reports `configured:false` and the page is unchanged.
  `USAGE_LIMIT_MODE` **remains `observe`** — this slice sells a plan, it does not
  start enforcing one.
- **Known limitations:** The positive display-price branch (a real configured
  Stripe amount rendered on the card) is **ENVIRONMENT-LIMITED** in the synthetic
  probe: reading it needs a live provider call. `scripts/stripe-testmode-probe.mjs`
  §2 asserts it against the real price when credentials exist. Business billing is
  deferred, so the Business card is copy only.
- **Next related step:** Nothing in this slice. When Business billing is built,
  the second purchasable plan is a `PURCHASABLE_PLAN_IDS` entry plus a price
  mapping — the control already handles more than one.

## Billing summary API (`GET /api/billing/summary`)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** One trusted, per-caller answer to "what plan is this, and what may
  this caller do about it" — so no browser has to work it out.
- **User-visible behavior:** `{ configured, signedIn, plan, priceLabel,
  pricePeriod, action, actionLabel, note }` and nothing else. Anonymous callers
  get `signedIn:false`, the guest plan, and a *Sign in* action when Pro is
  configured. `Cache-Control: private, no-store`.
- **Architecture:** **Plan state is trusted server state**, read from the
  organization's own `BillingSubscription` row — never from a query parameter, a
  cookie, a redirect or a request body. `organizationId` is a **filter, not an
  assertion**: it selects from `listForUser`, so naming another tenant's
  organization returns the caller's own default rather than that tenant's state.
  The response carries **no provider ids, no owner ids, no price ids and no
  secrets** — the price is already formatted, or `null`. `proDisplayPrice()` is
  memoized (`PRICE_CACHE_MS`) so a page view is one provider read at most, and the
  client caches in-flight summaries per organization so three controls on one page
  make one request. A failed price read degrades to `priceLabel:null` and leaves
  the rest of the summary structurally valid and truthful.
- **Key files:** `app/api/billing/summary/route.ts`,
  `src/application/services/BillingService.ts` (`proSummary`, `proDisplayPrice`,
  `resolveBillingContext`), `src/domain/billing/proOffer.ts`,
  `components/billing/proSummaryClient.ts` (`parseProSummary`)
- **Tests/probes:** `summaryRoute.test.ts` (13), `BillingService.test.ts` (57),
  `proSummaryClient.test.ts` (29). `parseProSummary` is **total** — a truncated
  body, an HTML proxy error page, a boolean arriving as `"false"`, or an unknown
  action all produce `null` and the approved copy, never a partially assembled
  offer. Runtime probe §17 proves the anonymous response names nothing: the exact
  key set, and none of nine known fixture secrets (customer ids, subscription id,
  price ids, API key, webhook secret, organization id, user id) present anywhere in
  it. Probe §21 proves a foreign organization selector gains no plan, no action and
  no identifier, and 403s both POSTs — run *after* a real Pro grant exists, so
  there is genuine state to leak.
- **Feature flags:** As above.
- **Known limitations:** Cross-organization switching in the UI reads the
  server-rendered `organizationId`; there is no organization picker on `/pricing`.
- **Next related step:** None. Add fields only when a surface needs them — every
  field here is one a client could start trusting.

## Checkout return and activation UX

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Cover the seconds between paying at Stripe and the webhook landing,
  without ever letting the redirect itself become the entitlement.
- **User-visible behavior:** Returning to `/pricing?checkout=success` shows
  *"Finishing your upgrade — this can take a few seconds."* while the client
  re-reads the server, then whatever the server actually says. `?checkout=` is
  dropped from the URL via `history.replaceState`, so a reload does not replay the
  wait. A cancelled checkout returns to `?checkout=cancelled` and does nothing at
  all.
- **Architecture:** **`?checkout=success` is not entitlement proof and grants
  nothing.** The success path calls `refreshProSummary` — it re-reads the server
  rather than concluding anything. **Activation polling is bounded**:
  `ACTIVATION_TRIES = 6` at `ACTIVATION_DELAY_MS = 2_000` in a `for` loop, never a
  `while`, so the worst case is ~12s and there is no infinite loop to enter. A
  delayed webhook leaves the honest state: after the last try the card shows the
  server's current answer, which is still *Upgrade to Pro*, and the subscription
  lands when Stripe retries. `awaitingEntitlement(null)` is `true` — an unreadable
  summary is not treated as success. **There is deliberately no confirm/activate/
  sync endpoint**; `app/api/billing/` holds exactly `checkout`, `portal`,
  `summary`, `webhook`, asserted by enumeration so a fifth route fails on the day
  it is added.
- **Key files:** `components/billing/ProUpgradeAction.tsx`
  (`useProSummary`, `returnedFromCheckout`, `clearCheckoutParam`),
  `components/billing/proSummaryClient.ts` (`refreshProSummary`,
  `awaitingEntitlement`), `src/application/services/BillingService.ts`
  (fixed `successUrl` / `cancelUrl`)
- **Tests/probes:** `upgradeSurfaces.test.ts` sections 3 and 7,
  `proSummaryClient.test.ts` (`awaitingEntitlement`). Asserted properties:
  `setSummary` only ever holds the value of a load/refresh call (an object literal
  there would be a client-decided entitlement); the component names no `"pro"`
  literal and no `plan:` of its own; `ACTIVATION_TRIES ≤ 10` and no `while`; the
  query is compared to exactly `"success"`. Runtime probe §22 proves the whole
  claim end to end: a fresh owner's summary is `free`/`checkout` **before and
  after** visiting `/pricing?checkout=success`, `/api/usage` still reports free,
  no `BillingSubscription` row was created, and the returned page names no
  confirm/activate/sync/grant path. Mutations verified: an optimistic Pro summary
  written on the success path; the activation wait triggered by anything that is
  not `"cancelled"`. Both failed; both restored byte-exact.
- **Feature flags:** As above.
- **Known limitations:** A **real paid** checkout completing end to end needs a
  browser and a test card and is **ENVIRONMENT-LIMITED / not run** — do it by hand
  once before launch. The bound is a fixed 6×2s rather than backoff; if webhook
  latency is ever measured above ~12s this is the knob.
- **Next related step:** None. If the wait proves too short in practice, raise
  `ACTIVATION_TRIES` — the shape does not need changing.

## Billing management UI (the manage state)

- **Status:** Complete
- **Date:** 2026-08-25
- **Purpose:** Let a paying owner reach their card, invoices and cancellation from
  the product, without the product building any of that.
- **User-visible behavior:** A paid owner sees *Manage billing* on the same
  control, which POSTs `/api/billing/portal` and navigates to the Stripe-hosted
  portal. A paid **non-owner** sees *Current plan* as a sentence, not a greyed-out
  button — a disabled control is how a member concludes the purchase is one click
  from working. There is no bespoke billing management page; Stripe's portal is
  the management UI, and it is also the cancellation UI.
- **Architecture:** **The portal uses the customer identity stored server-side.**
  `createPortalSession` has no `customerId` parameter at all — the id is read from
  the caller's own organization row — and the browser POSTs `{}` or
  `{ organizationId }` and nothing else. The return URL is the configured origin
  plus a fixed path. `billing:manage` is owner-only: an `admin` carries every
  other privileged permission and still cannot open it. A failed POST becomes a
  sentence chosen from **our own** error code, never from provider text, so a
  provider message that ever did leak upstream still cannot become UI copy.
- **Key files:** `app/api/billing/portal/route.ts`,
  `src/application/services/BillingService.ts` (`createPortalSession`),
  `components/billing/proSummaryClient.ts` (`startBillingSession`,
  `SESSION_ERRORS`), `components/billing/ProUpgradeAction.tsx`
- **Tests/probes:** `billingRoutes.test.ts` (28) asserts the **whole** argument
  object reaching the service is `["ip","organizationId","userId"]`, so any future
  field silently arriving from a body fails there. `proSummaryClient.test.ts`
  asserts no request body ever matches
  `/price|amount|currency|customer|successUrl|returnUrl|coupon|trial/i`. Runtime
  probe §12 and §20. Mutation verified: the portal route forwarding
  `body.customerId ?? body.customer` and `body.returnUrl` to the service — failed;
  restored byte-exact.
- **Feature flags:** As above.
- **Known limitations:** A **successful** portal URL needs a live Stripe call, so
  that assertion is **ENVIRONMENT-LIMITED** in the synthetic probe; every refusal
  is verified. `scripts/stripe-testmode-probe.mjs` §5 creates a real one when
  credentials exist, and reports the common "portal not configured in the test
  dashboard" case as a limitation rather than a failure.
- **Next related step:** None.

## Stripe test-mode verification (`scripts/stripe-testmode-probe.mjs`)

- **Status:** Complete (the probe). **Stripe test mode itself: ENVIRONMENT-LIMITED
  / NOT VERIFIED** — re-attempted for real on 2026-08-26 and still blocked on
  credentials, not on code.
- **Date:** 2026-08-25; real-execution attempt and secret-hygiene fix 2026-08-26
- **Purpose:** Separate, in code and in output, "our billing code is correct" from
  "a real Stripe account is wired to this deployment" — the second of which no
  synthetic probe can ever establish.
- **User-visible behavior:** None; a maintained probe.
- **Architecture:** `billing-probe.mjs` signs its own webhook deliveries and never
  opens a socket to Stripe; every credential it uses is a well-formed fake. This
  probe is the other half and the only one that may use the word Stripe about a
  live integration. **It never touches live mode** — two independent gates: an
  `sk_live_`/`rk_live_` prefix is refused before any request is made (exit 2), and
  every object retrieved must come back `livemode:false` or the run stops. **It
  never prints a secret** — presence, prefix class and length only, and the
  server's log tail is scrubbed before it reaches the console. It runs against its
  own throwaway SQLite database and its own `next start`, so no developer data and
  no `.env` value is touched, and it deletes the test customer it created.
  With credentials it verifies: the configured price exists / is active / is
  recurring / is test mode; PDFDadi's **own** endpoint creates a real TEST checkout
  session; then it asks **Stripe** what that endpoint created — subscription mode,
  the configured Pro price as the only line item, `client_reference_id` and
  `metadata.organizationId` both matching, the customer matching the one stored
  server-side, the success and cancel URLs equal to the exact fixed strings, and
  the session still unpaid; that the summary then shows the **real** amount rather
  than the fallback; a real portal session; and webhook delivery via the Stripe
  CLI, asserting that an event naming a customer this deployment never stored
  grants nothing.

### What the 2026-08-26 real-execution attempt established

Credentials were classified by presence and prefix class only; no value was
printed. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_PRO` are
**all absent** from both the process environment and `.env` (which carries only
`ADMIN_SECRET`, `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`); the Stripe CLI is **not
installed**, and no equivalent webhook tunnel (`ngrok`, `cloudflared`,
`localtunnel`) is on `PATH` either, so webhook ingress has no route in. A second
credentialed re-run on 2026-08-26 reached the identical gate result: absent on all
three variables, in both the process environment and `.env`, with no CLI and no
tunnel. `api.stripe.com` *is* reachable from here (an unauthenticated probe
request returns 401), so the blocker is credentials alone, not the network.

The probe's own refusal machinery was therefore exercised directly, with fake
values, and behaves as documented:

| Input | Result | Reached the network? |
| --- | --- | --- |
| `sk_live_…` + a price | `REFUSED: … is a LIVE key`, exit **2** | no |
| `rk_live_…` + a price | `REFUSED: … is a LIVE key`, exit **2** | no |
| `pk_test_…` (unrecognized class) | `REFUSED: … neither sk_test_/rk_test_ nor sk_live_/rk_live_`, exit **2** | no |
| `sk_test_…`, no price | `ENVIRONMENT-LIMITED / NOT RUN`, exit **0** | no |
| nothing set | `ENVIRONMENT-LIMITED / NOT RUN`, exit **0** | no |

**The live-mode gate is not fixture-inert.** The same fixture as the `sk_live_`
row, changed only in its prefix to `sk_test_`, *does* reach §1 and *does* open a
real HTTPS request to `api.stripe.com` (Stripe answers 401). So the only thing
stopping the live-key run from transmitting is the guard itself, which is the
property that matters and the one a passing-by-not-arriving test would fake.

### Integration defect found by real execution, and fixed

That `sk_test_` run printed Stripe's own 401 body to the console:

```text
FAIL STRIPE_PRICE_PRO resolves to a price object — status 401 —
     Invalid API Key provided: sk_test_***********0000
```

Stripe echoes the offending credential back **already partly masked**, and that
string never equals the configured value, so `scrub()`'s exact-match loop over
`secrets` could not see it — while five call sites interpolate
`error.message` / `.text` straight into a printed `check()` detail. The trailing
characters Stripe leaves unmasked are real, so a real key would have leaked its
tail into console output and into anything that output was pasted into. This
contradicted the probe's own stated guarantee that it never prints a secret.

Fix, at the one point every caller reads a Stripe response through
(`stripeRequest`), rather than at the five call sites: `scrub()` gained a
pattern-based redaction for key-shaped tokens (`sk_`/`rk_`/`pk_` × `test`/`live`,
and `whsec_`, including asterisk-masked forms), and the response body is scrubbed
as it is read, with `JSON.parse` running on the scrubbed text so the parsed
`error.message` is covered by the same single scrub. Output is now
`Invalid API Key provided: <redacted>`. The deliberate disclosures are preserved:
the `sk_test_` prefix class still prints, and `price_…` / `cs_test_…` / `cus_…` /
`sub_…` identifiers are **not** redacted, since those are the evidence the probe
exists to produce. No production source was touched.

- **Key files:** `scripts/stripe-testmode-probe.mjs` (new; 2026-08-26 secret-hygiene
  fix in `scrub` + `stripeRequest`), `scripts/billing-probe.mjs` (extended: §17–§23)
- **Tests/probes:** `src/infrastructure/billing/stripeProbeSecretHygiene.test.ts`
  (**4**, new) pins the fix — it executes the *real* redaction regex extracted from
  the shipped file, so weakening the pattern fails it even though the source still
  contains the word `scrub`. Mutation-verified against an exact backup with
  SHA-256 restore (repo is non-Git): reverting the scrub at `stripeRequest` fails
  1 test, deleting the pattern redaction fails 3, dropping the asterisk class from
  the pattern fails 2, and the restored file is byte-identical
  (`cf8e0486…5454b9`). Full suite **306 files / 6265 tests / 0 failed** (was
  305/6261: +1 file, +4 tests). Focused billing selection **14 files / 266 tests**.
  Billing runtime probe **78/78**, 3 ENVIRONMENT-LIMITED. `typecheck` clean;
  `lint` 0 errors (10 pre-existing warnings, none in the new file).
- **Feature flags:** `STRIPE_SECRET_KEY` (test), `STRIPE_PRICE_PRO`, optionally
  `STRIPE_WEBHOOK_SECRET` + the Stripe CLI.
- **Known limitations — every one of these remains ENVIRONMENT-LIMITED / NOT
  VERIFIED, because no request to Stripe was ever made:**
  - real Pro **price** verification (exists / active / recurring / `livemode:false`,
    amount+currency+interval as provider data)
  - real **Checkout Session** (`cs_test_…`, subscription mode, configured price
    only, correct customer, organization correlation, fixed success/cancel URLs)
  - real **customer** creation
  - real **webhook ingress** → `/api/billing/webhook` → Prisma → `/api/usage`
    reporting `pro`
  - resulting **Pro entitlement from a signed provider webhook**
  - subscription **created / updated / deleted** lifecycle, duplicate-event
    idempotency and stale-event rejection *against real Stripe events*
  - **billing portal** (`POST /api/billing/portal` → provider-generated URL); also
    needs the Billing Portal configured in the Stripe dashboard
  - a **completed paid** checkout, which additionally needs a browser and a test
    card and cannot be done by `stripe trigger` (it fabricates its own customer,
    which this deployment correctly refuses)

  All of the above are verified **synthetically** by `billing-probe.mjs` (78/78) —
  that is evidence about PDFDadi's code, and is **not** evidence that a Stripe
  account is wired to this deployment. Unrelated to this slice: the
  usage/analytics probe's recorded 83/83 could not be reproduced in this session
  because it needs an operator-provided server on `:3011` with a seeded database,
  Chrome and `--admin-pw`; it is not reachable from either file changed here.
- **Operator actions still required, in order:**
  1. In the Stripe dashboard, **test mode**, create a recurring Pro price; set
     `STRIPE_PRICE_PRO` to its id.
  2. Supply the test-mode `STRIPE_SECRET_KEY` (`sk_test_…`/`rk_test_…`). A live key
     is refused by design.
  3. Install and authenticate the Stripe CLI (`stripe login`) for webhook ingress,
     or provide a public tunnel to `/api/billing/webhook`, and set
     `STRIPE_WEBHOOK_SECRET` to that endpoint's signing secret.
  4. Configure the **Billing Portal** in the dashboard, or accept that subsection
     staying environment-limited.
  5. Run `STRIPE_SECRET_KEY=sk_test_… STRIPE_PRICE_PRO=price_… node
     scripts/stripe-testmode-probe.mjs`, then complete one checkout by hand with a
     test card, and record the result in this entry.
- **Next related step:** Re-run this probe once the five operator actions above are
  done. **Usage Hard Enforcement must not start from here** — enforcement keys off
  a plan whose only trusted source is the Stripe webhook, and that path has never
  been exercised against real Stripe. Enforcement readiness is separately still
  `insufficient_observation_data` with `USAGE_LIMIT_MODE=observe`.

---

## Production safety and deployment gate (Launch Readiness Slice 1)

- **Status:** Complete. Suite 310 files / 6321 tests / 0 failed; `tsc --noEmit`
  clean; runtime-verified against `next dev`.
- **Date:** 2026-08-26
- **Purpose:** Make a production deployment fail-safe and diagnosable. Before this
  slice, every misconfiguration listed below started **silently** and presented as
  a product bug — a forged admin cookie, a download link to the visitor's own
  machine, uploads vanishing on redeploy — rather than as a config error.
  Operational hardening only; no feature behavior changed.
- **User-visible behavior:** None on a correctly configured deployment, beyond
  security response headers. A *misconfigured* production deployment now refuses to
  start instead of serving.

### The gate

`productionProblems()` in `src/infrastructure/config/env.ts` is the single
authority on what "required" means. It lives in the existing config module rather
than a new one, so there is exactly one config system. It returns **every** problem
rather than throwing on the first, so an operator fixes the whole list in one
restart, and it names variables and consequences while **never echoing a value** —
this text reaches logs and error trackers.

`getConfig()` runs it once, before handing out any value, when
`NODE_ENV=production`. `instrumentation.ts` → `src/infrastructure/config/startupGate.ts`
calls `getConfig()` at process start, which moves the failure from "the first
request that happens to read config" to "the process exited 1 with the list".

What it refuses, and the concrete failure each one prevented:

| Refused | What used to happen instead |
|---------|-----------------------------|
| Missing `DATABASE_URL` | Silent fallback to a SQLite file on an ephemeral container disk; live data lost on redeploy. |
| Missing / short (<16) / public-dev-fallback `ADMIN_SECRET` | Defaulted to `""`, which flowed into `storage.signingSecret` and `LocalSignedUrlService("")` — **every signed storage URL forgeable with a publicly known empty key**, plus forgeable admin session cookies. |
| `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1` | The public repo-shipped fallback secret was accepted in production. This also gave the previously-dead `allowInsecureDevSecret` config field a purpose rather than deleting it. |
| Short `STORAGE_SIGNING_SECRET` | A placeholder signed real download URLs. |
| Loopback or non-absolute `NEXT_PUBLIC_SITE_URL` | Defaulted to `http://localhost:3000`; signed download and multipart-upload URLs are built from it, so clients received links to their own machine. |
| Half-configured R2 (1–3 of 4 vars) | Silent fallback to local disk — data loss presenting as a typo. The error names the missing variables. |

**Optional stays optional, by test as well as by intent.** No Stripe config
disables billing, no R2 selects local storage, no `REDIS_URL` selects the memory
queue; none blocks startup. A *partial* Stripe setup warns loudly at boot and
starts anyway — `configWarnings()` in `env.ts`, deliberately placed there because
`billingSecretConfig.test.ts` requires each Stripe variable name to appear in
exactly one source file, and it derives the count from the built config rather
than from a second `process.env` read.

**`next build` is exempt** via `NEXT_PHASE=phase-production-build`. The build sets
`NODE_ENV=production` too, but a build is not a deployment: CI must compile with no
production secret. Verified against Next's own
`node_modules/next/dist/build/index.js`, and pinned by its own test.

### Seams worth knowing

- **`startupGate.ts` exists only because of the Edge runtime.** Next compiles
  `instrumentation.ts` for **both** runtimes, so a static `process.exit` reference
  fails the Edge compile even though a `NEXT_RUNTIME !== "nodejs"` guard means it
  can never run there. The symptom was `Ecmascript file had an error` on every
  request. The Node-only work sits behind a dynamic import; do not inline it back.
- **`console`, not the DI `ILogger`,** in the startup gate: resolving the container
  at boot would eagerly construct Prisma and the queue adapters.
- **`INSECURE_DEV_SECRET` is now exported** from `lib/admin/session.ts` solely so
  the gate refuses the same literal the fallback uses — shared constant, no drift.

### Other hardening in this slice

- **Security response headers** on every route via `headers()` in
  `next.config.mjs`: `nosniff`, `X-Frame-Options: DENY` (justified by the verified
  absence of any `<iframe>`), `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, plus HSTS **production-gated** — over plain-HTTP
  dev it would pin `localhost` to HTTPS in a developer's browser for two years.
  Placed in `next.config.mjs` and not `proxy.ts`, whose matcher is `/admin/:path*`:
  widening it would put an edge function in front of every request to serve static
  headers. There were **zero** security headers before this slice.
  **CSP is deliberately deferred** — it needs nonce plumbing plus `worker-src`/
  `blob:` for the pdf.js worker, and a half-right CSP would silently break the
  editor while looking like a win.
- **`/api/health/ready` no longer echoes `detail`.** It is unauthenticated so a
  load balancer can reach it, and the detail strings are raw driver messages: a
  Prisma connection failure embeds the DSN host, user and database name. Now
  name + healthy only; details still logged server-side.
- **Docs:** `.env.example` gained the required set, the all-four-or-none R2 rule and
  the previously undocumented `DATABASE_URL`/storage/queue variables;
  `SERVER_SETUP.md` gained "Production configuration gate" (with the exact failure
  output) and "Security response headers". `.dockerignore` gained
  `.billing-backup-*`, `.storage`, `coverage`, `*.log`, which were entering the
  build context via `COPY . .`.

### Verification

- **The admin and debug surfaces were already correct in code and untested.** This
  slice changed no admin logic and added the tests that hold it: `app/api/admin/adminSetupRoute.test.ts`
  (18) pins that an initialized install answers 409 with the hash untouched, that
  **no** query parameter (`?force=1`, `?reset=1`, `?setup=1`, `?overwrite=yes`, …),
  body flag, or `NODE_ENV` value unlocks re-setup, and that no response contains a
  hash, salt or the submitted password. Its `updateStore` fake **runs the real
  mutator** against a draft — a mock that ignored it would make every assertion
  pass with the guard deleted.
- `app/api/productionHttpSurface.test.ts` (6) scans all ~100+ `app/api/**/route.ts`
  for env-var bypasses, magic test/debug request keys, and stray `NODE_ENV` reads
  outside the `secure:` cookie idiom. It asserts `files.length > 100` and names
  known routes first, so an empty glob cannot pass as "no backdoors found".
- **Mutation-tested, not merely green.** Fourteen mutations were planted across the
  gate, the warning and the header config; every one turned the suite red. Two
  found real gaps rather than confirming the tests: `configWarnings` firing on a
  *complete* Stripe setup initially went unnoticed, which would have warned every
  correct deploy and trained operators to ignore startup output — now pinned by
  "stays quiet about billing when all of it is configured".
- Runtime: `[startup] PDFDadi configuration OK — env=development db=sqlite
  storage=local queue=memory billing=disabled usageLimits=observe logLevel=info`,
  all five non-HSTS headers present on both a page and an API route, HSTS correctly
  absent in dev, and no Edge-runtime compile error in the log.
- **Not verified here:** no real `npm run build` was run (this host OOMs on static
  generation — see `experimental.cpus: 4` and `VIPS_CONCURRENCY=1`), and no
  production deployment was started, so the exit-1 path is covered by test rather
  than by observation.
- **Unchanged by design, per the slice's constraints:** billing, real Stripe
  verification (still ENVIRONMENT-LIMITED), `USAGE_LIMIT_MODE=observe`, the
  persistence architecture, the admin system's design, and every maintained probe
  script.
- **Next related step:** Content-Security-Policy with nonce plumbing and pdf.js
  worker allowances, as its own slice.

---

## Worker stuck-job recovery (Launch Readiness Slice 2)

- **Status:** Complete. Suite 312 files / 6367 tests / 0 failed; `tsc --noEmit`
  clean; runtime-verified by killing a real worker process.
- **Date:** 2026-08-26
- **Purpose:** A worker or process death must not leave a job permanently stuck.
  Before this slice it did, and no operator action short of raw SQL could fix it.
- **User-visible behavior:** A job whose worker died stops sitting at "processing"
  forever. It is returned to the queue and finished by another worker (or the same
  one after a restart), with the same job id, the same download URL, and **one**
  charge on the customer's meter. A job whose failure is reproducible exhausts its
  attempt budget and lands in `failed` with the Retry button live, rather than
  cycling.

### Root cause

Two independent gaps, both required:

1. **No durable claim.** Nothing on the row distinguished "a worker is alive on
   this" from "the worker that claimed this is gone". `startedAt` records the
   claim, never the liveness.
2. **`running` was a dead end.** `ALLOWED_TRANSITIONS.running` was
   `{completed, failed, cancelled}` and `RETRYABLE_FROM` was `{failed, cancelled}`,
   so *no code path existed* to return a `running` job to `queued`. `retryJob`
   answered `not_retryable_status`; `worker.requeue`'s `{retry: true}` transition
   returned `null`. The worker's own doc comment claimed an operator "can requeue
   it" — they could not.

### The mechanism

**The lease is `updatedAt`.** Prisma's `@updatedAt` is already refreshed by the
claim and by every `recordStage` progress write, so a live worker continuously
proves liveness and a dead one stops — no schema change, no heartbeat table, no
second concept of time to keep consistent. `listStaleRunning(cutoff, limit)`
filters in the query, so a sweep costs one indexed read, not a table scan.

`StuckJobRecoveryService.recoverStale()` is one bounded pass (25 rows, oldest
lease first) that never throws — one unrecoverable row must not abort the pass.
Per row, `recoverOne` decides three ways: a cancel request wins (`cancelled`), an
exhausted budget terminates (`failed`/`internal_error`), otherwise `queued` +
`queue.requeue`. Every write goes through `IJobRepository.transition`, whose
`updateMany where {id, status}` is the CAS that makes two concurrent recoverers
safe: the loser gets `null` and counts itself `skipped`. `RECOVERABLE_FROM` is
`{running}` only, so terminal and cancelled jobs cannot be resurrected by
construction rather than by a filter someone can forget.

**Metering:** recovery charges the dead attempt via the existing
`settleProcessingOutcome({ willRetry: true })` seam, which records the attempt
event and its `compute_units` delta but claims **no** settlement and refunds
nothing. The customer reservation was taken once at submit; per-attempt compute
telemetry keeps its row for the attempt that crashed. One logical job stays one
charge across any number of recoveries.

**Where it runs:** `startStuckJobRecovery` sweeps immediately (a restart is
exactly when stale rows exist) then every `WORKER_STALE_JOB_SWEEP_MS`, unref'd.
Started in *both* `workerBootstrap.ts` (the single-process deployment, where the
web container *is* the worker) and `processingWorker.ts`. The standalone worker
constructs the service locally instead of resolving `Tokens.StuckJobRecoveryService`,
because in the non-Redis branch it drains a `DatabaseQueue` it built itself while
`Tokens.Queue` is the web process's in-memory adapter — requeueing onto the wrong
adapter is recovery that reports success and delivers nothing.

- **Config:** `WORKER_STALE_JOB_AFTER_MS` (default 600 000 — deliberately longer
  than the 180 s `compress-pdf` ceiling, so a slow job is never mistaken for a
  dead one) and `WORKER_STALE_JOB_SWEEP_MS` (default 60 000). Both are parsed by a
  `positiveMs` guard: `Number("10m")` is `NaN`, a `NaN` threshold makes the cutoff
  an Invalid Date, and that means recovery **silently off** on exactly the
  deployment whose operator was tuning it. Found by a probe, not by review.
- **Key files:** `src/application/services/StuckJobRecoveryService.ts`,
  `src/domain/jobs/jobStateMachine.ts` (`RECOVERABLE_FROM`, `canRecoverTransition`,
  `isTransitionAllowed(..., { recover: true })`), `listStaleRunning` in the
  Prisma/in-memory job repositories, `src/infrastructure/jobs/workerBootstrap.ts`,
  `src/workers/processingWorker.ts`
- **Tests/probes:** `src/application/services/StuckJobRecoveryService.test.ts`
  (33 — including one that fails if either startup path stops calling the sweep,
  which is what the behavioural tests structurally cannot see), the recovery block
  of `pilotPipeline.integration.test.ts`, and
  `scripts/worker-recovery-probe.mts` (45 checks) — which submits a real job,
  spawns a real worker with `node --import tsx`, **SIGKILLs it mid-Ghostscript**,
  proves the fresh lease is *not* reaped, then spawns a replacement whose startup
  sweep recovers the job to completion. Five mutations (disable the stale-age
  check, recover terminal jobs, allow two recovery claims, charge the customer
  twice on retry, skip the startup sweep) each turned the suite red, plus a sixth
  (delete the web process's sweep call) added after it showed those five could not
  reach the single-process deployment's wiring.
- **Known limitations:** If `queue.requeue` throws *after* the CAS, the row is
  `queued` with no queue entry — the same pre-existing exposure
  `queueJob`/`retryJob` carry, and `DatabaseQueue` (the table *is* the queue) is
  immune. The stale worker's writes are no longer an exposure: see *Attempt
  fencing* below, which closed the `queued → failed` hole this entry used to list
  (the generous threshold is now a CPU-saving measure, not the mitigation).
- **Next related step:** Nothing required. If `REDIS_URL` deployments ever run many
  workers, the sweep's fixed 25-row bound and single-node assumption are the first
  things to revisit.

## Worker graceful shutdown

- **Status:** Complete
- **Date:** 2026-08-26
- **Purpose:** A deploy should not strand the jobs that happen to be running.
- **User-visible behavior:** A job in flight when a worker is asked to stop
  finishes normally instead of dying mid-write. One that cannot finish in time is
  abandoned deliberately and recovered by the stale-job sweep — never reported
  successful.
- **Architecture:** `SIGINT`/`SIGTERM` → stop the expiry sweep, stop the recovery
  timer, `worker.stop()` (which ends the *pull* loop, so no further job is
  claimed), then poll `worker.activeCount` until zero or `WORKER_SHUTDOWN_GRACE_MS`
  (default 20 000) elapses, then `exit(0)`. Bounded in both directions: an idle
  worker exits at once rather than sleeping out the window, and a wedged handler
  cannot hold the process open past the deadline. The abandoned-at-deadline case
  logs a sanitized count and a note naming the sweep that reclaims it. Same
  `positiveEnv` NaN guard as the recovery constants — a `NaN` deadline makes
  `Date.now() < deadline` false on the first check, which is the unbounded-kill
  defect this replaced, reintroduced by a typo.
- **Key files:** `src/workers/processingWorker.ts`,
  `src/application/ports/queue/Worker.ts` (`activeCount`),
  `src/infrastructure/queue/InMemoryWorker.ts`
- **Tests/probes:** `src/infrastructure/queue/workerShutdown.test.ts` (3 — stop()
  prevents the *next* claim, `activeCount` stays 1 through in-flight work, and work
  abandoned at the deadline is recoverable), plus section 7 of
  `scripts/worker-recovery-probe.mts`: a real SIGTERM, exit code 0 through the
  handler, in under 5 s.
- **Known limitations:** `activeCount` is the only drain signal, so a handler that
  leaks its slot would make shutdown wait out the full grace period. Nothing
  supervises the worker; a supervisor/orchestrator is expected to send the signal
  and to restart on non-zero exit.
- **Next related step:** None.

## Attempt fencing for recovered jobs (Launch Readiness Slice 2.1)

- **Status:** Complete
- **Date:** 2026-08-26
- **Purpose:** Close the last stale-worker race: a worker whose job was recovered
  out from under it must not be able to write to that job at all.
- **User-visible behavior:** None when everything is healthy. When a worker
  stalls long enough to be recovered and then wakes up, the user's job is no
  longer at risk of being marked failed, cancelled, or refunded by the process
  that lost it — the worker that actually holds the job decides the outcome. The
  observable difference is a job that finishes instead of one that reports
  "processing failed" seconds before its replacement would have succeeded.
- **Architecture:** `attempts` **is** the fencing token. It counts *finished*
  attempts, so a row under a live attempt N reads `N - 1`, and every recovery
  charges the abandoned attempt and bumps it — monotonic per job, unique per live
  attempt, with no new column and no lease id to drift out of sync. Both
  repositories accept `JobWriteOptions.expectAttempts`, which becomes an extra
  term in the *same* conditional `updateMany` the status CAS already uses, so a
  fenced-out write lands nowhere — including on `updatedAt`, which is the lease.
  `ProcessingJobService` derives the fence from the attempt a worker is already
  reporting (`completeJob`, `failJob`, `markCancelled`, `recordStage`) rather than
  asking the call site for it; a fence a caller can forget is not a fence.
  `ownsAttempt` then tells a refused worker *which* refusal it hit: superseded
  (write nothing, settle nothing) or beaten to a terminal state under its own
  attempt (still the job's authority, still owes the user a refund). The handler
  short-circuits on the first and is unchanged on the second. The state machine
  could not have solved this — `running → failed` and `queued → failed` are both
  legal moves, so the lifecycle cannot tell the owner from a zombie.
- **Key files:** `src/application/ports/repositories/JobRepository.ts`
  (`JobWriteOptions`), `src/infrastructure/persistence/PrismaJobRepository.ts`,
  `src/infrastructure/persistence/InMemoryJobRepository.ts`,
  `src/application/services/ProcessingJobService.ts` (`ownsAttempt`),
  `src/infrastructure/jobs/ProcessingJobHandler.ts` (`recordFailure`,
  `logSuperseded`)
- **Tests/probes:** 5 in `ProcessingJobService.test.ts` (the real sweep drives the
  requeue; each refusal is paired with the successor's identical call succeeding),
  2 in `ProcessingJobHandler.test.ts` (a superseded attempt publishes nothing,
  records no usage event, and triggers no settlement — on both the success and the
  throw path), and **section 8 of `scripts/worker-recovery-probe.mts`**, which is
  the only place the claim can actually be proved: an in-memory repository has no
  `@updatedAt` and no WHERE clause. Two mutations were run — dropping
  `expectAttempts` from the Prisma `updateMany` turned 6 probe checks red with the
  zombie's `failJob` landing `status=failed` on a job another worker owned, and
  making `ownsAttempt` always return true turned both handler tests red.
- **Known limitations:** The fence covers the four writes a worker makes about its
  own attempt. `StuckJobRecoveryService`'s own transitions are deliberately
  unfenced — competing sweeps already serialise on the status CAS — and so are
  user-initiated writes (cancel request, retry), which are not about one attempt.
  A superseded worker still finishes its Ghostscript run before discovering it was
  superseded; nothing interrupts in-flight compute, it just cannot report it.
- **Next related step:** CSP. Nothing further is required here.

## Queue handoff safety (Launch Readiness Slices 2.2 + 2.3)

- **Purpose:** Answer one question no path in the system had been asked: making a
  job runnable is a durable CAS to `queued` *and then* a call telling the queue
  adapter about it. Those are two writes. What happens if the second one fails?
  Slice 2.2 answered it for the unattended sweep (`StuckJobRecoveryService`);
  Slice 2.3 answered it for the two request-path handoffs
  (`ProcessingJobService.queueJob`, `.retryJob`) and made all three share one
  answer.
- **The answer depends entirely on the adapter, so all three are recorded:**
  - **`DatabaseQueue` (standalone `npm run worker`, non-Redis) — safe by
    construction.** The `queued` row *is* the queue entry: `pull` answers from
    `jobRepo.listByStatus("queued")`, so there is no second write to lose.
    `requeue` only deletes an in-flight de-duplication marker, and even a lost
    delete self-heals — `next()` expires the entry after `inflightTtlMs` (30 s).
    Proved, not asserted: a *different* `DatabaseQueue` instance, one that never
    had `requeue` called on it and shares no state with the sweep's, serves the
    recovered job anyway.
  - **`InMemoryQueue` (web-process default) and `RedisQueue` (`REDIS_URL`) — could
    strand.** Both answer `pull` from their own list of ready ids (an array; a
    Redis `READY` list). A push that fails leaves a row saying `queued` with
    nothing that will ever serve it, and **nothing in the system would look at it
    again**: `listStaleRunning` returns only `running`, and the user-facing retry
    refuses anything not `failed`/`cancelled`. For Redis the failure is a real
    network call, not a theoretical one.
- **Repair (smallest that removes the strand, no new infrastructure):** one
  compensating rollback, shared by all three callers —
  `deliverQueuedJob(deps, jobId, restore)` in
  `src/application/services/queueHandoff.ts`. It pushes; if the push throws it
  puts the row back and rethrows the original error. No reconciler, no
  visibility-timeout reaper, no new table, no scheduler, and no per-adapter
  branch in any service. Slice 2.3 extracted the seam out of the sweep rather
  than writing a second and third rollback, because a rollback that exists in one
  of three paths and not the others is a strand waiting for whichever path was
  forgotten.
- **What is path-specific is only where the row goes back to,** and each target
  is chosen so an *existing* mechanism can act on the result:
  - **Sweep (`recoverOne`) → `running`,** with `attempts` uncharged (charging the
    dead attempt twice would eat a retry budget the crash never used),
    `startedAt`, `queuedAt`, `progressStage` restored. That is exactly the stale
    `running` row the sweep is built to find, so the *existing* 60 s pass retries
    the handoff.
  - **Submission (`queueJob`) → `failed` / `internal_error`,** attempts untouched
    because nothing ran. Deliberately *not* back to `created`, which was the
    row's status a moment earlier: `created` is actionable by nothing (no sweep
    looks at it, `retryJob` refuses it), so a client replaying its
    `Idempotency-Key` after the error would be handed the same dead row forever.
    `internal_error` is retryable, so the affordance the user already has is the
    recovery path.
  - **User retry (`retryJob`) → the job's *original* terminal status,** with its
    error fields, `cancelRequestedAt`, `startedAt`, `finishedAt` and stage put
    back. This is the handoff where a lost push hurt most: the row landed
    `queued`, and `queued` is exactly what `retryJob` refuses, so a failed
    delivery made *every* further retry impossible. It has to be the original
    status — restoring `failed` over a `cancelled` job leaves
    `errorCategory: "cancelled"`, which `isRetryableCategory` calls permanent.
- **The usage debit stays with the row it paid for.**
  `lib/server/processingJobSubmit.ts` deliberately does **not**
  `.catch(releaseOnFailure)` around `queueJob`: the rollback leaves a *retryable*
  row, so the job may still run. Releasing there would leave the payload naming
  an already-refunded reservation, and the eventual terminal settlement would
  refund it a second time — `release` and `settleProcessingOutcome` apply their
  deltas independently and only the latter is guarded by the once-per-job
  settlement claim. That mints allowance, the one direction this must never fail
  in. Exactly one debit per logical job, refunded at most once.
- **Rollback is best-effort, guarded twice, and says so.** The row is re-read and
  must still be the `queued` row this call wrote — `queued → running` and
  `queued → failed` are both legal, so the lifecycle alone cannot tell "put my
  write back" apart from "clobber the attempt a worker just claimed" or "resurrect
  the job the user just cancelled". The write itself then goes through
  `jobRepo.transition`, whose CAS refuses anything that moved. Refused (`null`)
  means the job is someone else's row now. If the rollback itself *throws*, the
  database is unreachable too, which is the one case where the original CAS could
  not have succeeded either; that path logs `job is stranded` at `error` rather
  than swallowing it.
- **Key files:** `src/application/services/queueHandoff.ts` (the shared seam),
  `src/application/services/StuckJobRecoveryService.ts` and
  `src/application/services/ProcessingJobService.ts` (`queueJob`, `retryJob`) as
  its three callers, `lib/server/processingJobSubmit.ts` (the reservation that
  travels with the row), `src/infrastructure/queue/DatabaseQueue.ts` (the
  safe-by-construction adapter).
- **Tests:** 2 in `StuckJobRecoveryService.test.ts` (the sweep) — the
  `DatabaseQueue` no-side-effect proof above, and a rollback test that fails the
  ready-list push, asserts the row is `running` with the attempt *uncharged* and
  the ready list empty, then ages the lease and shows the next pass completing
  the handoff with the attempt charged exactly once across both passes. 7 in
  `ProcessingJobService.test.ts` (the request paths) — a submission whose delivery
  fails lands `failed`/`internal_error` with `attempts` 0, `queuedAt` null and an
  empty ready list, and is then retryable; a retry whose delivery fails comes back
  as `failed` with its *original* category and attempt count and a second retry
  succeeds; a retried *cancellation* comes back `cancelled`, not `failed`; a
  cancellation racing the failing push is not resurrected; and the table-as-queue
  adapter is served by an instance that was never told about the id. 5 in
  `queueHandoff.test.ts` — the real `RedisQueue.requeue`/`pull` against an ioredis
  double, covering a refused `LPUSH`, recovery afterwards, the `running` restore,
  the refusal to roll back over a job that moved on, and the stranded-log path.
  1 × 2 queue kinds in `pilotPipeline.integration.test.ts` — the whole chain with
  real Ghostscript and a real metering ledger: retryable failure → user retry →
  refused delivery → row still reports `retryable: true` → second retry →
  completed on attempt 2 with a published output, and `server_operations` equal to
  1 throughout with the settlement claim already taken.
- **Mutations (3, all red, exact bytes restored — SHA-256 verified):** removing the
  `queueJob` compensation turned 2 tests red; removing the `retryJob`
  compensation turned 4 red (including both integration variants); restoring
  `failed` instead of the original status on a retried cancellation turned 1 red —
  the one assertion that separates "rolled back" from "rolled back correctly".
- **Known limitations:**
  - **Re-detection costs one more stale interval (10 min).** The rollback write
    refreshes `updatedAt`, which *is* the lease, so the reverted row is not stale
    again immediately. Bounded, and the same wait any abandoned job already
    serves. Restoring the old `updatedAt` is not expressible through the port —
    Prisma owns `@updatedAt`.
  - **A submission whose handoff failed and is never retried stays charged one
    operation.** The debit deliberately follows the retryable row rather than
    being refunded on the spot, because refunding it and settling later mints
    allowance (see above). Erring one operation *toward* the house on a queue
    outage is the safe direction; the alternative is not.
  - **Redis is covered by contract, not by network.** `RedisQueue`'s constructor
    opens a socket, so no test instantiates it normally and CI has no server —
    classified environment-limited. Its real `requeue`/`pull` are exercised
    against an ioredis double whose `LPUSH` is refused the way a failover to a
    read-only replica refuses one, so the failure semantics are the adapter's own.
    A live-Redis run remains unperformed.
  - **The `deliverQueuedJob` re-read narrows the rollback race, it does not close
    it.** Two awaits separate the read from the write. It does not need to: for
    every adapter whose push can actually fail, the id was never delivered, so no
    worker can be holding it — and the `transition` CAS refuses the write anyway
    if one somehow is.
- **Next related step:** CSP. Queue handoff is closed on all three paths.

## Content-Security-Policy: report-only foundation, then nonce enforcement (Launch Readiness Slices 3.1 + 3.2)

**Enforced.** The header is `Content-Security-Policy` — no `-Report-Only` — and it
carries a fresh per-request nonce on every document. Under it: `script-src` is
`'nonce-…' 'strict-dynamic'` and nothing else, no `'unsafe-inline'`, no eval of any
kind, no wildcard in any directive.

3.1 built the measurement and 3.2 acted on it, in that order and deliberately: the
policy enforced today is the one 3.1 proved the product actually needs, not a
guessed one. The 3.1 record below is kept rather than rewritten, because *why* each
allowance exists is the part that will matter when someone is tempted to widen one.
Where 3.2 changed a fact, the bullet says so.

- **Policy architecture — one builder.** `lib/security/csp.mjs`
  exports `buildCsp({ nonce, isDev, storageOrigins })` and is the only place a
  directive is written. `next.config.mjs` calls it once inside `headers()` and
  appends the result to the five security headers that were already there, all of
  which the probe re-asserts intact. `.mjs`, not `.ts`, because `next.config.mjs`
  must import it at config-load time; `allowJs` lets the `.test.ts` import the same
  module the config does, so the tests exercise the real builder and not a copy.
  No new middleware, no proxy layer — in 3.1 the existing `proxy.ts` stayed scoped
  to `matcher: ["/admin/:path*"]`; 3.2 widened that same file rather than adding a
  second one. The `next.config.mjs` copy is baked into `.next/routes-manifest.json`
  at **build** time, which is why a browser probe against the real artifact is the
  only thing that can prove it ships — a stale build served a policy-free homepage
  while every unit test was green. **3.2 update:** there are now two call sites, and
  they are kept in agreement by one exported `CSP_HEADER` constant rather than by
  discipline. The proxy owns every document; `next.config.mjs` covers only what the
  proxy's matcher excludes (`/_next/static/*` and friends), which is a real
  requirement and not a leftover — a worker inherits the CSP of *its own* response,
  so an uncovered `pdf.worker.min.*.mjs` would run unpoliced.
- **Directives, and the evidence for each allowance.** 13 directives, 281 chars,
  zero wildcards.
  - `default-src 'self'` — the floor; every directive below only narrows or names
    a measured need.
  - `script-src` was `'self'` in 3.1 and is now `'nonce-<per-request>'
    'strict-dynamic'`. **Never** `'unsafe-inline'`: the 152 inline-script violations
    were the finding 3.1 existed to produce, allowing them would have erased it, and
    3.2 removed them at the source instead. (A nonce also makes browsers *ignore*
    `'unsafe-inline'`, so adding it would be inert on modern browsers and a downgrade
    on old ones — the worst of both.) **No `'unsafe-eval'` and no `'wasm-unsafe-eval'`** — read
    pdfjs-dist 6.1.200 rather than assuming: it has no `eval`/`new Function`
    compiler, and its PostScript→WASM path is `try`/`catch`ed with a JS
    interpreter fallback. The probe confirms it: PDF.js parsed and rendered the
    fixture with neither allowance present.
  - `style-src 'self' 'unsafe-inline'` — permanent, not laziness. A style
    *attribute* cannot carry a nonce, and the editor positions overlays through
    inline `style`.
  - `img-src 'self' data: blob:` — `data:` for the canvas rasterization the editor
    performs on every page background, `blob:` for object URLs. Both observed in
    the browser walk.
  - `font-src 'self'` — fonts are self-hosted through `next/font`; no Google Fonts
    origin was added because none is requested.
  - `connect-src 'self'` plus any configured storage origin. The R2 account
    endpoint is derived from config, never hardcoded, and `assertConcreteOrigin`
    refuses a wildcard, a relative value, or plain `http` off localhost. Under
    local disk storage the signed result URL is same-origin, which the probe
    verifies rather than assumes.
  - `worker-src 'self'` — **no `blob:`**. The pdf.js worker is a same-origin
    `/_next/static/chunks/pdf.worker.min.*.mjs`; the probe reads the fetched
    worker URL back out of the browser to prove it.
  - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
    `form-action 'self'`, `frame-src 'none'` — the restrictive baseline, each
    pinned by a test.
  - `report-uri /api/csp-report`, and deliberately **no `report-to`**. See below.
- **`report-to` was removed, because it was silently muting the whole slice.**
  The first policy carried both, on the reasoning that one is modern and one is a
  fallback. Chrome delivered *zero* reports. The Reporting API requires a secure
  context, and per spec the presence of `report-to` **suppresses** `report-uri`,
  so "both, for coverage" is a mute button on every http origin — dev, a probe, a
  plain-http staging box. Measured against a local server emitting each variant,
  over http and again over https with a self-signed cert:

  | origin | `report-uri` alone | `report-to` alone | both |
  |---|---|---|---|
  | http  | delivered <1s | nothing | **nothing** |
  | https | delivered <1s | delivered ~60s | ~70s |

  A report-only rollout that receives no reports is indistinguishable from a clean
  one, which is the exact failure mode this phase cannot afford. Deprecated-but-
  universal beats modern-but-silent while the only deliverable is the report
  stream. `report-to` belongs to 3.2, where there is an https environment to verify
  it against. `Reporting-Endpoints` was dropped with it — a group nothing refers
  to. Two tests now pin the absence, and the probe fails if either returns.
- **Nonce architecture (3.2), reusing Next's own contract rather than inventing one.**
  `app-render.js` reads the *request* header `content-security-policy[-report-only]`
  and extracts `'nonce-…'` from the first `script-src` (else `default-src`) with
  `/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/`. So the wiring is: request arrives → proxy
  mints a nonce → proxy sets the nonce-bearing policy on the **request** headers via
  `NextResponse.next({ request: { headers } })` → Next renders and stamps that nonce
  on every script it generates → the proxy sets the **same** policy on the response.
  One request, one nonce, both directions; two requests never share one.
  - **Nonce source:** `newCspNonce()` — `randomBytes(16)` base64, 24 chars, 128 bits
    from the CSPRNG. Not a hash, not a counter, not a request id. A test asserts it
    against Next's exported regex (`NEXT_CSP_NONCE_SOURCE_REGEX`) rather than a
    hand-copied pattern, because a nonce Next silently rejects yields a page whose
    scripts are all unnonced — a blank screen under enforcement.
  - **Where the nonce is not.** Never in a cookie, `localStorage`, a query param,
    persistent config, an analytics event, or a log line. It is written once, to two
    headers, and never read back. `proxy.ts` says so in a "what this file does NOT
    do" section so the next reader does not have to infer it.
  - **Proxy scope.** `matcher: ["/((?!_next/static|_next/image|.*\\.[^/]*$).*)"]`.
    Widened from `/admin/:path*` to every document, minus static chunks, optimized
    images, and anything with a file extension — those cannot consume a nonce and
    `next.config.mjs` already covers them. Where both apply, middleware wins:
    `resolve-routes.js` runs `fsChecker.headers` before `middleware` and both assign
    `resHeaders[key]`, so the nonce-bearing policy overwrites the nonce-less one on
    documents.
  - **The bug widening the matcher exposed.** The admin gate was
    `pathname.startsWith("/admin")`, which was unreachable for anything else under
    the old matcher. At the new width it is live, and it redirected `/administrator-notes`
    — any public slug beginning with "admin" — to the admin login. Fixed to
    `pathname === "/admin" || pathname.startsWith("/admin/")`, with `/administrator-notes`
    and `/adminish` pinned as regressions. This is exactly the class of accident §4
    of the slice warned about, and it was found by a test rather than by a user.
  - **An improvement found by reading the artifact.** The proxy compiles to the
    **nodejs** runtime, not edge (`functions-config-manifest.json` gives
    `"/_middleware": {"runtime":"nodejs"}`, and `process.env.R2_ACCOUNT_ID` survives
    as a live lookup in the compiled chunk). So the document policy picks up storage
    configuration at server **boot**, not at build time. Only the static-asset copy
    from `next.config.mjs` still lags a rebuild. An earlier draft of these docblocks
    claimed the opposite; the built artifact disproved it.
- **Rendering and caching impact (3.2), measured from the build, not assumed.** A
  prerendered document is built once and served from cache, so it *cannot* carry a
  per-request nonce — measured directly before the fix: `/editor` (already dynamic)
  rendered 24 scripts, all nonced; `/` (static) rendered 84, none nonced. Next 16
  offers no prerender nonce injection, and reusing a nonce to keep static rendering
  would hand every visitor the same script whitelist. So `app/layout.tsx` carries
  `export const dynamic = "force-dynamic"`.

  | | pre-3.2 | enforced |
  |---|---|---|
  | dynamic (`ƒ`) | 133 | 177 |
  | static (`○`) | 47 | 4 |
  | SSG (`●`) | 3 | 1 |

  44 concrete page routes plus `/blog/[slug]` and `/tools/[slug]` moved static/SSG →
  dynamic. **Metadata image routes do not inherit the root layout's mode**, so
  `/icon`, `/opengraph-image`, `/robots.txt`, `/sitemap.xml` and the 9 per-slug blog
  OG images stay at build time — libvips SVG rasterization is not paid per request,
  and no `force-static` pin was needed. Cost of the change: TTFB 6–16 ms on the
  formerly-static pages, because their content comes from `data/admin/store.json`
  rather than a database. No nonce cache was invented and no nonce is reused.
  `lib/server/processingPilotRendering.test.ts` failed on this change and was right
  to: its anti-vacuity guard was "other tool pages ARE prerendered", now false. The
  guard was rewritten to a premise that is still true and a strictly stronger
  assertion (`no /tools/* route is prerendered at all`), not relaxed. The pilot's own
  `await connection()` was deliberately kept, so pilot correctness does not become a
  side effect of a CSP decision a later slice could reverse.
- **Two stages, because enforcing an unproven policy is enforcing a blank screen.**
  - **Stage A — nonce wiring live, header still `-Report-Only`.** Full production
    browser walk: **109/109**. Inline-script violations **152 → 0**. Unnonced
    executable scripts across `/`, `/pricing`, `/editor`, `/tools/merge-pdf`,
    `/login`, `/blog`: **0 of 251** (97/35/23/35/24/37 scripts each). The only
    violation left was the probe's own deliberate canary. Two requests to the same
    route returned different nonces; five routes returned five distinct nonces.
  - **Stage B — response header flipped to `Content-Security-Policy`.** One line in
    `lib/security/csp.mjs` (`CSP_HEADER = CSP_ENFORCED_HEADER`), which is also the
    rollback. Full walk rerun: **114/114**. The canary's `disposition` reads
    `"enforce"` rather than `"report"` — the direct on-the-wire proof the browser is
    acting on the policy, and the walk's anti-vacuity instrument now that the
    homepage is silent. **Exactly one CSP header name per response, the other absent**,
    asserted on every route and on the static chunk: there is no report-only policy
    running alongside enforcement, and no second switch that could create one.
- **Report endpoint — `app/api/csp-report/route.ts`, diagnostics only.** POST only
  (405 + `Allow: POST` otherwise). Body bounded at 16 KB, checked on the declared
  `Content-Length` *and* the actual bytes, because a declared length is a claim.
  Rate limited at 60/min/IP through the existing `RateLimiter`, 429 with
  `Retry-After`. Always 204 + `no-store` — malformed, empty, wrong-shaped and
  unknown report types are indistinguishable to the caller on purpose, so the
  endpoint is not an oracle for what the parser accepts. It resolves its own
  `ConsoleLogger` instead of the DI container: a reporting sink must not be able to
  fail because an unrelated container binding did. **No entitlement, usage,
  quota or job side effects of any kind** — it reads a body and logs a line.
- **Redaction is the load-bearing part, and the browser proves it is needed.**
  `lib/security/cspReport.ts` is pure: parse both wire formats
  (`application/csp-report` and `application/reports+json`), cap at 20 reports per
  request, and reduce every field. URLs collapse to `origin + pathname`; the
  document URL collapses to a pathname; opaque schemes (`data:`, `blob:`,
  `filesystem:`) reduce to the scheme alone; unparseable becomes `"unknown"`. It
  never reads `sample`, `original-policy`, `referrer` or `status-code` — the four
  fields that carry document content, policy text and navigation history. It never
  throws. The probe closes the loop end to end: it triggers a real violation on
  `https://csp-probe.invalid/pixel.png?token=sk_live_…&doc=payroll`, asserts the
  *browser's own* report contains that secret (so redaction is not decorative),
  then reads the server log and asserts the logged line has the origin and path,
  the directive name, and **no** `token=`, no `doc=payroll`, no document query
  string, and no cookie, sample or policy text.
- **Browser probe — `scripts/csp-probe.mjs`, 74/74 in 3.1, 114/114 enforced.** (Checks
  have been added since; the same script reports **118/118** at the reconciliation tip.
  The counts in this section are the runs as they happened and are left as written.) It is
  one script across both stages, reading `CSP_HEADER` from the policy module rather
  than naming a header, so the flip cannot leave a second switch behind and the
  report-only walk and the enforced walk are literally the same walk. CDP over a raw WebSocket, no
  Playwright, matching the other probes in `scripts/`. Run against the real
  standalone artifact, never `next start`. (Recipe corrected at the ingress closeout: the
  entry is `node ingress/server.mjs` from the repository root, and the https origin must be
  exported at BUILD time. The commands as they were originally written boot nothing now —
  the generated entry exits 1 in production.)

  ```
  NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 node scripts/next-build.js
  cp -R .next/static .next/standalone/.next/static     # the Dockerfile's own recipe
  NODE_ENV=production PORT=3002 HOSTNAME=127.0.0.1 DEPLOYMENT_TOPOLOGY=single-instance \
    NEXT_PUBLIC_SITE_URL=https://<lan-ip>:3001 PROCESSING_PIPELINE=on \
    DATABASE_URL="file:/abs/path/prisma/prisma/dev.db" \
    node ingress/server.mjs > /tmp/csp-server.log 2>&1 &
  node scripts/tls-front.mjs --listen 3001 --target 3002   # in the repo now, not /tmp
  NODE_TLS_REJECT_UNAUTHORIZED=0 CHROME_PATH=/tmp/chrome-insecure \
    node scripts/csp-probe.mjs --url https://<lan-ip>:3001 --server-log /tmp/csp-server.log
  ```

  **Over real HTTPS, not http, and that is load-bearing.** Session and anonymous-owner
  cookies are `Secure` in production, so a plain-http origin drops them and every
  ownership check resolves a different actor — a 404 that reads exactly like a
  product defect. Serving the artifact behind a throwaway TLS terminator (plus a
  `CHROME_PATH` wrapper adding `--ignore-certificate-errors`, so no repo file learns
  about the cert) removes that whole class of false finding, and it is what §9's
  HTTPS clause asks for. `--url` must equal `NEXT_PUBLIC_SITE_URL`, or the result
  download becomes cross-origin and invents a `connect-src` violation that is a probe
  artifact. The LAN address rather than `localhost` because the production startup gate
  refuses a loopback `NEXT_PUBLIC_SITE_URL` — the gate stayed unweakened throughout
  (`env=production db=sqlite storage=local queue=memory billing=disabled
  usageLimits=observe`), and HSTS was observed on the https responses, which is the
  production-only header. Sections: headers off the wire for 5 routes plus a static
  chunk; a browser walk (homepage, pricing, workspaces, editor load, PDF.js render,
  canvas rasterization, local merge, blob download, server job, result download, and
  finally — deliberately last — signup from the page, the authenticated shell and the
  CSRF origin boundary); the report endpoint end to end; then classification. The
  authenticated section is last because `resolveJobActor()` prefers a session over the
  anonymous `pdfdadi_jid` cookie: signing up mid-walk would re-identify the browser and
  404 the job the earlier checks own. Ordering, not a product defect — but it presents
  as one.
- **Two anti-vacuity guards, because "no violations" is what a broken probe also
  reports.** First, the walk asserts the browser *is* evaluating the policy — 84
  violations on the homepage, all `disposition: "report"`, nothing blocked — so a
  missing header cannot read as a clean run. Second, every path must be observed
  to **work** before its violation set counts: the editor's canvas is measured at
  1082×762, PDF.js hit regions prove the worker parsed the document, the merge
  output is read back, the job is polled to `completed` and the result is verified
  to start with `%PDF-`.
- **Violations, fully classified. The table is CLOSED** — anything it does not
  already name is reported UNCLASSIFIED and fails the run, so a new source forces a
  decision instead of joining a whitelist.
  - **FIX-CODE — `script-src-elem inline` ×152**, across homepage, pricing,
    workspaces, editor and the merge page. React Flight serializes RSC payloads
    into inline `<script>` elements. Not fixable by allowing a source;
    `'unsafe-inline'` would defeat the policy. This is precisely what the nonce in
    3.2 must eliminate, and it is the reason enforcement is not on today.
  - **NOISE — `img-src https://csp-probe.invalid/…` ×1.** The probe's own
    deliberate violation. Never a product source.
  - **REQUIRED — none.** The running product asked for **nothing** the policy does
    not already grant: zero violations from the editor load, the PDF.js render, the
    canvas→`data:` rasterization, the local merge, the blob download, or the
    server-processed result through its 302.
- **Invariants proven in the browser, not argued:** the editor renders a PDF; the
  pdf.js worker starts (and its script came from our own origin, so the same policy
  covers the worker's own context — `headers()` covers `/_next/static/*`, verified
  on the wire); local merge executes and produces a downloadable result; a `blob:`
  object URL download violates nothing; server processing completes and the result
  downloads through the signed redirect; pricing renders its plans; a malformed
  report is 204 and an oversized one 413 with the page unaffected; the CSP response
  carries no secret-shaped value; no wildcard exists anywhere in the policy.
- **Key files:** `lib/security/csp.mjs` (the only source of the policy),
  `next.config.mjs` (its only call site), `lib/security/cspReport.ts` (pure parse +
  redaction), `app/api/csp-report/route.ts` (the sink),
  `scripts/csp-probe.mjs` (the browser probe).
- **Tests (49 in 3.1, 71 after 3.2):** 27 in `lib/security/csp.test.ts` against the pure builder rather
  than the header text — the restrictive baseline, no wildcard in any directive, no
  eval of any kind in production, `script-src` free of `'unsafe-inline'`, `data:`
  and `blob:` confined to `img-src`, `worker-src` held at `'self'`, `report-uri`
  present with `report-to` absent, storage-origin normalization and its refusals,
  the nonce shape checked against Next's own extraction regex, and dev proven
  *looser* never stricter (every production source still present). Two of them do
  read the served header — they exist to catch the build-time-bake failure a pure
  test structurally cannot see. 16 in `lib/security/cspReport.test.ts` (the
  redaction contract, asserted by scanning the whole serialized output for planted
  secrets rather than checking fields one at a time). 10 in
  `app/api/cspReportRoute.test.ts` (method, size on both the declared and actual
  path, rate limit, always-204, no side effects).
- **Tests added by 3.2.** 18 in `proxy.test.ts` (new) and 4 more in
  `lib/security/csp.test.ts` (23 → 27). The proxy tests assert the **wiring seam**,
  not source text: the request-side policy is decoded back out of the mechanism Next
  actually uses (`x-middleware-override-headers` → `x-middleware-request-<name>`)
  rather than a hardcoded header spelling, so a rename breaks the test instead of
  silently unwiring the nonce. They cover a fresh nonce per request (25 distinct in 25
  runs, each accepted by Next's regex, each 16 raw bytes), request-CSP === response-CSP
  for one request, a client-supplied CSP request header stripped under both names,
  exactly one CSP header name emitted, the strict policy under a stubbed
  `NODE_ENV=production`, the matcher's 8 excluded and 16 matched paths, authenticated
  pages not exempt, the whole admin gate (redirect with and without `next`, CSP on the
  redirect, login/setup/api carve-outs, a valid `createSessionToken()` admitted and a
  tampered one refused, `/administrator-notes` and `/adminish` not gated), and a real
  minted nonce planted in `original-policy` / `script-sample` / `referrer` proving
  `parseCspReports` emits neither it nor `nonce-` nor `strict-dynamic`. That last one
  first asserts the fixture produces a report at all, so it cannot pass by never
  reaching the sanitizer. The `csp.test.ts` additions are stage-agnostic — they key
  off `CSP_HEADER` and assert "exactly one header name, never both", so flipping the
  stage cannot make them vacuous in either direction.
- **Mutations — 3.1 (4, all red, exact bytes restored — SHA-256 verified):** removing
  `object-src 'none'` turned 3 red; replacing `connect-src` with `*` turned 6 red;
  leaking `url.search` from `safeSource` turned 4 red, including the whole-output
  secret scan and the field-level contract; making an unparseable report answer 500
  instead of 204 turned 1 red — and the probe asserts the same thing at runtime
  against the real endpoint.
- **Mutations — 3.2 (5, all red, exact bytes restored — SHA-256 verified):** hoisting
  the nonce to module scope so every request reuses one → 1 red; sending a nonce-less
  policy on the request while keeping the nonce on the response (the half-wiring that
  gives the browser a nonce Next never saw) → 3 red; adding `'unsafe-inline'` to
  `script-src` → 2 red; returning early for `/workspaces` so authenticated pages get
  no CSP → 1 red; disabling the admin session check → 5 red.
- **Known limitations:**
  - **~~The authenticated shell is unwalked~~ — CLOSED by Launch Readiness Slice
    3.1.1.** The 403 recorded here was real and was a launch blocker, and it was a
    proxy-origin defect in `requireSameOrigin` rather than anything to do with CSP.
    Fixed and proven: the probe now creates an account from inside the page over https
    behind the terminator, renders the authenticated `/workspaces` shell, and performs
    a representative authenticated mutation — the 10 new checks that take this probe
    from 64 to 74. See **Proxy-Aware CSRF origin validation (Launch Readiness Slice
    3.1.1)** below for the mechanism. The authenticated shell contributes **no new
    violation class**: only the same `script-src-elem inline` RSC payload scripts, so
    nonce enforcement remains the single gate on turning the policy on.
  - **The server-processing job is submitted from Node rather than clicked through
    the UI.** The ownership gate still runs against the real anonymous-owner cookie
    and still has to pass — a mismatched actor answers 404, which is how the
    Secure-cookie behaviour was diagnosed — and the CSP surface under test, the 302
    the download follows, is the real one. The pilot probe covers the clicked-through
    UI path in the same environment at 41/41.
  - **~~152 inline-script violations are unresolved on purpose~~ — CLOSED by 3.2.**
    They were the finding, not a defect in the policy, and they were the gate on
    enforcement. The nonce removed all 152 without widening a single directive.
  - **~~`report-to` is still absent~~ — CLOSED by the `report-to` slice below.** It is
    now emitted *conditionally*, on an https site origin only, with `report-uri` kept
    beside it — which is what the suppression rule actually requires. The measurement
    that motivated removing it here was right; the conclusion "remove it" was one
    directive too broad.
  - **~~The report stream is diagnostics, not alerting~~ — DECIDED, deliberately, in the
    same slice.** Nothing pages on a CSP violation and nothing should: the endpoint is
    unauthenticated by necessity and its input is attacker-chosen. What the slice added
    instead is a severity split an operator can alert on from their own pipeline.
- **Why enforcement IS enabled now.** Stage A produced a clean report stream with the
  nonce wiring live: 0 unnonced scripts across 251 on 6 routes, and the inline class at
  0. Only then was the response header flipped. The full walk under enforcement then
  showed every page rendering real content, React hydrating (a client-side link
  navigation lands on the new path in the same document, which server HTML alone cannot
  fake), forms submitting, the authenticated `/workspaces` shell rendering with an
  authenticated mutation succeeding, the PDF.js worker starting from its own origin, the
  editor canvas mounting and a real drag committing an object through IndexedDB, local
  merge succeeding, a server job reaching `completed` and its signed result downloading
  through the 302, a `blob:` object-URL download violating nothing, and the billing
  summary surface's own client fetch completing under `connect-src 'self'` — with zero
  genuine violations and zero CSP-caused JS or worker errors. No page was counted as
  passing for returning 200.
- **Discovered outside this slice, recorded so it is not lost:** production signup
  answered 403 (above) — **fixed in Slice 3.1.1**. Independently, `scripts/processing-pilot-probe.mjs`'s
  documented recipe (`npx next start -p 3001` with a loopback
  `NEXT_PUBLIC_SITE_URL`) was no longer runnable — `next start` refuses under
  `output: standalone`, and the startup gate refuses a loopback site URL. **Corrected in
  Usage Limits Slice 2**: the header now documents the standalone artifact behind
  `scripts/tls-front.mjs`, and the probe was re-run that way at 41/41.
- **Validation at the close of 3.2.** `npx prisma validate` OK, `npx prisma generate`
  OK, `npm run typecheck` clean, `npm run lint` **0 errors** (11 warnings, all
  pre-existing and none in a file this slice touched), `node scripts/next-build.js`
  green, `npx vitest run` **318 files / 6498 tests / 0 failed** (from 317 / 6476),
  `npm run test:export-fidelity` **32/32**, enforced CSP browser probe **114/114**
  (from 74/74), processing pilot **41/41**, editor persistence probe all passed under
  the enforced policy.
- **Next related step:** usage-limit enforcement — `usageLimits=observe` in the startup
  gate means quotas are metered and recorded but nothing is refused. Not started here.

## Proxy-Aware CSRF origin validation (Launch Readiness Slice 3.1.1)

Browser signup against the production artifact answered **403 `CSRF_ORIGIN_REJECTED`**
for a request that was genuinely same-origin. This slice makes the same-origin check
correct behind a reverse proxy without loosening it, and proves it on the real
standalone runtime rather than only in unit tests — because unit tests had been green
through the entire defect.

### Root cause

One line, `src/application/services/workspaceCsrf.ts:14`:

```ts
const expected = new URL(request.url).origin;   // the SERVER's bind address
```

Next's standalone server builds the route-handler request URL from the address it bound,
not from the address the browser typed: `next/dist/server/lib/start-server.js` sets
``appUrl = `${protocol}://${hostname}:${port}` ``. Behind a TLS terminator the browser
sends `Origin: https://pdfdadi.example` while `request.url` is
`http://127.0.0.1:3000/…`, so the comparison fails and every mutation is refused.

**Development matched by coincidence, not by design.** You browse the bind address
directly there, so `request.url` and `Origin` agree. That coincidence is also why the
suite stayed green: vitest runs with `NODE_ENV=test`, so the dev branch accepted the
request origin. The defect was only reachable when the public origin differs from the
bind address — i.e. in every real deployment and no test.

**It was never a signup bug.** `requireSameOrigin` is the shared seam: ~90 mutating
routes reach it, directly or through the re-export at `src/application/services/workspaceHttp.ts:15`.
A grep for other uses of a request URL as security authority found none — this was the
only one, so the fix is one function and the blast radius is every mutating route at once.

### The trusted origin authority

`getConfig().siteUrl` — `NEXT_PUBLIC_SITE_URL`, normalized through `new URL(...).origin`.
Reused rather than introduced: the production configuration gate already refuses to boot
unless that value is an absolute `http(s)` URL on a non-loopback host, so the trusted
origin inherits validation that already exists and no new environment variable or config
surface was added. In development the request origin is *additionally* trusted, which
preserves the existing practical localhost behaviour (any port, a LAN IP, a tunnel).

Comparison is **exact string equality against the pre-normalized origin**, and only ever
origin-to-origin — never a full URL, never a prefix, suffix or substring. That is both
stricter and less code than re-parsing: browsers emit canonical origins (lowercased scheme
and host, default port omitted, no path, no credentials), so `https://pdfdadi.example/`,
`https://pdfdadi.example:443`, `HTTPS://PDFDADI.EXAMPLE` and
`https://pdfdadi.example@evil.example` are all rejected without a single special case.

### Forwarded-header trust policy: none of them are read

`Host`, `X-Forwarded-Host`, `X-Forwarded-Proto` and RFC 7239 `Forwarded` are **never
consulted**, because this repo has no trusted-proxy model that would make them
authoritative. They are client-supplied strings; trusting one would let an attacker name
our origin and authorize their own cross-site request. The terminator used for the proof
*does* set `x-forwarded-proto` and `x-forwarded-host`, so correctness-without-reading-them
is demonstrated rather than assumed.

### Behaviour, unchanged where it was already deliberate

`Origin` first; absent, fall back to `Referer`'s origin; absent both, refuse with
`CSRF_ORIGIN_REQUIRED`. Missing-Origin policy, precedence and both error codes are
byte-identical to before — a same-origin check is not something to loosen as a side
effect of a proxy fix. **Fail-closed:** if the config cannot be read the trusted set is
empty and every mutation is refused; production cannot reach that state anyway, since
`instrumentation.ts` calls `getConfig()` at boot.

### Proven on the real runtime, which is the point of this slice

Same environment as the CSP probe: the standalone artifact on `http://127.0.0.1:3002`
behind the `https://<lan-ip>:3001` terminator, production gate unweakened
(`env=production storage=local queue=memory billing=disabled usageLimits=observe`).

- **Through an actual browser:** account created from the page, same-origin, over https →
  **201**; the `Secure; HttpOnly; SameSite=lax` session cookie arrived (proven by the
  authenticated `/workspaces` shell rendering, not by reading `document.cookie`, which
  cannot see an HttpOnly cookie); a representative authenticated mutation
  (`POST /api/workspaces/provision-default`, with a real `organizationId` read from
  `GET /api/workspaces?limit=1`) → **200**.
- **Cross-origin refusal, on the same runtime:** cross-origin signup → **403
  `CSRF_ORIGIN_REJECTED`**; the *same* authenticated mutation with the *same* session
  cookie and a foreign `Origin` → **403** (the only variable is the Origin header);
  an evil `Origin` carrying forged `X-Forwarded-Host: evil.example`,
  `X-Forwarded-Proto: https` and `Host: evil.example` → **403**; and naming the internal
  bind origin `http://127.0.0.1:3002` → **403**, which proves the trusted origin was
  *replaced* rather than *added to*.
- **Why the rejection half is asserted from Node, not from an iframe.** The first attempt
  used a `data:text/html` iframe and did two things wrong: it added a `frame-src`
  violation to the CSP walk, and it passed *vacuously* — the cross-origin fetch never
  happened, the iframe threw on reading `fetch` from a blocked window. Deleted. Minting a
  session with a correct Origin and then replaying it with hostile Origins isolates the
  variable properly, and it removed the violation without touching the policy or the
  classification table.

### Authenticated CSP report-only walk

`scripts/csp-probe.mjs` extended (not duplicated) — **74/74, 0 failed, 0
environment-limited**, up from 64/64 with the authenticated shell reported
ENVIRONMENT-LIMITED. **The policy and the classification table were not modified.** The
classification stayed closed and produced no new class: `FIX-CODE script-src-elem inline
×152` (now including `workspaces`) and `NOISE img-src https://csp-probe.invalid/… ×1`.
The authenticated shell's inline scripts are the same React Flight RSC payloads, which
belong to nonce enforcement in 3.2.

### Tests (37 new, `src/application/services/workspaceCsrfProxyOrigin.test.ts`)

Against the shared seam, not per-route copies. Production mode is simulated by setting a
real production env and calling `_resetConfigForTests()`, so these tests exercise the
branch the existing 13 in `workspaceHttp.test.ts` structurally could not reach.

- **The regression itself:** public `Origin` + internal bind `request.url` → allowed;
  unproxied → allowed; public `Referer` → allowed; **the internal bind origin → 403**.
- **Look-alikes, all 403:** `https://evil.example`, scheme mismatch (`http://` vs
  `https://`), wrong port (`:8443`), suffix confusion (`pdfdadi.example.evil.com`),
  prefix confusion (`evilpdfdadi.example`), subdomain (`sub.pdfdadi.example`), trailing
  dot, both userinfo tricks, trailing slash, `"null"`, `"not a url"`, `" "`; foreign and
  malformed `Referer`; missing both → `CSRF_ORIGIN_REQUIRED`.
- **Forwarded headers are not an authority:** evil `Origin` paired with each of
  `x-forwarded-host`, `x-forwarded-proto`+`host`, `host`, `forwarded`, a forwarded-host
  naming the real site, and all at once → 403 every time; plus the converse, that forged
  headers cannot *un*-authorize a genuine request.
- **Fail-closed and dev:** an unreadable site URL refuses everything, including the
  origin that would otherwise be valid; dev still works on `:3001` and on a LAN IP, and
  still rejects an evil origin.
- **Wiring, because a pure policy test proves nothing about its consumer:** signup at an
  internal bind URL with the public Origin → 201 with the session cookie set and
  `register` called; cross-origin → 403 with `register` **not** called; `POST /api/workspaces`
  with a session cookie → 201 with `createWorkspace` called; cross-origin → 403 with
  neither `createWorkspace` nor `getMe` called (refused before the session is even read).
- **Two anti-vacuity guards, because a failing production gate would make every 403
  assertion pass for the wrong reason:** a `guards the gate` test asserting `getConfig()`
  does not throw and reports `isProduction` with the expected `siteUrl`, plus a
  co-located allow-case in each rejection block.

### Mutations (6, all red, exact bytes restored — SHA-256 re-verified after each)

Repo is not Git-backed, so: byte backup → SHA-256 → mutate → prove red → restore → verify
SHA `4e1f76290d675ca67efa5cb4df6e33dc22657995b17fd2b1200e637bf2216db8` → prove green.

| Mutation | Red |
|---|---|
| M1 `request.url` as the sole trusted origin (the original defect) | 9 |
| M2 trust `X-Forwarded-Host` | 2 |
| M3 substring/suffix origin comparison | 10 |
| M4 accept any `Origin` | 31 |
| M5 trust `Host` | 3 |
| M6 trust RFC 7239 `Forwarded` | 2 |

M2 turning only 2 red is correct rather than thin coverage — only the cases exercising
that one header can catch it — but it is why M5 and M6 were added, so the whole
forwarded-header policy is mutation-covered rather than just the best-known member of it.

### Key files

`src/application/services/workspaceCsrf.ts` (the fix — the only file changed in the
product), `src/application/services/workspaceCsrfProxyOrigin.test.ts` (new),
`scripts/csp-probe.mjs` (extended). Read but unchanged:
`src/infrastructure/config/env.ts`, `src/application/services/workspaceHttp.ts`.

### Known limitations

- **No trusted-proxy model exists, and adding one is deferred.** A deployment that needs
  to serve several public origins from one process has no way to express that today; the
  trusted set is exactly `NEXT_PUBLIC_SITE_URL`. That is the right default and the reason
  no header is trusted, but it is a constraint rather than an oversight.
- **Missing-Origin still refuses.** Deliberately preserved, not re-examined. A non-browser
  client that sends neither `Origin` nor `Referer` cannot mutate.
- ~~**`scripts/processing-pilot-probe.mjs`'s header comment is still stale**~~ — **corrected
  in Usage Limits Slice 2**; the header now documents the standalone artifact behind
  `scripts/tls-front.mjs`, and the probe was re-run that way at 41/41.

### Next related step

~~Nonce-based CSP enforcement (3.2)~~ — **shipped and enforced**; see the CSP section
above, which records 3.1 and 3.2 together. This pointer was written while 3.2 was still
outstanding and is kept only so the sequence reads correctly: 3.1.1 landed alongside 3.1,
before enforcement. Both of the CSP limitations that pointer referred to — `report-to`
adoption and alerting — are closed by the `report-to` slice at the end of this ledger.

---

## Usage hard enforcement path (Usage Limits Slice 1)

Hard enforcement was already written — `USAGE_LIMIT_MODE=enforce` has been a supported
value since the calibration slice — but it had never been *run*. Every test that touched
it either exercised the pure policy or the service against fakes; nothing had ever put
`enforce` in front of a real HTTP request, a real Prisma counter, real staging and a real
worker at once. This slice proves the blocking path end to end on an isolated deployment
and leaves production on `observe`, because the readiness verdict still says so.

**No new quota system.** Nothing about the meters, the ceilings, the increment-first
reservation or the durable settlement was replaced. The enforcement path is the one that
already existed; what is new is a shared refusal body, a denial panel, and a probe that
runs the real thing.

### The two enforceable meters, and what admission actually does

`server_operations` (day) and `server_input_bytes` (day) are the enforceable pair;
`compute_units` and `ai_tokens` are month-window infrastructure ledgers and are never
enforced. Ceilings are read from the plan config — this slice changed none of them, and
the probe reads its fixture's ceiling from `/api/usage` at runtime rather than typing a
number.

Admission ordering in `lib/server/processingJobSubmit.ts`, unchanged and now
mutation-covered:

```
parse → validate → authorize → [refuse] → stage → create job → queue
```

`authorize` sits **after** validation so the reserved byte count is the measured size and
not a `content-length` the client chose, and **before** `uploadStream` so a refused
submission never costs a write to storage. A refusal therefore leaves no job row, no
`StoredFile`, no file on disk, no queue entry, no worker attempt and no compute-unit
event — and the probe asserts each of those against an *observed* +1 control, so "nothing
happened" cannot pass by nothing being measured.

Refusals leave the service as `UsageLimitError` and reach the client through one shared
body (`lib/server/usageLimitResponse.ts`, new): **429**, `Retry-After` when the meter has
a reset, and exactly two JSON keys — `error` (a static `DENY_MESSAGES` string) and
`reason` (the closed vocabulary `meter_exhausted` / `file_too_large` /
`too_many_concurrent`). The error's `meter`, `limit`, `used` and `plan` are dropped: a
meter key is an internal counter identifier and `(limit, used)` is the counter showing
through a public response. Shared rather than written twice, because the version of this
that ships is the one that leaks a counter in one of the two routes and not the other.

### Concurrency, retry and recovery accounting — all unchanged, all now proven

- **Concurrency.** Two simultaneous submissions with one operation left: exactly one
  **202** and one **429**, one new job row, and the counter lands in `[LIMIT-1, LIMIT]` —
  never above the ceiling. The increment-first algorithm was kept: `reserve()` applies the
  delta, then re-runs *the same* `evaluateLimits` against the post-increment totals, and
  the loser is refunded. No second limit rule was written.
- **Worker retry.** No `authorize` on the retry route or in `retryJob`, so a retry buys no
  further customer operation. A 3-attempt terminal failure charged **1** operation up
  front, recorded **3** attempt events, and settled back to **0** with exactly **one** new
  `UsageSettlement` row. `compute_units` still equals the sum of `costUnits` across every
  attempt event — per-attempt infrastructure cost is preserved and never refunded.
- **Exactly once.** The durable `usage_settlements` design is untouched: settlement is
  claimed once per job by primary key, so a second terminal write refunds nothing. The
  refund lands in `reservation.reservedAt`'s window, not the window the worker happened to
  finish in.
- **Local tools stay quota-free.** `authorize` returns early for an unmetered tool before
  any counter is read, so a browser tool writes no counter row at all — the property is in
  the control flow, not in an amount that happens to be zero. Proven twice: `/tools/merge-pdf`
  still serves 200 while the account is exhausted, and pushing a local slug at `/api/jobs`
  answers **404** with no counter movement.

### Runtime probe: `scripts/usage-enforcement-probe.mjs` (new) — **30/30**

Two throwaway production deployments, each on its own SQLite file under `mkdtemp` and its
own storage root, `prisma migrate deploy`d from the real schema. The real app path: real
routes, real Prisma, real staging, real in-process worker.

1. **Anti-vacuity first.** The fixture's configured ceiling is read from `/api/usage`
   before anything is tested against it, and the probe throws if the app does not report a
   usable one (observed: 100 operations/day, `mode: "enforce"`).
2. An in-allowance submission is admitted and moves operations, job rows, `StoredFile`
   rows and files on disk each **+1** — this is the observed-change control for every
   later "nothing happened".
3. The operation that brings the total to exactly the ceiling is admitted (`wouldExceed`
   is `>`, so the boundary op is the last free one); the next is refused.
4. The refusal is 429 with `Retry-After`, body keys exactly `{error, reason}`, no meter
   key, no `usage_counter`, no ceiling digits, no owner id — and exactly **one**
   `limit_reached` event with `enforced: true` carrying only taxonomy-allowed properties.
5. The concurrent boundary race: one 202, one 429, counter never above the ceiling.
6. `/api/usage` used / limit / remaining / degraded agree with the authoritative counter
   rows.
7. Local tool unmetered while exhausted (above).
8. Failure, refund, and a retry that answers 409 `attempts_exhausted` with no counter or
   settlement movement.
9. **Second deployment, `USAGE_LIMIT_MODE` unset** (deleted from the child env, so the
   default is observed rather than supplied): `/api/usage` reports `observe`, the *same*
   over-limit request is admitted, the work is still counted, and the would-have-denied is
   recorded with `enforced: false`. Observe mode still never blocks.

Every counter claim is fenced by a `quiesce()` (no job in flight **and** the counter
stable across two reads) and every seeded value is written into the window the application
itself opened — never a period the probe computed. The boundary claim is made by an
immediately-following submission rather than an instantaneous counter read, because a
refund needs ≥1.5 s of retry backoff and the two requests are ~30× closer together than
that.

**Production activation is explicitly not covered.** The probe *supplies*
`USAGE_LIMIT_MODE=enforce` to a disposable deployment. Whether production may switch is
the readiness verdict's decision, below.

### Calibration verdict — run, not assumed

`UsageAnalyticsReadService.calibration()` — the existing analysis, read-only, against the
real developer database, thresholds untouched and no data manufactured:

| Window | `ready_for_enforcement` | `reason` | Gaps |
|---|---|---|---|
| 7 days (default) | **false** | `insufficient_observation_data` | 7 of 14 days · 54 of 500 operations · 2 of 3 tools |
| 92 days (`MAX_REPORT_DAYS`) | **false** | `insufficient_observation_data` | 54 of 500 operations · 2 of 3 tools |

`degraded: false` in both — the counters were genuinely read, so this is a verdict over
real data rather than a failed-read fallback. `limitMode: "observe"`, `limitEvents: 0`,
`wouldHaveBlocked: 0`.

**Production stays `USAGE_LIMIT_MODE=observe`.** Nothing in this slice changes the default
or the deployed value.

**Operator note, found the hard way:** Prisma resolves a relative SQLite URL against the
**schema** directory, so `.env`'s `DATABASE_URL="file:./prisma/dev.db"` is
`prisma/prisma/dev.db` (1.4 MB, the real observation data). The `prisma/dev.db` a
repo-root-relative reading suggests is a stray 0-byte file. Reading the wrong one makes
the observation dataset look empty when it is not.

### Mutations (6, all red, exact bytes restored — SHA-256 re-verified after each)

Repo is not Git-backed, so: byte backup → SHA-256 → mutate → prove red → restore → verify
hash → prove green. Each mutation asserts its own pre-image exists exactly once, so a
mutation that silently no-ops is a hard error rather than a green run.

| Mutation | Red |
|---|---|
| M1 `shouldBlock` drops `enforced` — observe mode starts blocking | 4 |
| M2 `wouldExceed: false` — enforce mode admits past the ceiling | 10 |
| M3 admission moved after staging (validate → stage → authorize) | 2 |
| M4 post-increment re-evaluation stops refunding — both racers win the last slot | 2 |
| M5 `authorize` added to the retry route — a retry buys a second operation | 1 |
| M6 the denial panel reads `localStorage` and computes its own remaining | 2 |

### Key files

New: `lib/server/usageLimitResponse.ts`, `scripts/usage-enforcement-probe.mjs`.
Changed: `app/api/jobs/route.ts`, `app/api/tools/[slug]/route.ts` (both map
`UsageLimitError` through the shared body), `lib/server/meteringSubmitWiring.test.ts`
(+7 → 19). Audited and deliberately **unchanged**: `src/domain/metering/decision.ts`,
`src/application/services/UsageMeteringService.ts`, `lib/server/processingJobSubmit.ts`,
`app/api/jobs/[id]/retry/route.ts`, `app/api/usage/route.ts`,
`src/domain/metering/readiness.ts`, `src/domain/metering/events.ts`.

### Known limitations

- **Enforcement has never run in production**, by design. It is proven on isolated
  fixtures; the activation decision belongs to the verdict above.
- **The in-browser walk of "a local tool works while exhausted"** is delegated to
  `scripts/processing-pilot-probe.mjs` §6, which watches Chrome's own network stack. The
  enforcement probe makes the server-side version of that claim (a local slug pushed at
  `/api/jobs` while exhausted → 404, no counter movement) and reports the browser half as
  environment-limited rather than claiming it.
- ~~**`scripts/billing-probe.mjs` and the pilot probe's header recipe** both configure a
  loopback `NEXT_PUBLIC_SITE_URL` under `NODE_ENV=production`, which the Slice 1 boot gate
  refuses.~~ **Fixed in Usage Limits Slice 2.** Both now boot the standalone artifact with a
  non-loopback configured origin; the pilot probe additionally fronts it with real HTTPS.
  Re-verified: billing probe **78/78**, pilot probe **41/41**. The gate was not weakened.

### Next related step

Activation is gated on the existing thresholds being met on real traffic: **≥14
observation days, ≥500 operations, ≥3 distinct tools** in the calibration window, with
`ready_for_enforcement: true`. Until then production stays `observe`. No threshold was
altered to get closer to that.

---

## Quota denial UX (Usage Limits Slice 1)

A refused submission used to reach the user as `ErrorBanner`: one red sentence that
answers "it failed" but neither "what limit" nor "what can I do". This adds the smallest
panel that answers both, and nothing more — the banner is still the right answer for every
other failure.

### `components/tools/QuotaNotice.tsx` (new)

Limit reached, the current plan, the reset when there is one, and the upgrade control when
the deployment can actually sell Pro. Copy comes from `quotaNoticeView` in
`components/app/usageViewModel.ts` (pure, tested) keyed off the refusal's `reason`.

**The numbers come from the server, never from the client.** The panel fetches
`/api/usage` (`cache: "no-store"`) and parses it with the existing `parseUsage`; the only
thing threaded in from the failed submit is the `reason`. It performs no quota arithmetic
of its own and reads no `localStorage` — a client that subtracts its own remaining
allowance is wrong the moment a window rolls over or a second tab spends it. Both
properties are mutation-covered (M6).

**Nothing here can break the tool.** Both async paths are total: the usage fetch catches
everything and falls back to a panel with no plan line, and `ProUpgradeAction` owns its own
state and renders nothing when Pro is not purchasable — so a billing outage costs the panel
a button, not the user their PDF. The panel renders only *after* a failed submit, so it
never stands between anyone and a tool run.

**No internals reach the user.** No meter key, no counter, no owner id, no raw exception
text — the body carries none of them and the panel derives its sentence from the domain's
static copy rather than from a response string.

### One classifier, two surfaces

`readDenialReason(status, body)` returns a reason only for a **429** whose `reason` is in
the closed vocabulary — so a rate limiter's 429 keeps the generic banner. Both server-work
surfaces route through it (`ServerToolRunner`, and `useProcessingJob` for the pipeline
runner) and each renders the panel *or* the banner, never both. The refusal is cleared when
new work starts, so a stale panel cannot linger. The browser-only runners are deliberately
untouched: a local tool is never metered, so a quota panel has no business in one.

### Analytics: the existing event, emitted once, by the server

No new event and no new property. `limit_reached` is emitted where the decision is made —
in `UsageMeteringService`, through `sanitizeEventProperties`, with `meter`, `reason`,
`enforced` — and by no client surface, so a user hammering Submit cannot duplicate the
event that feeds the calibration dataset. The probe asserts exactly one event per
authoritative refusal, `enforced: true` under enforce and `false` for an observe-mode
would-have-denied.

### Key files

New: `components/tools/QuotaNotice.tsx`, `components/tools/quotaDenialUx.test.ts` (17).
Changed: `components/app/usageViewModel.ts` (`readDenialReason`, `quotaNoticeView`),
`components/tools/runners/ServerToolRunner.tsx`,
`components/tools/runners/PipelineToolRunner.tsx`, `hooks/useProcessingJob.ts`.

### Known limitations

- **Never rendered in a browser by a test.** vitest is `environment: "node"`, so the panel
  is covered by pure view-model tests plus source-text assertions on the component. The
  browser-level proof of a *denial* panel needs a deployment in `enforce` mode, which
  production is not; the enforcement probe proves the 429 and the event, not the pixels.
- **Reset time is shown only where a reset is meaningful.** `file_too_large` gets none —
  waiting does not change a file's size, and a countdown would send the user back to fail
  again.

### Next related step

Nothing outstanding in the UX itself. It becomes user-visible the moment enforcement is
activated, which is gated on the calibration verdict above.

---

## Observation readiness and browser quota proof (Usage Limits Slice 2)

Slice 1 shipped metering, the 429 path, and a readiness verdict. Two things were still
unproven: that the observation the verdict rests on is *counting the right thing*, and that
a refused person is ever *told* anything. Enforcement was **not** activated, and no
threshold was touched.

### Observation-integrity audit — three real counting defects, fixed

| # | Defect | Effect on the verdict |
|---|---|---|
| A | The admin route sent no `from`/`to`, so `boundReportWindow` fell to `DEFAULT_REPORT_DAYS` (7) | observed days was **structurally capped at 7** against a 14-day threshold — the gate could never open, whatever the traffic |
| B | "Observed days" was the *requested span*, not days carrying traffic | a 92-day date picker erased the days gap; the threshold was satisfiable by widening a dropdown |
| C | `settleProcessingOutcome` records the attempt event *before* its `!metered` guard, so local and unknown-slug attempts entered the ledger | in-browser work inflated operations and distinct tools — a local-only month could authorize a **server** ceiling |

A and B: `observedOperationDays(window, toolSlugs)` added to `IUsageRepository` and both
implementations — distinct UTC calendar days carrying a completed attempt for an allowlist
of slugs, counted in JS because SQLite and Postgres disagree on `date()`. An **empty**
allowlist means "count nothing", matching `eventCounts`. `CALIBRATION_DEFAULT_DAYS = 30`
so calibration reads wider than the page around it.

C is fixed in the pure judge rather than at the ingest site, because the ledger row is
legitimate — it is the *readiness arithmetic* that must not use it. `serverOperationsOf()`
sums only `executionMode === "remote_job"` tools, and `observed.excludedOperations`
surfaces the difference so two operation counts on one page do not disagree unexplained.

**Audited and confirmed NOT defective:** client ingest never sets `result`, so it cannot
forge a completed attempt; `limit_reached` is written server-side only; the `lt: to`
boundary is immaterial at day granularity; anonymous and authenticated actors both carry
`ownerType`, and `subjectHash` is never grouped on.

### Retention — safe already, so tested rather than changed

`pruneEventsBefore` / `pruneCountersBefore` have **no production caller**. The
`file-retention` sweep touches only `StoredFile` and storage keys under
`["tool-inputs/", "jobs/"]`. `usage_events` carries no `@relation` and no `Cascade`, so
deleting a job or a user cannot take ledger rows with it, and `usage_settlements` is never
pruned. Nothing shortens the observation window. Per the brief this was **documented and
pinned** (`usageObservationRetention.test.ts`, 6 tests) rather than "fixed"; no indefinite
retention was added.

### Calibration progress surface

`components/admin/AnalyticsDashboard.tsx` renders the existing
`UsageAnalyticsReadService.calibration()` — no second analytics subsystem, no new route.
Mode, verdict, reason, the measured window (stated, because it is wider than the page's),
a six-stat grid (**Days with traffic** / Server operations / Server tools used / Per day /
Guest share / Limit events) each against its threshold, the excluded-operations sentence,
would-have-blocked, gaps, and a `role="status"` amber banner when any read degraded. Every
figure is an aggregate; the page names no owner id, subject hash, event row or secret.

### `scripts/usage-readiness.ts` — read-only readiness command

`npm run usage:readiness [-- --days N] [--json]`. Runs the *same* service and the same
domain judge, so there is no second copy of "fourteen days, five hundred operations" to
drift. Read-only twice over: the repository reaches the service through a Proxy that
throws `ReadOnlyViolation` on all six mutating port methods, **and** the SQLite file's
SHA-256 is compared before and after, exiting 3 on any change — a guard nobody checks is a
comment.

Database resolution follows Prisma's actual rule: a relative `file:` URL resolves against
the **`prisma/` schema directory**, so this repo's `file:./prisma/dev.db` means
`prisma/prisma/dev.db` (1.4 MB) and *not* `prisma/dev.db` (a 0-byte decoy that has already
fooled one tool into reporting an empty ledger as an empty product). `DATABASE_URL` →
`.env` → dev default, the same three steps the app takes.

### Browser quota proof — `scripts/usage-quota-browser-probe.mjs`, 45/45

The gap this closes: vitest is `environment: "node"`, so `QuotaNotice` had **never been
mounted by any test**. A fully green suite was compatible with the panel throwing on mount,
rendering with no plan or reset, rendering *beside* the red banner, or a local tool showing
a quota panel it has no business showing.

The probe stands up its own throwaway deployment — fresh SQLite under `$TMPDIR`,
`prisma migrate deploy`, the standalone artifact with `USAGE_LIMIT_MODE=enforce`, a
self-signed terminator on a LAN address, one Chrome reused across restarts so the anonymous
cookie jar survives. **Real HTTPS is load-bearing, not decoration:** `pdfdadi_jid` is
`Secure` in production, so on plain `http://` Chrome drops it, every request resolves a
different anonymous owner, and the counter can never accumulate — the quota would never
exhaust and the probe would report a UX bug that is really a cookie.

| § | Proved |
|---|---|
| 1 | mode is `enforce`; the ceiling is **read from `/api/usage`** (30/day, Guest) — no number is typed anywhere in the probe |
| 2 | a real submission is **admitted** (202), the meter moves, a real anon-owned job row exists |
| 3 | the **last** allowance is admitted, and the server's own projection reports `used == limit, remaining == 0` |
| 4 | the next submission is **429 on the wire**, from the **pipeline** runner (its submit carries an `Idempotency-Key`); **exactly one** amber alert; domain copy; plan label; reset text; no meter key/counter/owner; the ceiling itself is not printed; **zero** red banners; the upgrade control is **absent** where Pro cannot be sold; no client exception; the counter did not move; no job row |
| 5 | with `PROCESSING_PIPELINE=off` the **legacy** runner (no `Idempotency-Key`) hits the same 429 and the **same single panel** — one shared denial UX, not two |
| 6 | `merge-pdf` while the server allowance is spent: really produced output and its **Download** control works, **no** quota panel, **zero** `/api/jobs?slug=` submits, counter and job count unchanged |
| 7 | restart with `USAGE_LIMIT_MODE` **unset** → mode `observe`, and the *same* submission that was refused is **admitted**, the overage recorded rather than blocked |

Anti-vacuity is the design: § 3 must show an admission and the exact boundary before § 4
may claim a denial; § 6 must show a working download before "no quota panel" means
anything; § 7 must show the refusal *reversing*, so a build that can never refuse and a
build that always refuses both fail. Job counting is scoped to `toolSlug != null`, because
the recurring `file-retention` sweep sits at `queued` by design and would make "no new job"
a coin flip.

### Probe recipes corrected (both re-verified by running them)

- **`scripts/billing-probe.mjs`** — now boots the production runtime instead of `npx next
  start`, which refuses under `output: standalone`. (It booted `.next/standalone/server.js`
  when this was written; since the ingress closeout it spawns `node ingress/server.mjs`,
  which loads that file itself.) With a
  non-loopback `probe-billing-<port>.test` origin used for both `NEXT_PUBLIC_SITE_URL` and
  the `Origin` header. No HTTPS terminator: it is `fetch`-based with its own cookie jar.
  **78/78, exit 0.** No real Stripe verification was attempted.
- **`scripts/processing-pilot-probe.mjs`** — header rewritten around the three constraints
  that actually bind (standalone artifact; the gate refuses a loopback site URL; `Secure`
  cookies need real HTTPS or § 5 404s on a different resolved actor). It now passes
  `--ignore-certificate-errors` and sets `NODE_TLS_REJECT_UNAUTHORIZED=0` **itself** for an
  https target — a recipe step that only matters on one transport is a step people omit,
  and omitting it made § 0 report "app is serving: FAIL" against a server that was serving
  perfectly. The recipe points at a **throwaway** database, not `prisma/prisma/dev.db`:
  this probe runs real operations, and aimed at the developer DB it would count probe
  traffic as production observation. **41/41.**
- **`scripts/tls-front.mjs`** (new) — the reusable self-signed terminator both recipes name.
  Certificate generated per run into a temp dir; no repo file and no keychain learns about
  it.

### Mutation testing

Exact backup + SHA-256 → mutate → RED → exact restore → **hash match** → GREEN. All five
caught; the working tree is byte-identical afterward.

| Mutation | Caught by |
|---|---|
| a degraded calibration read may report READY (`if (false && observation.degraded)`) | 3 tests |
| a local in-browser operation counts toward the server-operation threshold (drop the `remote_job` filter) | 3 tests |
| the quota notice renders for **any** 429 (unknown reason falls back to `meter_exhausted`) | 1 test |
| the readiness command may write to the database (defuse the Proxy guard) | 1 test |
| the days stat relabelled "Days observed" and the degraded banner removed | 2 tests |

### Current REAL calibration numbers

Read by `npm run usage:readiness` against `prisma/prisma/dev.db`, whose SHA-256
(`86f9eef5…38df79`) was **byte-identical before and after** every readiness run and every
probe in this slice:

```
ready_for_enforcement  false
reason                 insufficient_observation_data
days with traffic      3 / 14
server operations      54 / 500
server tools used      2 / 3      (compress-pdf 48, repair-pdf 6)
operations per day     18.0 (mean)
guest share            96%
would have blocked     0
limit events recorded  0
```

The days figure **dropped from 7 to 3** as a direct result of defect B: 7 was the span the
old code asked for, 3 is the number of days that actually carry server traffic. The lower
number is the honest one. No event was inserted, backdated or reclassified to move any of
these; no threshold was lowered.

### Key files

New: `scripts/usage-readiness.ts`, `scripts/usageReadinessCommand.test.ts` (7),
`scripts/usage-quota-browser-probe.mjs`, `scripts/tls-front.mjs`,
`src/application/services/usageObservationRetention.test.ts` (6).
Changed: `src/application/ports/metering/UsageRepository.ts` (+`observedOperationDays`),
`PrismaUsageRepository.ts`, `InMemoryUsageRepository.ts`,
`src/domain/metering/readiness.ts` (+`serverOperationsOf`, `excludedOperations`),
`UsageAnalyticsReadService.ts` (`CALIBRATION_DEFAULT_DAYS`, `boundReportWindow` default),
`app/api/admin/analytics/route.ts`, `components/admin/AnalyticsDashboard.tsx`,
`readiness.test.ts` (24), `usageCalibration.test.ts` (23),
`adminAnalyticsSurface.test.ts` (+5 → 13), `scripts/billing-probe.mjs`,
`scripts/processing-pilot-probe.mjs`, `package.json` (`usage:readiness`).

### Known limitations

- **The observation dataset is a development one.** 3 days / 54 operations / 2 tools is
  real traffic, not synthetic — and it is nowhere near the gate. READY has to be **earned**
  by production traffic; nothing here can shorten that.
- **The `enforce` path has still never run in production.** It is now proven end to end in
  a real browser, but on an isolated fixture.
- **`observedOperationDays` counts days in application code**, not SQL, to keep SQLite and
  Postgres agreeing. At production ledger sizes this reads more rows than a `GROUP BY`
  would; it is a once-per-dashboard query on a bounded window.

### Next related step

Production **stays in `observe`**. The activation condition is unchanged and unmet:
`ready_for_enforcement: true` — that is **≥14 days carrying server traffic, ≥500 server
operations, ≥3 distinct server tools** in the calibration window, with no degraded read.
Check it with `npm run usage:readiness`; flip `USAGE_LIMIT_MODE=enforce` only once that
prints `true`.


---

## CSP `report-to` on https origins, and the decision not to page (Launch Readiness Slice 3.3)

The CSP section above closed 3.2 with two reporting limitations: `report-to` absent, and
a report stream nobody is alerted by. This slice closes both. It changes **no directive
that decides what a browser may load** — only where violations are delivered, and how
loudly they are logged.

- **`report-to` is adopted, conditionally, and `report-uri` stays.** The spec rule that
  governs everything here: the *mere presence* of `report-to` suppresses `report-uri`,
  and the Reporting API needs a **secure context**. Measured with headless Chrome:

  | origin | `report-uri` alone | `report-to` alone | both |
  |---|---|---|---|
  | http  | delivered <1 s | nothing | **nothing** |
  | https | delivered <1 s | delivered ~60 s | delivered ~70 s |

  So `report-to` is emitted **iff the configured site origin is https**, and `report-uri`
  is emitted always. Chrome takes `report-to`; Firefox and Safari have no CSP Reporting
  API and take `report-uri`. On a plain-http dev or staging origin the directive is
  absent, which is the only reason http reporting still works at all.
- **The scheme test reads the *configured* origin, never the request.** `reportingEndpointFor()`
  in `lib/security/csp.mjs` parses the site URL, returns `null` for anything but `https:`,
  and otherwise returns an absolute `<origin>/api/csp-report` through the existing
  `assertConcreteOrigin` (so a wildcard origin throws rather than shipping). Deriving the
  endpoint from `Host`/`x-forwarded-*` would let a caller choose where this origin's
  violation reports — which carry blocked URLs and document paths — are delivered. A test
  sends a spoofed `host`, `x-forwarded-host` and `x-forwarded-proto` of `evil.example` and
  asserts the advertised endpoint is unmoved.
- **A directive naming an undefined group delivers nothing, silently.** Reporting API v1
  pairs the policy directive `report-to <group>` with a response header
  `Reporting-Endpoints: <group>="<absolute url>"`. Miss the header and the failure is
  indistinguishable from having no violations. So one module owns both halves —
  `CSP_REPORT_GROUP`, `reportingEndpointsHeader()` — and the header ships from the same
  condition as the directive, on **every** response: documents through `proxy.ts`'s
  `withPolicy()` (including the admin 307 redirect), static assets through
  `next.config.mjs`. The static path is load-bearing, not incidental: a Web Worker
  inherits the CSP of *its own* response, and pdf.js's worker is a
  `/_next/static/media/*.mjs` URL the proxy matcher deliberately excludes.
- **No transport work was needed.** `lib/security/cspReport.ts` already parsed both wire
  shapes (`application/csp-report` and the Reporting API's `application/reports+json`
  array), and already dropped `originalPolicy` — which would leak the nonce — and reduced
  an opaque `blocked-uri` to its scheme. Adopting `report-to` is a header change, not a
  parser change.

### Should a CSP violation page anyone? No — and here is the substitute

- **Nothing pages on `/api/csp-report`, deliberately.** The endpoint is unauthenticated
  by necessity: a browser cannot present a session to deliver a report. Its body is
  attacker-chosen. A pager reachable from it is a pager anyone with `curl` can hold down,
  and the on-call fatigue that follows is a security regression, not a security control.
  The reasoning lives in the route's own doc block, so the next reader does not have to
  rediscover it before "improving" it.
- **What the slice added instead is severity.** A report whose `disposition` is `enforce`
  means the browser **blocked** something — `logger.warn`. A report-only observation is
  `logger.info`. When the browser omits `disposition`, the stage the server is actually
  in decides, read from `CSP_HEADER` rather than duplicated. An operator can then alert on
  `level=warn module=csp-report` from their own pipeline and own the threshold, which is
  where a threshold belongs. `ConsoleLogger` routes `warn` to `stderr`, so the split is
  visible to a log shipper without parsing JSON.

### The defect this slice existed to find

`NEXT_PUBLIC_SITE_URL` **is substituted at build time**, and no unit test can see it.
Every test above passes against the source; the compiled middleware chunk contained the
literal `http://localhost:3000` and no lookup at all. A server started with the real
https origin therefore advertised no report endpoint — the whole slice dead on arrival in
exactly the build-once-run-anywhere deployment it exists for. Found by reading the built
artifact, not by testing.

The trap inside the fix is worth more than the fix. `const RUNTIME_ENV = process.env`
followed by `RUNTIME_ENV.NEXT_PUBLIC_SITE_URL` *reads* like a runtime lookup and is not
one: the minifier inlines the single-use alias back into a member expression and the
substitution lands anyway. That spelling was written, shipped a frozen literal, passed
typecheck, lint, 6563 tests and a source-text pin asserting exactly it. It was caught only
by **one build run under two different origins**. The fix is `{ ...process.env }` — an
object the substitution cannot see through, the same reason
`src/infrastructure/config/env.ts` gets a runtime value: it hands `process.env` whole to a
parser and never writes the member access. The proxy test now pins the spread, not just
the alias name; mutating it back to the alias turns the suite red.

### Verification

Both directions, against **one** normal production build of the standalone artifact, run
twice under different runtime origins — which is simultaneously the report-to proof and
the runtime-resolution proof:

- **https** (`scripts/tls-front.mjs` terminating TLS on a LAN IP in front of the artifact):
  `report-to csp-endpoint` present, `Reporting-Endpoints: csp-endpoint="https://<lan>:3001/api/csp-report"`
  on the document **and** on a static chunk, the browser's own report delivered to
  `/api/csp-report`, logged at `"level":"warn"` matching the live `enforce` disposition,
  with the planted secret `sk_live_…` in the browser's report and **absent** from the log
  line. `node scripts/csp-probe.mjs --url https://<lan>:3001` — **118/118**.
- **http** (same build, http LAN origin): `report-to` **absent**, `report-uri` intact,
  `Reporting-Endpoints` not sent at all. **118/118**, with two environment limitations
  the probe reports itself (a Secure cookie cannot ride plain http).
- The probe waits **95 s** on https, because Chrome's Reporting API batches on a ~60 s
  timer; a 30 s wait reads as "no violations" and is the same false green as a missing
  group.
- Mutation testing over the three test files: **11 mutations, 10 caught.** The survivor —
  "take the endpoint from the request `Host` instead of config" — is an **equivalent
  mutant** by design, not a coverage gap: `buildCsp` reads `reportEndpoint` only for
  truthiness, and the URL reaches the wire only through `Reporting-Endpoints`, computed at
  module scope from configuration. Rather than report a false 9/9, that fact was pinned
  (the policy text must not contain the endpoint or the site host) and three replacement
  mutations aimed at the header's *value* and *source* were run — all caught.

### Probe recipe corrections (both were live hazards)

- **The recipe pointed the probe's real signup and `compress-pdf` job at
  `prisma/prisma/dev.db`** — the production observation ledger `npm run usage:readiness`
  reads. Running it would have counted a test run as production observation toward
  enforcement. It now uses a throwaway `DATABASE_URL="file:$TMPDIR/csp.db"`, with the
  reason stated and the reminder that Prisma resolves a relative `file:` URL against
  `prisma/`, not the working directory.
- **TLS was configured by the operator instead of by the probe.** The recipe carried a
  `/tmp/chrome-insecure` wrapper and an exported `NODE_TLS_REJECT_UNAUTHORIZED=0` that
  only matter on one transport. The probe now detects an https `--url` and sets both
  itself (`--ignore-certificate-errors`, `NODE_TLS_REJECT_UNAUTHORIZED=0`), so the
  operator cannot half-apply them and read a TLS failure as a product failure.
- **A stale server process cost two false negatives in this slice alone** — `pkill -f
  ".next/standalone"` does not match `node server.js`, whose *cwd* carries that path.
  Confirm with `lsof -nP -i :<port>` and compare the process start time against the chunk
  mtime before believing a header is missing.

### Key files

`lib/security/csp.mjs` (`CSP_REPORT_GROUP`, `REPORTING_ENDPOINTS_HEADER`,
`reportingEndpointFor`, `reportingEndpointsHeader`, `buildCsp({ reportEndpoint })`),
`proxy.ts` (`RUNTIME_ENV`, `withPolicy`), `next.config.mjs` (build-time counterpart),
`app/api/csp-report/route.ts` (`wasBlocked` + the no-paging doc block),
`scripts/csp-probe.mjs` (https self-configuration, both directions, the 95 s wait).
Read but unchanged: `lib/security/cspReport.ts` — it already spoke both wire formats.

### Tests

`lib/security/csp.test.ts` 27 → **35** (the group name; `report-uri` kept beside
`report-to`; skipped on every non-https origin; absolute endpoint dropping a path and
preserving a port; `null` for missing or unparseable; throw on a wildcard https origin;
directive and header pinned to one group name; and the policy text must never contain the
endpoint or the site host). `proxy.test.ts` 18 → **23** (no group on http; group **and**
header on https; spoofed forwarded headers cannot move the endpoint; the pair rides the
admin 307; the build-time-substitution pin, including the spread). `app/api/cspReportRoute.test.ts`
10 → **14** (warn on `enforce`, info on `report`, stage-agnostic fallback when the browser
omits `disposition`, and an anti-vacuity check that the response is still 204 and still one
line per request). The route test's exact-import list **is** the "nothing pages"
guarantee, and says so.

### Known limitations

- **`next.config.mjs`'s header is build-time and cannot be otherwise** — `headers()` runs
  at build and is baked into `routes-manifest.json`. So a static asset advertises the
  endpoint of the origin the image was **built** for, while a document advertises the
  origin it is **running** on. They agree in any normal deployment and the probe asserts
  they agree; if they ever diverge, documents are right and static assets lag until a
  rebuild — the same tradeoff already recorded for `connect-src` storage origins.
- **Delivery latency is Chrome's, not ours.** ~60 s of batching means `report-to` is not a
  live console; `report-uri` remains the fast path, which is a second reason to keep it.
- **`report-to` has still never run on the production origin.** It is proven on an https
  LAN origin with a self-signed certificate, from a real browser, end to end.
- **No alerting rule ships.** The `warn`/`info` split makes one possible; choosing the
  threshold is an operator decision this slice deliberately does not make.

### Next related step

Unchanged and unrelated to CSP: production **stays in `observe`**. `npm run usage:readiness`
is still the gate — ≥14 days with server traffic, ≥500 server operations, ≥3 distinct
server tools, no degraded read.

---

## Workspace creation, membership and canonical navigation (Phase 1: Workspace Reliability)

- **Status:** Complete
- **Date:** 2026-08-30
- **Purpose:** A user must never create a Workspace successfully and then be sent
  to a route that refuses it. Creation, opening, refresh, deep links, the picker
  and archive/restore all resolve the same Workspace through one identity.
- **Root cause it fixes:** `PrismaWorkspaceRepository.create` wrote the
  `Workspace` row and nothing else. Access is granted by an active
  `WorkspaceMembership` or by the Workspace *being* the organization's
  `defaultWorkspaceId`, so a freshly created Workspace had neither and
  `WorkspaceService.get` refused it one redirect later — while `list` filtered on
  `organizationId` alone, so the picker still advertised it. Not a race, not a
  cache, not slug/id confusion.
- **User-visible behavior:** Create → the Workspace opens. Reload, a copied URL, a
  new tab, back-navigation and a picker click all land on the same Workspace. A
  duplicate name is a sentence in the dialog, not a crash. An unavailable
  Workspace is a controlled "This Workspace is not available" page (HTTP 404),
  identical for "does not exist", "no access", "another organization" and
  "malformed id".

### Architecture

- **One identity: `Workspace.id`.** `create` returns it, the dialog navigates with
  it (`workspaceHref(data.workspace.id, organizationId)`), `get` accepts it. No
  slug, name or list position is ever a navigation key.
- **Creation is one transaction.** `Workspace` + the creator's `owner`
  `WorkspaceMembership` are written together, so a returned Workspace is already
  openable by `createdById`; a failed membership insert rolls the Workspace back.
  `P2002` becomes `DomainError` → HTTP 409, not a 500.
- **`list` is actor-scoped** (`actorUserId` + `inheritedWorkspaceId`): the picker
  and `get` answer from the same rule, so "visible" implies "openable".
- **Refusals are categorised internally, uniform outwardly.**
  `WorkspaceAccessError.code` is one of `WORKSPACE_NOT_FOUND`,
  `WORKSPACE_ACCESS_DENIED`, `WORKSPACE_ID_INVALID`; the message is always
  "Workspace not found.". `WorkspaceLifecycleError` (`WORKSPACE_ARCHIVED`) is the
  one refusal allowed to name the state, and only after access is established.
- **`loadWorkspaceForRoute` / `routeOr404`** are the single place a route maps a
  `NotFoundError` to `notFound()`. Pages never call `service.get` directly, so an
  authorization refusal can no longer escape a render as a server error.
- **Lifecycle authorizes as a read.** `setLifecycle` uses read intent; a
  write-intent check refused every non-active Workspace, which made *restore*
  impossible.

### Key files

`src/infrastructure/persistence/PrismaWorkspaceRepository.ts` (transactional
`create`, membership-scoped `list`, P2002), `src/application/services/WorkspaceService.ts`
(categorised `get`, `warn()` sink, read-intent `setLifecycle`),
`src/application/services/WorkspaceAuthorizationResolver.ts` (lifecycle check
after access resolution), `src/application/services/workspaceRouteAccess.ts` (new),
`app/workspaces/not-found.tsx` + `app/workspaces/error.tsx` (new),
`components/workspaces/WorkspaceCreateDialog.tsx` (id-based navigation,
double-submit guard), `src/domain/errors/index.ts`,
`prisma/backfill-workspace-owner-memberships.ts` (new, repair for rows created
before the fix), `scripts/phase1-workspace-reliability-probe.mjs` (new, browser).

### Tests

`workspaceLifecycleReliability.test.ts` (new, 18, real migrated SQLite: create→get,
membership written, forced rollback leaves zero rows, list⇄get agreement, non-member
and cross-org refusals incl. a planted membership, invalid ids, no id in any message,
the logged field set, duplicate names, two concurrent creates → one row, read-after-write,
archive→restore, inherited default access, backfill incl. leaving a revocation revoked).
`workspaceRouteAccess.test.ts` (new, 5) and `workspaceRouteWiring.test.ts` (new, 9,
source-text: pages must call the helper, boundaries must exist and must not print
`error.message`/`digest`/`stack`, the dialog must navigate by id and contain no
`setTimeout`/retry). `scripts/phase1-workspace-reliability-probe.mjs` walks the
13-step flow in a real browser — 31/31 checks; deleting the membership write turns
it red at step 3, removing `loadWorkspaceForRoute` turns the same URL from 404 into 500.

### Known limitations

- **Two Workspaces cannot share a name.** `@@unique([organizationId, normalizedName])`
  and `@@unique([organizationId, normalizedSlug])` make the duplicate a controlled
  409. Routing-by-id is proven with distinct names instead; dropping the indexes to
  satisfy the literal test would trade integrity for a test.
- **Archive/restore has no UI control.** The API routes exist and work; the browser
  proof drives them from the page. An archived Workspace is deliberately still
  readable by its owner, which is what makes a future restore control reachable.
- **`next dev` forwards server stderr to the browser console**, so the structured
  `workspace.access.denied` line shows up there in development. It is ids only by
  design — the probe asserts no email, token, cookie or password in it.
- **The in-memory accessible-id set in `list`** is a `ponytail:` note in the
  repository: it becomes a raw join if one user ever has enough Workspaces for that
  to matter.

### Next related step

Phase 2. Nothing in this slice depends on it.

## Canonical editor save state, dirty tracking and persistence lifecycle (Phase 2)

- **Status:** Complete
- **Date:** 2026-08-30
- **Purpose:** Every surface must agree about whether the user's latest changes are
  unsaved, saved on this device, saving, saved to a Workspace, or failed — and the
  editor must become dirty on the mutation itself, not on blur, selection change or
  a debounce.
- **Root cause it fixes:** two defects with two different causes.
  - **A — typing read as "No changes yet".** The text tool opens a DRAFT object, not
    a document object, so an open text box commits no revision. Dirty was derived
    from revision watermarks alone, and characters that exist only in a textarea
    move no watermark. Nothing was broken about the watermarks; they were an
    incomplete account of what the user could lose.
  - **B — "Unsaved changes" beside "Saved on this device".** Two independent save
    models were rendered side by side: `appBarLogic.saveIndicator`, keyed on the last
    EXPORT, and the status bar's, keyed on durability watermarks. Two models, two
    answers, both on screen.
- **User-visible behavior:** the first character of a text box makes the document
  unsaved, with no blur, Enter, tool switch or wait, and abandoning it with Escape
  returns the readout to the durable state. The app-bar pill and the status readout
  are the same sentence at every moment, including mid-transition, at every width.
  Repeated "Save to Workspace" in one session updates one document. A failed save
  says so, keeps the work, and offers a Retry that targets the same document.

### Architecture

- **One state machine, four dimensions.** `persistenceMachine` tracks `edit`,
  `local`, `remote` and `recovery` with revision watermarks. `edit` is DERIVED in
  `reconcileEdit` from those watermarks — never assigned by a toolbar — so the
  forbidden `setDirty(true)` has nowhere to live.
- **`uncommittedInput` is a fact, not a revision.** A phantom revision for
  mid-typing text would enter the watermark arithmetic and be satisfiable by a write
  that does not contain the characters. It is a boolean that vetoes every durability
  predicate: `reconcileEdit`, `hasUnprotectedWork`, `shouldArmBeforeUnload`. Path:
  `TextEditor.onUncommittedChange` → `EditorCanvas.onUncommittedInputChange` →
  `EditorWorkspace` → `persistenceBinding.noteUncommittedInput` →
  `DocumentPersistenceCoordinator` → `UNCOMMITTED_INPUT_CHANGED`. It schedules NO
  write: a capture mid-typing would serialise the document without the characters
  and then report the result durable.
- **One projection.** `deriveSaveStatus(state) → SaveStatusView` (label, short,
  detail, tone, icon, announce, retry, needsResolution) is the only place copy is
  decided. `appBarLogic.saveIndicator` is deleted; `DocumentIdentity` renders the
  view it is handed and computes nothing.
- **Stale saves cannot clean a newer revision**, in two layers: a requestId check
  (`isCurrentAttempt`) drops completions from a superseded attempt, and the
  watermarks move by `Math.max` so even an accepted older completion cannot lower
  what is claimed safe.
- **Workspace saves keep one document identity.** `POST
  …/documents/:id/versions/upload` (new) stores bytes and hands the key to
  `VersionService.createVersion`; the shell creates a record only while it holds
  none and versions that id forever after. The compare-and-swap revision is the
  CLIENT'S — a route that read the current revision itself would satisfy its own
  check and protect nobody.
- **`/editor` is local-only by construction.** `remoteEnabled` requires
  `origin === "workspace"`, so a guest or signed-in visitor on the standalone editor
  gets "Saved on this device" and an explicit Workspace save is a shell action, not
  a persistence channel. No local-only document starts uploading because the save
  model changed.

### The pointer-write bug this slice found

`PrismaDocumentRecordRepository.update` treats `data.revision` as the EXPECTED
CURRENT revision — a WHERE-clause guard — and increments the column itself.
`VersionService.commit` passed `revision + 1`, the value it wanted to end up with,
which matched no row: `count !== 1` → "Document update conflict." → `DomainError` →
HTTP 409. Every Workspace save after the first failed with "the version was written
but the document could not be advanced", leaving an orphaned version row and a save
the user could not complete. `VersionService`'s own 61 tests were green throughout,
because the fake repository in them spread the patch over the row instead of
behaving like the adapter — the fake was the bug's hiding place. Fixed by passing
the expected revision (which also makes the pointer write conditional), with the
contract now pinned at the adapter and both fakes corrected to match.

### Key files

`src/application/editor/persistence/persistenceMachine.ts` (`uncommittedInput`,
`reconcileEdit`, watermarks), `derivedStatus.ts` (the one projection),
`navigationGuard.ts`, `DocumentPersistenceCoordinator.ts`
(`noteUncommittedInput`), `src/infrastructure/persistence/browser/persistenceBinding.ts`,
`components/editor/canvas/TextEditor.tsx`, `components/editor/EditorCanvas.tsx`,
`components/editor/EditorWorkspace.tsx`, `components/editor/DocumentIdentity.tsx`
(canonical pill; `saveIndicator` deleted from `appBarLogic.ts`),
`components/editor/StandaloneEditorShell.tsx` (create-once then version, banner,
`WorkspaceSaveError`), `components/editor/standaloneShellLogic.ts`
(`classifyWorkspaceSaveFailure`, `workspaceSaveFailureMessage`),
`app/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload/route.ts`
(new), `src/application/services/VersionService.ts` (pointer-write fix),
`src/application/ports/workspaces/DocumentRecordRepository.ts` (the `update`
contract, documented), `scripts/editor-save-state-probe.mjs` (new, browser).

### Tests

`uncommittedInput.test.ts` (new, 11), `saveStateAgreement.test.ts` (new, 49 — T14,
an event-built state matrix proving no reachable state projects two claims that
cannot both be true), `historyDurability.test.ts` (new, 8 — undo/redo relative to
the persisted revision), `versionUploadRoute.test.ts` (new, 12),
`PrismaDocumentRecordRepository.test.ts` (new, 5 — the `update` contract),
`loadStatesContract.test.ts` (+1: create-once-then-version). Suite: 328 files /
6670 tests, all green. `scripts/editor-save-state-probe.mjs` — 63/63 checks in a
real browser: A standalone, C a delayed-write race via test-only IndexedDB
interception, B first and second Workspace save, D a forced 500 then a retry.
Five invariants were mutation-tested and each mutation reverted with the tree
verified identical: dropping the uncommitted-input veto (2 files red), letting a
completed write claim the current revision (1), accepting a stale completion (4),
projecting a failed local write as success (5), an unconditional Workspace create
(1), and an unsaved state projected as success (21).

### Known limitations

- **`noteVersionCommitted` has no production caller**, so `committedServerVersion`
  is always null and the "saved as version N" copy is unreachable in the shipped
  app. The projection is correct; nothing feeds it yet.
- **`beginGesture`/`endGesture` have no component callers.** What actually prevents
  a save storm during a drag is the scheduler's 700ms debounce (4s ceiling, one
  write in flight per channel). Gesture bracketing would be an optimisation, not a
  correctness fix.
- **A save issued in the seconds after import can still 409.** Ingestion advances
  the document's revision asynchronously, so a client that read the revision just
  before ingestion finished sends a stale one. It is reported honestly and the
  Retry re-reads — deliberately not papered over with a server-side re-read, which
  would defeat the compare-and-swap.
- **The probe registers one throwaway account per run** (`phase2.<stamp>@example.test`)
  and writes to the dev database.

### Next related step

Phase 3. The annotation yellow-background persistence problem and the premium
visual redesign are untouched by this slice.

## Workspace commit acknowledgement, wired end to end (Phase 2 closeout)

- **Status:** Complete
- **Date:** 2026-08-30
- **Purpose:** close the two items the Phase 2 entry left open: the commit
  acknowledgement that nothing consumed, and an independent re-run of the Phase 1
  browser gate against the Phase 2 tree.
- **Root cause it fixes:** the entry above lists it as a known limitation —
  "`noteVersionCommitted` has no production caller". Two things kept the committed
  state unreachable:
  - **No caller.** `StandaloneEditorShell` uploaded a version, read the response and
    threw the acknowledgement away, so `committedServerVersion` stayed null forever
    and `isCurrentRevisionCommitted` could never return true. 6670 green tests said
    nothing about it, because every one of them built the event by hand.
  - **A gate that excluded the only surface that commits.** `isCurrentRevisionCommitted`
    required `remoteEnabled`, which is false for guest-origin documents — and `/editor`,
    the surface with the "Save to Workspace" button, is guest-origin. Even with a
    caller, the projection would have refused to say so.
- **User-visible behavior:** after an explicit Save to Workspace, both surfaces read
  "Saved — Every change is saved to your workspace as version N", with N the number
  the server chose. One edit leaves that state immediately; a further save returns to
  it with the next version number; a failure keeps the local truth and claims nothing.

### Architecture

- **No server change.** `POST .../versions/upload` already returns
  `toVersionResponse` (`id`, `documentId`, `versionNumber`, `revision`) and already
  withholds artifact storage keys. The authoritative number was on the wire; the
  client was discarding it. `versionNumber` is read from the response, never inferred
  from a client-side counter.
- **Atomic capture, structurally.** `EditorSurfaceHandle.exportBytes` now returns
  `{ bytes, revision }`, reading `persistenceRef.current.view?.state.currentRevision`
  BEFORE the export awaits. No call site holds a completion-time revision to reach
  for, because none is available.
- **Three revision domains, kept apart.** `CommandHistory.revision` (per mount,
  advances per frame and per load) ≠ the persistence revision (`RevisionBridge`'s
  count of committed mutations, the only value `noteVersionCommitted` accepts) ≠
  `DocumentRecord.revision` (the server's CAS token) ≠ the version number (the
  published identity). The first version of this fix read the history counter and the
  new tests failed loudly on the mismatch, which is why the harness keeps the two
  numbers visibly apart (12 vs 4).
- **Orchestration where a Node test can drive it.** `standaloneShellLogic.commitToWorkspace`
  owns export → create-or-version → acknowledge; the shell supplies ports only. It has
  no catch, so a failed request leaves `noteVersionCommitted` uncalled by construction.
- **Fenced by the frontier it moves, not by a second mechanism.** The existing
  `REMOTE_VERSION_COMMITTED` case accepts a response only if it advances the committed
  revision or publishes a higher version number, and otherwise takes the existing
  `ignoreStale` path (`staleResponsesIgnored`). `Math.max` alone protected the
  revision but would have let an older response overwrite a newer version number.
- **Three durability tiers stay three tiers.** Local draft → `saved_local`; remote
  autosave ack → "backed up … as a draft. Save the document to publish it as a new
  version."; explicit commit → the version sentence. `deriveStatusBreakdown`'s
  remote line for a guest document now distinguishes committed-now from
  committed-earlier-with-a-gap, so the breakdown cannot read "not applicable" beside a
  status quoting a version.
- **The first standalone save quotes no number, on purpose.** It goes through
  `documents/upload`, and ingestion writes version 1 asynchronously, so there is
  nothing authoritative to disclose yet: the revision is recorded, `serverVersion`
  stays null, and no number is invented. The version sentence appears from the second
  save onward.

### Tests

`workspaceCommitWiring.test.ts` (new, 7 — the commit driven through the REAL
coordinator and reducer: acknowledgement recorded, edit-during-flight leaves the
watermark at the committed revision, a stale response cannot regress, a failure moves
nothing, repeat saves keep one document while non-consecutive server versions
advance, plus two source-text guards for the render-time revision and the production
caller). `saveStateAgreement.test.ts` (+12: guest-origin commit cases, committed-then-
edited, a commit with no version disclosed, a stale commit, and two new invariants —
the version sentence appears if and only if `isCurrentRevisionCommitted`, and neither
an autosave acknowledgement nor a local draft may imply a published version).
`loadStatesContract.test.ts` (create-once assertions repointed at
`standaloneShellLogic.ts`, where the branch now lives). Suite: 329 files / 6689
tests, all green. `npm run typecheck`, `npm run lint` (0 errors), `npm run build` all
clean.

Browser: `scripts/editor-save-state-probe.mjs` — 80/80, extended with scenario B2,
which asserts the UI CONSUMED the acknowledgement rather than that an HTTP 2xx
happened: the visible readout must quote the number `GET .../versions` reports, one
edit must leave that state, a further save must return to it with the newer number,
the in-flight state must be observed (via a MutationObserver armed before the click —
polling could miss a sub-100ms window), and a reloaded `/editor` must make no version
claim it cannot verify. `scripts/phase1-workspace-reliability-probe.mjs` — 31/31,
unmodified, re-run against this tree.

Mutation-tested, each reverted with the tree verified identical: removing the
production `noteVersionCommitted` call (versioning path → 6 red, create path → 2
red); taking the revision at completion instead of at issuance (edit-during-save red;
reading it after the export awaits → the render-time guard red); letting a remote
autosave acknowledgement alone satisfy `isCurrentRevisionCommitted` (both new
projection tests red, on "workspace — synced").

### Known limitations

- **A reloaded `/editor` reconstructs no commit watermark.** It is a guest-origin
  surface that reopens from the local draft and holds no server session for the
  Workspace document, so there is nothing to reconstruct it from. The probe asserts
  the half the architecture supports: no version claim it cannot verify.
- **The annotation round trip is still unresolved** (the yellow annotation container
  disappearing on reload). Out of scope here and untouched.

### Deployment gates

- **The Phase 1 owner-membership backfill is still required** for environments with
  Workspaces created before the Phase 1 atomic membership fix. Unchanged and not
  re-run here; it remains a staging/production deployment gate.

## Canonical editor round-trip fidelity (Phase 3)

- **Status:** Complete
- **Date:** 2026-08-30
- **Purpose:** make a save mean the document, not the revision. Phase 2 answered "did
  we persist this revision?"; this phase answers "did we persist the complete document
  that revision represents?" — `edit → canonical scene → serialize → draft →
  deserialize → Workspace version → reopen → render → export` must preserve the same
  document semantics.
- **Root cause it fixes:** a yellow sticky note reopened, and exported, as bare text
  with no container. The yellow was never persisted, because it never existed as data:
  `ObjectRenderer` painted a hardcoded `rgba(255,245,180,0.95)` panel behind every
  annotation, and `PdfExportService` painted no panel at all. The envelope held only
  `text` and `color`, so there was nothing to lose in serialization — stage B never had
  the property. The exporter's disagreement with the canvas was the same defect seen
  from the other side.
- **User-visible behavior:** a note's fill, border, border width and corner radius are
  document properties. They survive a local draft, a Workspace version, a reopen and an
  export; the exported PDF draws the panel the canvas drew; a note authored with no
  fill stays transparent; and a pre-existing note keeps the look it had, because the
  6→7 migration backfills it.

### Architecture

- **`src/domain/editor/annotationLayout.ts` is the single source of truth** for a
  note's panel and text layout (`annotationPanel`, `annotationTextLayout`,
  `ANNOTATION_TEXT_PADDING`, `ANNOTATION_LINE_HEIGHT`). Both `ObjectRenderer.tsx` and
  `PdfExportService.ts` read it; neither invents geometry or colour. A renderer that
  disagrees with the exporter is now a compile-time impossibility rather than a bug
  waiting to be noticed.
- **`AnnotationObject` gained the four properties** (`background`, `border`,
  `borderWidth`, `cornerRadius`), defaulted centrally in `objectFactories`, validated
  during reconstruction, and carried by the envelope. `background: null` is a
  deliberately transparent note, not a missing value.
- **`EDITOR_FORMAT_VERSION` is 7,** with a registered 6→7 migration that backfills the
  historical look — `DEFAULT_ANNOTATION_BACKGROUND`, border taken from the note's own
  `color` (what the old renderer stroked with), `DEFAULT_ANNOTATION_BORDER_WIDTH`,
  `DEFAULT_ANNOTATION_CORNER_RADIUS`. A future version still fails safe.
- **A Workspace version now publishes the editable scene.** `commitToWorkspace` hands
  `ports.commit(documentId, bytes, scene, sourceBytes)` — flattened output, canonical
  envelope, and the original pages the scene sits on, kept distinct rather than derived
  from one another. Loading prefers `actions.deserialize(loaded.scene)` and falls back
  to `actions.loadState(loaded.state)`, so a version reopens as the session that saved
  it instead of as a re-import of its own export.
- **The first save no longer loses its compare-and-swap to its own import job.** A
  first save is create + version commit, and the upload's asynchronous ingestion cuts
  version 1 in between — bumping the revision with the same write that sets
  `currentVersionId`. `revisionForCommit` waits (bounded, 6 s) for that pointer before
  reading the revision it swaps on. It is not a substitute for the CAS: the server still
  checks, another tab still conflicts, and no rejected write is retried automatically.

### Tests

Boundary instrument first: `canonicalBoundaryProof.test.ts` walks one fixture through
stages A–G with a property table, so a failure reads "`background` at stage D" instead
of "expected 8 to be 7". `canonicalRoundTrip.test.ts` (T3–T11, T15–T17: per-type
property matrices, z-order from persisted order, page association, three-cycle
idempotence, zoom independence, unknown/malformed objects, original page content),
`annotationExportFidelity.test.ts` (T2, T14), `localDraftFidelity.test.ts` (T12,
through the real IndexedDB adapter), `workspaceSceneRoundTrip.test.ts` (T13, through the
real HTTP path), with a reusable semantic comparator in
`serialization/testing/semanticCompare.ts` and PDF content extraction in
`export/testing/pdfContent.ts`. `loadStatesContract.test.ts` gained the first-save CAS
guard. Suite: **334 files / 6772 tests, all green** (from 329/6689). `npm run
typecheck`, `npm run lint` (0 errors, 11 pre-existing warnings), `node
scripts/next-build.js`, `npm run test:export-fidelity` (**35/35 fixtures within
threshold**, from 32/32) all clean.

Browser: `scripts/editor-roundtrip-fidelity-probe.mjs` — **91/91**, no console errors,
no 5xx. Scenario A replays the recorded regression end to end including the exported
PDF; B carries a multi-type document through a Workspace round trip and compares
semantics, z-order and page placement; C recovers a standalone draft; D saves a second
version and proves the earlier one is still readable and still holds the earlier value.
Regression gates re-run against this tree, not substituted for:
`scripts/editor-save-state-probe.mjs` **80/80** and
`scripts/phase1-workspace-reliability-probe.mjs` **31/31**. The save-state probe is what
caught the first-save CAS defect: "the first Workspace save reports success in a live
region" failed with the conflict banner once the scene commit became part of a first
save. The fidelity probe now asserts `retried === false` on that first save, so the
regression cannot hide behind the product's Retry affordance again — which also closes
the Phase 2 known issue "save immediately after asynchronous ingestion can occasionally
409 and requires Retry".

Mutation-tested, each reverted with the tree verified byte-identical: annotation fill
omitted at serialize (19 red), annotation deserialized as generic text (24), layers
regrouped by object kind (13), image crop dropped on load (7), export skipping the
annotation container (7), object ids regenerated on load (45).

### Known limitations

- **The Workspace document surface cannot commit a version.** `DocumentWorkbench`
  autosaves drafts; only the standalone `/editor` shell's "Save to Workspace" cuts a
  version, and only the same tab session updates the same document. Recorded rather
  than worked around — scenario D is a standalone session for that reason.
- **Reopening a document immediately after saving it raises the conflict dialog,** and
  it blocks the canvas until answered: the tab is one revision behind the version it
  just wrote. Correct conflict detection, poor timing; not a fidelity loss.
- **A first save costs two requests** (create, then the scene commit) and waits for
  ingestion before the second. Unavoidable while `documents/upload` owns import.

### Deployment gates

- **Scene-bearing versions are additive.** A version saved before this phase has no
  `scene` part; loading falls back to `loadState`, so no backfill is required and no
  migration runs server-side.
- **The Phase 1 owner-membership backfill remains required** for environments with
  Workspaces created before the Phase 1 atomic membership fix. Unchanged, not re-run.

## Canonical product capability, tool availability and plan truth (Phase 4)

- **Status:** Complete
- **Date:** 2026-08-31
- **Purpose:** make every public and authenticated surface derive availability,
  execution location, processing lifecycle, plan state, limits and beta state from one
  canonical capability model, so a visitor never has to guess whether a thing works
  today, where it runs, what waiting looks like, or what it costs.
- **Root cause it fixes:** every surface answered those questions from its own local
  knowledge. `data/tools.ts` could say whether a tool exists and works, and nothing
  else — so the homepage, the catalog, the pricing page, the tool pages, the Workspace
  usage card and the FAQ each re-derived "available", "browser or cloud", "how long
  this waits", "what plan this needs" and "how big a file may be". A fact re-derived
  per surface is a fact that drifts, and twelve of them had:
  - `/pricing` said "there is no checkout on this site yet" and "no payment details are
    collected anywhere on this site" in a repository that contains Stripe checkout,
    webhooks, a portal and an activation UI. The claim was not false everywhere — it is
    true in a deployment with no Stripe keys — but it was baked into static copy and
    static metadata, so it could not be true in both.
  - Pricing sold shared team Workspaces and per-member roles as a future paid feature.
    Both ship today, on Free, with no plan gate anywhere in
    `WorkspaceMembershipService`.
  - The homepage hero showed `Redact` and an unlabelled `AI Assistant` as working
    controls; Redact is planned and every AI tool is unbuilt.
  - "Jobs you can watch" promised progress, cancel *and retry* for server work; retry
    exists on one flag-gated tool.
  - The Workspace usage card said "100 left" directly beneath copy explaining that
    allowances are measured and not applied.
  - The homepage said 50MB and the Workspace said 100MB, neither saying which ceiling
    it meant.
  - `Edit PDF` was described as "Rotate, delete and reorder pages with ease." — the
    description of Organize PDF, and a considerable undersell of the editor.
  - Version history was advertised without the Phase 3 limitation that only the
    standalone editor can commit a version.
  - The admin CMS exposed `status` as a plain select, and the public merge let it win,
    so one edit could advertise an unbuilt tool as available on three surfaces at once.
- **User-visible behavior:** the same numbers everywhere (32 tools available, 18 in the
  browser); a pricing page that reports its own deployment's live billing state instead
  of asserting one; a hero that shows only controls the editor has, with the AI panel
  marked `Preview`; an unavailable tool route that says so and offers a way back rather
  than an upload form; server tool pages that disclose both secure-cloud processing and
  that waiting means a cancellable background job; a usage card that shows measured
  usage without a headroom figure while enforcement is off; and file-size copy that
  names which ceiling it is quoting.

### Architecture

- **`lib/tools/capability.ts` is the canonical model** — one `ToolCapability` row per
  registry tool, every field derived, nothing hand-maintained except the two facts the
  code cannot infer (the pipeline-pilot slug list, guarded against `PILOT_TOOL_SLUG`).
  `capabilityInventoryProblems()` is the self-check; it returns `[]`.
- **Four dimensions kept deliberately apart**, because collapsing them is what produced
  the recorded defects: execution *location* (a privacy claim), processing *lifecycle*
  (a UX claim — a server tool must not inherit an async-job promise merely because it
  runs in the cloud), *build* state (`status`, `pipelinePilot`), and *environment* state
  (deliberately not a field: the pilot flag is read per request by
  `lib/server/processingPilot.ts`, and freezing it into a module constant is how a
  build-time snapshot comes to disagree with a route). Plan entitlement is the fifth
  axis and stays in `src/domain/metering` + `src/domain/billing`; `planRequirement`
  records only that no tool is plan-gated today, which is checkable.
- **Shared selectors, one per claim**: `getAvailableToolCount`, `getBrowserToolCount`,
  `getServerToolCount`, `getPlannedToolCount`, `getAiComingSoonCount`,
  `getUnavailableToolCount`, `getToolExecutionLabel`, `getLifecycleCopyForMode`,
  `canUseTool`. Each takes the tool list, because the registry is admin-mergeable and a
  page renders the merged list, not the compiled one.
- **Billing truth is per deployment, resolved per request.** `/api/billing/summary`
  (`private, no-store`) answers whether Pro is purchasable; `ProConfigured`,
  `ProPriceLabel` and `ProUpgradeAction` upgrade the Pro card in place and each falls
  back to the server-rendered copy underneath it, so a deployment without Stripe and a
  visitor whose summary request fails both get a page that is true. Business is
  non-purchasable by domain law — `BillingPriceMap` has no `business` slot — so it gets
  unconditional copy and no live control.
- **The CMS may rename a tool; it may not decide what the repository implements.**
  `getTools()` now takes `status` from the compiled registry for every slug the registry
  knows, and editorial fields (name, description, icon, category, SEO copy) still
  override. The dynamic tool route branches on `capabilityForSlug(slug)`, and
  `generateStaticParams` enumerates capabilities rather than merged records. The tool
  editor shows status read-only for a registry tool, because a lever attached to
  nothing is worse than no lever. This is the rule `getServerTools()` already followed
  — admins tune what exists, they do not invent a handler.

### Tests

- `lib/tools/capability.test.ts` (29) — inventory, counts, card/route agreement,
  execution labels, lifecycle distinction, runner wiring (every server tool submits to
  the job API; no runner posts to the legacy synchronous route).
- `lib/tools/productClaims.test.ts` (16) — homepage and catalog figures derived, hero
  control truth, AI preview marking, jobs claim, version-history claim, file-limit
  context.
- `data/pricing.test.ts` (12) — Free/Pro/Business copy truth, Business/team truth, and
  the guard that `ProUpgradeAction` renders no control at all before the summary says
  Pro is purchasable.
- `components/app/usageViewModel.test.ts` (21) — observe mode shows no headroom figure,
  never a raw counter key.
- `data/admin/toolStatusTruth.test.ts` (4) — drives the merge with a hostile store:
  `chat-with-pdf` overridden to `functional-server` still merges as `coming-soon-ai`
  while its overridden *name* survives.
- `scripts/product-capability-truth-probe.mjs` — permanent CDP probe, 36/36: homepage
  figures, `/tools`, `/pricing` rendered against the config the server actually used,
  Workspace usage in observe mode (signed in), Workspace membership labels (no request
  sent, so no email could be), an AI route and a planned route (no input, no dropzone,
  no start control), and Merge / Compress / Word-to-PDF disclosures.

### Known limitations

- **No tool is classified `sync-server`.** The legacy `POST /api/tools/[slug]` still
  implements a synchronous conversion, but no production UI calls it: all 14 server
  tools submit through the job API. The lifecycle stays in the vocabulary with
  `PROCESSING_LIFECYCLE_NOTES` explaining why no row claims it — a lifecycle the
  codebase can perform but cannot name is one a future surface will mislabel.
- **`getLifecycleCopyForMode` is a mode-level shortcut**, sound only while lifecycle is
  a function of mode. `lifecycleCopyDisagreements()` fails the moment it stops holding,
  and that failure is the instruction to plumb the slug through ~30 call sites.
- ~~**An admin-created tool has no capability row**, so its own status is all there is: it
  can be listed and counted as available. Its route 404s rather than rendering a runner.~~
  Closed by the Phase 4 closeout entry below: the merge is registry-driven, the write
  boundary refuses an unknown identity, and a stored non-registry record is inert.
- **Retry is compress-only** and flag-gated; the "jobs you can watch" copy promises
  progress and cancel, which all 14 have.

### Deployment gates

- **The Phase 1 owner-membership backfill remains required** for environments with
  Workspaces created before the Phase 1 atomic membership fix. Unchanged, not re-run.
- **No Stripe verification was performed in this phase.** Whether a given deployment can
  take money is answered at runtime by `/api/billing/summary`; nothing here proves a
  production Stripe configuration works, and the pricing copy is written so that it does
  not need to.

## Canonical tool identity: the CMS may not invent a tool (Phase 4 closeout)

Phase 4 left one hole in its own invariant — *every public tool count, availability
claim, route state and execution claim derives from canonical capability truth* — and
the hole was the CMS. `getTools()` merged `registry UNION store`: the store is a
`Record<slug, Partial<Tool>>`, and any key it held that the registry did not know was
appended as a **whole new tool**. `POST /api/admin/tools` accepted any kebab-case slug,
so one content edit produced a public tool that:

- appeared in the `/tools` catalog and in the total ("45 tools"),
- counted as available and browser/server when its own `status` said so, moving "32
  tools ready" — the homepage hero, the catalog header, the header menu and pricing all
  read the same selectors, so every surface moved together and stayed self-consistent
  while disagreeing with the product,
- was submitted to Google when that status was `functional-server`,
- rendered an **active** catalog card whose href 404d, because `generateStaticParams`
  and `/tools/[slug]` both answer from the compiled registry,
- and would have been refused by `assertRemoteJobTool` if a visitor got that far.

So listing truth, route truth and execution truth disagreed, and a public number was
movable by an admin edit. Two adjacent holes were the same defect wearing different
clothes: an override's `slug`/`href` fields could aim a *working* tool's card at a dead
route, and a `deleted.tools` tombstone (reachable only by hand-editing the volume — no
route writes one) could remove a working tool from the catalog and the sitemap while its
route, capability row and job handler all kept working.

**Policy chosen: registry-only editorial overrides (Option A).** Audited first, because
the alternative — a supported non-executable CMS extension — would have been right if
custom tools were an intended feature. Nothing supports that reading: no ledger entry,
doc or type describes CMS-invented tools; `/tools/[slug]` already branched only on
`capabilityForSlug`; `generateStaticParams`, `RelatedTools` and `getToolsPopular` were
already canonical (the last one *filtered out* unresolvable slugs, i.e. it already
treated them as a defect); and `data/admin/store.json` plus its `.bak` both hold
`"tools": {}`, so **no production record was ever created this way**. A capability that
was never used, never documented and only ever produced a public lie is a bug, not a
feature. Code owns identity, slug, href, implementation state, availability and counts.
The CMS owns name, description, icon, tone, category, accepted MIME types and
`plannedReason`.

- **Merge (`data/admin/index.ts`).** `getTools()` now maps the registry and applies the
  matching override per slug, with `slug`, `href` and `status` taken from the compiled
  row. Store-only keys are never emitted; `deleted.tools` tombstones are ignored.
- **Write boundary.** `POST /api/admin/tools` and `PUT /api/admin/tools/[slug]` refuse an
  unknown identity with **422** and one shared message (`UNKNOWN_TOOL_IDENTITY_ERROR`),
  writing nothing — a PUT on an unknown slug is creation by another name. Both routes are
  kept rather than deleted so a stale admin client gets the reason, not a bare 405.
  `DELETE` is deliberately *not* guarded: refusing to delete an unsupported record would
  strand it in the volume forever.
- **Existing records.** Nothing is migrated or deleted. A non-registry record is inert —
  not listed, not counted, no route, no sitemap entry, refused by the job API — and
  `getOrphanToolRecords()` surfaces it in an "Unsupported records" panel in the admin so
  an operator can see and clear it rather than wonder where their entry went.
- **SEO.** `app/sitemap.ts` derived tool URLs from `tool.status` and a hardcoded
  client-slug set; a submitted URL is a promise that the route exists, so it now derives
  both the decision and the URL from `capabilityForSlug(...)` (`available` + `route`).
  Three independent gates now answer the same question — merge, sitemap, static params —
  and each is tested with hostile input, because a single gate is one edit from gone.
- **Admin UX (minimum, not a redesign).** The "New tool" button and the editor's create
  mode are gone; slug is read-only; `status` is read-only text for every tool ("Set by
  the code that implements this tool"), where it had been a live `<select>` for
  non-canonical slugs; card and page copy say plainly that existence, availability and
  execution location are code-owned.

Counts are unchanged and now unmovable: **45 total, 32 available, 18 browser, 14 server,
5 planned conventional, 8 AI coming soon.**

- **Tests (+17):** `data/admin/cmsToolIdentity.test.ts` (13) drives the real merge with a
  hostile store via a mocked `fs.promises.readFile` — three invented identities (one per
  status class), an editorial override *and* a hostile status on the same `merge-pdf`
  record, `chat-with-pdf` promoted, a `split-pdf` href hijack, and a `compress-pdf`
  tombstone — asserting the six counts, the 45-slug inventory, absent capability rows, a
  throwing `assertRemoteJobTool`, the surviving editorial override, that every active
  card's href equals its capability route, the sitemap's own gate (fed a list that
  *contains* the unknown record, or it would prove nothing), and that the param list is
  registry-derived. `app/api/admin/toolIdentityWriteBoundary.test.ts` (4) drives POST/PUT
  with a fake store that records writes, so "refused" is distinguishable from "wrote it
  anyway", and asserts a canonical override still saves. `data/admin/toolStatusTruth.test.ts`
  updated: its "an admin-created tool keeps its own status" case pinned the defect.
- **Browser (`scripts/product-capability-truth-probe.mjs`, 36 → 49).** New scenario H
  writes an adversarial record into the live store volume (into the backup it took, so
  the admin password hash survives) and re-reads the running site: the catalog states the
  same count, its tool-link set is byte-identical, the invented tool is neither linked nor
  named, the renamed card **is** rendered, `merge-pdf` and the tombstoned `compress-pdf`
  stay active, the promoted AI route still offers no upload, `/tools/invented-tool` 404s,
  the sitemap is unchanged, an unauthenticated create is refused and writes nothing, and
  the volume is restored byte-for-byte.

### Known limitations

- **The volume is still hand-editable.** Nothing stops an operator with filesystem access
  from writing `data/admin/store.json` directly; the guarantee is that such a record
  cannot become public, not that it cannot exist. That is what scenario H tests.
- **Editorial fields are trusted.** `accept` and `multiple` remain CMS-editable, so an
  override can still narrow or widen an upload box's client-side filter for a real tool.
  The server re-validates on submission; this is a UX-truth surface, not an execution one.
- **Adding a tool now requires a deployment**, by design. A registry row, a capability row
  and a route or processor are the only way to create one.

## End-to-end workflow completeness and Workspace integration (Phase 5)

A recording of the real product showed the work stopping where the workflow should
have started. A merge finished, and the result page offered **Download** and **Start
over** — nothing else. The file it offered was `probe-document-merged (1)-merged.pdf`:
a suffix stacked on a suffix, with a browser collision marker baked into the middle of
the name. Saving anything into a Workspace produced another `Untitled PDF.pdf`. The
Workspace list showed `Opened —` for documents that had just been opened. The activity
feed said *someone uploaded an item*. And the Workspace editor autosaved drafts it
could never publish as a version. Each of those reads as a separate cosmetic bug; they
are one structural gap. Nothing owned the decisions **what is this result**, **where
does it go**, and **what is it called** — so every result component improvised, and
improvisation cannot produce a workflow.

Phase 5 gives those three decisions one owner each and wires every surface to them.

### Architecture

- **A result is a contract, not a Blob (`components/tools/resultWorkflow.ts`).** One
  description of a finished tool run carries its bytes *or* its job id — deliberately not
  pretending a browser result and a server result are the same thing — plus provenance:
  source document id, source file name, tool slug, `createdAt`, originating Workspace.
  Actions are derived from that contract, never from where the component happens to sit.
- **One action bar (`components/tools/ResultWorkflowActions.tsx`).** `ResultActions`,
  `JobStatePanel` and `ServerToolRunner` all render it, so *Download*, *Open in Editor*
  and *Save to Workspace* mean one thing product-wide, and a result page cannot be a
  dead end unless the contract says every action is impossible.
- **Capability owns which actions exist (`lib/tools/capability.ts`).** `editorOpenableOutput`
  (`kind === "pdf"` and not an `OPAQUE_PDF_OUTPUT_SLUGS` entry — a password-protected PDF
  is a PDF the editor cannot open) and `workspaceSupported` are computed once, next to the
  rest of capability truth. No result component asks "is this a PDF?" on its own.
- **Destination is decided by the server (`GET /api/workflow/save-target` →
  `resolveSaveTarget`).** The client never names a Workspace; it asks where the actor may
  save and gets the organization's default (first authorized as fallback). Phase 1
  membership rules answer the question, so an action cannot address a Workspace the actor
  cannot reach.
- **Destination semantics are separated.** *Download* mutates no Workspace. *Open in
  Editor* saves nothing. *Save to Workspace* **creates** when the result has no Workspace
  identity and **publishes a new version of the same document** when it has one — the two
  are different verbs on different surfaces (*Save to Workspace* vs *Publish version*),
  never one overloaded button.
- **Handoff carries an id, not a payload (`lib/workflow/handoff.ts`).** Result bytes go
  into IndexedDB (`pdfdadi-handoff`, 30-minute TTL) and the editor is opened at
  `/editor?handoff=<id>`; the shell claims it once, deletes it, and strips the spent id
  from the address bar. No Blob URL in a query string, no base64 in history, no signed
  URL leaked into a link, and a browser-local result never touches the network to be
  edited.
- **Cloud results transfer server-to-storage (`POST /api/jobs/:id/save-to-workspace`).**
  Same-origin gate, JSON content type (415), destination required (422), job ownership via
  `resolveJobActor` (a foreign or signed-out caller gets 404, not a hint), PDF-only output
  (415 `UNSUPPORTED_OUTPUT`), upload ceiling (413), then `getWorkspaceActor` and the
  established `uploadToWorkspace` service. The browser never re-downloads and re-uploads
  the result, so persistence does not race the result URL's expiry, and no new
  "convenient" save path bypasses the application services.
- **Names are policy, not string concatenation (`lib/workflow/fileNames.ts`).** One module
  owns the generated name: the operation suffix is applied to the *stem*, an existing
  suffix for the same operation is not stacked, a browser collision marker (` (1)`) is
  stripped rather than embedded, the extension is derived from the output kind (so no
  `.pdf.pdf`), multi-input names are deterministic and bounded
  (`quarterly-report.pdf` + `appendix.pdf` ⇒ `quarterly-report-and-appendix-merged.pdf`),
  and Workspace collisions are resolved in one place. Every runner and the two save paths
  call it; none of them formats a name itself.
- **Publishing reuses the Phase 2/3 coordinator, and only it.** `commitToWorkspace`
  (`components/editor/standaloneShellLogic.ts` + `components/editor/workspacePublish.ts`)
  is the single commit path: it takes `existingDocumentId` and, in the workbench, its
  create branch **throws** — a Workspace publish that reached document creation would be
  the duplicate-document defect, so it is made unreachable rather than merely unused. The
  commit fences on `DocumentRecord.revision`, writes scene + source + output (Phase 3),
  and reports through `noteVersionCommitted` so publish status derives from the canonical
  persistence projection. A failed publish leaves the editing state and its dirty flag
  intact; an edit made while a publish is in flight stays dirty and does not ride along on
  the older commit's acknowledgement; a repeat publish produces version *n+1* of the same
  document; autosaved drafts remain per-device recovery state and never appear as versions.
- **A publish no longer conflicts with itself.** The content route now emits
  `X-Document-Revision` (the *record* revision, not the version number),
  `loadWorkspaceDocument` reads it, and `REMOTE_VERSION_COMMITTED` in
  `persistenceMachine.ts` adopts `event.documentRevision` as the session's known server
  revision. Reopening straight after your own publish is therefore not a conflict, while a
  genuinely competing write still is: compare-and-swap is untouched, the local session just
  stops being wrong about what it last wrote. This is the fourth counter in the family the
  Phase 3 entry warns about, and it is the one a write is fenced against.
- **`Opened` is an event, not a side effect
  (`POST /api/workspaces/:id/documents/:id/opened`).** Both workbench mounts fire it after
  the editor has actually loaded the document. Fetching bytes, loading metadata, listing a
  folder or running a tool over a document do **not** write it, and the write creates no
  version and does not advance the record revision. `Recent` filters on *opened* in the
  query (`openedOnly`, ordered by `lastAccessedAt desc`) rather than in application memory,
  so `—` still honestly means never opened.
- **Activity describes documents (`components/workspaces/dashboardLogic.ts`).** Document
  events record the name they will be described by and the version a publish produced, read
  through checked accessors, with the page's own name as a historical fallback for events
  written before this phase — so old rows degrade to a name rather than to "an item". Metadata
  stays inside the existing audit convention: document id, filename, tool slug, version
  number, actor id, timestamp. No PDF text, annotation contents, form values, signatures or
  bytes are recorded anywhere in the feed.
- **No schema change.** `lastAccessedAt` and its `[workspaceId, lastAccessedAt]` index, the
  record revision and the audit tables all already existed; Phase 5 adds no migration and
  fabricates no historical timestamps.

### Key files

- `components/tools/resultWorkflow.ts`, `components/tools/ResultWorkflowActions.tsx` — the
  result contract and the one action bar; `ResultActions.tsx`, `components/jobs/JobStatePanel.tsx`
  and `components/tools/runners/ServerToolRunner.tsx` render it.
- `lib/workflow/fileNames.ts`, `lib/workflow/handoff.ts` — name policy and id-based handoff.
- `lib/tools/capability.ts` — `editorOpenableOutput`, `workspaceSaveableOutput` (named
  `workspaceSupported` when this entry was written), `OPAQUE_PDF_OUTPUT_SLUGS`.
- `app/api/workflow/save-target/route.ts`, `src/application/services/workspaceSaveTarget.ts` —
  authorized destination resolution.
- `app/api/jobs/[id]/save-to-workspace/route.ts`, `lib/server/jobActor.ts`,
  `components/jobs/jobResultTransfer.ts` — cloud result → Workspace, server-side.
- `components/editor/workspacePublish.ts`, `components/editor/standaloneShellLogic.ts`,
  `components/workspaces/PublishVersionButton.tsx`, `components/workspaces/DocumentWorkbench.tsx` —
  publish, on the Phase 2/3 coordinator.
- `src/application/editor/persistence/persistenceMachine.ts`, `lib/editor/loadWorkspaceDocument.ts`,
  `src/application/services/documentContent.ts` — the record revision, on the wire and in state.
- `app/api/workspaces/[workspaceId]/documents/[documentId]/opened/route.ts`,
  `src/application/services/DocumentRecordService.ts`,
  `src/infrastructure/persistence/PrismaDocumentRecordRepository.ts` — the open event and Recent.
- `components/workspaces/dashboardLogic.ts`, `components/workspaces/DashboardCards.tsx` — activity copy.

### Tests

T1–T22, 167 tests in the phase's own files plus the additions to existing suites:
`lib/workflow/fileNames.test.ts` (33) and `fileNameWiring.test.ts` (6, T1 — every runner and
both save paths call the policy); `lib/workflow/handoff.test.ts` (16, T2/T21 — claim-once,
expiry, cleanup); `lib/tools/capability.test.ts` (37, T6/T7 — capability and offered actions
agree, and a non-PDF or opaque output offers no editor open);
`components/tools/resultWorkflowWiring.test.ts` (22, T3/T4/T5/T19/T20/T22 — including that a
signed-out result keeps Download and Open in Editor, uploads nothing, and routes to
`/login?next=…`); `components/editor/workspaceCommitWiring.test.ts` (8) and
`components/workspaces/publishVersionWiring.test.ts` (12, T8–T11 — repeat publish, edit during
publish, failed publish, no second document, drafts are not versions);
`src/application/editor/persistence/remoteSync.test.ts` (19, T12 — own write adopted, competing
write still a conflict); `components/workspaces/openedRecentWiring.test.ts` (6, T13/T14) and
`components/workspaces/activityWiring.test.ts` (8, T15–T18, including that nothing derived from
document contents is recorded). All eight mandated mutations (duplicate document on retry,
Open in Editor falling back to re-upload, publish calling create-document, own revision not
adopted, `lastAccessedAt` unwritten, activity without a name, a non-PDF offering the editor, a
local result sent to the server) were each applied, observed red, and reverted.

**Browser (`scripts/workflow-completeness-probe.mjs`, ~80 assertions, permanent).** Nine
journeys against the running product: A merge → editor, B merge → Workspace, C compress →
Workspace, D workbench publish, E own-write conflict regression, F Opened/Recent, G activity,
H unauthenticated handoff, I unsupported output. It asserts the produced name
(`quarterly-report-and-appendix-merged.pdf`), that a browser-local run sends **no** bodied
request beyond the allow-listed analytics beacon, that the handoff crosses as an id and the
spent id is cleaned from the URL, that exactly one document exists per save and the save lands
in the Workspace the run is watching, that a publish produces version 2 then 3 on the same
document with scene + output + source and raises no conflict on the next edit, that `Opened` is
a real time while `—` survives and opening cuts no version, that activity names the document
and the tool, and that the save route refuses a signed-out caller (404), a non-JSON body (415)
and a missing destination (422). Reverting the one-line revision fix turns the probe red with
four product failures, so it is not vacuous.

### Known limitations

- **The first save still waits for ingestion.** `revisionForCommit` polls for the imported
  `currentVersionId` for up to 6 s at 200 ms before a *first* Workspace save can fence its
  version write. Removing the wait needs either a weakened compare-and-swap (forbidden) or a
  scene attachable at upload time — a change to the ingestion protocol itself. Left as it is,
  deliberately: it is one bounded wait on the first save of a document's life, and it fails
  loudly rather than silently overwriting.
- ~~**`POST /api/jobs/:id/save-to-workspace` and the `opened` route have no route-level unit
  test.**~~ Their guards were asserted by source-text wiring reads plus the live probe, which
  drives the real 404/415/422 branches. **Closed in the Phase 5 closeout below:**
  `app/api/jobs/saveToWorkspaceRoute.test.ts` (14) and `app/api/workspaces/openedRoute.test.ts`
  (8) drive both routes end to end against migrated SQLite.
- **The 415 `UNSUPPORTED_OUTPUT` branch is unreachable on a machine without the server
  binaries** (`qpdf`, `pdftoppm`, `soffice`), because every non-PDF-output tool is server-run.
  The probe reports that as an environmental gap rather than a pass; the capability tests and
  the Phase 4 probe cover the decision itself.
- ~~**One destination, chosen for you.**~~ *Save to Workspace* resolved the organization's
  default Workspace, with no picker. **Closed in the Phase 5 closeout below:** a member of
  several Workspaces now chooses on the result page, and Save cannot start until they do.
- **Multi-output tools are still one-per-result.** A tool that produces several files is not
  presented as a single Workspace document, and no bulk "save all" exists.

### Deployment gates

Full suite 346 files / 6977 tests (run four times, green each time); `tsc --noEmit` clean;
`eslint .` 0 errors / 11 pre-existing warnings; production build green; Phase 5 probe 79/80
(the one failure is the environmental gap above, exit 0); Phase 4 capability probe 49/49;
Phase 3 round-trip 91/91; Phase 2 save-state 80/80; Phase 1 Workspace reliability 31/31;
export fidelity 35/35. The Phase 5 probe requires the standalone artifact behind
`scripts/tls-front.mjs` (production refuses a loopback `NEXT_PUBLIC_SITE_URL` and its cookies
are `Secure`) and a throwaway database — it creates documents and versions.

## Phase 5 closeout — destination choice, independent capability truth, persistent save identity and route proof

Phase 5 shipped the workflow. A strict audit then found that several of its
load-bearing claims were *asserted* rather than *owned*: a multi-Workspace member was
still given the account default, "the Workspace can store this" was still the editor's
answer wearing the Workspace's name, and "saving twice cannot create two documents" was
believed because a happy-path test counted one row. Seven gaps, and every one of them is
the same shape — a truth with no owner, or an owner with no proof.

### What changed

- **A destination is chosen, not assumed.** `resolveSaveTarget` answered with one
  Workspace, so a member of several got the organization default and the job of moving
  the document afterwards. `resolveSaveDestinations` now answers with *every* Workspace
  the actor may save into, plus `defaultWorkspaceId` — which is a **label, not a
  preselection**. `SaveDestination` gained `choose`, and `resolveInitialSelection`
  selects for the user only when there is exactly one destination: one Workspace is not
  a decision, two is, and it is theirs. Until they make it, `saveToWorkspace` is false
  and nothing is uploaded.
- **The filtering happens at the boundary, not in the browser.** The destination list
  comes from `WorkspaceService.list`, which is membership-scoped, organization-scoped
  and `lifecycleState: "active"` in the repository query — so a cross-organization, a
  non-member or an archived Workspace is never sent to a client that would have to
  filter it out. Nothing the client says widens the set.
- **A chosen `workspaceId` is a request, not a grant.** Both save paths re-authorize it
  independently of the selector: the routes resolve the actor with `getWorkspaceActor`,
  and `WorkspaceAwareUploadService.uploadToWorkspace` opens with
  `workspaces.get(actor, workspaceId, true)` and then rejects a cross-organization
  owner. A Workspace id typed into the request by hand fails even though it never
  appeared in any selector, and it fails the same way whether it is foreign, in another
  organization, or archived.
- **Two capabilities, two fields.** `workspaceSupported` was literally
  `output.editorOpenable`, which is why `protect-pdf` — a perfectly storable PDF — had
  no Workspace destination. It is now `workspaceSaveableOutput`, read from its own
  field, and the two counts are deliberately unequal (**28 editor-openable, 29
  Workspace-saveable**) so a future recoupling cannot be silent: a change that makes
  them agree fails `capability.test.ts`.
- **`protect-pdf` saves, and that is a proved behaviour rather than a decision.**
  `protectedPdfWorkspace.test.ts` builds a real password-protected PDF, puts it through
  the real `WorkspaceAwareUploadService` into a real `LocalFileStorage`, ingests it with
  the real `DocumentIngestionService`, reads the object back byte-for-byte, and
  separately confirms no parser in this repository can open it. Verdict:
  **Workspace-saveable true, editor-openable false.** Had the store corrupted or refused
  the bytes, `workspaceSaveableOutput` would have to be false and that file would say so.
- **One logical save is one document, durably — and no migration was needed to say so.**
  *(Corrected by the Phase 5 data-identity closeout below: this bullet's claim is wrong.
  `(workspaceId, sha256)` is content **de-duplication**, not operation idempotency. It makes
  two saves of identical bytes one document even when the user meant two, and it makes a
  re-save after trashing fail. The durable identity of a save is now
  `WorkspaceSaveIntent`, which did need a migration. Everything else in this bullet —
  ask-the-repository-who-won convergence, and that none of it lives in memory — still
  holds and is still how the race is settled.)*
  Identity is `(workspaceId, sha256(bytes))`, which is already a unique index on
  `DocumentIngestion` (`prisma/migrations/20260802153439_add_document_ingestions`). The
  read-side pre-check only saves work; the load-bearing half is the index plus the
  convergence path, where a request that *loses* the race asks the repository who won
  and returns that document instead of an error. Asked of the repository, not read off a
  Prisma error code, so it holds for any adapter and for a name collision too. That
  survives two concurrent requests, a lost HTTP response, a remounted page and a process
  restart, because none of it lives in memory.
- **Recording an open writes one column.** `touchLastAccessed` is raw parameterized SQL
  because `updatedAt` is `@updatedAt` and Prisma has no per-call opt-out — and
  `updatedAt` is what the file manager renders and sorts as **Modified**. An `update()`
  here would reshuffle the Modified column every time somebody merely looked at a
  document. `openedRoute.test.ts` pins that: `lastAccessedAt` advances, `revision`,
  `currentVersionId`, `updatedAt`, the version count and the content bytes do not.
- **Both new routes are driven, not read.** The Phase 5 entry above admitted that
  `POST /api/jobs/:id/save-to-workspace` and the `opened` route were covered by
  source-text wiring reads plus the live probe. They now have behavioural route tests on
  the repository's existing harness — a migrated throwaway SQLite database, the real
  Prisma repositories, the real application services, the route function called with a
  real `NextRequest` — and they cover the branches that matter: CSRF, content type,
  malformed body, missing destination, a job that does not exist and a job belonging to
  somebody else answered *identically*, an anonymous result a signed-in actor may not
  claim, an expired result, an unsupported MIME, an oversized output, a foreign,
  cross-organization or archived Workspace, and the successful save.
- **Fidelity is asserted over the stored object.** "One document exists" is not
  fidelity: storing the *input*, or a stale handoff buffer, produces exactly one document
  with exactly the right name. `storedOutputFidelity.test.ts` merges two real PDFs with
  the real `mergePdfs`, saves the result through the real upload route, and then reads
  the stored object back out of storage and *parses* it — sha256 equality, page count,
  per-page geometry — and proves the other candidate's checksum exists nowhere in the
  database or in storage. For the cloud path both the job input and the job output sit in
  storage, which is what makes "stored the wrong one" a real mistake to make.
- **The competing-write conflict is now proved with two real browsers.** Journey M runs a
  second Chrome profile, because two tabs of one profile share the cookie jar *and* the
  IndexedDB store the persistence coordinator keeps its locally-durable revision in — so
  the second tab would read the first one's state and the conflict under test would never
  be reached. Both sessions open the same document at revision N, A publishes and adopts
  its own write, B stays stale, B publishes, and B is refused — the existing Conflict
  dialog, the two differing revisions in it, and the server's version list unchanged. No product code knows it is being tested and the compare-and-swap was
  not weakened.

### Key files

- `src/application/services/workspaceSaveTarget.ts` — `resolveSaveDestinations` (the
  authorized set) and `resolveSaveTarget` (the editor's single destination, delegating to
  it so there is one authorization query and not two that can drift).
- `app/api/workflow/save-target/route.ts` — takes no input, returns
  `{ authenticated, destinations, defaultWorkspaceId }`, `no-store`; a guest gets a 200
  with an empty list because "not signed in" is a state the result page renders.
- `components/tools/resultWorkflow.ts` — `SaveDestination` including `choose`,
  `resultWorkflowActions`, `awaitingDestinationChoice`, `resolveInitialSelection`.
- `components/tools/ResultWorkflowActions.tsx` — the selector: a native `<select>` with a
  real `<label htmlFor>`, so keyboard and screen-reader behaviour come from the platform;
  shown only when there is more than one destination; Workspace **names** only, never
  internal ids or organization structure.
- `src/application/services/WorkspaceAwareUploadService.ts` — content identity, the
  Workspace-scoped dedup pre-check (a match in another Workspace is deliberately not
  consulted, because reporting it would disclose another tenant's holdings), and the
  race-loss convergence.
- `src/infrastructure/persistence/PrismaDocumentRecordRepository.ts` —
  `touchLastAccessed`, raw and single-column.
- `lib/tools/capability.ts` — `editorOpenableOutput` and `workspaceSaveableOutput` as
  independent fields.

### Tests

Six new files (47 tests) and 10 assertions strengthened inside existing ones:

- `components/tools/resultWorkflowWiring.test.ts` (28) — destinations returned, chosen,
  auto-selected only when singular, the two capabilities independent, runtime MIME
  overriding the declared capability in both directions.
- `src/application/services/protectedPdfWorkspace.test.ts` (3) — the protected-PDF
  verdict, behaviourally.
- `src/application/services/resultSaveIdempotency.test.ts` (9) — concurrent local saves,
  concurrent job saves, the lost-response retry, one initial version, one activity event,
  bytes not written twice, and idempotency that crosses neither actors nor destinations.
- `app/api/workflow/saveTargetRoute.test.ts` (10) — the authorized set, and that a
  Workspace the actor is not a member of is not in it.
- `app/api/jobs/saveToWorkspaceRoute.test.ts` (14) — the whole guard ladder, plus the
  retry and the concurrency case at the route.
- `app/api/workspaces/openedRoute.test.ts` (8) — authorization, `lastAccessedAt`, and the
  five things an open must not move.
- `app/api/workspaces/storedOutputFidelity.test.ts` (3) — local Merge and cloud Compress
  stored-byte and stored-content fidelity.
- `data/admin/cmsToolIdentity.test.ts` (15) and `lib/tools/capability.test.ts` (39) — the
  CMS cannot alter either capability, output kind, multiplicity or persistence mode, and
  the two capability counts stay unequal.

`scripts/workflow-completeness-probe.mjs` gained four journeys and replaced one:
**J** multi-Workspace destination choice (16 checks), **K** persistent save idempotency
across a reload (10), **L** stored content fidelity through the browser (4), **M** the
two-session competing write (18), and **I′** unsupported output rendered truthfully (9),
made deterministic by intercepting the same-origin result response in the browser rather
than by any production test affordance. **136 of 137**, exit 0, the single non-pass being
the environmental line below, which is reported as `ENVIRONMENTAL` and not relabelled.

### Known limitations

- **Save, trash, save the same bytes again does not converge.** *(Fixed by the Phase 5
  data-identity closeout below. It was not a product decision waiting to be made: it was
  content standing in for identity. A save carrying a new intention now creates a sibling
  document and the trashed one stays trashed.)* The unique
  `(workspaceId, checksum)` row survives trashing while `existingSaveResult` deliberately
  ignores a trashed document, so the second save collides on the index and fails rather
  than restoring or re-creating. It no longer destroys the stored object, and the first
  save is unaffected. Fixing it means deciding what a re-save of a trashed document
  *means* (restore it, or create a sibling) — a product decision, not a bug fix.
- **One organization.** The selector answers "which Workspace", which is the gap users
  hit; a user in several organizations still sees only the first organization's
  Workspaces. That is not a new ceiling — `resolveSaveDestinations` resolves the
  organization exactly as `getWorkspaceActor` and `workspacePageData` already do
  (`orgs[0]` when the caller names none), so the selector's scope is the same scope the
  whole Workspace UI runs in. Multi-organization destination choice stays deferred.
- **The first 100 Workspaces.** `resolveSaveDestinations` inherits the service's page
  ceiling; an account past it gets a truncated selector.
- **The 415 `UNSUPPORTED_OUTPUT` branch still needs the server binaries.** Journey I′ now
  proves the *browser* behaviour deterministically — Download shown, Open in Editor
  absent, no hidden handoff written, and the canonical selector not bypassable — but the
  server branch itself is only reachable on a machine with `qpdf`, `pdftoppm` and
  `soffice`. That one line remains `ENVIRONMENTAL`.
- Everything the Phase 5 entry above lists as accepted still holds: authentication does
  not carry a large local result across sign-in, multi-output image tools stay
  Download-only, the first Workspace save still waits for ingestion, version-history
  browsing is minimal, and folder or project destinations are not part of this selector.

### Deployment gates

**No migration.** Save identity is the unique index created in
`20260802153439_add_document_ingestions`, so there is no schema change to order and no
deployment sequencing requirement beyond the usual one: the code can go out on its own,
and a rollback needs nothing undone.

Run against the final tree: full suite **352 files / 7034 tests / 0 failures**;
`tsc --noEmit` clean; `eslint .` 0 errors / 11 pre-existing warnings; `node
scripts/next-build.js` exit 0; `prisma validate` and `prisma generate` clean; Phase 5
workflow probe **136/137** (the environmental line above, exit 0); Phase 4 capability
probe **49/49**; Phase 3 round-trip **91/91**; Phase 2 save-state **80/80**; Phase 1
Workspace reliability **31/31**; export fidelity **35/35**. Eleven mutations (A–J plus a second variant of F, because the first
variant failed only as a 500 and never reached the byte comparison) were each applied,
observed red for the intended reason, and reverted; a whole-tree sha256 manifest over
1375 files confirms the reverted tree is byte-for-byte the tree the gates ran against.
**This repository is not under version control**, so that manifest — not `git diff` — is
the revert evidence, and there are no commits to report.

## Phase 5 data-identity closeout — a save intention is not a checksum

The previous entry closed Phase 5 with `DocumentIngestion @@unique([workspaceId,
checksum])` as "persistent save identity". That index answers *"are these bytes already
here?"* — a useful question, and the wrong one. It was being used to answer *"has this
save already happened?"*, and the two come apart in both directions:

- **Two intentions collapse into one.** Export the same page twice under two names and
  the second save returns the first document. Nothing failed, nothing was stored, and the
  file the user named is not there.
- **One intention is refused.** Save, trash it, save the same bytes again: the trashed
  ingestion still holds the index, `existingSaveResult` deliberately ignores a trashed
  document, so the insert collides and the route answers with an error. A server error is
  not a product policy, and the previous entry mis-diagnosed this as a product decision
  waiting to be made.

Three identities were wearing one name. They are now separate: **an intention to save**,
**a logical document**, and **the content bytes**.

### The three identities

| Identity | Owner | Uniqueness | Answers |
| --- | --- | --- | --- |
| Save intention | `WorkspaceSaveIntent` | `(organizationId, userId, key)` | did *this* save already happen? |
| Logical document | `DocumentRecord` | its own id | which document is the user looking at? |
| Content | `StoredFile` / object key `ca/<2>/<2>/<sha256>` | `sha256` | are these bytes already stored? |

A retry converges because the *intention* is the same. A second save of identical bytes
gets its own document because the *intention* is new. Neither question is asked of the
checksum any more, and the checksum index survives as an ordinary index for the one
question it is right for.

### The intention, and what a key means

`normalizeSaveIntentKey` (`src/domain/entities/WorkspaceSaveIntent.ts`) is the only
gate: 16–200 characters, `[A-Za-z0-9._:-]`, trimmed. A key is an **identifier, not a
credential** — every request is authorized on its own, and the key is only ever consulted
*inside* the scope the actor already proved. Its row carries the intention's meaning:
destination Workspace, `sourceKind`, `sourceIdentity`, and `payloadChecksum`.

`claimSaveIntent` in `WorkspaceAwareUploadService` is claim-before-work. `insertPending`
is a plain insert against the unique index, so it is also the mutual exclusion: the
concurrent second request loses the insert instead of doing the work twice. What happens
next is decided by the row that is already there, compared with `sameMeaning` over all
four fields:

- **Same meaning, `completed`** → return the recorded document and ingestion.
  `deduplicated: true`, HTTP 200, no second version and no second activity event.
- **Same meaning, `pending` and fresh** → the other request is mid-flight. Poll briefly,
  then `SaveIntentInProgressError` rather than a duplicate.
- **Same meaning, `pending` and stale, or `failed`** → `reclaim`, a conditional
  `updateMany` on `status in (pending, failed)` **and** the `updatedAt` the caller read.
  A compare-and-swap, so exactly one of two retriers may proceed.
- **Different meaning** → `SaveIntentConflictError`. Never another document.

`complete(claim.id, document.id, ingestion.id)` runs **after** both writes. Marking it
earlier is mutation I, and D18 goes red: a crash mid-write would leave a completed
intention pointing at nothing, and every retry would be answered with that nothing.

### Key lifecycle — a local result

`lib/workflow/saveIntent.ts`. A key is minted when the result exists, not when it is
uploaded, and **no bytes leave the browser before an explicit Save**. Opening in the
editor stays local and mints nothing.

- `newSaveIntentKey()` — `crypto.randomUUID` with a `getRandomValues` fallback, because a
  non-secure context has no `randomUUID` and a save that cannot mint a key cannot happen.
- `saveIntentKeyForJob(jobId)` — memoized in `sessionStorage`, so the same job saved after
  a remount *or a reload* is the same intention. Storage blocked entirely degrades to
  per-page, which costs a duplicate document at worst and never a refused save.
- `saveIntentKeyForTarget(key, workspaceId)` — the destination is part of the meaning, so
  a client that offers a Workspace picker narrows its key per destination. Two saves of
  one result are still visibly related (the base key is the prefix), which is what makes
  a conflict legible in a log; a destination change is a new intention, not a 409 the user
  cannot act on.

### Key lifecycle — a processing job

`POST /api/jobs/:id/save-to-workspace` keeps every ownership check it had: the job is
resolved for the actor, a job that does not exist and a job belonging to somebody else
answer identically, and result bytes are read **server-side from storage** — they never
travel through the browser. The intention binds `sourceKind: "job-result"` and
`sourceIdentity` to the exact job result plus its checksum, so the same key presented for
a *different* job is a typed conflict rather than a cross-wired document. A job id alone
is not the key: one job can be saved to two destinations, and that is two intentions.

### Content, references, and deletion

Storage stays content-addressed at `ca/<2>/<2>/<sha256>` and there is **no second storage
subsystem**. Many documents may point at one object; `StoredFile` is the reference index.

- Trashing or permanently deleting one document never touches an object another row still
  references (`existsByKey` is deliberately *not* owner-scoped — a reference belonging to
  another Workspace or organization still counts).
- The upload rollback deletes an object only when it created it *and* nothing references
  it. Both halves are load-bearing: mutation G (delete unconditionally) fails D14/D15.
- `VersionService` retention asks the same question before dropping a superseded artifact,
  and treats a lookup failure as "still referenced" — losing bytes is worse than keeping
  them.

### Concurrency and lost responses

No process-local locks: the mutual exclusion is the unique index, the release is a
compare-and-swap, and the document plus its initial version are one transaction. A lost
HTTP response is the ordinary case, not a special one — the retry carries the same key and
is answered from the intention row. Removing that row's uniqueness (mutation B) produces
duplicate documents in the concurrency tests.

### Trash and non-disclosure

Save-to-Workspace **never silently restores** a trashed document and never returns one as
though the new save succeeded. A new intention over the same bytes creates an active
sibling; the trashed document stays trashed with its `trashedAt` intact.

The uniqueness scope makes §9 non-disclosure structural rather than a check that can be
forgotten: `(organizationId, userId, key)` means another actor's key is a *different row*.
There is no global lookup to get wrong, so an invalid actor learns nothing — not the
document id, not the destination, not whether the key exists.

### Schema and migration

`prisma/migrations/20260902100000_add_workspace_save_intents/` — creates
`workspace_save_intents` (+ its unique index and two secondary indexes), then **drops**
`document_ingestions_workspaceId_checksum_key` and re-creates it as a plain index. Both
steps are additive to the data: dropping a uniqueness constraint cannot fail on existing
rows and deletes nothing. No historical intention rows are fabricated — an old save has no
recorded intention, which is the truth; the keyless upload path still de-duplicates by
content, so every existing document opens and downloads exactly as before.

**Deployment order:** migration first, then code. The new code needs the table; the old
code is unaffected by it and does not care that the checksum index lost its uniqueness.

**Rollback is not symmetric.** Re-creating the UNIQUE index fails once one Workspace holds
two ingestions of identical bytes — precisely what this phase enables. Roll back by
reverting the *code* and leaving the schema, or collapse those rows by hand first.

`prisma/saveIntentMigration.test.ts` (D20) proves it on a **copy of a populated
database**: every migration except the last is applied through the real Prisma CLI and
seeded with an active, an archived and a trashed document plus their ingestions, versions
and stored files; the final migration is then applied by the same CLI to a byte copy,
leaving the seeded original as the control. Documents, lifecycle timestamps, ingestions,
versions, manifests and stored files all survive; the intention table arrives empty; two
ingestions of identical bytes now insert; and a legacy document still reads back through
the same repositories downloads use.

### Browser journey N

`scripts/workflow-completeness-probe.mjs`, real Chrome over CDP, before journey H (which
signs out). **N1** the same key twice with a different filename — 201 then 200,
`deduplicated: true`, the same document id, the name unchanged, one document added, exactly
one version (polled, then settled and re-asserted), one activity entry. **N2** a new key
over identical bytes — 201, a *different* document id, the intended filename preserved,
and both documents' downloaded content hashing identically: physical de-duplication without
collapsing identity. **N3** trash it, then save the same bytes under a new key — a new
active document, the old one still `trashed`, and the new document downloads with the same
content. **N4** the settled key with altered payload — 409, and the body carries neither the
first document id nor the Workspace id.

### Key files

- `src/domain/entities/WorkspaceSaveIntent.ts` — key normalization, limits, status.
- `src/application/ports/workspaces/WorkspaceSaveIntentRepository.ts` — `insertPending`,
  `find`, `reclaim`, `complete`, `fail`.
- `src/infrastructure/persistence/PrismaWorkspaceSaveIntentRepository.ts` — `insertPending`
  returns `null` on P2002 (the lost race is a value, not an exception);
  `reclaim` is the conditional `updateMany`.
- `src/infrastructure/persistence/InMemoryWorkspaceSaveIntentRepository.ts` — the twin.
- `src/application/services/WorkspaceAwareUploadService.ts` — `claimSaveIntent`,
  `sameMeaning`, `completedIntentResult`, the reference-safe rollback.
- `lib/workflow/saveIntent.ts` — key minting and the two ways an intention repeats.
- `prisma/migrations/20260902100000_add_workspace_save_intents/migration.sql`.

### Tests

`src/application/services/saveIntentIdentity.test.ts` (16) is D1–D19 on real Prisma
repositories, real `LocalFileStorage` and a migrated throwaway database — retry
convergence, new-intention siblings, one payload under two names, trash-then-resave,
payload/destination/source conflicts, cross-actor non-disclosure, shared-content deletion
safety, single activity event, claim release on failure. `prisma/saveIntentMigration.test.ts`
(6) is D20 on a copied populated database. `lib/workflow/saveIntent.test.ts` (7) checks the
client keys against the **real server validator**, including the reload case.
`app/api/jobs/saveToWorkspaceRoute.test.ts` (14), `resultSaveIdempotency.test.ts` (9),
`WorkspaceAwareUploadService.test.ts` (31), `VersionService.test.ts` (62),
`container.test.ts` (75), `resultWorkflowWiring.test.ts` (33).

Nine mutations (§12 A–I) were each applied, observed red, and reverted: checksum-as-identity
(8 red), no intention uniqueness (9), one key with a different payload (1), one key for
another destination (2), another actor's operation returned (1), a trashed ingestion
blocking a new intention (7, including D20), unconditional object deletion (2), a second
activity event on retry (2), completing the intention before the transaction (1). Reverts
are verified against pre-mutation snapshots byte-for-byte, `git status`, and a 1428-file
sha256 manifest.

### Known limitations

- **A key is per-tab, not per-account.** `sessionStorage` means a job saved from two tabs
  is two intentions and therefore two documents. Correct for the local-result case (two
  tabs are two results) and mildly surprising for a job. A server-side derivation from
  `(job, destination)` would close it and is not built.
- **No intention history for old saves.** Anything saved before this migration has no row,
  so a retry of an ancient save de-duplicates by content, exactly as it did before.
- ~~**Nothing prunes `workspace_save_intents`.** Rows are small and bounded by real saves;
  a retention job is not built.~~ **RESOLVED by the final pre-launch audit** (`1d36b30`) —
  "bounded by real saves" is not bounded: the row count is monotonic in traffic for the
  life of the deployment. A 30-day horizon now rides the recurring `file-retention` sweep.
  See *Retention findings from the final pre-launch audit* at the end of this ledger.
- **The loser of a race waits, it does not stream.** A concurrent second request polls
  briefly and then returns `SaveIntentInProgressError` for the client to retry, rather
  than blocking on the winner's transaction.
- **Every `DomainError` is still one 409 shape.** `mapWorkspaceError` flattens
  `SaveIntentConflictError` and `SaveIntentInProgressError` into
  `WORKSPACE_OPERATION_REJECTED`; the distinction lives in the message, and clients cannot
  branch on a code.

### Deployment gates

**Migration first, then code** —
`prisma/migrations/20260902100000_add_workspace_save_intents`. It is additive to the
data and the old code is indifferent to it. Rollback is code-only once two ingestions of
identical bytes exist in one Workspace; see the migration file's own header.

Run against the final tree: full suite **355 files / 7069 tests / 0 failures** (baseline
352/7034); the D1–D23 set **4 files / 62 tests**; the prior Phase 5 closeout set **6 files
/ 47** unchanged; every route test **15 files / 202**; the persistence, document and
version set **32 files / 779**; `tsc --noEmit` clean; `eslint .` **0 errors / 11
pre-existing warnings**; `node scripts/next-build.js` exit 0, **63/63** static pages;
`prisma validate` and `prisma generate` clean. Browser: Phase 5 workflow probe
**155/156**, exit 0, the one non-pass being the same `ENVIRONMENTAL` missing-binaries line
as before and journey **N 19/19**; Phase 4 **49/49**; Phase 3 **91/91**; Phase 2
**80/80**; Phase 1 **31/31**; export fidelity **35/35**. The Phase 5 probe runs against
the production standalone artifact behind the self-signed TLS front (it needs a secure
context); the earlier-phase probes run over plain HTTP, because the production start-up
guard correctly refuses a loopback `NEXT_PUBLIC_SITE_URL`.

Unlike the entry above, **this repository is now under local version control**: commit
`a82aa3a` is a labelled pre-fix baseline, so `git status` is the primary revert evidence
for the nine mutations, with a 1428-file sha256 manifest as the secondary. No remote is
configured and nothing was pushed.

## Premium UI/UX system, responsive consistency and accessibility (Phase 6)

Phases 1–5 made the product *true*: capability, save state, round-trip fidelity, plan
truth and save identity all have one owner each. Phase 6 makes it *look* like that is
so, and does it without moving a single one of those owners. The rule the whole phase
was built under: **no visual change may alter product truth or workflow semantics.**
Every finding below is either a token/layout change, or an accessibility defect that
was already a bug before anyone asked about design.

The pre-implementation audit is `docs/PHASE6_UI_AUDIT.md` — ten findings, four of them
real product defects, one of them a defect in the probe rather than the product. The
design rules Phase 6 leaves behind are `docs/DESIGN_SYSTEM.md`.

### Design principles

Calm, precise, fast, trustworthy, document-focused. The document is the only thing on
screen that should draw the eye; chrome that competes with it is a defect however
attractive it looks in isolation. Concretely refused: gradient-per-section,
glassmorphism, glowing blobs behind text, cards inside cards, low-contrast grey body
copy, oversized headings, animation carrying meaning it does not have, and any accent
colour that is not in a token file. Premium here is restraint — the identity is the
existing PDFDadi violet, unchanged, applied consistently instead of decoratively.

### Token system: one canonical source per decision

`styles/tokens.ts` already existed and was **partly fiction**. Three findings:

- **Two z-index systems.** `tokens.zIndex` was consumed by nothing. What shipped was
  `z-[55]`, `z-[60]`, `z-[70]`, `z-[75]`, `z-[100]` across four files — the global
  stacking order written down five times and nowhere authoritative. The named layers
  now exist as Tailwind utilities (`z-header`, `z-drawer`, `z-dialog`, `z-skiplink`, …)
  and the literals are gone. Only `menu`, `editor`, `popover` and `skipLink` are new
  layers, and each replaces a literal rather than inventing a level.
- **The homepage carried a second, unnamed palette.** Six components wrote raw hexes —
  `bg-[#3B82F6]/25`, `stopColor="#4F46E5"`, `bg-[#38BDF8]/20`. They are now `aura.*`,
  a group documented as **decoration only**: no text, border or control surface may use
  it, because none of those values is contrast-checked. Naming what ships is what lets
  a later pass see it; two of them (`blue`, `sky`) are not brand-derivable at all and
  now say so.
- **A purged utility class.** `tailwind.config.ts` `content` did not include
  `./styles/**`, where `iconToneClasses` and `focusRing` live as strings. Tailwind
  purged any utility named *only* there: `teal` was the one icon tone no component
  referenced directly, so every teal-toned tool — Edit PDF among them — rendered its
  icon with no tile and no colour. One glob, one whole tone restored.

`tailwind.config.ts` mirrors `styles/tokens.ts` because Tailwind cannot import a TS
module at config time. `styles/tokens.test.ts` (7 tests) asserts the mirror holds and
that no component re-opens a token with an arbitrary value, so a divergence fails a
test instead of shipping.

**The PDF canvas is not a themed surface.** No page-theme token reaches the canvas or
an exported document; `editor-page` is the document's own white. A token that changed
the rendered PDF would be a product-truth change wearing a styling change's clothes.

### Component system: states, not appearances

The audit's instruction to itself was *do not rewrite working components to rename
them*. `components/ui/` already had `Button`, `Badge`, `Icon`, `Modal`,
`SectionHeading`, `Reveal`, and the variant maps already lived in
`components/ui/buttonStyles.ts` for a good reason (`lib/utils/cn.ts` is a plain string
joiner with no Tailwind conflict resolution, and we shipped a white-on-white CTA
because of it). So Phase 6 changed **states**, not structure:

- **`loading` became a real state.** It rendered a spinner and stayed clickable — a
  double-submit dressed as feedback. It now implies `disabled` and sets
  `aria-busy="true"`, applied after the prop spread so a call site cannot un-imply it.
- **`BUTTON_BASE` names `ring-2` but never a ring colour**, so a dark-surface variant
  never has to out-sort a light-surface default. `onDark`/`onDarkOutline` carry a white
  ring with `ring-offset-navy` and a `forced-colors:` border for Windows High Contrast.
- Every interactive primitive now expresses default · hover · active · focus-visible ·
  disabled · loading · keyboard operability · an accessible name · a ≥24×24 target.

### Shell and navigation

The public header, the authenticated `AppShell` and the standalone editor shell now
draw from the named layers rather than from literals, which is what makes their
relationship legible: the header is 40, an in-flow dropdown 50, the mobile drawer and
its scrim 60 (one layer on purpose — they are siblings, so DOM order decides, and the
panel always renders after its scrim), a portalled popover 70, a dialog 80, the skip
link 100.

The mobile drawer was already a real dialog (`role="dialog"`, `aria-modal`, trapped
focus, Escape to close, focus returned to the trigger). `components/layout/mobileNavA11y.test.ts`
(7 tests) now holds that shape in place, because it is the kind of correctness that is
invisible until it is gone.

**One `<main id="main">` per document.** The root layout ships a skip link targeting
`#main` on every route, and it pointed at nothing on `/editor` while the Workspace
editor nested a second `main` inside `AppShell`'s. The editor frame had spent the
`<main>` on its canvas region. `/editor` now owns the landmark and
`PremiumEditorFrame` does not, so the one bypass mechanism the page has works (WCAG
2.4.1). `components/editor/editorLandmarks.test.ts` guards both halves.

### Homepage

The hero advertised a tool that does not exist. `HeroShowcase` named tools in its
illustration from a hand-written list, and one of them was not in `data/tools.ts` at
all — a decorative image misrepresenting capability, which is precisely the failure
mode the brief calls out. The showcase now derives its tiles from the canonical tool
list, so the illustration cannot drift from the product again;
`lib/tools/productClaims.test.ts` (18 tests) asserts every claim the marketing surface
makes resolves to a real, available tool.

`components/home/AIPreview.tsx` carried the phase's one contrast failure: the AI badge
text did not clear 4.5:1 against its wash. It is now `text-pink-700`, found by
`styles/contrast.test.ts` (5 tests) rather than by eye.

### Tools directory

The category rail was the last consumer of an inline `z-[…]`; it now uses `z-sticky`,
the layer that was named for it. Card capability is unchanged and remains derived from
`data/tools.ts` + `lib/tools/capability.ts` — Phase 4's truth, untouched. What Phase 6
adds is proof it cannot be locally overridden: making a planned tool render as
available is mutation **C**, and it fails six tests.

### Result workflow and destination UX

Semantics unchanged, and that is the deliverable. `resultWorkflowActions` remains the
only source of which actions exist; `ResultWorkflowActions.tsx` renders what it returns
and holds no opinion of its own. Hardcoding the three actions locally is mutation
**D**, and `resultWorkflowWiring.test.ts` T7 catches it. `Open in Editor` still does
not upload local bytes, Workspace saving is still explicit and authorized, Download is
still distinct from persistence, and a protected PDF is still saveable but not
editor-openable (mutation **E**, six failures).

`components/tools/destinationSelectorA11y.test.ts` (7 tests) pins the destination
selector's keyboard and naming behaviour, and `components/jobs/processingStates.test.ts`
(9 tests) pins that queued, processing, complete and failed remain four visually and
programmatically distinct states rather than four shades of grey.

### Workspace

`components/workspaces/documentListUx.test.ts` (13 tests) holds two things that were
one careless class away from breaking:

- **The list stays a semantic table.** The mobile representation restacks; it may not
  drop the header relationship or an action.
- **A long filename cannot escape its cell.** A flex child's default
  `min-width: auto` refuses to shrink below its content, so `min-w-0 flex-1 truncate`
  on the link *and* `min-w-0` on the table are load-bearing. Removing them is mutation
  **H**.

Two real accessibility defects were fixed here. `CommandPalette` had no visible focus
indicator on its own items — a palette is keyboard-first, so this was the worst place
in the product to be missing one. And the document list's **filtered-empty** state
offered no way back: a search that matches nothing now renders a recovery action, not
just a sentence. `DocumentWorkbench`'s tab strip was below 24×24 and is not any more.

### Editor, standalone and Workspace-backed

The audit's F1 was the phase's worst finding, and it was a genuine product defect:
**the editor tool row was a ~90px window onto 437px of controls, behind a hidden
scrollbar.** `scrollbar-none` plus `overflow-x: auto` means a control outside the
client box has no affordance that reveals it — Text, Image, Signature, Note, Shape and
Highlight were simply gone on a phone, not scrolled. The row now **wraps**:
`toolbarWraps(width)` with `TOOLBAR_WRAP_MIN_WIDTH = 732`
(`components/editor/toolbarLayout.ts`), measured by a `ResizeObserver` on the toolbar
root, and an unmeasured width (0/NaN, first paint) deliberately does not wrap so the
first frame does not announce a constraint it has not measured.

The save-status control's entire accessible name was an em-dash. It has a name and a
24×24 target now, and — the part that matters for Phase 2 — it still reads
`persistence.view.status`, the canonical projection, with no local boolean anywhere
near it. Introducing one is mutation **F**.

Editor controls meet ≥44×44 on touch, safe-area insets are respected on the floating
canvas controls, and every essential action stays reachable at 390px — which is now
*measured*, not asserted: probe gate **H5** walks every button and link, finds its
nearest hidden-scrollbar scroller, and fails if any control's box falls outside that
scroller's client box.

### Pricing

Unchanged in substance: `PricingPage` still awaits `getPricingList()` and splits on
`plan.available`. Phase 4's plan truth is the only source, and
`app/(marketing)/pricing/pricingTruth.test.ts` (7 tests) is new — replacing it with
hardcoded copy is mutation **G** and takes 5 of those 7 red.

### Responsive behaviour

Nine audited widths: **320 · 360 · 390 · 412 · 768 · 1024 · 1280 · 1440 · 1920**.

**No global `overflow-x: hidden` was added, and none exists.** Overflow was fixed at
the element that was too wide, every time. Two measurements worth recording because
they redirect where the risk actually lives:

- A CSS-injection sweep at 320px removed `min-w-0`, `truncate`, `flex-wrap` and
  `break-words` from the marketing pages one at a time. The document width did not
  change: those layouts collapse on their own. Long-text overflow risk lives in the
  **Workspace and editor** surfaces, which is where the guards and the tests are.
- `/editor` renders inside `fixed inset-0`, so document-level horizontal overflow is
  **structurally impossible** on that route. Probe H4's overflow clause can never fail
  there, which is exactly why the reachability gate H5 exists — the editor's
  responsiveness is a question about containers, not about the document.

### Accessibility (WCAG 2.2 AA)

Fixed in this phase, all of them bugs before they were design questions: the skip link
that pointed at nothing on `/editor`; the nested `main` on the Workspace editor; the
save-status control whose accessible name was an em-dash; the `CommandPalette` items
with no focus indicator; the filtered-empty document list with no recovery action; the
workbench tab strip, `StatusBar` page chevrons, `Breadcrumbs`, `WorkspaceShowcase` and
`WorkspaceCreateDialog` controls below 24×24 (2.5.8); the AI badge below 4.5:1; and
`Button loading` remaining clickable while claiming to be busy.

Focus is never colour-alone — every indicator is a ring, so it survives greyscale,
forced colours and colour-vision deficiency. One `focusRing` string, one
`focus-visible:ring-2` in `BUTTON_BASE`.

### Performance measurements

Measured on the production standalone build over `localhost`, three navigations each,
`largest-contentful-paint` via `PerformanceObserver` with `buffered: true`.

| | LCP element | LCP | FCP |
| --- | --- | --- | --- |
| Before | hero `H1`, inside the fade-up reveal | **744 ms** | 88 ms |
| After | hero `H1` | **88 / 88 / 96 ms** | 88 / 88 / 96 ms |

The hero heading was the largest contentful paint *and* was gated behind a decorative
entrance animation, so the page's headline metric measured the animation rather than the
render. The `H1` no longer waits for a fade; LCP and FCP are now the same event. The
fade remains on the surrounding composition, where it costs nothing measurable, and is
cancelled entirely under `prefers-reduced-motion`.

### Motion

`tokens.motion` — 120ms feedback, 200ms colour/shadow, 300ms panels. One `@media
(prefers-reduced-motion: reduce)` block in `app/globals.css` covers every animation
utility, including the ~22 uses that a per-call-site `motion-reduce:animate-none` had
never reached. `animate-pulse` **stops** at `opacity: 1`; `animate-spin` **slows to
2.4s** rather than stopping — a frozen spinner claims the process died, and WCAG 2.2.2
exempts an activity indicator for the same reason. Cancelled animations get explicit
`opacity: 1; transform: none`, because cancelling an animation whose `from` state is
invisible would otherwise hide the content permanently. Removing this block is mutation
**I**.

### Tests

**18 files / 252 tests / 0 failures**, of which 11 files are new and 7 are pre-existing
files extended. U1–U30 map onto them as follows:

| Tests | File | U |
| --- | --- | --- |
| 7 | `styles/tokens.test.ts` | U1 |
| 5 | `styles/contrast.test.ts` | U1, U15 |
| 10 | `components/ui/buttonStyles.test.ts` | U2 |
| 6 | `components/ui/focusVisible.test.ts` | U3 |
| 7 | `components/layout/mobileNavA11y.test.ts` | U4 |
| 18 | `lib/tools/productClaims.test.ts` | U5, U6, U7 |
| 9 | `components/jobs/processingStates.test.ts` | U8, U9 |
| 13 | `components/workspaces/documentListUx.test.ts` | U15, U16, U17, U24, U28 |
| 7 | `components/tools/destinationSelectorA11y.test.ts` | U13, U14 |
| 50 | `components/editor/persistence/editorPersistenceWiring.test.ts` | U19, U20 |
| 31 | `components/editor/toolbarLayout.test.ts` | U21 |
| 16 | `components/editor/toolbarChrome.test.ts` | U21 |
| 3 | `components/editor/editorLandmarks.test.ts` | U29 |
| 13 | `components/ui/dialogChrome.test.ts` | U22, U25 |
| 7 | `components/ui/reducedMotion.test.ts` | U26 |
| 7 | `app/(marketing)/pricing/pricingTruth.test.ts` | U23 |
| 22 | `components/home/homeSections.test.ts` | U5, U27 |
| 6 | `src/application/services/workspaceRouteWiring.test.ts` | U18, U30 |

U10, U11, U12 and U30 are carried by the Phase 4/5 suites they belong to
(`lib/tools/capability.test.ts`, `components/tools/resultWorkflowWiring.test.ts`,
`src/application/services/protectedPdfWorkspace.test.ts`) — Phase 6 added no second
opinion about capability, and mutations C, D and E confirm those gates still bite.
U27 and U29 are measured in the browser rather than asserted in Node, which is the
honest place for them.

The environment has no DOM (`vitest` runs `environment: "node"`, `include:
["**/*.test.ts"]`), so rendered tests use `renderToStaticMarkup` on real components.
That is a genuine limit — effects do not run under SSR, so anything effect-derived is
proven in the browser probe instead of in a unit test. Source scans guard architecture
only; no layout or interaction claim in this phase rests on one alone.

### Browser verification

Node tests cannot see layout, focus rings or hydration, so every claim in this phase
that is about what a user sees was measured in a real browser — Chrome headless over
raw CDP through `scripts/lib/probe-browser.mjs` (`--force-device-scale-factor=1`, and
`Emulation.setFocusEmulationEnabled` on, without which a headless window matches no
`:focus` and every focus assertion is vacuous).

**How the server has to be configured, and why.** The permanent probe is
`scripts/premium-ui-ux-probe.mjs`, run against the production standalone artifact
(`node ingress/server.mjs`, which loads `.next/standalone/server.js` behind the ingress
guard — the generated entry exits 1 in production since the ingress closeout, and
`next start` refuses under `output: "standalone"` as it always did)
listening on loopback http, with `scripts/tls-front.mjs` terminating TLS on the LAN
address in front of it, and `NEXT_PUBLIC_SITE_URL` set to exactly that https origin.
Three production rules make that the only configuration in which an authenticated
journey can be measured at all:

* `src/infrastructure/config/env.ts` `productionProblems()` refuses a loopback
  `NEXT_PUBLIC_SITE_URL`.
* `workspaceCsrf.trustedOrigins()` trusts only `new URL(config.siteUrl).origin` in
  production, so a probe on any other origin gets `403 CSRF_ORIGIN_REJECTED`.
* Session cookies are `Secure` in production, so a plain-http origin silently drops
  them and every signed-in gate would measure a signed-out page.

Probing `next dev` over `127.0.0.1` is worse than useless: Next 16 blocks cross-origin
dev resources, React never hydrates, and interaction gates pass while measuring dead
markup. The probe therefore refuses to continue — it checks for `__react*` keys on the
root node and exits `2 ENVIRONMENTAL` rather than reporting green. Each run uses a
throwaway SQLite database (`prisma migrate deploy` into `/tmp`), never the repo's own.

**Result: 111 gates pass · 0 product failures · 0 environmental · 0 not exercised.**

| Scenario | Gates |
| --- | --- |
| A — Homepage | 12/12 |
| B — Tools directory | 13/13 |
| C — Local tool workflow (Merge PDF) | 8/8 |
| D — Server tool workflow (Compress PDF) | 7/7 |
| E — Result workflow and destination | 5/5 |
| F — Workspace | 13/13 |
| G — Workspace-backed editor | 11/11 |
| H — Standalone editor | 10/10 |
| I — Pricing | 12/12 |
| J — Responsive global shell | 5/5 |
| K — Keyboard and accessibility | 11/11 |
| L — State matrix | 4/4 |

The probe prints a "what actually rendered" list — the route and the character count of
the text it measured for every scenario — because a scenario that silently landed on a
sign-in page would otherwise report the same green as one that rendered the product.
Scenarios D and G are the two that most easily go vacuous: D needs Ghostscript
(`lib/server/toolProcessing.ts` `compress` shells out to `gs -sDEVICE=pdfwrite`) and
G needs a real Workspace document created earlier in the same session, so both are
named in that list with the ids they used.

The six things the phase's brief asks to be inspected separately, and what they were:

* **Browser console** — zero JS errors in all twelve scenarios. The probe deliberately
  splits JS errors from network entries: a `401` from `/api/auth/me` is the documented
  signed-out answer, and counting it as a console error would make every page look
  broken. The ignored network entries are now named in the gate detail line rather than
  only counted, so they can be reviewed instead of trusted.
* **Hydration warnings** — none. React hydration is a precondition, not a gate.
* **Failed network requests** — one, in scenario G: `GET …/documents/<id>/editor-state`
  answers `404`, which is that route's documented contract for a version that has no
  stored scene (an imported version legitimately has none, and the client falls back
  to loading the PDF). Every other scenario recorded none.
* **Unhandled promise rejections** — zero; they arrive as `Runtime.exceptionThrown` and
  are counted with JS errors.
* **Page-level horizontal overflow** — none at any of 320, 360, 390, 412, 768, 1024,
  1280, 1440 and 1920 CSS px on any measured surface.
* **Final production route rendering** — the production build renders 63/63 routes, and
  the routes above were then measured in the browser from that same artifact.

**Prior-phase probes, all re-run at this phase's HEAD.**

| Probe | Result | Configuration |
| --- | --- | --- |
| Phase 6 premium UI/UX | 111 pass / 0 product failures | production artifact behind the TLS front |
| Phase 5 workflow completeness | 149/156 | production artifact behind the TLS front |
| Phase 4 capability | 49/49 | dev server on `localhost` |
| Phase 3 round-trip | 91/91 | dev server on `localhost` |
| Phase 2 save-state | 80/80 | dev server on `localhost` |
| Phase 1 Workspace reliability | 31/31 | cold dev server on `localhost` |
| Export fidelity | 35/35 | Node, no browser |

Two of those numbers need their honest footnote.

**Phase 5 measures 149/156 here, not the 155/156 this phase was handed as a baseline —
and it measures 149/156 with a byte-identical failure list on the commit before Phase 6
began.** That was checked the only way it can be: the pre-Phase-6 commit was built in a
separate worktree, served behind its own TLS front, and probed with the same script. The
seven are the same seven on both trees — journey C's cloud-save success copy and document
id, journey I's two absence gates (its `outputMimeType` rewrite never fires, so both
measured a real PDF result), an N3 download `409`, and the documented `ENVIRONMENTAL`
`415` branch. Phase 6 did not cause them; this machine does not reproduce the stated
baseline. Nothing in this phase touches the cloud-save path — the diff over
`app/api/jobs`, `lib/workflow`, `prisma` and `src/infrastructure/persistence` is empty
apart from one new test file.

**Phase 1 measures 31/31 only on a cold dev server.** On a dev server left warm by
earlier probe runs it reported 30/31 with `TypeError: Failed to execute 'measure' on
'Performance': 'WorkspacePage' cannot have a negative time stamp` from
`flushComponentPerformance` inside `react-server-dom-turbopack` — React's dev-only
Server Components performance track, not shipped code. The production artifact never
throws it. Recorded here because the first three runs looked like a Phase 6 regression
and were not one.

### Mutation results

A green suite proves nothing until a deliberate break makes it red. Ten mutations were
applied one at a time, each observed failing at a named gate, each reverted through Git
(`git checkout -- <path>`) and each gate re-run green afterwards.

| # | The break | Where | Gate that caught it |
| --- | --- | --- | --- |
| A | dialog panel takes a fixed width instead of a constrained one (`w-full` → `w-[640px]`) | `components/ui/Modal.tsx:72` | `components/ui/dialogChrome.test.ts` U25 — 1 failed / 12 passed |
| B | shared button base loses `focus-visible:outline-none focus-visible:ring-2` | `components/ui/buttonStyles.ts:38` | `components/ui/focusVisible.test.ts` U3 — 1 failed / 5 passed |
| C | a planned tool claims to be available (`pdf-to-powerpoint` `planned` → `available`) | `data/tools.ts:292` | `lib/tools/capability.test.ts` U5/U6 — 6 failed / 75 passed |
| D | result actions hardcoded in the component instead of derived | `components/tools/ResultWorkflowActions.tsx:167` | `components/tools/resultWorkflowWiring.test.ts` T7/U10 — 1 failed / 32 passed |
| E | protected PDF loses Workspace Save (`workspaceSaveable` excludes `protect-pdf`) | `lib/tools/capability.ts:304` | `src/application/services/protectedPdfWorkspace.test.ts` C6 + 5 more, U11 |
| F | editor status bar overrides the canonical projection with a local "Saved" | `components/editor/EditorWorkspace.tsx:2032` | `components/editor/persistenceWiring.test.ts` U19 — 1 failed / 2278 passed |
| G | Pricing renders hardcoded plan copy instead of `getPricingList()` | `app/(marketing)/pricing/page.tsx:58` | `app/(marketing)/pricing/pricingTruth.test.ts` U23 — 5 failed / 2 passed |
| H | long filename escapes its cell (`min-w-0 … truncate` removed) | `components/workspaces/DocumentFileManager.tsx:515` | `components/workspaces/documentListUx.test.ts` U24 — 1 failed / 12 passed |
| I | reduced-motion rules deleted from the media block | `app/globals.css:295` | `components/ui/reducedMotion.test.ts` U26 — 1 failed / 6 passed |
| J | editor toolbar never wraps, so tools leave the viewport on mobile | `components/editor/toolbarLayout.ts:459` | `components/editor/toolbarLayout.test.ts` F1 ×3, U21 — 3 failed / 44 passed |

Two of these changed the work rather than just confirming it.

**Mutation A had to be re-aimed.** The brief names "remove a mobile width constraint",
and there is no such constraint to remove: the layout is fluid and its narrow behaviour
comes from wrapping and `min-w-0`, not from a width. The nearest real contract is the
dialog panel's maximum, which is what a fixed `w-[640px]` breaks at 320px — so that is
what was mutated, and the substitution is recorded here rather than quietly made.

**Mutation J found a genuine hole in the phase's own verification.** It went red in
Node but the browser probe stayed green, because scenario H had no gate that measured
*reachability* — only that the editor rendered and did not scroll sideways. A toolbar
that overflows a `scrollbar-none` scroller hides controls with no visible affordance,
which is exactly the mutation's damage and exactly what a source scan cannot see. Gate
**H5 "every editor control stays inside its own container"** was added: it walks each
control's ancestors for a hidden-scrollbar horizontal scroller and reports any control
whose box falls outside it. Verified red under the mutation (`43 controls, 10 out of
reach` at 390 px, still passing at 1440) and green at HEAD (`44 controls, 0 out of
reach` at 390; `54, 0` at 1440). The first attempt to measure it was itself invalid —
taken against an unhydrated dev page — and was re-taken against the production build.

### Remaining visual limitations

Things this phase deliberately did not solve, so the next one does not have to rediscover
them:

* **No pixel baselines.** Every visual claim here is structural or geometric — token
  identity, class contracts, measured boxes, focus order, overflow at nine widths. No
  screenshots are committed, so a change that keeps the structure and ruins the
  appearance (a wrong shadow, a wrong gradient stop) is not caught by any gate.
* **Effect-derived UI is only provable in the browser.** `vitest` runs
  `environment: "node"` with `include: ["**/*.test.ts"]`, so anything that depends on
  `ResizeObserver`, a focus trap or a layout measurement — the toolbar's wrap mode most
  of all — has a source contract in Node and its real proof in the probe. A contributor
  without Chrome can run the suite and still not know whether the editor toolbar wraps.
* **Three palette families remain three.** Marketing (`primary`/`lavender`/`aura`), app
  chrome (`app-*`) and editor (`editor-*`) are one system by rule, not one palette by
  value: crossing from `/` into `/workspaces` is still a visible change of surface. That
  is intended — a productivity surface should not look like a landing page — but it is
  the seam a future pass would most likely be asked to soften.
* **No dark mode.** Out of scope for this phase, and nothing here was built to make it
  hard: the tokens are named by role, so a dark set is additive.
* **Tablet portrait keeps a compromise.** At 768 px the editor collapses to a single rail
  and the canvas takes the rest. Nothing overflows and every control stays reachable, but
  the composition is denser than desktop rather than re-thought for the width.
* **Four server tools cannot be exercised on this machine.** `qpdf`, `soffice`,
  `pdftoppm` and `pdfinfo` are not installed, so the result states of the tools that need
  them (repair, unlock, flatten, Office conversion, PDF→image) are unmeasured here. The
  probe classifies that as `ENVIRONMENTAL`, never as a pass.
* **Phase 5's seven probe non-passes are still open**, unchanged and pre-existing —
  measured identically on the commit before this phase. They belong to the workflow
  phase, not to this one.

### Deployment gates

**No migration, no schema change, no dependency change.** `package.json` and
`package-lock.json` are byte-identical to the pre-phase commit, and the diff over
`app/api/`, `lib/workflow/`, `prisma/` and `src/infrastructure/persistence/` contains no
runtime file. This phase is presentation only, which is what makes the invariant list
above cheap to defend: nothing in it is re-decided by a stylesheet.

Run against the final tree: full suite **366 files / 7172 tests / 0 failures** (from
355/7069); `tsc --noEmit` clean; `eslint .` **0 errors / 11 pre-existing warnings**;
`node scripts/next-build.js` exit 0, **63/63** static pages; `prisma validate` and
`prisma generate` clean. Browser, all after the mutations were reverted and against the
final production artifact with stale servers stopped: premium UI/UX probe **111 pass / 0
product failures**, Phase 5 **149/156** (identical pre-phase), Phase 4 **49/49**, Phase 3
**91/91**, Phase 2 **80/80**, Phase 1 **31/31**, export fidelity **35/35**.

The permanent gate this phase adds is `scripts/premium-ui-ux-probe.mjs`. It exits nonzero
on a product failure and exits `2` when it cannot measure the product at all — an
unhydrated page, or a server whose origin does not match `NEXT_PUBLIC_SITE_URL`. Run it
the way the section above documents: production artifact, TLS front, `--auth`. Run
against a dev server over `127.0.0.1` it will refuse rather than mislead.

No remote is configured and nothing was pushed.

## Retention findings from the final pre-launch audit

Two tables grew forever, and the second was found only because the audit went
looking at runtime rather than at the code. Both are fixed; a third is left alone
deliberately and is recorded here so it cannot quietly become a surprise.

### The shape of both defects

Neither was an access-control bug, and that is exactly why neither surfaced. A row
that nothing reads and nothing deletes costs nothing today, passes every test, and
is invisible in a code review that asks "can the wrong person see this?" It only
ever shows up as a table that is larger than it was last month. Both findings are
that shape, in different tables:

| Table | Written on | Deleted by | Before |
|---|---|---|---|
| `workspace_save_intents` | every save-to-workspace | nothing — no cascade reaches it, and the service that writes it only ever moves a status | unbounded |
| `sessions` | every login | an explicit logout, and nothing else | unbounded |

`ISessionProvider.get` already refuses an expired token, so a stale session row was
never usable. The leak was the row, not the access.

### What was built

Both prunes ride the **existing** recurring `file-retention` sweep
(`RETENTION_INTERVAL_MS` = 15 min) rather than adding a recurring job each. One
sweep already runs, already reschedules itself, and already has a wiring test; two
more would be two more things to register, schedule, monitor and forget.

- `WorkspaceSaveIntentRepository.pruneBefore(cutoff)` — horizon
  `SAVE_INTENT_RETENTION_MS` = 30 days, measured from `updatedAt` rather than
  `createdAt` because a row reclaimed for a fresh attempt is live again.
- `ISessionProvider.pruneExpired(now)` — no horizon; `expiresAt` already is one.

`pruneExpired` is a **required** port method, not optional. Nothing in the request
path needs it, so an optional method would have compiled forever and never been
implemented. Making it required cost five `tsc` errors across four test doubles,
which was the intended outcome. `ClerkProviders` returns 0 and says why: Clerk owns
its own session lifecycle and there is no local table.

A throw from either prune is warned and swallowed. A retention sweep that dies on
its newest duty stops expiring *files*, which turns a growth problem into a
data-retention failure.

### `audit_logs` is unpruned ON PURPOSE

Recorded rather than fixed. `AuditLog` (table `audit_logs`) has no pruning anywhere
and should not get any by default: it is the record of who did what, and a
retention policy for it is a compliance decision belonging to whoever operates the
deployment, not a default this repository picks. It is listed as an operator
decision in the audit's launch profile. Its growth is bounded by user actions, and
unlike the two above it is *read* — by the activity feed.

### Tests, and why one of them uses a real database

- `PdfToolWorkerHandler.test.ts` — the sweep's reported counts, the horizon length,
  and that a throwing session prune still purges files and still reschedules.
- `workerBootstrap.test.ts` — behavioural, not "register was called": the handler
  the bootstrap actually registered is RUN and must prune both tables. This exists
  because a policy with green tests and a consumer that never called it is a
  failure this repository has already shipped once.
- `LocalSessionProvider.test.ts` — against a **real migrated SQLite database**. The
  whole risk in `pruneExpired` is one comparison crossing the ORM boundary: Prisma
  stores `DateTime` on SQLite as INTEGER milliseconds, and a value that lands in
  that column as TEXT sorts after every integer, so `{ expiresAt: { lt: now } }`
  against the wrong storage type deletes nothing or everything. A hand-written
  double comparing two JS `Date`s calls both of those green. The test asserts
  `select typeof(expiresAt) = 'integer'` directly. The audit hit that exact defect
  in its own retention probe first, which is why it is asserted and not assumed.

Seven mutations, applied singly and reverted through Git, are recorded in
`docs/evidence/final-prelaunch/mutation-P-retention.md`. The one worth naming here
is **P7**: the provider is still resolved from the container but an inert stand-in
is handed to the handler. It **passes `tsc --noEmit`** — a missing required
argument is a compile error and needs no test, but a resolved-then-discarded one
compiles silently, and only the behavioural bootstrap assertion sees it.

### Runtime proof, because no mutation reaches it

Every unit test here runs in `environment: "node"` and constructs the handler
itself, so all of them stay green in a deployment where the lazy
`ensureWorkerReady()` is never triggered and nothing expires at all. Observed
instead, in a deployed standalone artifact: one real `compress-pdf` job triggered
the bootstrap at 22:36:55Z, and 900 s later, unprompted,
`{"msg":"Retention sweep complete","purged":325,"intentsPruned":0}` — with the row
that had been aged past its expiry gone and zero rows left expired. Full record in
`docs/evidence/final-prelaunch/retention-r19-r20.md`. That run is also where
`sessions already expired and still stored: 1` came from, which is how the second
finding was found.

**No migration and no schema change.** Both prunes are `deleteMany` over columns
that already existed.

## Cross-tenant refusals are now audited, not just correct

`workspacePageActor` refuses a Workspace page in two shapes: the caller is not a
member of the `organizationId` in the URL, or the membership exists with no role.
Both already answered correctly — Next's `notFound()`, a controlled 404 page,
nothing about the other tenant in the response. Neither wrote a line.

The reason is ordering, not omission: the organization guard runs **before** any
Workspace lookup, so `WorkspaceService.get` — the one place that logs
`workspace.access.denied` — is never reached. A URL naming another tenant's
`organizationId` is exactly the shape a deliberate cross-tenant probe has, and it
was the single refusal in the system that left no trace at all.

`denyOrganization()` now emits one `workspace.access.denied` line before
`notFound()`, with the same ids-only rule as `WorkspaceService`: `operation`,
`category` (`ORGANIZATION_NOT_FOUND` / `ORGANIZATION_ROLE_MISSING`), `stage`,
`actorId`, `organizationId` — no email, no session token, no cookie. Behaviour for
the caller is unchanged; only observability changed.

Five tests cover it; deleting the log call turns three of them red. The ids-only
test asserts `toHaveBeenCalledOnce()` **first**, because an absence check over an
empty object passes with the logging gone — a green test proving nothing is the
failure mode this repository keeps finding.

Measured on the deployed artifact rather than asserted: a browser walk through
every refusal shape left **6** `access-denied` lines in the server log — including
the two `workspacePageActor` lines that did not exist before — and **0** containing
an email, password, cookie or token. Record in
`docs/evidence/final-prelaunch/f5-cross-tenant-final.log`.

One probe row was wrong, and is recorded as such: "the refusals produced
structured access-denied lines" read the **browser** console, and only `next dev`
replays server stderr there, so against a production standalone build it can never
see one. It and its paired ids-only row are now `NOT EXERCISED` unless
`--dev-log-forwarding` is passed, and are counted in no total.

**No migration and no schema change.**

## A malformed upload body is the caller's error, and a 500 now leaves a trace

Two defects in one request, found by POSTing a hostile filename at a running
server rather than by reading code.

A filename containing a raw double quote makes the `Content-Disposition` header
ambiguous, so undici throws `TypeError: Failed to parse body as FormData.` before
any product code sees a file. That fell through the submit route's generic `catch`
and became **HTTP 500**, and the server log for the request was **empty**. A
malformed request is the caller's error, and a 500 nobody records cannot be
diagnosed after the fact.

The guard already existed in this codebase — the three Workspace upload routes have
always wrapped `request.formData()` and answered
`400 "Malformed multipart body."`. Only the two tool submission paths lacked it. The
fix is that same `try`/`catch` at `toolJobSubmit` and `processingJobSubmit`, throwing
`UploadValidationError`, which both routes already map to 400: no route changed, and
one guard covers every caller instead of one per route.

Separately, both unclassified-500 sites now log — the shared `jobErrorResponse`
helper and `/api/jobs`'s own catch. Error name and message only, never the
filename: the response body is deliberately vague because the message may name a
path or a command, which is exactly why the message has to go somewhere.

**Reachability, stated rather than assumed.** A spec-conforming client escapes the
quote as `%22`, and that round-trips back to the literal name, so no browser reaches
this path — the public API does. `finalPrelaunchRegression` R19b asserts all three
halves: that the parser really does reject the raw body (so the guard is not dead
code), that the escaped form parses back byte-for-byte, and the guard's shape at
both submit paths. Three cases in `jobErrorDisclosure.test.ts` cover the logging,
including a non-`Error` throw and that classified refusals stay silent. Mutations
U1–U3 turn them red.

**No migration and no schema change.**

## One upload boundary: authenticate before parsing, and bound the parse

The previous entry closed a malformed-body 500 by wrapping the two tool submit paths in the
same guard the three Workspace upload routes already had. Listing all five call sites to prove
that fix had no unguarded sibling is what exposed this one: on the three **private** upload
routes the only thing ahead of `request.formData()` was `requireSameOrigin`, so an
**unauthenticated** caller's 8 MiB multipart body was buffered and parsed before any
authentication ran — and unlike the *public* tool route, none of the private ones had a rate
limit. Bounded per request, unbounded in request count. Reclassified **P2 → P1** and closed.

### What was built

**`lib/server/multipart.ts` — the only `request.formData()` in shipped code.** One reader, one
taxonomy. `readMultipart` wraps `request.body` in a counting stream that **errors instead of
enqueueing** the chunk that would cross the ceiling, so peak cost is the ceiling plus one
chunk and the bound does not depend on `Content-Length`; the rebuilt Request uses
`duplex: "half"`. `parseOrThrow` walks `cause` to recover the ceiling from undici's TypeError,
which is what keeps a streamed 413 from arriving as a 400. `MultipartTooLargeError` →
413 `PAYLOAD_TOO_LARGE`, `MalformedMultipartError` → 400 `MALFORMED_MULTIPART`. The old
`422 "A multipart upload is required."` for an unreadable body is gone: a multipart upload
*was* supplied, it just could not be read. 422 keeps its correct use — a well-formed body with
invalid fields.

**`lib/server/workspaceUploadGate.ts` — the boundary the three private routes share.** In
executed order: origin/CSRF → declared length → media type → session lookup → rate limit →
401 → bounded parse. Nothing above the parse touches `request.body`, and every refusal carries
`Cache-Control: no-store` — the 403 and the 401 included.

Two orderings are deliberate and are documented in the file so they are not "tidied" later.
The **session lookup runs before the limiter while the 401 is returned after it**, because
keying an authenticated caller `user:<id>` requires knowing who they are; an anonymous flood
therefore costs one session lookup, never a parse. And **organization authorization stays
after the parse**: the organization id is a *form field*, so hoisting it would authorize
against an unknown organization and would make a foreign Workspace distinguishable from a
missing one.

**`lib/server/uploadRateLimit.ts` — pre-parse abuse control on the same `RateLimiter` the six
already-protected routes use.** 120/min keyed `user:<id>`, 20/min per trusted client, 240/min
global, 60 s window, all three overridable (`UPLOAD_RATE_LIMIT_PER_MIN`,
`UPLOAD_ANON_RATE_LIMIT_PER_MIN`, `UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN`) and each an invalid value
away from a **fatal** config error rather than a silent default. Forwarding headers are read
only when the request presents `x-pdfdadi-proxy-secret` matching `TRUSTED_PROXY_SECRET`
(sha256 + `timingSafeEqual`); default is unset, so they are not read at all. Unauthenticated
traffic always charges the unspoofable global bucket and a trusted bucket refuses *earlier,
never instead*, so a rotated forgery escapes nothing. The limiter **fails closed**.
`Retry-After` is the time left in the caller's own window, never a constant.

**`proxy.ts` — the five multipart endpoints are excluded from the middleware matcher.** A
matched path waits for the last byte before the handler runs, which is why a 1 ms gate refusal
still arrived only after 8 MiB. `/api/nope` with no route at all waited 2616 ms for a 200 MiB
body; `/api/nope.txt`, excluded, answered in 3 ms. `$`-anchored so every descendant route stays
matched.

### Tests, and why they measure instead of arguing

`uploadBoundary.test.ts`, S1–S18. Each request is sent through a stream that counts bytes
written **at the instant the response arrives**, so "refused before the parse" is a number.
S1 fails if a sixth `.formData()` appears anywhere in shipped code. S9/S10 cover absent,
understated, conflicting and unparseable `Content-Length` plus chunked. S13/S14 run both
topologies and every forwarding-header shape. S15 re-measures the non-disclosure invariants
that moving authentication earlier could have broken. S16 plants strings in filenames, field
values and body bytes and asserts none reaches a log, an audit row, a rate-limit key or a
refusal body.

Eleven mutations, each alone, intended test red, reverted with a verified-clean tree. Two of
them changed product code rather than tests: a forged header could name a bucket, and
"earlier, never instead" was unpinned — both green under mutation, both now pinned.

Live against a rebuilt artifact: anonymous 8 MiB → **401 in 1–10 ms with 0.06 of 8.00 MiB
sent**, on all three routes, direct and through a TLS front; 8 concurrent anonymous 8 MiB
(64 MiB offered) → all 401 with RSS 377.3 → 377.8 MiB; chunked 26 MiB with no
`Content-Length` → 413 after 25.5 MiB; 429 with a `Retry-After` that was obeyed to the second
and honoured. 32/32.

**No migration and no schema change.** Optional env only: `TRUSTED_PROXY_SECRET` and the three
`UPLOAD_*_PER_MIN` overrides. The limiter is process-local, like every other limiter here, so
behind N instances the request ceiling is N × the number — the per-request **byte** ceiling is
unaffected.

## Final code-readiness reconciliation

- **Purpose:** Close four readiness contradictions that a green suite had not closed —
  nine high dependency advisories, one full-suite failure whose identity was never
  retained, process-local upload limiting with no enforced instance topology, and five
  upload paths excluded from Next's proxy matcher without proof that every other matcher
  responsibility survived. No product feature was added. Product-side changes are exactly:
  one runtime source file (`src/infrastructure/config/env.ts`, the topology gate), two
  production dependency upgrades (`next 16.2.12 → 16.3.4`, `pdfjs-dist 6.1.200 → 6.3.289`)
  plus one narrow `overrides` entry, and deployment configuration
  (`docker-compose.yml`, `.env.example`). Everything else is tests, harness scripts and
  evidence.
- **Advisories:** 0 vulnerabilities on the production graph and the full graph, down from
  9 distinct production advisories (11 full-graph). **They were fixed, not reclassified,
  and 9 of the 11 were production-reachable** — `next` (which carried the nested `postcss`
  and `sharp` fixes), `pdfjs-dist`, `brace-expansion` (which reaches production through
  `archiver`, not just eslint), `nanoid`, `autoprefixer` for the two dev-only
  `browserslist` entries, and one narrow `overrides: { "deepmerge-ts": "^8.0.2" }` where
  `@prisma/config` pins 7.1.5 and npm's own proposed fix was a semver-major *downgrade*.
  Prisma compatibility with the override was proved (`validate`, `generate`,
  `migrate status` all exit 0), not assumed. Where a fix existed, reachability was never
  used as an argument. Three tests keep it that way: the inventory is derived from the
  audit JSON rather than written beside it, production-reachability is re-derived from real
  lockfile edges and dev flags, and each installed version is asserted outside the window
  that was actually violated.
- **The unattributed failure:** reproduced at seed 20260904, owned, fixed. Cause was
  test-side, not the product — a shared not-found spy left set by whichever test ran
  first, a wall-clock fallback racing an abort, and one file crossing vitest's inherited
  5000 ms default. `testTimeout` is now declared explicitly. Three retained runs at the
  tip are GREEN at **384 files / 7432 tests**, including the previously red seed and a
  single-worker run.
- **Instance topology, declared and gated — not yet excluded** (this heading read "now
  enforced rather than described", which overstates a boot gate; the body below was already
  accurate that it is not mutual exclusion, and the ingress closeout made it so)**:**
  `DEPLOYMENT_TOPOLOGY` is
  required in production and `single-instance` is its only accepted value. The boot gate
  reports it alongside every other problem, states the multiplied budget using the
  operator's own configured limits, and stays out of development and `next build`.
  `docker-compose.yml` declares it and pins `container_name`, so
  `docker compose up --scale pdfdadi=2` fails. It is **not** mutual exclusion, and
  `SERVER_SETUP.md` says so. No Redis or other service was added.
- **Matcher parity:** tested against the regexp the cold production build actually
  compiled — `functions-config-manifest.json`, because Next 16's `middleware-manifest.json`
  is present, parsable and empty. All five upload paths excluded; every other API route on
  disk still matched, including ones added after the test. Boundaries: trailing slash,
  query string, percent-encoding (matched raw, excluded decoded), nested ids, similar
  prefixes, and the two dimensions the matcher does not have — method and case. Every
  responsibility in the inventory is disposed of per route (headers from
  `next.config.mjs`; nonce inapplicable to a handler that renders no script; CSRF, auth,
  limiting, tracing and `no-store` inside the gate); the list itself is pinned so a new
  responsibility cannot skip the file. Nothing was lost, so nothing moved.
- **Authentication cost at the gate, measured:** 5002 sessions, median of 21 — no cookie
  **0 queries**, malformed 1 / 0.168 ms, random invalid 1 / 0.090 ms, expired 1 /
  0.140 ms, valid 2 / 0.211 ms; the plan searches the unique token index and never scans
  `sessions`. No preliminary control was added, and that is the measured conclusion: the
  two candidates are a spoofable key or one global bucket, i.e. an easy denial of service.
- **Tests added:** `finalReconciliation.test.ts` 18 (R1–R5), `deploymentTopology.test.ts`
  12 (R6/R8), `proxyMatcherParity.test.ts` 19 (R9–R11), `authLookupCost.test.ts` 6
  (R12/R13). Mutations: **10/10** red then reverted.
- **Regression surface held:** 78 S1–S18 assertions green, live `upload-abuse-probe`
  **32/32**, and every live gate re-run at one cold artifact
  (`BUILD_ID J9-02HdnjsxfHyAkc7Xg-`): csp 118/118, proxy-parity 37/37, job-ownership
  25/25, export-fidelity 35/35, workflow-completeness 155/156, tsc/eslint/prisma clean.
- **Known limitations** (the first of these was CLOSED IN CODE at the ingress closeout —
  see "Ingress body policy and the single-instance lease" below; it is left here as written
  because the reasoning it records is what the closeout had to overturn)**:** Matched paths
  still retain up to `proxyClientMaxBodySize`
  (120 MB) of an anonymous body before dispatch — every page URL and every unrouted path,
  with no limiter in front; 28 concurrent 100 MiB posts took one process 301 → 1795 MB
  RSS. Pre-existing Next behaviour, strictly reduced by the exclusion, quantified in
  `docs/evidence/final-prelaunch/proxy-body-clone-cost.log`. Not fixed in code: the only
  in-app lever re-arms the silent truncation `next.config.mjs:130-159` guards against, so
  the mitigation is a reverse-proxy `client_max_body_size` with
  `proxy_request_buffering off` on the five excluded paths, now in `SERVER_SETUP.md`. The
  topology gate is a declaration, not mutual exclusion.
- **No migration and no schema change.** One variable becomes required in production:
  `DEPLOYMENT_TOPOLOGY=single-instance`.
- **Next related step:** human visual acceptance (Entry Gate B) and production acceptance
  in a real environment. Neither is code, and neither was performed here.

## Ingress body policy and the single-instance lease

The previous entry's own "Known limitations" is what this one closes, and the reasoning there
is what had to be overturned. Two claims were wrong. "The only in-app lever re-arms the silent
truncation `next.config.mjs:130-159` guards against" — the only lever *inside Next's
configuration*, yes; there is another one outside it, the `http.Server` Next is handed. And
"the topology gate is a declaration, not mutual exclusion" was accurate as written and was
being *reported* as enforcement. Both were reclassified from "recorded and mitigated by
configuration" to open P1 and closed in code.

Measured before: a page URL and an unrouted path each retained up to 120 MB of an anonymous
body before dispatch, and two production processes against one SQLite database both booted and
both served `200` — each with its own in-memory rate-limit `Map`, so the global upload ceiling
admitted twice its budget against a database that assumes one writer.

### What was built

**`ingress/guard.mjs` — the seam, at `http.createServer`.** `installIngress()` patches the
factory once and swaps the single `'request'` listener Next installs for one that classifies
first and delegates second, so the policy is in place **before the port binds**. That timing is
the whole design: the generated `.next/standalone/server.js` prints `✓ Ready in 0ms` *before*
`instrumentation.ts` runs, so anything that must refuse on behalf of a not-yet-known state
cannot live in instrumentation. A refusal writes JSON plus `connection: close`, which is what
actually stops an in-flight transfer — the sender never gets to finish sending.

**`ingress/policy.mjs` — three classes, one implementation.** **A** (`CLASS_A_MAX_BYTES` 0):
everything that takes no body — page URLs, GETs, `/admin/*`, and **every unknown path**, which
refuses byte-identically to a known one so a body-bearing probe cannot tell a page from a
protected route from a nonexistent one. **B** (`CLASS_B_MAX_BYTES` 2 MiB): JSON,
`application/csp-report`, `text/plain`, form-encoded — refused on the request line, before
parsing. **C**: the five matcher-excluded multipart paths, unchanged, still on
`lib/server/multipart.ts`'s bounded reader with authorization first. Chunked or absent
`Content-Length` on A/B is **411 before a byte is read**, because measuring a body means
reading it; `Content-Length` is parsed digits-only so the guard agrees with Node's own parser
rather than holding a second opinion about the same header.

**`ingress/bodyRoutes.mjs` — 98 routes, and a test that fails when one appears without a
policy.** Every route with the methods it exports and its class, including the seven that read
no body, because "reads nothing" is a policy an edit should not be able to change silently.
Membership is "can receive a body", not "calls `.json()`" — `app/api/auth/register/route.ts` is
`export const POST = signupPost`, which a file-local search for a body read would have missed.
`ingress/bodyRoutes.test.ts` walks `app/api/**` on disk and goes red when a route exists that
the table does not list, when it lists one that no longer exists, when a route's methods
change, or when a class C entry has no ceiling of its own.

**`ingress/server.mjs` — the entry, and the refusal to run without it.** It installs the guard
and then `require`s the generated server. `assertIngressInstalled()` in `instrumentation.ts`
makes an unguarded production boot **exit 1** rather than serve, and `Dockerfile:102` starts
`prisma migrate deploy … && exec node ingress/server.mjs`.

**`src/infrastructure/config/instanceLease.ts` — mutual exclusion, one row.**
`instance_leases` id `app`: `create` wins the first boot, and afterwards
`updateMany WHERE id='app' AND (holder=me OR expiresAt < now−grace)` updates exactly one row or
none — the read and the write are one statement, so two contenders cannot both see a free
lease. `holderId = <host>:<pid>:<uuid>` is per **process**, so a restart onto a recycled pid
cannot inherit a lease. TTL 10 s, heartbeat 3 s, clock grace 2 s. A refused process does not
exit: it cannot serve (the guard answers 503 to everything while the lease is not held) and
exiting would turn every stale-lease window into a restart loop under
`restart: unless-stopped`, so it becomes a **warm standby** that retries on the same interval.
`/api/health/ready` carries a named `instance` check.

### Tests, and why the numbers are the argument

- **Live, on a cold `output: "standalone"` artifact** (`BUILD_ID 98appVCcbyMxzlhk26zya`): the
  original 28 × 100 MiB burst, twice on one process. Unguarded it read all 2800 MiB and grew
  +2800 then +828 MiB, monotonically. Guarded it read **15.75 MiB of 2800 offered** and moved
  RSS **0.0 MiB** — 238.4 → 238.4 → 238.4, then 241.3 → 241.3 → **238.0**, settling below its
  own baseline. `scripts/ingress-probe.mjs` **25/25**, twice.
- **The ceiling triple, which is what "no silent truncation" means.** One byte below the class B
  ceiling reaches the application (413 from the route, **with a CSP**); exactly the ceiling
  likewise; one byte over is the guard's 413 with **no CSP** after 0.06 MiB. The CSP is the
  external witness throughout: every Next response carries one, so a response without one was
  written before Next ran.
- **Five controls read off the baseline JSON and compared** — status, CSP provenance and body —
  5/5 identical (E16). A slow legitimate body (64 KiB every 40 ms for 3.0 s) is untouched; a
  malformed sub-ceiling body still gets the route's own documented answer, not the guard's.
- **Two processes, one database:** `scripts/singleton-probe.mjs` **8/8**. SIGKILL the holder and
  the standby served in **12 107 ms** unattended; after a clean SIGTERM release a fresh
  instance acquired in **433 ms**, against ≥12 000 ms for the expiry path.
- **68 unit tests** — `ingress/policy.test.ts` 16, `guard.test.ts` 11, `bodyRoutes.test.ts` 7,
  `instanceLease.test.ts` 14, `ingressState.test.ts` 4, `instrumentation.test.ts` 8,
  `readyRoute.test.ts` 8. **13 mutations, 13 caught**, each applied alone and reverted; M6
  (skipping GET/HEAD) is recorded as a near-miss because one assertion caught it and no live
  probe could have — a GET with a body is not a shape a browser produces.
- **Regression surface held** at the same artifact: upload-abuse **32/32** with S1–S18 intact,
  csp 118/118, proxy-parity 37/37, job-ownership 25/25, tool-matrix 29/29 exercised,
  phase1-reliability 29/29, workflow-completeness 155/156, export-fidelity 35/35, vitest
  **389 files / 7487 tests**, tsc 0, eslint 0 errors, prisma valid. **PRODUCT FAILURE 0**.

### Two instrument defects found by running it

`scripts/ingress-probe.mjs` read `peakOk = baseline === null || peak - baseline <= 150`: run
without `--pid` it sampled nothing and printed `RSS null → peak 0 → settled null` **under a
PASS** — a memory claim, in the finding that is entirely about memory, that no one had
measured. And S7's bare `status === 200` is also what waiting out the expiry produces, so it
was green at baseline where nothing was ever released, and green again with a shutdown bug that
skipped the delete; it now asserts an 8 000 ms budget the expiry path cannot meet.

### One migration, and two operational consequences

`20260905090000_add_instance_lease`. **Apply migrations before starting** — a database with no
`instance_leases` makes *every* process refuse (`serving=0`: the correct direction, but a total
outage), which is how it was found. **Start through `node ingress/server.mjs`** — the generated
entry exits 1 in production. Both are now in `SERVER_SETUP.md`, which also no longer requires a
reverse proxy for body limits: the app bounds bodies itself, and the nginx `location` list is
kept as defence in depth.

- **Known limitations:** the lease is judged on the application clock plus a 2 s grace margin —
  exact on one host, and marked `ponytail:` in the source with the upgrade (compare against
  `now()` in the database) for the day a second host is real. A standby is failover, not
  capacity: the upload limiter is still per-process memory, safe *by exclusion*, so it must
  move to a shared store before the lease is relaxed. Carried forward unchanged and not closed
  here: `app/api/storage/multipart/**` is anonymous, bounded by class B's 2 MiB rather than by
  authorization.
- **Next related step:** container execution is **NOT EXERCISED** — no local `docker`, so the
  `CMD` is covered statically and by `deploymentArtifact.test.ts` (mutation M12). Then human
  visual acceptance (Entry Gate B) and production acceptance. None is code, and none was
  performed here.

## The third path that could put live data in the image layer

**Date:** 2026-09-05 · **Scope:** production configuration gate, deployment
documentation, and the two probes that check them. Found during the production
acceptance (Stages 2–4), not by a report.

### What was built

The gate refused a **relative `DATABASE_URL`** with a message naming the exact
consequence — "a relative path would silently put the live database inside the
container's writable layer and delete it on the next deploy" — and refused
**half-configured R2** because it falls back to local disk and "uploads would land
on an ephemeral container disk and vanish on redeploy". The third path with that
same failure mode, **local storage with a relative root**, had no guard at all:
`LocalFileStorage` does `path.resolve()`, so the `.storage/local` default resolves
against the working directory, which in the image is `/app`. `docker-compose.yml`
sets an absolute root onto the `pdfdadi-storage` volume, so this repository's own
deployment was never exposed; a `docker run`, a PaaS or a systemd unit was.
`productionProblems` now refuses a relative **or empty** `STORAGE_LOCAL_ROOT` when
object storage is local — empty is the same branch because it resolves to the
working directory itself, which would write documents among the application files.

Two things the same acceptance found in the deployment artifacts:

- `SERVER_SETUP.md`'s compose-free `docker run` said every variable in it was
  required and **omitted `DEPLOYMENT_TOPOLOGY`**, so the command as printed exited
  1 before serving a request.
- `PROCESSING_COMPRESS_TIMEOUT_MS` was read unguarded into `setTimeout`, where
  `""`, a typo or a negative value means ~1 ms: every pipeline compress job would
  abort on its first tick and report a timeout. Guarded the way its three
  neighbours already were.

### Tests, and why they ask instead of restating

`deploymentArtifact.test.ts` asserted three variable names by hand — which is how
it stayed green while the gate grew two more requirements. It now resolves the
compose `environment:` block the way Docker would (`${X:-default}` to the default,
`${X:?…}` to a stand-in, because that value is the operator's contribution and not
the file's) and hands the result to **`productionProblems` itself**; it does the
same with the `-e` flags parsed out of the documented `docker run`. A requirement
added to the gate tomorrow fails both deployment paths tomorrow.

`scripts/migration-restore-drill.mjs` derived the head migration dynamically but
compared against a **hardcoded table name** from an earlier phase. Once
`20260905090000_add_instance_lease` became head, the "absent before" row failed and
the "present afterwards" row passed for the wrong reason — a vacuous green next to
a red one. Both now derive the table from the head migration's own SQL, and the
drill is PASS 16/16 against throwaway copies.

Every new guard was verified to **fail** with the property removed: the gate branch
deleted (two cases red), the storage root removed from compose, the topology flag
removed from the documented command.

- **Known limitations:** the gate checks the *shape* of a path, not that it is a
  mount point. Prisma **creates** a missing directory, so an absolute
  `DATABASE_URL` with a typo in it applies all 24 migrations to a brand-new empty
  database, exits 0 and serves — indistinguishable from a first deploy. Verifying
  the mounts is an operator step at first boot, now a row in the go-live checklist.
  `/api/health/ready`'s `dataDir` check remains `fs.access(dirname(STORE_PATH))`:
  presence of `/app/data/admin` only, no writability probe, nothing about the
  database directory or the storage root (manual row L3) — changing it changes when
  a load balancer drains, so it is an owner decision rather than a silent edit.
- **Next related step:** Stage 5 proxy topology, then the local production-mode
  surrogate for Stages 6–11. Container execution is still **NOT EXERCISED**: no
  runtime and no image scanner on this host.

## The rate-limit key a caller could choose

Every rate limiter except the upload limiter, plus five audit `ip` fields, was
keyed on `X-Forwarded-For` — a header the caller writes. Two functions answered
"who is calling": `uploadRateLimit.ts`'s `trustedClientAddress()` read forwarding
headers only after a `timingSafeEqual` match of `x-pdfdadi-proxy-secret`, while
`rateLimit.ts`'s `clientIp()` read them from anyone, with a comment calling a
trusted extractor "future work".

### What was built

`ingress/guard.mjs` deletes any client-sent `x-pdfdadi-peer` and stamps
`req.socket.remoteAddress` into it, before Next sees the request. `clientIp()` now
resolves in order: a **verified** proxy's `X-Forwarded-For` (or `X-Real-IP`) first
hop → the stamped peer → `"unknown"`. The trust rule itself moved *down* from
`uploadRateLimit.ts` into `rateLimit.ts` and is re-exported, so no importer changed
and the existing dependency direction (`uploadRateLimit` → `RateLimiter`) is not
reversed into a module-scope TDZ crash. The three auth routes now record
`ip: clientIp(req)` instead of the raw header.

The severity is the inversion, not the bypass: a browser sends **no**
`X-Forwarded-For`, so honest callers all shared the `"unknown"` bucket while a
caller sending `1`, `2`, `3` got a fresh bucket per request — strictest on the
traffic that was not attacking. Behind it sits a measured **22.2 ms median** of
blocked event loop per password attempt (`scryptSync`), which
`lib/admin/passwords.ts` justifies by citing the very limit that was rotatable.

The earlier audit had accepted a dilemma — spoofable, or one global bucket that is
itself a denial of service. The third source is the socket: production refuses to
serve when the ingress guard is not installed, so a stamped peer address is always
available and cannot be forged.

### Tests, and the one that was inert until a Unix socket

`ingress/guard.test.ts` pins the header name against the app's own constant (the
string is duplicated because the guard loads before the Next bundle exists),
proves a client's copy is overwritten over TCP, and connects over a **Unix domain
socket** to make the `delete` bite: over TCP the assignment that follows overwrites
the forged value anyway, so deleting that line left the suite green. Six mutations
were run and every one went red — including the two that check the nginx caps
documented in `SERVER_SETUP.md` against `STREAMING_ROUTE_PATTERNS`, a set the guide
had asked readers to keep in step by hand.

Six route-test helpers were rotating `X-Forwarded-For` to isolate the in-process
limiters; they now rotate `x-pdfdadi-peer`. The three suites that assert
`X-Forwarded-For` is *not* trusted were left exactly as they were.

- **Known limitations:** behind a reverse proxy with no `TRUSTED_PROXY_SECRET`
  every request arrives from the proxy's address, so all callers share one key —
  unspoofable, but one caller can spend another's budget on the credential
  endpoints. The server now warns once per process, naming the variable and never
  the address. Runtime confirmation that the stamped header reaches a route handler
  is static only (Next 16.3.4's `NextRequestAdapter` builds the handler's `Request`
  from the mutated headers); the end-to-end row is owed by the rebuilt surrogate.
- **Next related step:** Stages 6–11 against the local production-mode surrogate,
  which needs a rebuild and will therefore change `BUILD_ID`.
