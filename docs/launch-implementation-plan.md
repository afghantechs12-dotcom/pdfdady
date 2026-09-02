# Launch Implementation Plan

**Date:** 2026-08-05
**Companion documents:** `launch-readiness-baseline.md` (what is true today),
`launch-feature-evidence.md` (what we may claim).

This plan is scoped by what the baseline audit actually found. Where the brief
anticipated a problem that does not exist in this repository, that is recorded
as *already correct* rather than being rebuilt — the brief explicitly forbids
rewriting stable code to improve presentation.

---

## Scope corrections from the audit

Three items in the brief assume defects that the audit refuted. Acting on them
anyway would mean changing working code for no benefit:

1. **"Audit all duplicate dedicated/dynamic tool routes … redirect alternatives
   permanently."** There are no duplicates. The dynamic route calls `notFound()`
   for `functional-client` slugs and excludes them from `generateStaticParams`;
   every `href` is generated centrally. **No redirects will be authored** —
   authoring them would create redirect chains where none exist.
2. **"Public header … inside the focused Editor workbench."** Chrome is already
   split by route group; the editor never renders marketing chrome.
3. **"Private Workspace/document URLs must not be indexed."** Already true —
   every private route sets `robots: { index: false, follow: false }` and
   `robots.ts` disallows `/admin` and `/api`.

These remain as *verification* work (tests asserting they stay true), not
implementation work.

---

## Phase 2 — Shells, brand tokens, navigation

**Goal:** decisions #1–#5 and #14 of the brief.

| Change | File | Note |
| --- | --- | --- |
| Extend design tokens: semantic/surface/text/border colors, focus ring, motion, z-index, breakpoints | `styles/tokens.ts` + `tailwind.config.ts` | Additive. The existing marketing and `app-*` palettes stay; this names what is already in use rather than restyling. |
| Add `Tools` as a real header item (already in `data/nav.ts`) and keep `Pricing` | `data/nav.ts` | Already present — verify and lock with a test. |
| Add a **Log in** action to the public header | `components/layout/Header.tsx` | Currently absent entirely. |
| Repoint `Get Started Free` → `/register?returnTo=/workspaces` | `Header.tsx`, `data/pricing.ts` | **Requires a `/register` route** — see decision below. |
| Make the header session-aware | new `PublicHeader` server wrapper + client nav | Server component reads the session, passes `user` down; signed-in header shows Tools / Workspace / Editor / profile and an **Open Workspace** primary CTA. |
| Mobile menu: focus trap, Escape, body scroll lock, no tabbable hidden links | `Header.tsx` | Reuses the tested `lib/a11y/focusTrap.ts`. Fixes a real a11y defect (hidden-but-focusable links). |

### Decision: `/register` vs `/signup`

The brief mandates `/register?returnTo=/workspaces`. The repository implements
`/signup` with `?next=`. Both differ. Resolution:

- Add `/register` as the canonical public registration URL and **redirect
  `/signup` → `/register`** preserving query params.
- Accept `returnTo` as an alias for `next`, sanitized by the existing
  `safeRedirectPath`. Both are honored; `returnTo` wins if both are present.
- Auth business logic is untouched — this is routing and parameter aliasing
  only, satisfying "do not rewrite authentication business logic".

---

## Phase 3 — Homepage and public pages

| Change | Detail |
| --- | --- |
| Rewrite `data/features.ts` | Delete C1–C3 (see evidence matrix). Replace with real differentiators: Workspace, editor, versions, autosave, transparent processing. |
| Rewrite `site.trustBullets` | Delete "Files deleted automatically". |
| Demote AI | Replace the full-width `AIToolsSection` with one compact, honest roadmap block low on the page — or remove it from `/` entirely. No fake interactions. |
| Add a Workspace + Editor section | The single biggest gap: the product's best features are absent from marketing. Explains upload → process → save → continue → recover. |
| Homepage order | Hero → processing explanation → essential tools → Workspace/Editor → how it works → security → use cases → pricing preview → guides → FAQ → final CTA. |
| Hero CTAs | Primary "Choose PDF File" acts on the upload zone; secondary "Explore PDF Tools" → `/tools`; tertiary "Organize documents in Workspace". |
| Section rhythm | Tighten the vertical gaps flagged in screenshots 9/10 via the spacing scale, not per-page values. |

All content stays server-rendered.

---

## Phase 4 — Tools index and tool pages

| Change | Detail |
| --- | --- |
| `ProcessingModeBadge` | Derived from `tool.status` per the evidence matrix mapping. Replaces the leaked `Server` badge. |
| One `ToolCard` system | Availability vs processing mode as distinct, consistent signals; full keyboard access; hover/focus/active states. |
| Separate planned tools | Available tools primary; `planned` and `coming-soon-ai` move to a clearly labelled "Coming later" area. Planned cards must not look executable and must not dead-end. |
| Tool search | Prominent, keyboard-shortcut-accessible, on `/tools`. |
| Essential tools section | Renamed from "Popular" — ordering is curated, not measured (C13). |
| Sticky category nav (desktop) / drawer (mobile) | Keeps one H1, semantic H2 per category. |
| Tool metadata on cards | From / To / Processing / batch support. |
| Save to Workspace | R15 — the one genuinely new integration; storage and document APIs already exist. |

---

## Phase 5 — Authentication and pricing

- Premium branded auth layout; Login ⇄ Register switching; show/hide password;
  loading, disabled, rate-limit and session-expiry states; autocomplete
  attributes; focus management. **No business-logic changes.**
- Pricing rebuilt from `getPricingList()` (the existing admin source — no second
  pricing system). Remove the Premium AI tier and the dead `/` CTA. No toggle
  (only one price exists), no fake discounts, no checkout button. Unavailable
  tiers get "Contact us".

---

## Phase 6 — Workspace and Editor polish

- Workspace picker: adopt authenticated chrome. The existing comment correctly
  notes `AppShell`'s sidebar is Workspace-scoped, so the fix is to extract the
  shared chrome (brand bar, user menu, background) into a shell the picker can
  use without a Workspace-scoped sidebar — not to force `AppShell` in.
- Dashboard: New/Upload menu, drag-and-drop, richer document rows, stronger
  folder cards, skeletons, empty/error/partial states, virtualization for long
  lists.
- Editor: toolbar groups (Navigate / Edit / Annotate / Draw / Insert / Page /
  More), overflow instead of squeezing, tooltips + accessible names + shortcuts
  + disabled reasons, resizable/collapsible panels with remembered state, better
  document tabs. **The editor engine is not touched.**

---

## Phase 7 — Performance

- Fix the confirmed leak: `HeroUpload` imports the entire 45-tool catalog into
  the homepage client bundle for four links.
- Assert by test that no public route bundle contains editor, Workspace,
  `pdfjs-dist` or `pdf-lib` code.
- Audit `framer-motion` reachability from public routes.
- Images: `next/image`, explicit dimensions, modern formats, lazy below fold,
  preload only the real LCP image.
- Record before/after in `docs/launch-performance-report.md`.

---

## Phase 8 — SEO

Add what is missing (`BreadcrumbList`, tool `SoftwareApplication`, blog
`Article`), review FAQ-schema eligibility, optional `/llms.txt` generated from
the canonical public route registry, and automated tests for metadata
uniqueness, canonical correctness, sitemap contents and JSON-LD validity.

---

## Phase 9 — Security, accessibility, QA

- Security headers added incrementally and **tested against the editor before
  enforcement** — a generic CSP would break it. Fold in the deferred findings
  already tracked in project memory.
- WCAG 2.2 AA sweep; automated a11y tests plus real keyboard testing.
- Responsive verification at the seven listed viewports.
- Browser matrix documented honestly, including what could not be verified in
  this environment.
- `docs/launch-security-review.md`.

---

## Phase 10 — Final gates

Clean `.next`, then `prisma validate` → `prisma generate` → `typecheck` →
`lint` → `test` → `build`, followed by the scans listed in the brief.

---

## Standing constraints

- Do not start M8; do not implement or fake AI.
- Do not market anything without a `verified` row in the evidence matrix.
- Do not rewrite the editor engine, Workspace domain services or auth logic.
- Marketing copy changes go in `data/admin/index.ts` defaults, not components.
- The 3239-test suite stays green at every phase boundary.

---

## Progress log

### Phase 2 — complete (2026-08-05)

Gates after the phase: typecheck ✅, lint ✅, **3295 tests** ✅ (3239 baseline +
56 new), build ✅ with **static generation preserved on every public route**.

Delivered:

| Item | Where |
| --- | --- |
| Extended design tokens: section rhythm, motion, z-index layers, breakpoints, focus ring | `styles/tokens.ts` |
| Processing-mode model derived from the tool registry | `lib/tools/processingMode.ts` |
| Client session detection that keeps public pages static | `hooks/usePublicSession.ts` |
| Pure header navigation logic | `components/layout/headerLogic.ts` |
| Session-aware header: Log in action, correct CTA, active states, real mobile dialog | `components/layout/Header.tsx` |
| `/register` canonical route; `/signup` → 308 redirect; `returnTo` alias | `app/register`, `app/signup`, `components/auth/returnTo.ts` |
| Truthful features, FAQ, trust bullets, and blog privacy claims | `data/features.ts`, `data/faq.ts`, `data/admin/*`, `data/blogPosts.ts` |
| `PrivacyNote` rebuilt on the processing model | `components/tools/PrivacyNote.tsx` |
| Hero CTA fix + Workspace link; homepage client-bundle leak closed | `components/home/Hero.tsx`, `HeroUpload.tsx`, `(marketing)/page.tsx` |

**Decision recorded — client-side session detection.** Making the header
session-aware server-side would have turned ~30 static/SSG public routes
dynamic, forfeiting the LCP and Lighthouse budgets this milestone must hit. The
header therefore ships as static signed-out markup and upgrades after
hydration, with a fixed-width account slot so the swap causes no layout shift.
Verified against the build output: every public route still reports ○ or ●.

**Defects found during the phase that were not in the original brief:**

1. `registerHrefFor` accepted scheme-relative destinations (`//evil.test`).
   Hardened, with a regression test.
2. **The compress and protect blog articles claimed browser-only processing for
   tools that are `functional-server`.** Four published statements were
   factually wrong about where a user's file goes. Corrected to describe the
   real upload-process-download flow.
3. `data/admin/store.json` carried a runtime override of the trust bullets, so
   fixing only the TypeScript defaults would have left the false claim live in
   production. Both were updated.
4. The homepage FAQ listed compress and OCR as forthcoming when both ship, and
   ignored Workspace entirely in its account answer.

The `FORBIDDEN_CLAIMS` scan in `lib/tools/processingMode.test.ts` is what
surfaced 2–4; it now guards the whole of `app/`, `components/` and `data/`
against their return.

---

## Execution record (2026-08-06)

Phases 3–10 executed. Outcome, deviations and evidence are recorded in
`launch-readiness-completion.md`. Summary of where execution departed from this
plan, and why:

| Planned | What happened |
| --- | --- |
| Phase 6.3 editor toolbar groups, tooltips, shortcuts, overflow | **Already implemented** by M6.7 (`toolbarLayout.ts` + `EditorToolbar.tsx`). Verified, not rewritten — the brief forbids rewriting stable code for presentation. |
| Phase 3.3 "use real screenshots or lightweight product imagery" | Vector mock used instead. The assets in `i/` are full-frame captures of the pre-redesign UI and would ship a stale picture of screens this milestone changed. |
| Phase 7 Lighthouse / LCP / CLS evidence | **Not produced.** Bundle composition is enforced by test (`lib/seo/publicBundles.test.ts`); runtime metrics were not measured, so `launch-performance-report.md` was not written rather than filled with unmeasured numbers. |
| Phase 9 `launch-security-review.md` | **Not written.** This milestone introduced no new security surface — the changes are presentation, content, and one account menu reusing the existing POST logout endpoint. |
| Phase 6.2/6.4/6.5 dashboard, panels, tabs | **Not addressed.** No proven defect was identified from source. |

**Defects found during execution that were not in the brief:**

1. **Six committed icon names rendered as blank squares.** `Icon` falls back to
   an empty square for unmapped names, silently. `FolderKanban`, `History`,
   `Building2`, `Minimize2`, `Table2` and `Wand2` were all unmapped — the last
   three in the shipped tool catalog. Fixed, and guarded by a new test.
2. **Collapsed FAQ answers were exposed to screen readers.** The accordion hid
   panels with `opacity-0` + `grid-rows-[0fr]`, which is visual-only; every
   answer was in the accessibility tree simultaneously, contradicting
   `aria-expanded`.
3. **The upload dropzone promised "Auto deletion"** in its default trust text,
   on every tool page — the same unimplemented retention claim as C4, in a
   component the original claim audit had not scanned.
4. **Unavailable tool cards were focusable links.** Every card was wrapped in a
   `Link` regardless of status, so planned tools were in the tab order and led
   to stub pages.
5. **The public-bundle guard initially passed vacuously** — a path-construction
   bug meant it read no manifests. Caught by its own tripwire assertion, which
   is why that assertion exists.
