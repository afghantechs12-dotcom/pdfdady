# PDFDadi

A premium, privacy-first PDF tools platform built with Next.js (App Router),
TypeScript and Tailwind CSS. Simple operations run entirely in the browser;
heavier operations run server-side through secure API routes. Ships with a
full **admin panel** for managing every piece of content on the site.

## Tech stack

- Next.js 16 (App Router) + TypeScript
- Tailwind CSS, lucide-react, framer-motion
- pdf-lib (browser PDF manipulation), jszip (multi-file results)
- Server tools via system binaries: LibreOffice, Ghostscript, qpdf, Poppler,
  Tesseract/OCRmyPDF
- Admin panel: cookie-based auth, file-backed JSON store, zod validation

## Run locally

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production
npm start        # production server
```

Browser-side tools work with no extra setup. Server-side tools need the system
binaries below (or use Docker).

## Admin panel

Visit `/admin/login`. **There is no default password** — on a fresh deploy,
visit `/admin/setup` once to set the admin password (PDFDadi no longer ships
with one). After that, sign in at `/admin/login` and change the password
anytime via the change-password card on the dashboard.

```
Dashboard         – overview, counts, quick links
Site Settings     – brand name, URL, OG defaults, footer copy, trust bullets
SEO & Metadata    – default author, sitemap exclusions, robots disallow
Navigation        – header links + footer columns (reorder, edit, add)
Pages             – About / Contact / Privacy / Terms / Pricing / Server-status copy
Blog              – full SEO editor: blocks, HowTo, FAQ, scheduling, author
FAQ               – homepage FAQ items (drives FAQPage JSON-LD)
Pricing           – all four plans including features per plan
Features          – "Why choose PDFDadi" selling points
Use Cases         – audiences shown on the homepage
Trust Strip       – homepage trust signals
AI Tools          – coming-soon AI lineup
Tools             – every PDF tool, with category / status / accept filter
Server Tools      – per-tool upload limits, labels, hints & option fields for
                    every server-processed tool (compress, OCR, convert, …)
Tool Categories   – label overrides for the seven catalog tabs
```

The panel reads/writes `data/admin/store.json`. Defaults live in
`data/*.ts` so any unset field falls back automatically. Edits take effect on
the very next page load — the public site reads from the same store on every
request, so admin changes are visible immediately. Creating, deleting
(built-in items are hidden via tombstones) and reordering all persist to the
store, and the Pages editor drives the real About / Contact / Privacy / Terms
pages and the Pricing / Server-status intros.

### Admin auth & `ADMIN_SECRET`

Sessions use an HMAC-signed, httpOnly cookie — a forged cookie value cannot
grant access. **`ADMIN_SECRET` is required in every environment** (a public
fallback would make every admin cookie forgeable). Generate a long random
value, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
or `openssl rand -hex 32`, and set it in `.env.local` for dev or your deployment
env for prod. For local dev only, `PDFDADI_ALLOW_INSECURE_DEV_SECRET=1` opts
into the public fallback (never use in production). Rotating `ADMIN_SECRET`
invalidates all existing admin sessions.

## Production build

```bash
npm run build
npm start
```

## Server dependencies (Ubuntu/Debian)

```bash
sudo apt-get update
sudo apt-get install -y \
  libreoffice ghostscript qpdf poppler-utils \
  tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu tesseract-ocr-fra tesseract-ocr-spa \
  ocrmypdf fonts-liberation fonts-dejavu fonts-noto-core python3
```

## Docker

```bash
# ADMIN_SECRET is required — generate one first:
export ADMIN_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
docker compose up --build
```

`docker-compose.yml` requires `ADMIN_SECRET`, persists admin content via the
`pdfdadi-data` volume, and attaches the app to an `internal: true` network (no
external egress) to block the LibreOffice conversion SSRF vector. Once the
container is up, visit `/admin/setup` once to set the admin password. See
**SERVER_SETUP.md** for details, the privacy/security model, and Windows notes.

## Health checks

- `GET /api/health` — public liveness probe (`{ok:true}`); used by the
  Dockerfile `HEALTHCHECK` and by load balancers.
- `GET /api/health/ready` — public readiness probe (data dir present +
  toolchain binaries installed); returns 503 when not ready.
- `GET /api/health/dependencies` — per-binary breakdown as JSON (admin-only).
- Visit `/server-status` to see which server binaries are installed.

## Environment variables

- `ADMIN_SECRET` — **required in every environment.** Signs admin session
  cookies. Use a long random value (`openssl rand -hex 32` or
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
  Without it, admin sessions are forgeable and the app refuses admin operations.
- `NEXT_PUBLIC_SITE_URL` — your real domain, so canonical/OG/sitemap URLs are
  correct.
- `TOOLS_MAX_CONCURRENCY` — max simultaneous server-side jobs (default `4`).
- `TOOLS_RATE_LIMIT_PER_MIN` — per-IP requests/minute on the public tool API
  (default `20`).
- `TOOLS_MAX_BODY_BYTES` — hard cap on upload request body size, checked before
  buffering (default `115343360` ≈ 110MB).
- `PDFDADI_ALLOW_INSECURE_DEV_SECRET` — set to `1` for local dev only, to allow
  the public fallback `ADMIN_SECRET`. Never set in production.

The admin panel's **Site Settings** form can override name, URL, title
template, description, social links, footer copy and trust bullets at runtime —
no redeploy needed.

## Security notes for server tools

Server conversions shell out to LibreOffice, Ghostscript, qpdf and Poppler.
Hardening applied: Ghostscript runs with `-dSAFER`; LibreOffice runs with a
locked-down per-job profile (no link auto-update, no proxy, max macro
security); uploads are checked by magic bytes, not just extension/MIME; and a
concurrency cap protects against upload floods. **A malicious document can
still try to fetch remote references through LibreOffice — run server
conversions with no network egress** (Docker `--network none` or an egress
firewall) for full SSRF protection. See **SERVER_SETUP.md**.

## Privacy

No database, no analytics, no permanent storage of uploaded files for supported
tools. Server jobs use temporary directories that are deleted automatically
after processing. The admin panel writes only to `data/admin/store.json`.
