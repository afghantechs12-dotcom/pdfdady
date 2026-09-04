# Request-gate ordering at every multipart call site

Branch `upload-abuse-closeout` · gate code at f6f0fa8 · artifact BUILD_ID VWgZdjW1LEZvaUo6nwJJi
Behavioural source for every "measured" claim: `uploadBoundary.test.ts` (S1–S18) and
`docs/evidence/final-prelaunch/upload-abuse-live.json` (32/32 against the running artifact).

Stage numbers are the audit brief's: (1) request-size checks · (2) content-type
validation · (3) same-origin/CSRF · (4) session authentication · (5) tenant/Workspace
authorization · (6) rate limiting · (7) multipart parsing · (8) field validation ·
(9) storage/processing.

Nothing below is inferred from source shape. Each row's "body consumed" column is a
measurement: the tests send a body through a stream that counts bytes written at the
moment the response arrives, and the live probe reports `sent X/Y MiB`.

## The five call sites

`grep -rn '\.formData()' app/ lib/ src/ components/ --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
returns exactly one shipped line at the branch tip — `lib/server/multipart.ts:113`, inside
`readMultipart`. The five *upload* entry points reach it through two shared functions:

| # | Entry point | Reaches the parser via | Ceiling |
|---|---|---|---|
| 1 | `POST /api/workspaces/[workspaceId]/documents/upload` | `workspaceUploadGate` | 100 MiB (`DOCUMENT_INGESTION_LIMITS.maxUploadBytes`) |
| 2 | `POST /api/workspaces/[workspaceId]/documents/[documentId]/versions/upload` | `workspaceUploadGate` | 100 MiB (same constant) |
| 3 | `POST /api/workspaces/[workspaceId]/documents/[documentId]/attachments` | `workspaceUploadGate` | 25 MiB + 64 KiB envelope (`METADATA_LIMITS.maxAttachmentBytes`) |
| 4 | `POST /api/tools/[slug]` | `submitToolJob` → `readMultipart` | 110 MiB (`TOOLS_MAX_BODY_BYTES`) |
| 5 | `POST /api/jobs?slug=…` | `submitToolJob` / `submitProcessingJob` → `readMultipart` | 110 MiB (same) |

## Sites 1–3 — the three private routes (`lib/server/workspaceUploadGate.ts`)

Executed order, and what each stage costs an unauthenticated caller:

| Order | Stage | Code | Refusal | Body consumed |
|---|---|---|---|---|
| 1st | (3) same-origin/CSRF | `requireSameOrigin` | 403 `CSRF_ORIGIN_REJECTED` | no — L5: 403 in 1 ms, 0.06/8.00 MiB |
| 2nd | (1) declared size | `declaredLengthExceeds` | 413 + route's own message | no — L2: 413 in 1–2 ms |
| 3rd | (2) media type | `isMultipartRequest` | 415 `INVALID_INPUT` | no — L6 |
| 4th | — | `getSessionUser` (lookup only, no refusal) | — | no |
| 5th | (6) rate limit | `checkUploadLimit` | 429 `RATE_LIMITED` + `Retry-After` | no — L8b: 429 in 1 ms, 0.06/8.00 MiB |
| 6th | (4) authentication | the deferred 401 | 401 `UNAUTHORIZED` | no — L1: 401 in 1–10 ms, 0.06/8.00 MiB, all three routes, both topologies |
| 7th | (7) bounded parse | `readMultipart(request, maxBytes)` | 413 / 400 `MALFORMED_MULTIPART` | yes, up to the ceiling |
| 8th | (8) field validation | each route's zod schema | 422 `INVALID_INPUT` | yes |
| 9th | (5) tenant authorization | `getWorkspaceActor(request, organizationId)` | existing non-disclosing 403/404 | yes |
| 10th | (9) storage/processing | the route's service call | — | yes |

Two orderings in that table are deliberate and cannot be swapped:

**Session lookup (4th) precedes the limiter (5th), but the 401 (6th) follows it.** Keying
an authenticated caller as `user:<id>` requires knowing who they are, and that key is the
one a caller cannot forge. So the lookup happens first and the *refusal* is deferred: an
anonymous flood is stopped by the limiter after one session lookup, never after a parse.
Measured: L8b offers 8 MiB while limited and 0.06 MiB is read.

**Tenant authorization (5th stage) stays last, after the parse.** The organization id is a
*form field*, not a path segment. Hoisting authorization above the parse would mean
authorizing against an unknown organization, and answering differently for "no such
Workspace" and "a Workspace you cannot see" is exactly the disclosure the Workspace slice
refuses. S15 measures that a real and an invented Workspace still answer identically to an
anonymous caller, and that a foreign organization is indistinguishable from a missing one.

Every refusal from the gate — including the CSRF 403 and the 401 — carries
`Cache-Control: no-store` (`refuse()`), confirmed live in the L1/L2/L5/L6/L7/L8 rows.

## Sites 4–5 — the two public tool routes

Order (`app/api/tools/[slug]/route.ts:66-113`, `app/api/jobs/route.ts:52-119`):

| Order | Stage | Code | Refusal |
|---|---|---|---|
| 1st | route resolution | `getServerToolConfigMerged` + `getProcessor` | 404 |
| 2nd | (6) rate limit | `RateLimiter.hit(clientIp(request))` | 429 + `Retry-After: 10` |
| 3rd | (1) declared size | `Number(content-length) > MAX_BODY_BYTES` | 413 `Upload too large.` |
| 4th | concurrency | `acquireSlot()` | 429 (`TooBusyError`) |
| 5th | actor | `resolveJobActor()` — session or this visitor's anon id | — |
| 6th | (7) bounded parse | `readMultipart(request, toolsMaxBodyBytes)` | 413 / 400 `MALFORMED_MULTIPART` |
| 7th | (8) field validation | `validateUpload` (+ batch admissibility) | 400 |
| 8th | admission | `UsageMeteringService.authorize` | 429 `UsageLimitError` |
| 9th | (9) storage/processing | `uploadStream` then `enqueue` | — |

Stages (3), (4) and (5) do not apply here and are not missing: these are the *public*
anonymous tool endpoints. There is no tenant, authentication is not required, and no CSRF
gate has ever guarded them — an anonymous visitor with no cookie is the primary caller.
What they do have is stage (6) ahead of everything heavy, which is what the three private
routes lacked. S17 measures that both submit paths raise the shared errors and that both
routes map them to 400/413 rather than 500.

## The limiter

`lib/server/uploadRateLimit.ts`, built on the same `RateLimiter` the six previously
protected routes use (`lib/server/rateLimit.ts`) — no route-local counter.

- **Window** 60 s fixed (`WINDOW_MS`), three buckets from `getConfig().upload`:
  `userPerMin` 120 (`UPLOAD_RATE_LIMIT_PER_MIN`), `anonPerMin` 20
  (`UPLOAD_ANON_RATE_LIMIT_PER_MIN`), `globalPerMin` 240
  (`UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN`).
- **Invalid config is fatal.** Each is `z.coerce.number().int().positive()`, so a
  non-numeric or zero override fails the whole config parse instead of silently reverting
  to a default. `TRUSTED_PROXY_SECRET` is `z.string().min(16)`: a guessable secret buys the
  ability to name your own rate-limit key, so a short one is a configuration error.
- **Identity.** An authenticated caller is keyed `user:<id>` — server-derived from the
  session cookie, unforgeable by the body or by any header. An unauthenticated caller has
  no trustworthy identity, so it is charged to `global` *always*, and to a per-client
  bucket *additionally* when — and only when — the request presented the configured proxy
  secret. "Earlier, never instead": the trusted bucket can refuse sooner, it never replaces
  the unspoofable one. Mutation H found that property unpinned; S14 now pins it.
- **Trusted proxy.** `trustedClientAddress` returns `null` unless
  `x-pdfdadi-proxy-secret` matches `trustedProxySecret` under a sha256 +
  `timingSafeEqual` comparison; only then is the first `x-forwarded-for` hop (else
  `x-real-ip`) read. Default is `null`, i.e. forwarding headers are not read at all. S13
  and S14 measure both topologies: rotation of a forged header cannot escape the global
  bucket, and a wrong secret is treated as no secret.
- **Fail-closed.** The `catch` in `checkUploadLimit` returns
  `{limited: true, retryAfterSeconds: 60, bucket: "unavailable"}` — a limiter that cannot
  answer refuses. Pinned by S5.
- **`Retry-After` is computed, not constant.** `RateLimiter.retryAfterSeconds` returns the
  time left in the caller's own window (`+1 ms` so the boundary instant is not refused
  again, minimum 1 s). Measured: L8 got `Retry-After: 58` at attempt 227, and L9 obeyed it
  to the second and was *not* refused again (401, i.e. through the limiter to the auth
  gate).
- **Nothing sensitive is a key or a log field.** Keys are `user:<id>`, a trusted client
  address, or the literal `global`. `UploadLimitBucket` carries no key at all, so a bucket
  name is safe to log. S16 plants strings in filenames, field values and body bytes and
  measures that none reaches a log line, an audit record, a rate-limit key or a refusal
  body.
- **Process-local.** State lives in this process's `Map`, exactly like the six pre-existing
  limiters. Behind N instances the effective ceiling is N × the configured number. That is
  a documented deployment consequence, not a claim of shared enforcement; the per-request
  byte ceiling is unaffected because the bounded reader is per request.

## Size enforcement without trusting `Content-Length`

`declaredLengthExceeds` is a cheap pre-check on a *claim*. The authoritative bound is the
counting stream in `readMultipart`, which wraps `request.body`, and **errors instead of
enqueueing** the chunk that would cross the ceiling — peak resident cost is the ceiling
plus one chunk, and the rebuilt Request uses `duplex: "half"`.

| Header shape | Behaviour | Evidence |
|---|---|---|
| Honest, over the ceiling | 413 before a byte is read | L2 (413 in 1–2 ms), S4 |
| Absent (`Transfer-Encoding: chunked`) | pre-check passes; stream refuses at the ceiling | L3: 413 after 25.50 of 26.00 MiB, RSS 377.8 → peak 378.1 MiB; S10 |
| Understated (declares 1 KiB, sends 26 MiB) | the framing layer reads only the declared bytes, so the parse sees a truncated body and the request is never served | L4; S9 |
| Two conflicting `Content-Length` values | refused | S9 |
| Negative / unparseable | treated as *no* declaration, so the stream bounds it | S9 |
| `Expect: 100-continue`, over-ceiling declaration | `100 Continue` is emitted by the Node runtime, not by route code, then 413 in 4 ms | L12 — reported honestly: the continue is the runtime's, and the route's refusal is still pre-body |

## Direct-origin access

Both topologies were measured, not assumed: `direct http://127.0.0.1:3052` (the standalone
server, no proxy in front) and `front https://172.20.10.2:3051` (the TLS front). Every L1
row passes on both. Because the default configuration reads no forwarding header, a caller
that reaches the origin directly is keyed exactly as one arriving through a front, and the
global bucket applies either way — there is no bypass that a proxy is needed to close.

## The residual, stated plainly

Next's middleware matcher used to include these five paths, and a matched path waits for
the last byte before the handler runs — so the gate's 1 ms refusal arrived only after the
client finished sending. f6f0fa8 excludes exactly the five upload paths (anchored with `$`,
so `/api/jobs/<id>/download` and every other descendant stay matched). Paths still matched
by the matcher still buffer their bodies; that is unchanged pre-existing behaviour for
non-upload routes, and it is recorded in `proxy.ts` with the measurements that found it.

No cookie, token, session value, filename, field value or body byte appears in this file.
