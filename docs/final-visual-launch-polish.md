# PDFDadi — Final Visual Launch Polish

Closing report for the pre-launch visual/UX pass. Scope was polish only: no new
milestone, no AI features, no schema changes, no rewrite of Editor, Workspace,
authentication or PDF-processing logic.

**Status: all P0 defects fixed and verified. All quality gates green.**

| Gate | Result |
|---|---|
| `npx prisma validate` | pass — "The schema at prisma\schema.prisma is valid 🚀" |
| `npx prisma generate` | pass |
| `npm run typecheck` | pass — 0 errors |
| `npm run lint` | pass — 0 errors, 0 warnings |
| `npm run test` | **181 files, 3477 tests, 0 failed, 0 skipped** |
| `npm run build` | pass — `/` and `/tools` still static (`○`) |

Baseline was 171 files / 3373 tests. The count rose to 181 / 3477; no test was
removed, skipped, weakened or focused.

---

## A note on how this session started

Most of this brief had already been implemented before this session. Rather than
redo it, the session began with an audit of each phase against the actual source,
and then fixed only what was genuinely outstanding. What was **found already
complete and verified in place** (P0 1–6, plus P1 7, 9, 10, 13 and P2 15/17):

- the homepage CTA contrast fix and its `buttonStyles` variant system,
- the standalone `/editor` shell (`StandaloneEditorShell.tsx`, 18 tests),
- adaptive right-panel layout (`editorPanelLayout.ts`, 23 tests),
- the Properties overflow fix (`propertiesOverflow.test.ts`, 5 tests),
- email-based member lookup replacing raw user IDs (`memberDirectory.ts`, 18 tests),
- toolbar responsive overflow (`toolbarLayout.ts`, 19 tests),
- the blog SVG illustration system, Workspace picker, Activity rows, and the
  `$0 today` pricing wording.

Four real gaps remained. They are the "changed this session" items below.

---

## 1. Homepage CTA bug — root cause and fix

*(Implemented previously; verified this session.)*

The dark CTA rendered a white button with white text. The root cause was not a
colour typo — it was that `cn()` (`lib/utils/cn.ts`) is a plain string joiner
with no Tailwind conflict resolution. A call site passing
`className="bg-white text-navy"` to a variant already declaring
`bg-primary text-white` emitted **both**, and the winner was whichever utility
sorted later in the compiled stylesheet: `.bg-white` sorts after `.bg-primary`
(override won) while `.text-navy` sorts before `.text-white` (override lost).
White on white.

The fix is structural rather than a one-off text colour: colour decisions live in
variants, each variant declares a complete self-consistent set (background,
foreground, hover, focus ring), and `BUTTON_BASE` deliberately declares `ring-2`
with **no** ring colour so no variant has to out-sort it. Dark surfaces get
dedicated `onDark` / `onDarkOutline` variants with a white offset ring (a
`primary/40` ring is near-invisible on navy) and `forced-colors:` borders for
Windows High Contrast. Covered by `components/ui/buttonStyles.test.ts`.

## 2. Standalone `/editor` changes

*(Implemented previously; verified this session.)*

A lightweight branded shell (`StandaloneEditorShell.tsx`) around the same
`EditorWorkspace` the Workspace workbench mounts — brand, a way back, document
title, Open PDF, Export, and Save to Workspace for authenticated users with a
`returnTo`-safe signup route for guests, plus an intentional first-run empty
state. Deliberately **not** the authenticated `AppShell`: mounting it would pull
Workspace bundles onto a route guests reach from `/tools`.

## 3. Workspace Editor adaptive-panel design

*(Implemented previously; verified this session.)*

`editorPanelLayout.ts` resolves width → mode: `>= 1600` dual dock, `1200–1599`
single dock (Properties wins, because it is edited continuously while
outline/comments are consulted), `< 1200` overlay drawers only. It also fixed a
genuine inversion: the inspector used to dock at Tailwind's `2xl` (1536px), so
*widening* 1440 → 1536 **took 192px away** from the canvas. Drawers are mutually
exclusive and force-close when a resize docks the same panel.

## 4. Properties-panel fix

*(Implemented previously; verified this session.)*

Two structural causes, both fixed: `<fieldset>` carries a browser-default
`min-inline-size: min-content` and will not shrink below its widest content
(unlike a `<div>`); and flex items default to `min-width: auto` while native
`<input>`/`<select>` have substantial intrinsic width. Fixed with `min-w-0` on
the fieldset and on both the row and the control, plus `overflow-x-hidden` /
`overflow-y-auto`. Vertical scrolling remains; horizontal is gone.

## 5–8, 10–13. Toolbar, tabs, picker, Activity, members, blog, pricing

All verified already implemented and passing their own tests (counts listed in
the audit note above). Notably, the members UX resolves an **email to a user who
already exists and is already in the Organization** — deliberately *not* an
invitation system, because there is no invitation table, token or email
delivery, and shipping a "Send invitation" button that never sends anything
would be dishonest. The Organization constraint is a security boundary, not a
convenience: without it the endpoint would answer "does an account exist for
this email?" for any address on the internet.

---

## Changed this session

### 9. Dashboard navigation duplication (P1-9) — **fixed**

`DocumentFileManager` rendered its own vertical rail (All documents / Favorites /
Recent / Archived / Trash) duplicating the dark sidebar's Workspace section.
Investigation showed this was not merely redundant — the two controls
**disagreed about state**:

```
sidebar → <Link href="?view=favorites">   navigates; the URL is the truth
rail    → onClick={() => loadView(...)}   local state only; URL unchanged
```

So selecting a view in the rail left the sidebar highlighting the old item, and a
refresh, shared link, or Back press silently reverted the list. It also cost
~160px of horizontal space at every desktop width, taken from the document list
it was navigating.

The rail is removed; the sidebar is the single owner. No filtering capability was
lost — all five views are one click away in the sidebar (`APP_NAV_ITEMS`) and the
dashboard quick-access cards link to the same URLs. A view heading remains so
Archived is still distinguishable from Trash. New test:
`components/workspaces/viewNavigationOwnership.test.ts` (4 tests).

### 14. Auth legal-copy duplication (P2-14) — **fixed**

`/register` showed two different consent models for the same action: the
validated checkbox ("I agree to the Terms of Service and Privacy Policy") *and* a
passive shell line ("By continuing you agree to our Terms"). They disagreed — the
passive line named only the Terms, omitting the Privacy Policy the checkbox
covers. The affirmative checkbox survives because it is the one the server
validates; the shell footer now carries a support link instead. New test:
`components/auth/legalConsent.test.ts` (3 tests).

### 15. Footer trust card (P2-15) — **fixed**

"Made with 💜 for your documents." was the one footer panel that told the reader
nothing, in the position with the most room to say something true. Replaced with
**Processing transparency** — "Every tool tells you whether your file is handled
in your browser, in our secure cloud, or in your Workspace." — which restates the
promise the homepage processing-mode section and every tool badge already make.

No extra links were added: `/privacy-policy` is already a footer column link and
there is no `/security` route, so the brief's suggested link row would have been
duplication or a dead end.

**This one caught a live bug.** Editing only the TypeScript default left the old
string rendering, because `data/admin/store.json` (the file-backed admin store)
merges *over* `defaultStore` and still held it. Both are now updated, and
`data/admin/footerCard.test.ts` (4 tests) asserts they agree — so this class of
silent override cannot recur.

### 16. Coming Later density (P2-16) — **fixed**

13 planned tools rendered as 13 grey cards carried more visual weight than any
single category of working tools, at the bottom of the page, advertising nothing
the visitor could do. Now collapsed behind "Show planned tools", with the count
stated from real data.

Honesty properties held: the count is derived (not hardcoded, so it cannot go
stale); collapsed cards are **absent from the DOM**, not merely hidden, so they
are neither keyboard tab stops inside a closed section nor crawlable text the
visitor cannot see; an active search or filter forces the section open so a query
can never hide its own result; and planned tools remain non-link cards when
revealed. Verified on the rendered page: `13 planned tools`, **0 anchors** in the
section while collapsed. New test: `components/tools/comingLaterDensity.test.ts`
(6 tests).

---

## 17. Responsive evidence

Measured on the **real rendered DOM** via Chrome DevTools Protocol
(`scripts/responsive-qa.mjs`) — not inferred from CSS. 7 pages × 7 viewports =
**49 combinations, 0 with page-level horizontal overflow**.

| viewport | / | /tools | /pricing | /blog | /editor | /login | /register |
|---|---|---|---|---|---|---|---|
| 360×800 phone | ok | ok | ok | ok | ok | ok | ok |
| 390×844 phone | ok | ok | ok | ok | ok | ok | ok |
| 768×1024 tablet | ok | ok | ok | ok | ok | ok | ok |
| 1024×768 small laptop | ok | ok | ok | ok | ok | ok | ok |
| 1280×720 laptop | ok | ok | ok | ok | ok | ok | ok |
| 1440×900 laptop | ok | ok | ok | ok | ok | ok | ok |
| 1920×1080 desktop | ok | ok | ok | ok | ok | ok | ok |

Raw data: `responsive-qa-report.json`. The harness drives locally-installed
Chrome and is deliberately **not** a project dependency — adding Playwright for
launch verification would ship a browser download to everyone who clones the repo.

**Elements reported wider than the viewport, each investigated:**

- `/login`, `/register` — two `pointer-events-none absolute … rounded-full
  blur-3xl` decorative blobs inside a `relative overflow-hidden` aside. Clipped
  by the parent, non-interactive, cause no page overflow. Benign by design.
- `/editor` at 360–768 — the toolbar's `overflow-x-auto` scroll strip. This is
  the documented backstop *behind* the priority-based overflow menu, not a
  layout failure; the page itself does not overflow.

**Console errors / failed requests:** 0 failed requests. The only console entry
is a `401 (Unauthorized)` from `/api/auth/me` on public pages — the correct
response for a signed-out visitor, and the client handles it.

> Worth recording: an earlier sweep reported this as a **404** across all API
> routes. That was stale dev-server state, not a defect — after a restart
> `/api/auth/me` returns 401 as written. Re-verified before reporting.

## 18. Accessibility evidence

- Focus rings are declared per variant so dark surfaces get a visible white
  offset ring; `forced-colors:` rules keep borders in Windows High Contrast.
- Drawer panels trap focus, close on Esc and restore focus to their trigger
  (`lib/a11y/focusTrap.test.ts`, `hooks/editor/useEditorPanels.ts`).
- The collapsed Coming Later section uses `aria-expanded` + `aria-controls`, and
  removes rather than hides its content so there are no hidden tab stops.
- The removed view rail took its duplicate `aria-current="page"` with it — two
  elements previously claimed to be the current view simultaneously.
- Small-target scan: remaining sub-24px hits are inline **text links** inside
  prose and the intentional 1×1 skip-link/hidden input, not controls.
- Live regions retained on the document list (`role="status"`, `aria-live`).

## 19. Visual-regression evidence

Deliberately **not** full-page pixel assertions — dynamic content (dates, counts,
relative times) makes those flap, and a test that cries wolf gets ignored. The
committed coverage asserts structural contracts instead: layout thresholds
(23 tests), properties-overflow class contracts (5), toolbar placement (19),
standalone shell staging (18), plus the four new suites from this session. The
rendered-DOM sweep above is the pixel-level check, re-runnable on demand.

## 20–24. Gate results

Stated in the table at the top: Prisma validate + generate pass, typecheck 0
errors, lint clean, **181 files / 3477 tests all passing with 0 skipped**,
production build succeeds with `/` and `/tools` still static.

Note on the test count: an earlier run showed 180 files / 3427 passing with 50
skipped. Those 50 are `lib/seo/publicBundles.test.ts`, which reads per-route
client manifests and skips when no production build exists — the suite that
enforces "no PDF.js / Editor / Workspace code in public bundles". Running `build`
before `test` makes it execute; it passes, so the bundle rules this brief sets
are verified, not assumed.

## 25. Remaining honest limitations

- **No email invitations.** Members can only be added by email if the person
  already has an account in the Organization. Inviting a stranger is not built,
  and no UI claims it is.
- **No document counts or "last opened" on Workspace picker cards.** The list
  endpoint does not return them and decorating the picker would mean N queries.
  An invented number is worse than an absent one.
- **"Shared with me" is absent from the sidebar.** Per-document grants are
  enforced, but `DocumentRecordService.list` has no "granted to me" view, so the
  item would be empty or lie about scope.
- **13 tools remain planned and non-functional.** They are collapsed and
  labelled, not hidden — no fake processors, no doorway pages.
- **Free plan reads "$0 today", not "forever"** — whether the free tier stays
  free after paid plans arrive is a business decision, not a fact.
- **Source-text assertions.** Several tests assert on source strings because the
  suite runs in Node with no DOM renderer; a "does it overflow" assertion there
  would be theatre. The CDP sweep covers what they cannot.
- **The responsive sweep covers public routes and `/editor`.** Authenticated
  Workspace routes redirect without a session, so their responsive behaviour is
  covered by layout-threshold unit tests and manual inspection rather than by
  this harness.

---

*Scope note: M8 was not started, per the brief.*
