# PDFDadi — Server Setup

PDFDadi processes simple operations in the browser and heavier operations on
the server using well-known open-source binaries. This document explains how to
install those binaries and run the app in production.

## Server-side tools and their dependencies

| Tool | Binary | Package |
|------|--------|---------|
| Compress PDF, PDF to PDF/A, Repair (fallback) | `gs` | ghostscript |
| Repair PDF, Protect, Unlock, Flatten | `qpdf` | qpdf |
| OCR PDF | `ocrmypdf` (+ `tesseract`) | ocrmypdf, tesseract-ocr + language packs |
| Word/PowerPoint/Excel/HTML → PDF, PDF → Word | `soffice` | libreoffice |
| PDF to JPG / PNG | `pdftoppm` | poppler-utils |

You can verify what is installed at runtime by visiting **`/server-status`**
or calling **`GET /api/health/dependencies`**.

If a binary is missing, the matching tool returns a clear error:
`Server dependency missing: <tool>. Install it or run via Docker.`
No file is ever faked or returned without real processing.

## Production configuration gate

With `NODE_ENV=production`, PDFDadi validates its configuration **at process
start** and refuses to serve traffic if anything genuinely required is missing or
unsafe. It reports *every* problem at once and exits non-zero, so a misconfigured
deploy dies visibly instead of booting "healthy" and then failing on the first
request that happens to read config.

A failing start looks like this — note that it names variables and consequences
and never echoes a value, because this text lands in logs and error trackers:

```
[startup] PDFDadi refused to start.
Refusing to start: 4 production configuration problems.
  - DATABASE_URL is not set. Point it at a SQLite file on a persistent volume,
    e.g. file:/app/data/db/pdfdadi.db. There is no production default on
    purpose: a relative path would silently put the live database inside the
    container's writable layer and delete it on the next deploy.
  - ADMIN_SECRET is not set. It signs admin session cookies and local storage
    download URLs, so without it both are forgeable: admin takeover with no
    password, and arbitrary reads of any stored file.
  - NEXT_PUBLIC_SITE_URL points at a loopback host ...
  - DEPLOYMENT_TOPOLOGY is not set to "single-instance". PDFDadi's upload rate
    limits are counted in process memory, so N instances behind one address
    admit N times those budgets ...
```

The process then exits with code 1, so Docker, systemd or your orchestrator
reports a failed container rather than a running one that 500s.

**Required in production**

| Variable | Why the gate refuses to start without it |
|----------|------------------------------------------|
| `DATABASE_URL` | No production default. Must be an **absolute** `file:` path — see "Which database" below. A relative path would put the live database inside the container's writable layer and lose it on redeploy. |
| `ADMIN_SECRET` | Signs admin session cookies *and* local storage download URLs. Must be ≥16 characters, and must not be the public dev fallback string that ships in this repo. |
| `NEXT_PUBLIC_SITE_URL` | Signed download and multipart-upload URLs are built from it; a loopback value hands clients links to their own machine. Must be an absolute `http(s)` URL and not localhost/127.0.0.1/0.0.0.0/::1. |
| `DEPLOYMENT_TOPOLOGY` | Must be exactly `single-instance`, the only supported value. It makes the operator declare what the rest of the build assumes: upload rate limits are counted in one process's memory, and the database is single-writer SQLite. See "Instance topology" below. |

**Also refused**

- `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1` — a local-dev-only escape hatch for the
  public fallback secret. Not a warning in production; a refusal.
- `STORAGE_SIGNING_SECRET` set but shorter than 16 characters. Unset it (it falls
  back to `ADMIN_SECRET`) or give it a real random value.
- **Half-configured R2**: some but not all of `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. That state silently
  selects local-disk storage, so uploads would land on an ephemeral container
  disk and vanish on redeploy — data loss presenting as a typo. Set all four, or
  none to use local storage deliberately. The error names the missing ones.

**Also refused: an unusable upload limit.** `UPLOAD_RATE_LIMIT_PER_MIN`,
`UPLOAD_ANON_RATE_LIMIT_PER_MIN` and `UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN` must each be a
positive integer, and `TRUSTED_PROXY_SECRET` — if set at all — must be ≥16 characters. A
bad value fails the whole config parse instead of reverting to a default, because an abuse
control that quietly disables itself is worse than none: nothing announces that it is gone.
All four are **optional**; the three limits have working defaults (120 / 20 / 240 per
minute) and the secret defaults to unset, which means forwarding headers are not read.

**Optional features stay optional.** Absent Stripe config disables billing
(checkout/portal answer 503 `BILLING_NOT_CONFIGURED`), absent R2 credentials
select local storage, and an absent `REDIS_URL` selects the in-memory queue.
None of them blocks startup. A *partially* configured Stripe setup logs a loud
warning at boot and still starts — billing stays off.

**`next build` is exempt.** The build sets `NODE_ENV=production` too, but a build
is not a deployment: it has no deployment secrets and must stay hermetic, so CI
compiles with none of the above set. The gate keys off Next's
`NEXT_PHASE=phase-production-build` to tell the two apart.

On a healthy start you get one line naming provider selections and flags only —
never a secret:

```
[startup] PDFDadi configuration OK — env=production db=sqlite storage=r2 \
  queue=redis billing=enabled usageLimits=observe logLevel=info
```

### Which database — and why not PostgreSQL

`prisma/schema.prisma` declares `provider = "sqlite"`, and a Prisma datasource
accepts only its own provider's URLs. It does not discover a mismatch until it
**connects**, so a `postgresql://` value would pass the gate, log
`configuration OK`, answer the readiness probe, and then fail every request that
reads the database. The gate therefore refuses any `DATABASE_URL` that does not
begin with `file:`, and refuses a relative `file:` path as well.

Moving to PostgreSQL is a schema change plus a regenerated migration history
(all 23 migrations are SQLite DDL), not a change to this variable. Until that
work is done and verified, one writable deployment per database file is the
supported topology — see `docs/adr/ADR-M7-009-sqlite-operations.md`.

### Instance topology — one instance, declared at boot

`DEPLOYMENT_TOPOLOGY=single-instance` is required in production, and it is the
only accepted value. It is a declaration rather than a tuning knob, and two
independent things depend on it:

1. **The upload rate limits are per-process.** `lib/server/uploadRateLimit.ts`
   holds three `Map`s in memory — `user:<id>`, `client:<address>` and one literal
   `global` bucket. The global bucket is the one an attacker cannot rotate away
   from by changing keys, which makes it the real ceiling. Behind a load balancer
   with N instances, each admits the full budget independently, so that ceiling
   becomes **N × `UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN`** and the number in your
   configuration stops describing your deployment.
2. **The database takes one writer.** SQLite supports one writable deployment per
   database file (ADR-M7-009). That constraint holds regardless of rate limiting,
   and it is not relaxed by a shared queue.

There is deliberately no multi-instance value. Adding one would be a lie until
all three of these exist, in this order:

| Needed for multi-instance | Status today |
|---------------------------|--------------|
| PostgreSQL (or another multi-writer engine) with a regenerated migration history | Not started; `provider = "sqlite"` |
| A shared rate-limit store, so the three buckets are counted once for the fleet | Not started; the buckets are process-local `Map`s |
| A shared job queue | **Available** — set `REDIS_URL` (see "Background jobs") |

`REDIS_URL` alone does **not** make the app multi-instance; it moves job dispatch
out of the server process. The other two rows still apply.

**What the gate does and does not do.** It refuses to boot a production process
that has not declared the topology, and `docker-compose.yml` declares it and
pins `container_name`, which makes `docker compose up --scale pdfdadi=2` fail. It
is **not** mutual exclusion: two processes started by hand against the same
database would each declare `single-instance` and each start. Operating one
instance per database remains an operator responsibility — the gate makes the
assumption explicit and auditable, and R6/R8 in `deploymentTopology.test.ts` keep
it that way.

### Migrations

The schema is **not** created automatically by the server process. Apply it
before or as part of every deploy:

```bash
DATABASE_URL=file:/app/data/db/pdfdadi.db npx prisma migrate deploy
```

The Docker image does this for you: its `CMD` runs `prisma migrate deploy`
against `prisma/migrations` (both are copied into the image) and only then execs
the server, so a fresh volume gets its schema on first boot and an existing one
gets any new migrations. `migrate deploy` never generates or resets — it applies
committed migrations and fails loudly on a drifted database.

Implementation: `productionProblems()` in `src/infrastructure/config/env.ts` is
the single authority on what "required" means; `instrumentation.ts` (via
`src/infrastructure/config/startupGate.ts`) is what makes it happen at boot
rather than per request.

## Security response headers

Every route gets these via `headers()` in `next.config.mjs`:

| Header | Value |
|--------|-------|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` — **production only** |

HSTS is production-gated on purpose: sent over plain-HTTP local dev it would pin
`localhost` to HTTPS in the developer's browser for two years.

`Content-Security-Policy` **is** set, and enforced (not report-only). Both
places that can attach it use one builder, `buildCsp` in `lib/security/csp.mjs`,
so there is a single policy to read:

| Directive | Value |
|-----------|-------|
| `default-src` | `'self'` |
| `script-src` | `'nonce-<per-request>' 'strict-dynamic'` on documents; `'self'` on `/_next/static/*` and `/_next/image` |
| `style-src` | `'self' 'unsafe-inline'` |
| `img-src` | `'self' data: blob:` |
| `font-src` | `'self'` |
| `connect-src` | `'self'` plus the configured R2 origin, when one is configured **at build time** |
| `worker-src` | `'self'` |
| `object-src`, `frame-src`, `frame-ancestors` | `'none'` |
| `base-uri`, `form-action` | `'self'` |
| `report-uri` | `/api/csp-report` |
| `report-to` | `csp-endpoint` — **only** when `NEXT_PUBLIC_SITE_URL` is `https:` |

Two things an operator needs to know about it:

- **`connect-src` is baked at build time for static assets.** `headers()` in
  `next.config.mjs` is evaluated during `next build`, so an image built without
  R2 configuration ships a static-asset policy with no storage origin. `proxy.ts`
  reads the environment at boot and has no such limitation, so this affects only
  `/_next/static/*` — which issues no download `fetch`.
- **`report-to` needs https.** The Reporting API requires a secure context, and
  its presence *suppresses* `report-uri` by spec. On a plain-http origin it would
  therefore be a mute button rather than a fallback, so it is omitted there. If
  you terminate TLS at a proxy, set `NEXT_PUBLIC_SITE_URL` to the `https://`
  public URL and reports keep flowing.
- **On static assets, `report-to` is decided at BUILD time — including in
  Docker.** `next.config.mjs` resolves `reportingEndpointFor(NEXT_PUBLIC_SITE_URL)`
  once, while `next build` runs, so it is the *build* environment's value that
  decides whether `/_next/static/*` carries `report-to csp-endpoint` and a
  `Reporting-Endpoints` header. Setting the variable only at runtime fixes
  documents (`proxy.ts` reads the environment at boot) and cannot fix static
  responses — which is the half that matters for the pdf.js worker, since a Web
  Worker inherits the CSP of its own `/_next/static/media/*.mjs` response. The
  `Dockerfile` passes no build argument for it, so `docker build` with no extra
  flag produces an image whose static assets report only through `report-uri`.
  Pass it in:

  ```bash
  docker build --build-arg NEXT_PUBLIC_SITE_URL=https://pdfdadi.com -t pdfdadi .
  ```

  and add the matching `ARG NEXT_PUBLIC_SITE_URL` / `ENV NEXT_PUBLIC_SITE_URL`
  pair to the builder stage. Measured both ways on a cold 16.3.4 artifact:
  built with `http://localhost:3000`, the static policy ends `report-uri
  /api/csp-report` and carries no `Reporting-Endpoints`; built with the https
  origin it ends `report-uri /api/csp-report; report-to csp-endpoint` and carries
  `csp-endpoint="https://…/api/csp-report"`. Legacy `report-uri` works either
  way, so this degrades reporting rather than breaking the policy.

## Option A — Docker (recommended)

The provided image installs every dependency for you.

```bash
# ADMIN_SECRET is required (generate a long random value):
export ADMIN_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

# The public URL. Required in production: signed download and upload URLs are
# built from it, and the default below is almost certainly not your host.
export NEXT_PUBLIC_SITE_URL="https://your-host"

docker compose up --build

# App available at http://localhost:3000
# First run: visit http://localhost:3000/admin/setup to set the admin password.
```

`docker-compose.yml` supplies the remaining required configuration itself:
`DATABASE_URL=file:/app/data/db/pdfdadi.db` and
`STORAGE_LOCAL_ROOT=/app/data/storage`, both inside named volumes. Override
either from the environment if you mount storage elsewhere; do not point them
back inside `/app`, which is the image's own layer.

Three volumes persist across `docker compose up --build`: `pdfdadi-data`
(admin content, including the operator-set password), `pdfdadi-db` (the
database) and `pdfdadi-storage` (uploaded and generated documents). The app runs
on a no-egress `internal` network (see "Docker volume & network isolation"
below).

Or with plain Docker — note that every one of these is required, and that
without the two mounts the database and the documents live in the container:

```bash
docker build -t pdfdadi .
docker volume create pdfdadi-db && docker volume create pdfdadi-storage
docker run -p 3000:3000 --tmpfs /tmp \
  -e ADMIN_SECRET="$ADMIN_SECRET" \
  -e NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
  -e DATABASE_URL=file:/app/data/db/pdfdadi.db \
  -e STORAGE_LOCAL_ROOT=/app/data/storage \
  -v pdfdadi-db:/app/data/db -v pdfdadi-storage:/app/data/storage \
  pdfdadi
```

## Option B — Ubuntu / Debian server (manual)

```bash
sudo apt-get update
sudo apt-get install -y \
  libreoffice \
  ghostscript \
  qpdf \
  poppler-utils \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa \
  ocrmypdf \
  fonts-liberation fonts-dejavu fonts-noto-core \
  python3
```

Then build and run the Node server:

```bash
npm ci
npm run build
npx prisma migrate deploy   # applies the schema; required before the first start
npm run start               # serves on PORT (default 3000)
```

## Windows (local development)

The server tools (LibreOffice, Ghostscript, qpdf, Poppler, Tesseract,
OCRmyPDF) are Linux-friendly CLI tools. On Windows the simplest path is:

- **Use Docker Desktop** and run `docker compose up --build`, or
- Install the binaries manually (e.g. via Chocolatey:
  `choco install ghostscript qpdf poppler tesseract`, plus LibreOffice from
  libreoffice.org) and ensure they are on your `PATH`.

Browser-side tools (merge, split, organize, rotate, crop, images→PDF, edit,
watermark, page numbers, sign, fill forms, remove metadata) work locally with
**no extra dependencies**.

## Security & privacy model

- Uploaded files are written to a unique temp directory per job under the OS
  temp folder.
- Original filenames are never trusted for filesystem paths (path-traversal safe).
- File type, extension and size are validated before processing; total request
  body size is capped (`TOOLS_MAX_BODY_BYTES`) and checked from `Content-Length`
  before the multipart body is buffered into memory. `Content-Length` is only the
  *cheap* check: every multipart read goes through `lib/server/multipart.ts`, whose
  counting stream errors on the chunk that would cross the ceiling, so a chunked or
  understated body cannot get more parsed than an honest one. **No reverse proxy is
  required for this bound** — the app enforces it.
- External binaries are invoked with `execFile` and **argument arrays** — user
  input is never interpolated into a shell string.
- Each job has a processing timeout; the concurrency slot is acquired *before*
  buffering so the memory-heavy parse phase is also bounded.
- The public tool API is per-IP rate-limited (`TOOLS_RATE_LIMIT_PER_MIN`).
- **Every multipart upload route is rate-limited before it parses anything**, and the
  three private Workspace upload routes **authenticate before they parse** — an
  anonymous caller gets 401 after roughly 64 KiB of an 8 MiB body has arrived, not
  after all of it. Defaults: 120 uploads/min per signed-in user
  (`UPLOAD_RATE_LIMIT_PER_MIN`), 20/min per trusted client address
  (`UPLOAD_ANON_RATE_LIMIT_PER_MIN`), 240/min per process overall
  (`UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN`), 60-second window. An invalid value is a
  **fatal** configuration error, not a silent fallback.
- **Forwarding headers are not trusted by default.** `X-Forwarded-For` and
  `X-Real-IP` are read *only* when the request carries `x-pdfdadi-proxy-secret`
  matching `TRUSTED_PROXY_SECRET` (≥16 characters). Without it every unauthenticated
  caller is counted in one global bucket, which is exactly the bucket a spoofed or
  rotated header cannot escape. If you deploy behind a proxy, set the secret **and**
  configure the proxy to send it; if you do not, change nothing.
- **The upload limiter is process-local**, like every other limiter here — which is
  why `DEPLOYMENT_TOPOLOGY=single-instance` is required in production and is the only
  accepted value. Behind N instances the request ceiling would become N × the
  configured number while the per-request byte ceiling stayed the same; rather than
  leave that to a load-balancer rule nobody owns, the boot gate refuses the
  configuration. See "Instance topology" above for the three things multi-instance
  would need first.
- **Bound request bodies at the reverse proxy too, if you run one.** Not for the byte
  ceilings — the app owns those, as above — but for memory. Next buffers the body of
  any request its proxy matcher claims before the handler runs, up to
  `experimental.proxyClientMaxBodySize` (`next.config.mjs`, 120 MB here), and that
  includes every page URL and every unrouted path, where no rate limiter has run yet.
  Measured on a cold production artifact: a 64 MiB anonymous POST to a matched path
  is read in full, the same POST to an excluded upload path stops after ~1.25 MiB, and
  28 concurrent 100 MiB posts took one process from 301 MB to 1795 MB RSS and kept it
  there (`docs/evidence/final-prelaunch/proxy-body-clone-cost.log`). This is
  pre-existing Next behaviour, not something the upload work introduced, and lowering
  the config value instead re-arms the silent-truncation problem its docstring
  documents. So set a small `client_max_body_size` globally and raise it only on the
  five paths the matcher excludes, which are the only ones that need a large body:

  ```nginx
  client_max_body_size 1m;                      # everything else

  location ~ ^/api/(jobs|tools/[^/]+)$                          { client_max_body_size 120m; proxy_request_buffering off; }
  location ~ ^/api/workspaces/[^/]+/documents/upload$            { client_max_body_size 120m; proxy_request_buffering off; }
  location ~ ^/api/workspaces/[^/]+/documents/[^/]+/versions/upload$ { client_max_body_size 120m; proxy_request_buffering off; }
  location ~ ^/api/workspaces/[^/]+/documents/[^/]+/attachments$  { client_max_body_size 120m; proxy_request_buffering off; }
  ```

  `proxy_request_buffering off` matters as much as the size: with it on, nginx
  absorbs the whole body itself and the app's early 401/413/429 refusals stop being
  early. Keep the two path sets in step — a path added to the matcher exclusion in
  `proxy.ts` needs a `location` here, or its uploads start failing at the proxy.
- The temp directory is deleted in a `finally` block after every request.
- **A public tool run keeps nothing.** No database row, no stored file, no
  history: the temp directory is deleted in a `finally` block and a server tool's
  output is removed when its job expires.
- **A signed-in Workspace deliberately keeps things**, which is what a Workspace
  is: documents, versions, comments, tags, activity and audit rows persist until
  the user or the operator deletes them. Retention, deletion and export are
  covered in `docs/FINAL_PRELAUNCH_AUDIT.md` §10 — this line used to read "no
  database, no permanent storage", which was true before the Workspace shipped
  and is not a claim to make to users now.
- Admin content is persisted to `data/admin/store.json` on a Docker volume, the
  database to `data/db` and stored documents to `data/storage` — see below.

## Admin security & first-run setup

- **No default admin password is shipped.** On a fresh deploy, visit
  `/admin/setup` once to set the admin password; until then login is refused.
  The setup endpoint atomically sets the password only if none exists (store
  mutex + check-and-set), so concurrent first-run requests can't both succeed.
- **An initialized deployment cannot be re-setup.** Once a password exists,
  `POST /api/admin/setup` answers `409` and leaves the stored hash untouched.
  Setup state is read server-side from the store, so nothing in the request can
  change the answer: no query parameter (`?force=1`, `?reset=1`, `?setup=1`,
  `?overwrite=yes`, …), no body flag, and no `NODE_ENV` value unlocks it — there
  is no development shortcut that behaves differently in production. Attempts are
  still per-IP rate-limited (10/min). Responses never contain the password hash,
  the salt, or the submitted password.
- **`ADMIN_SECRET` is required in every environment.** It HMAC-signs admin
  session cookies; without it, cookies are forgeable. Generate a long random
  value and set it in your environment (or `.env.local` for dev). For local dev
  only, `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1` allows the public fallback.
  `docker compose` refuses to start without `ADMIN_SECRET`.
- **`ANALYTICS_SUBJECT_SECRET` is optional.** It keys the analytics subject
  pseudonym (a daily-rotated HMAC used only to stitch funnel steps together).
  Unset, it falls back to `ADMIN_SECRET`; with neither, events are still
  recorded but unstitched. It is intentionally *not* in the validated env schema
  — a missing analytics key must degrade reporting, not stop the app booting.
  Set it separately when you want analytics and admin auth on different keys, so
  rotating one does not invalidate the other. Server-only: never give it a
  `NEXT_PUBLIC_` prefix, which would publish it in the client bundle.
- Admin store writes are **atomic** (temp file + `rename`) with a `.bak`
  backup, and serialized by an in-process mutex; a crash never leaves a
  truncated `store.json`, and concurrent admin edits don't silently clobber
  each other. `readStore` falls back to the `.bak` if the primary is corrupt.

## Docker volume & network isolation

- Three named volumes, and all three matter. `pdfdadi-data` at
  `/app/data/admin` keeps admin content (including the operator-set admin
  password) and is seeded from the image's `data/admin` on first attach;
  `pdfdadi-db` at `/app/data/db` keeps the database; `pdfdadi-storage` at
  `/app/data/storage` keeps uploaded and generated documents. Without the last
  two the app still boots and still accepts uploads — and loses every document
  and every account on the next `docker compose up --build`.
- The app attaches to an `internal: true` network with **no external egress**.
  Published port 3000 still accepts inbound traffic. This blocks the
  LibreOffice/`soffice` SSRF vector — a crafted uploaded document cannot make
  the conversion subprocess reach external or internal hosts. The app has no
  legitimate outbound dependency today; when the AI API lands, route that
  egress through a separate proxy rather than re-enabling broad egress. To
  re-enable egress (not recommended), switch the service network to the
  commented `pdfdadi-web` network in `docker-compose.yml`.

## Billing (Stripe) — optional

Billing is off unless it is fully configured. With no Stripe variables set the app
runs exactly as before: `/api/billing/checkout` and `/api/billing/portal` answer
`503 BILLING_NOT_CONFIGURED`, and every account stays on the free plan.

| Variable | Required for billing | What it is |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | yes | Secret API key (`sk_test_…` / `sk_live_…`). Dashboard → Developers → API keys. |
| `STRIPE_WEBHOOK_SECRET` | yes | Signing secret (`whsec_…`) for the webhook endpoint. |
| `STRIPE_PRICE_PRO` | yes | Price id (`price_…`, not a product id) for Pro. |

All three are **server-only**. None carries a `NEXT_PUBLIC_` prefix and none may be
given one — Next.js inlines `NEXT_PUBLIC_` values into the client bundle, and a
published secret key can move money while a published webhook secret lets anyone
forge a "subscription active" event and grant themselves Pro. Keep them in the
deployment's secret store; never commit real values.

Pro is the only purchasable plan. Business remains a real plan with real
entitlements — an operator can still set an organization to it — but it has no
price to configure and no checkout path accepts it, so there is no
`STRIPE_PRICE_BUSINESS` to set.

Billing enables only when the key, the webhook secret and the Pro price are
all present. A key without a webhook secret would take money it could never
confirm, and a key without the Pro price would have to invent one — so both count as
"not configured" rather than half-working.

### Webhook endpoint

Paid entitlement changes come from signature-verified webhooks and from nothing
else — a customer returning from Stripe with `?checkout=success` grants no plan.
Without a reachable webhook, checkout completes at Stripe and the account stays
free.

```bash
# Production: Dashboard → Developers → Webhooks → Add endpoint
#   URL:    https://your-host/api/billing/webhook
#   Events: checkout.session.completed
#           customer.subscription.created
#           customer.subscription.updated
#           customer.subscription.deleted
# Copy the signing secret into STRIPE_WEBHOOK_SECRET.

# Local development:
stripe listen --forward-to localhost:3000/api/billing/webhook
```

The endpoint is unauthenticated by design — Stripe has no session — and
authenticated in fact by the HMAC signature over the raw request body. Deliveries
are idempotent by event id, out-of-order events cannot overwrite newer state, and
a price this deployment does not map grants no paid plan.

Only an organization **owner** can start a checkout or open the billing portal
(the existing `billing:manage` permission). Usage limits stay observe-only:
selling a plan does not start refusing work, which remains gated on
`USAGE_LIMIT_MODE`.

## Health endpoints

- `GET /api/health` — public liveness (`{ok:true}`); used by the Dockerfile
  `HEALTHCHECK`.
- `GET /api/health/ready` — public readiness (data dir + toolchain binaries +
  database ping); 503 when not ready. The dependency check is cached for 30s.
  Reports **whether** each subsystem is healthy and never **why**: this endpoint
  is unauthenticated so a load balancer can reach it, and the underlying detail
  strings are raw driver messages — a Prisma connection failure embeds the DSN
  host, user and database name. Details are still logged server-side, and the
  per-binary breakdown stays behind the admin-gated `/api/health/dependencies`.
- `GET /api/health/dependencies` — per-binary JSON (admin-gated).
