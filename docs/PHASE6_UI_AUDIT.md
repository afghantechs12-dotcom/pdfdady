# Phase 6 — pre-implementation UI/UX audit

Measured, not estimated. Every number below came out of a headless Chrome over
CDP against the running app (`scripts/ui-inspect.mjs`, `scripts/lib/probe-browser.mjs`)
or out of the source files named. Nothing here is a plan; §2 is what is wrong and
§3 is what Phase 6 will do about it.

## 1. What already exists (so Phase 6 does not build a second one)

**Styling architecture.** One CSS entry point (`app/globals.css`), one Tailwind
config (`tailwind.config.ts`), no CSS-in-JS, no second framework. Tokens are
authored in TypeScript (`styles/tokens.ts`, `styles/editor.ts`) and mirrored into
the Tailwind config. Three colour namespaces share one brand: marketing
(`primary`/`navy`/`lavender`/`softborder`), authenticated app (`app-*`), editor
(`editor-*`). `styles/tokens.ts` already defines `radius`, `shadow`, `spacing`,
`sectionRhythm`, `motion`, `zIndex`, `breakpoints`, one `focusRing` string and
`iconToneClasses`.

**Shell ownership.** `app/layout.tsx` owns fonts, `globals.css`, JSON-LD and the
skip link only. `app/(marketing)/layout.tsx` owns the public Header/Footer and its
own `#main`; `components/app/AppShell.tsx` is the authenticated shell (dark rail,
sticky top bar, mobile drawer) with its own `#main`; `components/auth/AuthShell.tsx`
and `components/admin/AdminShell.tsx` likewise. `components/editor/StandaloneEditorShell.tsx`
is deliberately *not* AppShell.

**Component primitives.** `components/ui/` — Badge, Button (+ `buttonStyles.ts`),
Modal, Reveal, SectionHeading, Icon. `components/app/primitives.tsx` — AppCard,
SectionHeader, EmptyState, StatusBadge, IconButton, Meter, Skeleton. These are two
families on purpose (marketing surfaces vs. app surfaces) and Phase 6 does not
merge them; the brief forbids renaming working components.

**Accessibility utilities already present.** `lib/a11y/focusTrap.ts` (used by both
the public Header drawer and the AppShell drawer), body-scroll lock with restore,
Escape + outside-pointerdown dismissal with focus returned to the real trigger,
`aria-expanded`/`aria-controls` on every disclosure read, a live `role="status"`
result count on `/tools`, `role="toolbar"` with roving tabindex in the editor, and
a `@media (prefers-reduced-motion: reduce)` block in `globals.css` that disables
every homepage animation *and* restores `opacity:1; transform:none` so a cancelled
animation can never leave content invisible.

**Probe infrastructure.** Ten existing `scripts/*.mjs` probes drive Chrome over raw
CDP (no Playwright dependency). Phase 6 adds `scripts/lib/probe-browser.mjs` as the
one client the *new* tooling shares; the existing probes are left alone because
they are the evidence Phases 1–5 rest on.

## 2. Findings

Ordered by what they cost a user. Every one is reproducible from the command or
file reference given.

### F1 — PRODUCT. The editor tool row is a 90px window onto 437px of controls, behind a hidden scrollbar

`components/editor/EditorToolbar.tsx:392` renders the tool row as
`flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none`.

| viewport | scroller `clientWidth` | content `scrollWidth` | visible share |
|---|---|---|---|
| 320×800 | 90 | 437 | 21% |
| 360×800 | 130 | 437 | 30% |
| 390×844 | 160 | 437 | 37% |
| 412×915 | 182 | 437 | 42% |

The pinned undo/redo/Open/Export cluster is `shrink-0` and takes ~200px of a 304px
content box, so the tool row gets what is left. Everything past the window is
reachable only by a sideways swipe on a scrollbar that `scrollbar-none` removes —
and `app/globals.css` says of that utility, in its own words: *"Do not use this on
a region whose only affordance is the scrollbar."* The tools that scroll out of
view are priority-1 tools, so they are **not** in the `More` menu either; `More`
only holds tools above the mode's priority cut.

`components/editor/toolbarLayout.ts:375` already records the cause: *"below ≈609px
(e.g. a 390px phone) not even that fits, so the backstop takes over and the row
scrolls rather than clipping."* That was accepted as honest degradation. At 21%
visibility with no affordance it is not.

Same defect, second instance: `components/editor/FloatingCanvasControls.tsx:220`
is `overflow-x-auto … scrollbar-none` and measures `scrollWidth 331` against
`clientWidth 294` at 320px.

### F2 — PRODUCT. The save-status control's entire accessible name is an em-dash

`components/editor/persistence/SaveStatusIndicator.tsx:144`. In `compact`
presentation the disclosure trigger's text is `status.short`, and the `idle` branch
of `src/application/editor/persistence/derivedStatus.ts` sets `short: "—"`. Its
`title` ("No document is open.") does not become the accessible name, because
textContent already supplies one. Measured at 320px and 412px: `button 44×20`,
accessible name `"—"`.

Two failures in one control: WCAG 4.1.2 (no meaningful name) and WCAG 2.2 AA 2.5.8
Target Size (Minimum), which requires 24×24 CSS px. The name defect is not
idle-only — every one of the nine states renders whatever `short` happens to be,
so the fix belongs on the trigger, not in the `idle` branch.

### F3 — PRODUCT. `/editor` ships a skip link that points at nothing, and the Workspace editor nests two `<main>` landmarks

`app/layout.tsx:84` renders `<a href="#main">Skip to content</a>` for every route.
Measured on `/editor` at 1440×900:

```
{"mains":[{"id":"","cls":"relative flex min-w-0 min-h-0 flex-1 fle…"}],
 "skipTargetExists":false,"skip":"Skip to content"}
```

`document.getElementById("main")` is **null** on `/editor` — the skip link is
inert. WCAG 2.4.1 Bypass Blocks.

The same line is the other half of a second defect. `components/editor/PremiumEditorFrame.tsx:113`
uses `<main>` for the canvas region, and the Workspace-backed editor mounts it
inside `AppShell`'s `<main id="main">`
(`app/workspaces/[workspaceId]/documents/[documentId]/page.tsx:60` → `DocumentWorkbench`
→ `EditorWorkspace:1671` → the frame). Nested `main` is invalid HTML and two `main`
landmarks is an ARIA violation. One root cause: the frame claims a document-level
landmark for a region.

### F4 — PRODUCT. The hero advertises a tool that does not exist

`components/home/HeroShowcase.tsx` `FLOATERS` (~409–464) hand-writes five
decorative chips: PDF/"24 pages", Word/"Converted", **Excel/"Extracted"**,
JPG/"12 images", Sign/"Signed". Verified against the registry: `pdf-to-word`,
`pdf-to-jpg` and `sign-pdf` are functional; **`pdf-to-excel` is `planned`.** Nothing
ties the array to `data/tools.ts`, so it cannot fail when a status changes.

The brief calls this out twice — "decorative imagery that misrepresents product
capability" and "do not claim capabilities that are planned or coming soon".

### F5 — DESIGN SYSTEM. Two z-index systems, and the token one is unused

`styles/tokens.ts` exports `zIndex` (base 0, sticky 30, header 40, drawer 60,
overlay 70, dialog 80, toast 90). **No component imports it, and it is not in the
Tailwind config.** What ships instead is five arbitrary escape hatches, each a
different number, each a global layer:

| value | file |
|---|---|
| `z-[55]` | `components/layout/Header.tsx:401` (drawer scrim) |
| `z-[60]` | `components/layout/Header.tsx:411` (mobile drawer) |
| `z-[70]` | `components/editor/EditorToolbar.tsx:742` (portalled tool menu) |
| `z-[75]` | `components/editor/color/ColorPicker.tsx:241` (portalled popover) |
| `z-[100]` | `app/layout.tsx:85` (skip link) |

plus 69 uses of `z-10`/`z-20`/`z-30`/`z-40`/`z-50`. The numeric-scale uses inside a
component's own stacking context are fine; the five arbitrary ones are the global
layer order, written down five times in four files and nowhere authoritative.

### F6 — DESIGN SYSTEM. The homepage invents palette outside the token files

Six marketing components write decorative aura and gradient colours as arbitrary
Tailwind values with no token behind them: `#3B82F6` and `#38BDF8` (cyan — not in
the brand set at all), `#4F46E5`, `#60A5FA`, `#2563EB`, `#8B5CF6`, across
`HeroShowcase.tsx`, `TrustStrip.tsx`, `WorkspaceShowcase.tsx`, `WhyChoose.tsx`,
`FinalCTA.tsx`, `Logo.tsx`.

Deliberately **not** in scope, and must stay literal: `components/workspaces/tagLogic.ts`
(`#0f172a`/`#ffffff` are computed contrast outputs for user-chosen tag colours) and
`components/editor/canvas/*` (`#f8fafc`/`#e2e8f0`/`#ef4444` are PDF-canvas and ruler
colours — the brief forbids pushing page-theme tokens onto the document surface).

### F7 — ACCESSIBILITY. Standalone links below the 24×24 minimum

Measured, all viewports:

| element | measured | file |
|---|---|---|
| `a "Or pick a single-purpose tool"` | 168×16 | `components/editor/StandaloneEditorShell.tsx:489` |
| `a "I already have an account"` | 173×20 | `components/home/WorkspaceShowcase.tsx:139` |
| `a "Home"` / `a "Tools"` (breadcrumbs) | 39×20 / 36×20 | `components/seo/Breadcrumbs.tsx` |

WCAG 2.2 AA 2.5.8. The auth-page links the probe also flagged (`"Create an
account"` 124×17, `"Contact support"` 110×17) sit inside a sentence and take the
spec's Inline exception; these three do not.

### F8 — LOADING/BUSY. `Button loading` renders a spinner but stays clickable

`components/ui/Button.tsx` maps `loading` to a `Loader2` swap and nothing else: no
`disabled`, no `aria-busy`, no announcement. A double click on a loading button is
a double submit. The brief's §2 requires every interactive primitive to have a real
loading state.

### F9 — MEASURED, NOT A DEFECT. Mobile page heights

Homepage 12082px at 320, 11488 at 360, 10835 at 412. `/tools` 12099 / 11688 /
11388. That is ~14 viewport heights of one-column content across eleven sections.
`.section-pad` is **not** the cause — nine sections × 68px of adjacent padding is
612px, 5% of the total. It is content volume, and §4 asks for density, not deletion.
Recorded so the responsive report has the number; the only bounded improvement is
tile grids that can honestly go 2-up on a phone.

### F10 — PROBE CORRECTNESS, not a product defect

The sweep reported `input 16×16` on the auth pages. `components/auth/LoginForm.tsx:142`
wraps that checkbox in `<label class="flex min-h-[44px] …">`, so the real target is
44px tall and WCAG 2.5.8 is satisfied. `LAYOUT_PROBE` measures the `<input>`'s own
box. **The Phase 6 probe must measure an input at its labelling ancestor**, or it
will report this false failure on every run — exactly the "vacuous" class of probe
error this repo has been bitten by before.

Two more confirmed non-defects, both previously suspected:
- **Zero page-level horizontal overflow.** 7 routes × 9 widths (320/360/390/412/768/1024/1280/1440/1920): `documentElement.scrollWidth === innerWidth` everywhere. No global `overflow-x: hidden` is needed and none will be added.
- **The 401 on public pages** is `hooks/usePublicSession.ts` probing `/api/auth/me`; 401 is the documented signed-out answer. It is a *network* log entry, not a JS console error, which is why `probe-browser.mjs` reports the two channels separately. Changing the endpoint's status code would be out-of-scope backend work.

## 3. What Phase 6 changes, and where

| # | Finding | Root-cause fix | Files |
|---|---|---|---|
| 1 | F1 | Below the measured `≈609px` container fit, the toolbar wraps instead of scrolling; the floating capsule likewise | `EditorToolbar.tsx`, `toolbarLayout.ts`, `FloatingCanvasControls.tsx` |
| 2 | F2 | Stable `aria-label` on the trigger for all nine states + a 24px hit area | `SaveStatusIndicator.tsx` |
| 3 | F3 | The frame's canvas region stops being `<main>`; the standalone shell supplies the real `#main` | `PremiumEditorFrame.tsx`, `StandaloneEditorShell.tsx` |
| 4 | F4 | Each floater carries the slug it depicts; a test asserts every slug is functional | `HeroShowcase.tsx` + new test |
| 5 | F5 | `zIndex` becomes the Tailwind scale; the five arbitrary layers become named classes | `styles/tokens.ts`, `tailwind.config.ts`, 4 call sites |
| 6 | F6 | Aura/gradient colours get names in the token file | `styles/tokens.ts`, `tailwind.config.ts`, 6 components |
| 7 | F7 | Padding, not new components | 3 files |
| 8 | F8 | `loading` implies `disabled` + `aria-busy` | `Button.tsx` |

Everything else in the brief's §3–§17 is polish on top of surfaces that already
hold their invariants, and is verified by the new probe (`scripts/premium-ui-ux-probe.mjs`,
scenarios A–L) rather than asserted here.

## 4. Reproduction

```
npm run dev                                    # port 3001
node scripts/ui-inspect.mjs --path /editor --width 320 --layout
node scripts/ui-inspect.mjs --path /editor --width 1440 \
  --eval "!!document.getElementById('main')"
node scripts/responsive-qa.mjs                 # 9 widths, page-level overflow
```
