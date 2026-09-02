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
Refusing to start: 3 production configuration problems.
  - DATABASE_URL is not set. Point it at PostgreSQL. There is no production
    default on purpose: falling back to a local SQLite file would silently store
    live data on an ephemeral container disk and lose it on the next deploy.
  - ADMIN_SECRET is not set. It signs admin session cookies and local storage
    download URLs, so without it both are forgeable: admin takeover with no
    password, and arbitrary reads of any stored file.
  - NEXT_PUBLIC_SITE_URL points at a loopback host ...
```

The process then exits with code 1, so Docker, systemd or your orchestrator
reports a failed container rather than a running one that 500s.

**Required in production**

| Variable | Why the gate refuses to start without it |
|----------|------------------------------------------|
| `DATABASE_URL` | No production default. A SQLite fallback would put live data on an ephemeral disk and lose it on redeploy. |
| `ADMIN_SECRET` | Signs admin session cookies *and* local storage download URLs. Must be ≥16 characters, and must not be the public dev fallback string that ships in this repo. |
| `NEXT_PUBLIC_SITE_URL` | Signed download and multipart-upload URLs are built from it; a loopback value hands clients links to their own machine. Must be an absolute `http(s)` URL and not localhost/127.0.0.1/0.0.0.0/::1. |

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
[startup] PDFDadi configuration OK — env=production db=postgres storage=r2 \
  queue=redis billing=enabled usageLimits=observe logLevel=info
```

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

`Content-Security-Policy` is deliberately **not** set yet. A correct one needs
nonce plumbing for Next's inline bootstrap plus explicit `worker-src`/`blob:`
allowances for the pdf.js worker; a half-right CSP would silently break the PDF
editor in production while looking like a security win. It is tracked as its own
task rather than guessed at here.

## Option A — Docker (recommended)

The provided image installs every dependency for you.

```bash
# ADMIN_SECRET is required (generate a long random value):
export ADMIN_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
docker compose up --build

# App available at http://localhost:3000
# First run: visit http://localhost:3000/admin/setup to set the admin password.
```

`docker-compose.yml` persists admin content on the `pdfdadi-data` volume and
runs the app on a no-egress `internal` network (see "Docker volume & network
isolation" below).

Or with plain Docker:

```bash
docker build -t pdfdadi .
docker run -p 3000:3000 --tmpfs /tmp pdfdadi
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
npm run start   # serves on PORT (default 3000)
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
  before the multipart body is buffered into memory.
- External binaries are invoked with `execFile` and **argument arrays** — user
  input is never interpolated into a shell string.
- Each job has a processing timeout; the concurrency slot is acquired *before*
  buffering so the memory-heavy parse phase is also bounded.
- The public tool API is per-IP rate-limited (`TOOLS_RATE_LIMIT_PER_MIN`).
- The temp directory is deleted in a `finally` block after every request.
- No database, no permanent storage of uploaded files, no file history (admin
  content is persisted to `data/admin/store.json` on a Docker volume — see below).

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

- The `pdfdadi-data` named volume is mounted at `/app/data/admin` so admin
  content (including the operator-set admin password) survives redeploy and
  restart. The volume is seeded from the image's `data/admin` on first attach.
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
