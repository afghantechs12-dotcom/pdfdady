# PDFDadi design system — reference

The rules a new component has to obey, and where each decision already lives.
Written in Phase 6; it describes what ships, not an aspiration.

**One sentence:** calm, precise, document-focused. Every colour, radius, shadow,
duration and stacking layer comes from a token file; a component that writes its
own hex, its own `z-[…]` or its own focus ring is the defect.

## 1. Where the decisions live

| Layer | Source | Consumed as |
| --- | --- | --- |
| Marketing palette, radius, shadow, spacing, motion, z-index, focus ring, icon tones | `styles/tokens.ts` | Tailwind utilities via `tailwind.config.ts` |
| Authenticated app surfaces | `tailwind.config.ts` `app.*` | `bg-app-surface`, `text-app-muted`, … |
| Editor surfaces | `styles/editor.ts` + `tailwind.config.ts` `editor.*` | `bg-editor-bg`, `text-editor-text`, … |
| Button variants and sizes | `components/ui/buttonStyles.ts` | `<Button variant size>` |
| Reduced-motion policy | `app/globals.css` | one `@media` block, global |

`tailwind.config.ts` **mirrors** `styles/tokens.ts`. The mirror is deliberate —
Tailwind cannot import a TS module at config time — and `styles/tokens.test.ts`
asserts the two agree, so a value changed in one place and not the other fails a
test rather than shipping a divergence.

`tailwind.config.ts` `content` includes `./styles/**/*.{ts,tsx}`. Class strings
live in `tokens.ts` (`focusRing`, `iconToneClasses`); without that glob Tailwind
purges any utility named only there. That is not hypothetical: `teal` was the one
icon tone no component named directly, so every teal tool — Edit PDF among them —
rendered with no tile and no colour.

## 2. Three palettes, and the rule that separates them

- **Marketing** (`primary`, `navy`, `lavender`, `softborder`) — the public site.
- **App** (`app-*`) — the authenticated workbench: cooler, denser, flatter. Neutral
  elevation (`shadow-appcard`), not the violet marketing shadows, which read as
  decorative at dashboard density.
- **Editor** (`editor-*`) — its own surface, with three deliberately distinct
  signal colours: `accent` (brand + active tool), `selection` (blue), `guide`
  (pink). Collapsing any two loses the canvas hierarchy.

`aura.*` is decoration only: blur circles and gradient stops. **Nothing that needs
a contrast ratio may use it** — no text, border or control surface. It exists
because six components shipped arbitrary `bg-[#3B82F6]/25` literals, and naming
what ships is the only way a later pass can see it.

**The PDF canvas is not a themed surface.** Page white is the document's own white
(`editor-page`), and no page-theme token may reach an exported PDF. A token that
changed the rendered document would change product truth, not styling.

## 3. Interactive primitives

`components/ui/`: `Button`, `Badge`, `Icon`, `Modal`, `SectionHeading`, `Reveal`.
Editor and workspace surfaces compose their own controls from the same tokens.

A `Button` variant declares a **complete, self-consistent set** — background,
foreground, hover, focus ring. This is structural, not stylistic: `lib/utils/cn.ts`
is a plain string joiner with no Tailwind conflict resolution, so a call site
passing `className="bg-white text-navy"` to `variant="primary"` lands both classes
and the compiled stylesheet order picks the winner. We shipped that bug — the
homepage dark CTA rendered white-on-white, because `.bg-white` sorts after
`.bg-primary` while `.text-navy` sorts before `.text-white`. `BUTTON_BASE`
therefore names `ring-2` but never a ring **colour**; the variant owns it, so a
dark-surface variant never has to out-sort a light-surface default.

Every interactive primitive must express: default · hover · active · focus-visible ·
disabled · loading · error where applicable · keyboard operability · an accessible
name · a touch target ≥24×24 (≥44×44 for editor controls on mobile).

`loading` is a **real state**, not a spinner: it sets `disabled` and
`aria-busy="true"`. A button that shows a spinner and still fires is a double-submit.

## 4. Focus

One string, `tokens.focusRing`, and `focus-visible:ring-2` in `BUTTON_BASE`.

- Never colour-alone. Every indicator is a ring (geometry), so it survives
  greyscale, forced colours and colour-vision deficiency.
- `focus-visible`, not `focus` — a mouse click must not paint a ring.
- Dark surfaces use the white ring with an offset colour (`ring-offset-navy`,
  `aura.indigoPanel`), because `primary/40` is invisible on navy.
- `forced-colors:` keeps a border in Windows High Contrast, where background
  colours are replaced by the system palette.

## 5. Layering

`tokens.zIndex` is the **global** order: `sticky 30 · header 40 · menu/editor 50 ·
drawer 60 · popover 70 · dialog 80 · toast 90 · skipLink 100`. Named utilities:
`z-header`, `z-dialog`, ….

Tailwind's numeric scale stays correct **inside** a component's own stacking
context. The named layers are for surfaces that compete across the whole page —
the only kind that can be wrong. `popover` is above `editor` because portalled
menus render into `document.body`, outside the editor's stacking context.

A drawer and its scrim share one layer deliberately: they are siblings, so DOM
order decides which paints on top, and the panel always renders after its scrim.

## 6. Responsive

Breakpoints are Tailwind's (`sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536`),
declared in `tokens.breakpoints` so tests have a named contract.

- Mobile first: the narrow layout is the base, `sm:`/`lg:` widen it.
- **Never fix overflow with `overflow-x: hidden`.** Find the element that is too
  wide. The audited widths are 320 · 360 · 390 · 412 · 768 · 1024 · 1280 · 1440 ·
  1920.
- Any surface that renders a filename needs `min-w-0` on the flex child **and**
  `truncate` on the text, plus `min-w-0` on the table. A `flex` child's default
  `min-width: auto` refuses to shrink below its content, so one 200-character
  upload widens the whole table without it.
- A control row that runs out of room **wraps** (`toolbarWraps`,
  `TOOLBAR_WRAP_MIN_WIDTH = 732`). It must not become a horizontal scroller with a
  hidden scrollbar: `scrollbar-none` plus overflow means a control outside the
  client box has no affordance that reveals it, and the tool is simply gone.

## 7. Motion

`tokens.motion`: `fast 120ms` (hover/focus) · `base 200ms` (colour/shadow) ·
`slow 300ms` (panels/drawers). Motion is feedback, never decoration.

`prefers-reduced-motion: reduce` is honoured in one `@media` block in
`app/globals.css`: `scroll-behavior` goes `auto`, every named keyframe animation
(`animate-fade-up`, the float/glow/drift set, the `Reveal` states) is cancelled with
`opacity: 1; transform: none` so nothing is left invisible, decorative
`animate-pulse` **stops** at `opacity: 1`, and `animate-spin` **slows to 2.4s**
rather than stopping. Hover/focus colour transitions are left alone — they are
feedback at 120–200ms, not movement. The distinction is the point — a stopped
spinner claims a process died; a slow one still communicates activity to someone
whose vestibular system the fast spin would provoke.

## 8. Accessibility floor (WCAG 2.2 AA)

- Exactly **one** `<main id="main">` per document. The root layout's skip link
  targets it on every route; two `main`s, or none, breaks the one bypass the page
  has (2.4.1).
- Text meets 4.5:1, large text 3:1, UI boundaries 3:1. `styles/contrast.test.ts`
  computes the ratios from the token values, so a palette edit that dips below the
  floor fails a test.
- Targets ≥24×24 (2.5.8); editor controls ≥44×44 on touch.
- Every control has an accessible name; icon-only controls get `aria-label` and
  their glyph is `aria-hidden`.
- Dialogs: `role="dialog"`, `aria-modal`, trapped focus, Escape closes, focus
  returns to the trigger.
- Status changes are announced, not only coloured.
- Semantic tables stay tables — the mobile representation may restack, but it may
  not drop actions or the header relationship.

## 9. What Phase 6 refuses to do

No gradient-per-section, no glassmorphism, no glowing blobs behind text, no cards
inside cards, no low-contrast grey body copy, no accent colour absent from the
token files, no animation that carries meaning it does not have. Premium here means
restraint: fewer surfaces, better aligned, with the document as the only thing that
draws the eye.

## 10. Verification

- `styles/tokens.test.ts`, `styles/contrast.test.ts` — the token layer and its
  contrast ratios.
- `components/ui/*.test.ts` — button states, focus-visible, dialog chrome,
  reduced-motion.
- `scripts/premium-ui-ux-probe.mjs` — twelve rendered scenarios (A–L) across the
  audited viewports, classifying `PASS` / `PRODUCT FAILURE` / `ENVIRONMENTAL` /
  `NOT EXERCISED`. Source scans may guard architecture; they cannot be the only
  proof of layout or interaction.

Run the probe against `localhost` or the production build — **never
`127.0.0.1` against a dev server**, which Next 16 treats as cross-origin, leaving
the page unhydrated and every interaction gate vacuous. The probe refuses to run
(exit 2) when nothing on the page has hydrated.
