# Launch Readiness — Baseline Audit

**Date:** 2026-08-05
**Repository:** `D:\AndroidStudioProjects\Backup\PDFMaster`
**Dev URL:** http://localhost:3001
**Product name (user-facing):** PDFDadi

This document records the state of the repository *before* any launch-readiness
change. It is the reference point for the before/after evidence required by the
later phases. Nothing here is aspirational: every claim was read out of the
source or produced by a command run in this repository.

---

## 1. Baseline gates

All six gates were run from the working tree as it stood at the start of this
milestone.

| Gate | Command | Result |
| --- | --- | --- |
| Prisma schema | `npx prisma validate` | **Pass** — "The schema at prisma\schema.prisma is valid" |
| Prisma client | `npx prisma generate` | **Pass** (runs as part of `predev`/`build`) |
| Types | `npm run typecheck` | **Pass** — no output, exit 0 |
| Lint | `npm run lint` | **Pass** — no findings, exit 0 |
| Tests | `npm run test` | **Pass** — 165 files, **3239 tests**, 31.19 s |
| Build | `npm run build` | Recorded separately (see §7) |

The pre-existing test suite is large and green. It is the safety net for every
change in this milestone: no phase may land with it red.

### Environment caveats

Per `docs`/project memory, this host has ~16 GB RAM with only a few GB
typically free. `next.config.mjs` pins `experimental.cpus: 4` and
`scripts/next-build.js` pins `VIPS_CONCURRENCY=1` because static generation
otherwise oversubscribes memory and dies with `vips_tracked: out of memory` or a
V8 heap OOM. **Those failures are host-memory artifacts, not code regressions.**
Build failures must be triaged against free memory before being treated as a
defect. Node heap limits must not be raised to paper over a real failure.

---

## 2. Repository map

```
app/                      Next.js App Router
  (marketing)/            PUBLIC route group — owns PublicHeader + PublicFooter
  admin/                  Admin console (proxy-gated, noindex)
  api/                    ~200 route handlers (admin, auth, jobs, storage, workspaces)
  editor/                 Full-viewport editor application
  login/  signup/         Authentication pages (noindex, force-dynamic)
  workspaces/             Authenticated product (picker, dashboard, documents)
  layout.tsx              Root: fonts, global CSS, skip link, Organization+WebSite JSON-LD
  robots.ts  sitemap.ts   Technical SEO entry points
components/
  admin app auth background blog contact editor home layout pages pdf seo
  tools ui upload workspaces
data/                     Marketing/content source of truth + admin override store
lib/                      a11y admin brand.ts editor pdf seo server tools utils validation
src/                      Clean-architecture core: application/ domain/ infrastructure/
styles/tokens.ts          Design tokens (mirrored into tailwind.config.ts)
prisma/                   Schema + SQLite dev DB (prisma/prisma/dev.db)
proxy.ts                  Edge proxy — admin session gate, matcher /admin/:path*
```

### Architectural facts that constrain this milestone

- **Chrome is already split by route group.** The root layout deliberately does
  *not* render the marketing header/footer; `(marketing)/layout.tsx` does, while
  `/workspaces` and `/editor` render authenticated chrome. This is the correct
  foundation — the milestone builds on it rather than replacing it.
- **Content is admin-editable at runtime.** `data/admin/index.ts` defines a
  `defaultStore`, and `data/admin/store.json` holds overrides. `lib/seo/
  adminRuntime.ts` is the `server-only` public read surface. Public pages,
  sitemap, robots and JSON-LD all read through it, so admin edits appear on the
  next render. **Marketing copy must be changed in the defaults, not hardcoded
  into components**, or the admin console and the site will disagree.
- **`lib/brand.ts` is the single source for the visible product name.** Package
  name, API paths, the `pdfdadi_session` cookie and the `.pdfdadi.json` editor
  format are deliberately *not* derived from it — they are contracts.
- **`src/application/services/authValidation.ts`** already implements shared
  email normalization, password rules and `safeRedirectPath` open-redirect
  protection, used by both API routes and forms.

---

## 3. Route map

### Public, indexable

| Route | Source | Metadata | Notes |
| --- | --- | --- | --- |
| `/` | `(marketing)/page.tsx` | canonical + OG set explicitly | FAQ JSON-LD |
| `/tools` | `(marketing)/tools/page.tsx` | `buildMetadata` | Renders all 45 tools |
| `/tools/[slug]` | dynamic | `buildToolMetadata` | server + planned + AI tools |
| `/tools/<18 slugs>` | dedicated folders | per-page | functional-client tools |
| `/blog`, `/blog/[slug]` | marketing | per-page | admin-managed posts |
| `/pricing` | marketing | per-page | reads `getPricingList()` |
| `/about`, `/contact` | marketing | per-page | admin page content |
| `/privacy-policy`, `/terms` | marketing | per-page | admin page content |
| `/server-status`, `/brand-logo` | marketing | — | utility routes |

### Private / non-indexable

| Route | Guard | Robots |
| --- | --- | --- |
| `/login`, `/signup` | `redirectIfAuthenticated` | `index: false` ✅ |
| `/workspaces`, `/workspaces/[workspaceId]/**` | `requireUser` | `index: false` ✅ |
| `/editor` | client app | `index: false` ✅ |
| `/admin/**` | `proxy.ts` HMAC cookie | `robots.ts` disallow ✅ |
| `/api/**` | per-route | `robots.ts` disallow ✅ |

### Route-duplication finding — **no duplicates exist**

This was the highest-risk item in the brief and it checks out clean:

- 18 tools are `functional-client` and each has exactly one dedicated folder
  under `app/(marketing)/tools/<slug>/`.
- `app/(marketing)/tools/[slug]/page.tsx` calls `notFound()` for
  `functional-client` and its `generateStaticParams` filters them out, so the
  dynamic route cannot shadow a dedicated one.
- Every tool's `href` is generated centrally by `tool()` in `data/tools.ts` as
  `/tools/${slug}`.

**Conclusion: each tool already has exactly one canonical public URL.** No
redirects need to be authored, and no redirect-loop risk is introduced. This is
recorded as *verified*, not assumed.

---

## 4. Tool inventory (45 tools)

| Status | Count | Public meaning today | Sitemap |
| --- | --- | --- | --- |
| `functional-client` | 18 | works in browser | included |
| `functional-server` | 14 | works via server API | included |
| `planned` | 5 | stub page | excluded ✅ |
| `coming-soon-ai` | 8 | stub page | excluded ✅ |

By category: organize 8, convert-to 7, convert-from 5, edit 9, optimize 3,
security 5, ai 8.

The sitemap already excludes `planned` and `coming-soon-ai` slugs — correct, and
retained.

---

## 5. Screenshot defect list

Fourteen screenshots were supplied in `i/`. **The image files are valid PNGs
(headers and dimensions verified programmatically: e.g. 1909×948, 1919×944) but
this environment's image reader returned empty content for every one of them, in
both PNG and converted-JPEG form.** They could not be viewed. The numbered
review supplied in the brief is therefore used as the authoritative defect list,
as the brief specifies it is the *minimum*. Each item below has been confirmed
or refuted against the source.

| # | Screen | Defect (from brief) | Source confirmation |
| --- | --- | --- | --- |
| 1 | Modern Editor | icon-only toolbar, panel competition, weak states | `components/editor/**` |
| 2 | Workspace dashboard | prototype feel, weak folder cards, no onboarding | `WorkspaceDashboard.tsx` |
| 3 | Workspace selector | empty page, not the app shell | **Confirmed** — `app/workspaces/page.tsx` renders a bespoke 14 px header, not `AppShell` |
| 4 | Security + AI cards | internal `SERVER` badge, `AI SOON` looks clickable | **Confirmed** — `ToolCard.tsx:15-36` renders literal `Server`, `AI Soon`, `Planned` badges |
| 5 | Convert cards | `PLANNED` mixed with available, thin descriptions | **Confirmed** — `ToolsCatalog.tsx` renders every status in one grid |
| 6 | Optimize/convert-to | repeated grid, no search, no semantic colors | **Confirmed** — no search control exists on `/tools` |
| 7 | All tools | no search, non-sticky categories, no Popular section | **Confirmed** — `ToolsCatalog.tsx` has category chips only |
| 8 | Blog grid | generic placeholders, no pagination/search | `components/blog/**` |
| 9 | Blog hero | excessive whitespace, generic featured art | `(marketing)/blog/page.tsx` |
| 10 | Use cases + FAQ | large gaps, generic claims | `UseCases.tsx`, `FAQAccordion.tsx` |
| 11 | AI coming soon | large promo block for unbuilt features | **Confirmed** — `AIToolsSection.tsx` is a full section with a 5-card grid on the homepage |
| 12 | Why choose | untruthful claims | **Confirmed** — see §6 |
| 13 | Popular tools | `SERVER` badges, no processing explanation | **Confirmed** — `PopularTools.tsx` reuses `ToolCard` |
| 14 | Homepage hero | no Login, wrong Get Started target, no Tools item | **Confirmed** — see §6 |

---

## 6. Confirmed high-severity defects (source-verified)

### 6.1 `Get Started Free` points at `/tools` — violates decision #2

`components/layout/Header.tsx:45` and `:88` both render
`<Button href="/tools">Get Started Free</Button>`.
`data/pricing.ts:27-28` also sets the Free plan's CTA to `Get Started Free` with
`href: "/tools"`.
Required target: `/register?returnTo=/workspaces`.

### 6.2 No Login action in the public header

`Header.tsx` renders only nav links, a `Contact` link and `Get Started Free`.
There is no sign-in affordance anywhere in public chrome, even though
`/login` exists and works.

### 6.3 Header never adapts to an authenticated user

`Header.tsx` is a `"use client"` component taking only `navLinks`. It has no
session awareness, so a signed-in visitor browsing `/tools` is still asked to
"Get Started Free" and is offered no route back to their Workspace.

### 6.4 Untruthful marketing claims — violates decisions #8/#9

`data/features.ts` (rendered by `WhyChoose` under the heading
"Why Choose PDFDadi?") states:

- `"100% Secure"` — absolute claim, unevidenced.
- `"Files are processed in your browser, never uploaded."` — **false**: 14 tools
  are `functional-server` and Workspace upload/ingestion stores files durably.
- `"Auto File Deletion" / "Nothing is stored. Your files stay yours."` —
  **false**: Workspace storage is the product's headline feature.

`data/admin/index.ts` `site.trustBullets` (rendered in the hero) states
`"Files deleted automatically"` — same problem.

### 6.5 Internal implementation badge leaks to users — violates decision #10

`ToolCard.tsx:15-21` renders a literal `Server` badge derived from the internal
`functional-server` status. `AI Soon` (`:23-29`) and `Planned` (`:31-36`) badges
sit on cards that are fully clickable links, so planned work looks available —
violating decision #11.

### 6.6 AI dominates the homepage — violates decision #12/#11

`AIToolsSection.tsx` renders a full-width gradient section with a 5-card grid
promoting 8 unimplemented AI tools, and it sits *above* Use Cases and FAQ in
`(marketing)/page.tsx`. Meanwhile the homepage has **no Workspace or Editor
section at all** — the product's two strongest real differentiators are absent
from the marketing site.

### 6.7 Workspace picker does not use the authenticated shell

`app/workspaces/page.tsx` builds a bespoke minimal header. The code comment
explains the reasoning (the `AppShell` sidebar is Workspace-scoped, so it cannot
be reused as-is) — this is a genuine constraint, not an oversight, but the
result is the visually detached page described in screenshot 3.

### 6.8 No tool search on `/tools`

45 tools are rendered as category chips plus a flat grid. There is no search
input, no Popular section, no sticky category rail, and no processing filter.

### 6.9 Pricing is a hardcoded four-plan array with a dead CTA

`data/pricing.ts` hardcodes Free/Pro/Premium AI/Business. Three of four are
`"Coming soon"`, and the `ai` plan's CTA links to `/` — a dead-end. The Premium
AI plan advertises M8 functionality as a purchasable tier.

### 6.10 Hero CTAs both point to `/tools`

`Hero.tsx:46-51` renders "Choose PDF File" and "Explore Free Tools" both as
`href="/tools"`. The primary CTA does not act on the adjacent upload zone.

---

## 7. Technical SEO baseline

**Already correct** (verified, retained):

- `robots.ts` disallows `/admin` and `/api`, emits the sitemap URL, and merges
  admin-configured extra disallows.
- `sitemap.ts` excludes `planned` and `coming-soon-ai` tools, and guards against
  admin-created `functional-client` tools that would 404 (no dedicated folder).
- Private routes (`/login`, `/signup`, `/workspaces`, `/editor`) all set
  `robots: { index: false, follow: false }`.
- Root layout emits Organization + WebSite JSON-LD; the homepage emits FAQ JSON-LD.
- `next/font` (Inter) with `display: "swap"`, one family, one variable.
- `metadataBase` is set from the admin-configured site URL.

**Gaps to close in Phase 8:**

- No `BreadcrumbList` JSON-LD on tool or blog pages.
- No `SoftwareApplication` JSON-LD on tool pages.
- FAQ JSON-LD is emitted on the homepage; eligibility needs review against
  current guidance.
- No `/llms.txt`.
- No automated test asserting metadata uniqueness or canonical correctness.
- No automated JSON-LD validity test.

---

## 8. Performance baseline

Structural observations (measurements land in
`docs/launch-performance-report.md`):

- `output: "standalone"`, `reactStrictMode: true`, `experimental.cpus: 4`.
- Marketing pages are Server Components; the client boundary is limited to
  `Header`, `ToolsCatalog`, `HeroUpload`, `FAQAccordion` and tool runners.
- **Risk:** `components/home/HeroUpload.tsx` imports `tools` from
  `@/data/tools` at module scope inside a `"use client"` component, pulling the
  whole 598-line, 45-entry catalog into the homepage client bundle to render
  four quick links.
- `pdfjs-dist` and `pdf-lib` are the two heaviest dependencies; confirming they
  never reach a public route bundle is a Phase 7 gate.
- `framer-motion` (11.18.2) is a dependency — its reachability from public
  routes needs auditing.
- No `next/image` usage audit yet; blog art is described as placeholder-heavy.

---

## 9. Accessibility baseline

**Already correct:**

- Skip link in the root layout with a matching `#main` landmark per route group.
- `lib/a11y/focusTrap.ts` exists, is unit-tested (7 tests) and is used by the
  `AppShell` mobile drawer.
- Public header mobile toggle has `aria-label`, `aria-expanded`, `aria-controls`.
- `ToolsCatalog` tabs use `aria-pressed`; nav landmarks are labelled
  (`Primary` / `Mobile`).
- Focus-visible rings are applied consistently via Tailwind utilities.
- `components/workspaces/m7Accessibility.test.ts` exists.

**Gaps:**

- The public mobile menu has **no focus trap, no Escape handler and no body
  scroll lock** — it animates `max-height` and leaves links focusable while
  visually collapsed (`Header.tsx:65-71`), which is a keyboard trap in reverse:
  hidden content remains tabbable.
- Tool cards are whole-card links with no described processing mode.
- Icon-only editor toolbar buttons need an accessible-name audit.

---

## 10. Security baseline

**Already correct:**

- `proxy.ts` gates `/admin/*` on an HMAC-signed cookie verified with Web Crypto
  in the Edge runtime; the same helper guards the Node API routes.
- `safeRedirectPath` sanitizes `next` on both `/login` and `/signup` before it
  reaches the form or the signup link.
- Auth validation is shared between client and server, so they cannot disagree.
- Rate limiting exists (`lib/server/rateLimit.ts`, unit-tested).

**Gaps for Phase 9:**

- No security headers are configured in `next.config.mjs` — no CSP, HSTS,
  `X-Content-Type-Options`, `Referrer-Policy` or `Permissions-Policy`.
- Pre-existing deferred findings are tracked in project memory
  (`pending-security-hardening`) and must be folded into
  `docs/launch-security-review.md`.

---

## 11. What is explicitly *not* broken

Recording this matters as much as the defect list, because the brief forbids
rewriting stable code to improve CSS:

- Route-group chrome separation — already correct.
- One canonical URL per tool — already correct.
- Sitemap/robots private-route exclusion — already correct.
- Authentication business logic, redirect safety, rate limiting — already
  correct and unit-tested.
- Editor engine and Workspace domain services — 3239 passing tests.
- Admin-editable content pipeline — the correct place to change copy.

---

## 12. Phase 1 exit

Phase 1 is complete: gates recorded, routes mapped, defects confirmed against
source, and the two companion documents written
(`launch-feature-evidence.md`, `launch-implementation-plan.md`). Implementation
begins at Phase 2.
