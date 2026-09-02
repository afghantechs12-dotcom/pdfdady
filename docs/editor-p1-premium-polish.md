# PDFDadi Editor P1 Premium Polish

## Phase H — Single Inspector

### Final status

**Phase H is complete.** Implementation, browser verification and final gates are
all done.

- Implementation: stages 1–5 complete.
- Browser verification: two CDP probes, both green.
- Final gates: stage 6 complete (Prisma validate/generate, typecheck, lint,
  production build, full post-build test suite).

Explicitly **not** part of this phase, and still deferred:

- **Continuous multi-page scrolling** — intentionally deferred to its own
  architecture phase. The editor remains one-page-at-a-time.
- **Workspace redesign** — deferred to P2.
- **AI / M8** — not started.

### Ground truth

Most of what the browser probes first reported as broken was not broken. Of the
eight initial failures in the Properties probe, **seven were probe defects and one
was a real product defect**. The states probe added a second real defect (the
Comments crash) that the Node suite had never surfaced.

The methodological rule this phase was run under, carried forward from Phase G:

> **"My change makes a check pass" is not equivalent to "the product was broken."**

Before narrating any browser failure as a bug, the failure was classified:

| Class | Meaning | Correct response |
| --- | --- | --- |
| **PRODUCT DEFECT** | The shipped UI genuinely violates the contract. | Fix the product. Then mutate the fix to prove the guard bites. |
| **PROBE DEFECT** | The product is correct; the probe asked the wrong question. | Fix the probe. Never weaken the UI to satisfy a bad assertion. |
| **ENVIRONMENTAL DEFECT** | Neither; the harness or host got in the way. | Fix the harness, or record the limitation honestly. |

Every fix in this phase was **mutation-tested**: the real implementation was
deliberately broken, the guard was confirmed to fail, and the implementation was
then restored. A guard that cannot fail is not evidence.

### Inspector architecture

**One dock only.** The pre-Phase-H editor had drifted toward more than one
right-hand surface; Phase H collapsed it to a single Inspector.

- A single flat tab strip: **Properties · Outline · Comments · Versions**.
- `components/workspaces/DocumentInspector.tsx` owns the strip. Comments used to
  sit behind two nested strips, costing two clicks; it is now one.
- Standalone editor tab behaviour: the editor selects the tab, so opening an
  object drives the Inspector rather than the user re-finding it.
- **320px dock** at desktop width.
- **1200px docking breakpoint** (`components/editor/editorPanelLayout.ts`,
  `docked: 1200`). At or above, permanent dock. Below, drawer.

### Shared Inspector control system

All Inspector rows are built from one primitive set in
`components/editor/InspectorControls.tsx`, so density and accessible-name
behaviour cannot drift per panel:

| Primitive | Role |
| --- | --- |
| `InspectorSection` | Collapsible titled section. |
| `FieldGroup` | Titled cluster of related rows inside a section. |
| `ControlRow` | One labelled row. |
| `NumberPairRow` | Paired numeric fields (X/Y, W/H). |
| `SegmentedControl` | Mutually-exclusive choice (e.g. text style, alignment). |
| `SecondaryButton` | Non-primary action inside a panel. |
| `NumberField`, `SelectField`, `ColorField`, `Slider` | Typed field controls. |

**32px control rhythm** (`h-8`) is the shared control height — the low end of the
brief's 32–36px range, chosen because the high end would not fold into a 320px
dock without pushing fields below the fold. Density won, deliberately.

### Collapsible sections

The original probe reported `InspectorSection` collapse as broken. It was not.

The probe clicked the React section header and read the DOM **in the same
synchronous page evaluation** — before React had committed. That same-tick read
saw the stale pre-click state: `aria-expanded="true"`, `height: 91`.

Re-querying after the commit proved the product was correct:

```
aria-expanded = false
height        = 0
hidden        = true
display       = none
```

The probe was restructured to **click → leave the evaluation → wait → re-query**.
Mutation testing then broke the real collapse implementation and confirmed the
improved probe fails, so the asynchronous check is real evidence and not merely a
longer path to `true`.

### Accessibility

- **Real accessible-name association.** The original probe only looked at
  `aria-label` and `name`, which ignores correct HTML `<label>` association.
  Chrome's actual Accessibility Tree proved names like `Font`, `Size pt`,
  `Leading`, `Track px`, `Opacity 100` were already resolving correctly from
  associated labels. The probe was rewritten to understand the real accessible-name
  channels: `aria-label`, `aria-labelledby`, `element.labels`, wrapping labels.
  Mutation testing broke label association and confirmed the improved check fails.
- **Geometry unit labels.** Accessible names carry PDF units — `X position (pt)`,
  `Y position (pt)`, `Width (pt)`, `Height (pt)`. The probe originally expected
  bare names and failed; the UI was **not** weakened to match. Each visible label
  is contained in its spoken name (WCAG 2.5.3).
- **Slider target size — a real defect, fixed.** See below.
- ARIA semantics on sections and segmented controls follow the primitives, not
  per-panel hand-rolling.

### Text Inspector

Browser-verified controls:

- **Bold** — `fontWeight`.
- **Italic** — real, family-based (see next section).
- **Left / Center / Right** alignment.
- **X / Y** position, **W / H** size, in points.
- Aspect-ratio handling where applicable.

Deliberately absent: **No Underline. No Justify.**

### Italic implementation

Italic is represented by the **base-14 font family** (e.g. `Helvetica-Oblique`),
not by a new boolean.

- Bold and Italic are **independent axes**: bold is `fontWeight`, italic is the
  family. The exporter derives them separately, so all four permutations map to a
  real font and neither toggle clobbers the other.
- **No new `italic` boolean on `TextObject`** — confirmed absent from the domain.
- **No editor format version bump. No schema migration.**

Supporting helpers live in `lib/editor/fontSubstitution` (`familyIsItalic`,
`italicSupport`, `withItalic`, `resolveFont`).

### Geometry / units

- X/Y/W/H are **PDF points**.
- Accessible names include `(pt)`; the `Size` field carries `suffix="pt"`.
- **One resize remains one undoable operation** — a drag does not decompose into
  a burst of history entries.

### Source PDF text

The P0 honesty invariant is preserved in full. Imported PDF text uses **read-only
range semantics** and is never silently converted into an editable copy.

Inspector heading: **`Original PDF text`**

Available actions — only ones that genuinely work:

- `Copy text`
- `Highlight`
- `Comment`

Verified **absent**:

| Absent | Why |
| --- | --- |
| X / Y | It is not a movable object. |
| W / H | It has no editable box. |
| Rotation, Opacity, Flip | No transform authority over source content. |
| `Edit` action | Would imply an editable copy — the discredited defect. |
| Resize handles, rotation handle | No transform affordances at all. |
| Drag movement | Dragging source text does not move it. |

No `Redact` either: this build has no content-destroying redaction, and a button
implying data was removed when it was not is a safety claim the product will not
fake.

The panel says plainly: *"You can select and copy this text. To add new text, use
the Text tool."*

### Shape Inspector

Browser-verified. Heading: **`Shape`**.

Sections: `Shape`, `Shadow`, `Position & size`, `Appearance`.

Real controls: `Fill`, `Stroke`, `Dash`, `Radius`, `X position (pt)`,
`Y position (pt)`, `Width (pt)`, `Height (pt)`, `Rotation`, `Opacity`.

No horizontal overflow.

### Drawing Inspector

Browser-verified. Heading: **`Drawing`**.

Real controls: `Brush`, `Stroke color`, `Width`, `Smooth the stroke`, `X/Y`,
`W/H`, `Rotation`, `Opacity`.

No horizontal overflow. Draw P0 behaviour intact.

### Image Inspector

**Honest scope statement.** Image Inspector behaviour is covered by the **Node
test suite**. Its browser state was **not automated** in the current CDP probe:
selecting an image requires a real native file-picker interaction the headless
probe cannot satisfy.

The states probe reports this explicitly rather than silently passing:

```
SKIP  s01 Image inspector — requires a real file-picker selection
      (N file inputs present); covered by the Node suite,
      NOT verified in-browser here.
```

There is **no `h05` browser screenshot**, and none should be invented. This is a
probe-level limitation, **not** a skipped Vitest test — the final suite had
**0 skipped tests**.

### Multi-selection

Browser-verified with a real count heading (e.g. **`5 objects selected`**).

Sections: `Align`, `Distribute`, `Appearance`.

Verified: **no single-object typography fields leaked**, **no per-object geometry
fields leaked**, no horizontal overflow.

### Outline

The test fixture PDF has no outline. The Inspector renders an **honest empty
state** — *"This document has no outline."*

No fake CRUD controls are exposed for a structure the build cannot edit. No
horizontal overflow.

### Comments

**This is the section that justifies browser verification existing at all.**

#### The crash the unit suite never found

```
TypeError: Cannot read properties of undefined (reading 'length')
```

`CommentsPanel` requires `thread.messages` and immediately reads
`thread.messages.length` (`components/workspaces/CommentsPanel.tsx:288`). But the
comments list API returned only `toCommentThreadResponse(thread)` — thread summary
fields, with **no `messages` array**. `DocumentInspector` passed those raw
summaries straight into the panel.

Consequence: **any Workspace document with at least one comment thread could crash
the Comments tab.** A genuine product defect, invisible to the Node tests because
they had never wired the real API shape to the real panel.

#### The fix — server-side, not client N+1

`CommentService` gained a bounded, concurrent listing path:

- `src/application/services/CommentService.ts` → `listThreadsWithMessages`
- `app/api/.../comments/route.ts` now returns each thread with its `messages`,
  decorated through the existing batched identity logic (`withCommentAuthors`).

Constraints preserved:

- No client-side per-message identity fetch.
- No raw ID-as-name fallback.
- Bounded message reads.
- Concurrent message loading.
- Batched author identity resolution.
- Real thread staleness retained (not defaulted).

The route comment records the reasoning at the call site:

> *Threads carry their messages, because the panel renders the conversation
> inline; a summary-only listing gave it `messages: undefined` and the tab crashed
> on `thread.messages.length`.*

Live API verification confirmed a `messages` array, thread author
`Phase H Probe`, initials `PH`.

#### Regression tests + mutation evidence

`components/workspaces/commentAuthorDisplay.test.ts` was extended to **13 tests**.
The new guards cover: the panel still reads `messages` off each thread (the crash
site), the list route returns a `messages` array on every thread, identities
resolve in batched passes rather than once per thread, messages load concurrently
and within the domain limit, and each thread reports its real staleness.

**Mutation test:** removing `messages: byThread.get(thread.id) ?? []` from the
route made the new regression test fail. The real route was then restored.

#### Final browser result — PASS

Verified: fixture comment body visible; display **name** shown; no raw internal
cuid presented as a person; initials present; human-readable relative timestamps
(no raw ISO string); no horizontal overflow; switching tabs does not unexpectedly
reset the page view; **zero console errors**.

### Versions

Browser-verified: real version rows render, with author, origin, and a `CURRENT`
state. Restore actions exist. The current version's Restore is **disabled with a
stated reason**; an older valid version's Restore is **enabled**. Dates are
human-readable. No horizontal overflow.

Restore helper text (`versionRestoreLogic.ts`, `RESTORE_HELPER_TEXT`):

> **Creates a new version from this one. History is kept.**

That is the real product contract: restore is additive, not destructive.

**No fake `Preview`. No fake `Compare`.** Neither has an endpoint, so neither has
a button — confirmed absent from `DocumentInspector`.

There is **no separate confirmation dialog**. Restore is one click. An earlier
probe assumed a second confirmation step and was corrected to match the product.

### Restore CAS

The compare-and-swap revision rule:

```
expectedRevision  ←  GET document → document.revision      ✅
                 NOT  latest version.revision              ❌
```

`expectedRevisionFrom(document)` (`components/workspaces/versionRestoreLogic.ts`)
reads the **document's** revision and validates it is a non-negative integer.
Relatedly, `isCurrentVersion` uses the document's `currentVersionId` rather than
"first row in the list" — the list is newest-first and paginated, so position is
only a proxy for currency on page one; the pointer is authority on every page.

A real stale-write scenario was constructed. The server conflict surfaced to the
UI with wording equivalent to:

> The version was written but the document could not be advanced. Reload and retry.

The UI exposes **`Reload versions`**, which refetches the list *and* the document.

The browser probe counted **exactly 1 restore request**. Therefore there was
**no silent automatic retry** of a 409 — the user decides again, explicitly.

### Responsive Inspector

Below the **1200px** docking breakpoint:

- The permanent 320px dock disappears.
- The canvas remains usable.
- The Inspector opens as a **drawer**.
- The correct floating control is **`Show inspector`**
  (`FloatingCanvasControls.tsx`, toggling to `Hide inspector`). An earlier probe
  accidentally matched `Organize pages` and was corrected.
- Verified: no offscreen controls, no horizontal overflow, drawer closes, canvas
  returns to full width.

### Browser probe evidence

| Probe | Result |
| --- | --- |
| `scripts/editor-inspector-probe.mjs` | **ALL CHECKS PASSED** |
| `scripts/editor-inspector-states-probe.mjs` | **55 checks passed — ALL CHECKS PASSED**, stable across two consecutive runs |

Also recorded: **0 browser console errors**.

Verified states in the states probe include: Workspace document loaded with all
four Inspector tabs; Shape Inspector; Drawing Inspector; source PDF text; multi-
selection; Outline; Comments; Versions; responsive/overlay Inspector.

#### QA fixture (retained — do not delete without authorization)

Browser testing used a dedicated **local development** account and workspace so
that real Version Restore testing could never touch real user documents:

- User: `Phase H Probe`
- Email: `phaseh-probe@example.test`

A real PDF (`docs/qa/p0/source-text-fixture.pdf`) was uploaded through the actual
Workspace ingestion pipeline, producing a real document with stored PDF bytes,
then given multiple real versions, comment threads, replies, and restore/conflict
scenarios. This is isolated local QA data, useful for later probes.

### Screenshot evidence

Thirteen retained files:

```
docs/screenshots/phase-h/h01-no-selection.png
docs/screenshots/phase-h/h02-collapsed-section.png
docs/screenshots/phase-h/h03-text-selected.png
docs/screenshots/phase-h/h04-italic-applied.png
docs/screenshots/phase-h/h06-shape.png
docs/screenshots/phase-h/h07-drawing.png
docs/screenshots/phase-h/h08-source-pdf-text.png
docs/screenshots/phase-h/h09-multi-selection.png
docs/screenshots/phase-h/h10-outline.png
docs/screenshots/phase-h/h11-comments.png
docs/screenshots/phase-h/h12-versions.png
docs/screenshots/phase-h/h13-restore-conflict.png
docs/screenshots/phase-h/h14-overlay-inspector.png
```

**These screenshots are retained for human visual review.** The environment
asserted structural facts (headings, control presence, accessible names, absence
of forbidden affordances, no horizontal overflow) — it did **not** necessarily
judge their aesthetic quality. **No claim of pixel-perfect target matching is
made.**

Stale screenshots from earlier failed iterations were deliberately removed. There
is no `h05` because image selection remained the honest native-file-picker
limitation.

### Probe corrections

| Correction | Class |
| --- | --- |
| Collapse read stale React DOM in the same tick | PROBE |
| Geometry names are unit-bearing (`X position (pt)`) | PROBE |
| Accessible names come from real `<label>` association | PROBE |
| Opacity slider was genuinely 16px high | **PRODUCT** |
| Image selection needs a native file picker | ENVIRONMENTAL |
| Source-text check ran after new objects covered the hit region | PROBE |
| Drawer button matched `Organize pages` instead of `Show inspector` | PROBE |
| Restore assumed a second confirmation step | PROBE |

**The slider defect, in detail.** The opacity range input was only **16px** high —
a 16px row among 32px rows, visibly breaking the Inspector's grid and violating
WCAG 2.5.8's 24px minimum target expectation. The product was fixed to a **32px
hit target / row height** (`h-8` applied to the input box so the pointer hit
region grows while the visual track stays slim). The probe was *also* corrected to
classify ordinary boxed controls and range sliders separately. Mutation testing
removed the 32px treatment and confirmed the probe reports the regression.

**The source-text ordering fix.** The source-text check originally ran *after*
Shape and Drawing objects had been added to the page. Those new objects could
cover the transparent imported-text hit regions and intercept the click. The probe
was reordered so source PDF text is exercised **before** drawing new objects,
aligning it with the proven P0 source-text strategy.

### Mutation testing

Each guard was proven capable of failing:

| Mutation introduced | Guard failed as required |
| --- | --- |
| Broke the real collapse implementation | ✅ |
| Removed the geometry accessible-name labels (all four) | ✅ |
| Broke `<label>` association | ✅ |
| Removed the 32px slider treatment | ✅ |
| Removed `messages: byThread.get(thread.id) ?? []` from the comments route | ✅ |

All real implementations were restored afterwards.

### Final gates

Exact retained results from the final checkpoint:

| Gate | Result |
| --- | --- |
| Prisma validate | **PASS** — schema valid |
| Prisma generate | **PASS** — Prisma Client 6.19.3, after the known Windows EPERM DLL lock was released |
| TypeScript (`npm run typecheck`) | **PASS** — 0 errors |
| Lint | **PASS** — 0 errors (after four genuine probe-script fixes) |
| Production build (`node scripts/next-build.js`) | **PASS** — exit 0 |
| Tests (post-build) | **202 / 202 files, 3866 / 3866 tests passed, 0 failed, 0 skipped** |
| `lib/seo/publicBundles.test.ts` | **50 / 50 executed post-build** — genuinely ran against build manifests |

The build included `/workspaces/[workspaceId]/documents/[documentId]` and the rest
of the application.

**Test baseline movement:** the prior baseline was 202 files / 3860 tests. The
**+6 tests** came from the Phase H closure fixes (the Comments regression guards
and the geometry/slider accessibility guards).

**Post-build ordering matters.** The final suite was run *after* the production
build so the build-state-dependent `publicBundles` suite actually executed rather
than skipping.

**Skip discipline.** The only conditional skip in checked source is the
pre-existing `describe.skipIf(!built)` in `lib/seo/publicBundles.test.ts`. Verified
absent: no `.skip`, no `.only`, no `.todo`, no broad lint suppression, no
TypeScript suppression were introduced.

**Lint fixes** (all genuine, all in newly-created probe scripts):

- `Buffer` missing from globals in `editor-inspector-probe.mjs`
- `Buffer` missing from globals in `editor-inspector-states-probe.mjs`
- unused initial `ready` assignment
- unused initial `srcHeading` assignment

### Environment

The Prisma `generate` EPERM was **not a code fault**. The running PDFDadi dev
server held Prisma's query-engine DLL open on Windows.

Resolution was surgical: only the confirmed PDFMaster processes were stopped —
**PID 2628, 10448, 9748, 6844**. Unrelated `modelgate` processes were deliberately
left running. After the DLL was released, `prisma generate` passed.

### Current probe files

Retained:

```
scripts/editor-inspector-probe.mjs          (Phase H — Properties/controls)
scripts/editor-inspector-states-probe.mjs   (Phase H — all Inspector states)
scripts/editor-object-toolbar-probe.mjs     (Phase G)
scripts/editor-p0-probe.mjs                 (P0)
scripts/editor-source-text-probe.mjs        (P0 source text)
scripts/editor-find-probe.mjs               (Ctrl+F)
```

The throwaway diagnostic `scripts/tmp-inspector-diagnose.mjs` was removed before
final gates — confirmed absent.

### P0 / P1 invariants confirmed intact

1. **ONE** right Inspector only.
2. Source PDF text uses read-only range semantics.
3. Source PDF text has no transform handles.
4. Editable objects still retain transform controls.
5. `CommandHistory.revision` remains the mutation/save watermark.
6. `clear()` advances revision.
7. The export watermark is captured **before** async export/upload.
8. The Phase G contextual toolbar remains independent from snap-guide incidental
   rerenders.
9. Italic remains family-based.
10. No new italic boolean on `TextObject`.
11. No schema migration.
12. No editor format version bump.
13. Underline remains omitted.
14. Justify remains omitted.
15. No fake Preview/Compare in Versions.
16. Restore uses the real **document** revision.
17. Restore never silently retries a 409.
18. Comments expose real/fallback member identities, never raw IDs as names.

### Deliberate omissions

| Omitted | Reason |
| --- | --- |
| **Underline** | `TextDecoration` exists in the type system but has zero renderer and zero export support. A `U` button would visibly do nothing — omitted rather than faked. |
| **Justify** | `align` has no `justify` member in the domain, and the layout engine does not stretch inter-word space. The button could not do what it says. |
| **Preview** (Versions) | No endpoint. |
| **Compare** (Versions) | No endpoint. |
| **Image browser selection** | Native file picker not automatable by this CDP probe. Covered by the Node suite. |
| **Continuous multi-page scrolling** | Deferred to its own architecture phase. |
| **Workspace redesign** | Deferred to P2. |
| **AI / M8** | Not started. |

### Final Phase H verdict

**Complete:**

- Single Inspector architecture — one dock, four tabs, 320px, 1200px breakpoint.
- Shared control primitives on a 32px rhythm.
- Collapsible sections, verified asynchronously.
- Accessibility: real accessible-name association, unit-bearing geometry names,
  corrected slider target size, ARIA semantics.
- Text / Shape / Drawing / multi-selection / Outline Inspector states,
  browser-verified.
- Family-based Italic with no schema or format-version change.
- Source PDF text honesty invariant preserved.
- Comments: real crash found and fixed server-side, with batched identities and
  regression guards.
- Versions + Restore CAS: real revision source, 409 surfaced, no silent retry.
- Responsive drawer Inspector.
- Final gates green: 202 files / 3866 tests / 0 failed / 0 skipped, build exit 0.

**Not complete, by intent:**

- Image Inspector **browser** automation (Node-covered; native file picker).
- Underline, Justify, Versions Preview/Compare (no real capability behind them).
- Continuous multi-page scrolling (own architecture phase).
- Workspace P2 redesign.
- AI / M8.

**Next authorized work, in order:**

1. **P1 Phase I** — Floating bottom controls
2. **P1 Phase J** — Loading / empty / error UX
3. Final visual/responsive P1 pass
4. Separately: continuous multi-page scrolling architecture

None of these were started in this session.

---

## Phase I — Floating bottom controls

### Final status

Complete. Every claim below is a measurement or a semantic assertion taken from
a real browser, or a Node test. Nothing here rests on reading the source.

- Focused tests: **67 passing** (`zoom.test.ts` 35, `floatingControlsLogic.test.ts` 32).
- Browser probe: **71 checks, all passing, exit 0, 0 console errors**, stable
  across three consecutive cold runs.
- Screenshots: six, recaptured *after* the final visual refinements.

### The four defects, as measured

The controls existed before this phase. They were also wrong in four ways that
only measurement exposed — reading the component would not have found any of
them, because each is a claim about geometry or about state the component does
not own.

| # | Defect | Measured before | After |
|---|---|---|---|
| 1 | Capsule centred on the editor **frame**, not the canvas | +72px right of canvas centre @1440, −88px left @1024 | delta ≤ 2px at all 8 widths |
| 2 | Capsule overlapped the status bar | 13px overlap | 0 |
| 3 | Zoom ± never disabled at the clamp bounds | "+" live and inert at 800%, "−" at 10% | disabled, with a stated reason |
| 4 | Page nav hidden entirely for a 1-page document | separators implied a missing control | disabled `1 / 1` with a reason |

**Canvas-relative centring.** The fix was positional, not arithmetic: the capsule
is positioned inside the canvas region itself, so it tracks the 176px left rail
collapsing and the 320px Inspector docking for free. No offset constants to keep
in sync with a layout that changes. Defect 2 fell out of the same change — the
bar is no longer pinned to a frame whose bottom belongs to the status bar.

**Zoom-limit honesty** is derived from the canonical `MIN_ZOOM`/`MAX_ZOOM`, not a
second copy of the ladder, and compares against the real clamp bound rather than
the preset list: the wheel can land the zoom between presets, and a "−" disabled
at 0.11 because "0.1 is the lowest preset" would lie about a step it can still
take. Disabled controls carry the reason in **both** the tooltip and the
accessible name, so the explanation is not inferable only from grey pixels.

### Fit page: why a zoom-only fix is not a fix

The page ran underneath the floating bar in Fit Page mode. The reserve is
composed from the capsule's real layout budget rather than being a magic number:

```
1px border + 6px padding + 2px group inset + 36px control
           + 2px group inset + 6px padding + 1px border  = 54px  FLOATING_CONTROLS_HEIGHT
                                                        + 12px  FLOATING_CONTROLS_GAP
                                                        = 66px  CANVAS_BOTTOM_RESERVE
```

The important part is that the reserve applies to **zoom and pan together**,
through one `fitViewport(...)` built on `usableFitArea(...)`:

- reserve the zoom alone → the page is smaller but still centred in the *full*
  height, so its bottom edge is still under the bar;
- reserve the pan alone → an exactly-fitting page is pushed off the top.

Both were reachable while this was two calls at the call site, and the shipped
build did exactly that. One function, so the reserve cannot be half-applied.

Measured page clearance above the bar, after activating Fit Page:

| Width | 1920 | 1440 | 1366 | 1024 | 768 | 390 |
|---|---|---|---|---|---|---|
| Clearance | 23px | 23px | 23px | 23px | 29px | 76px |

At every width: capsule misalignment 0, status overlap 0, page-level horizontal
overflow 0, console errors 0.

### Density and page entry

Priority under width pressure, most-cut-last: zoom and page navigation are the
two reasons the capsule exists, so they never drop. What drops is duplicated
chrome — the pointer-mode pair (the toolbar and V/H already offer it), the
Inspector toggle, then the standalone Fit button (the mode stays reachable inside
the zoom menu, so no capability is lost). Breakpoints are the **canvas's** own
width, not the viewport's: inside the workbench a 1024px window does not give the
canvas 1024px.

The page readout is a real input, committed on blur/Enter rather than on change —
re-rendering per keystroke would walk the view through pages 1 → 12 → 120 while
the user is still typing "120". Out-of-range entries clamp into the document.

### Mutation testing: the reserve test was too weak

The first version of the reserve test passed for the wrong reason. Setting
`CANVAS_BOTTOM_RESERVE = 0` broke only **one unrelated constant assertion**,
because the clearance check referenced the same mutated constant on both sides of
the comparison — it was asserting `x === x`. After strengthening it to assert
against independently-derived expected geometry, the same mutation fails **three
zoom tests**. The real implementation was then restored.

### The 12-page fixture

`docs/qa/p1/multipage-fixture.pdf` — 12 pages, opened through the editor's own
real file input via `DOM.setFileInputFiles`. Page navigation rules are only
meaningful on a document with pages to move between. Verified: page 1 (Previous
disabled with reason, Next enabled), a middle page (both enabled), typing `10`
navigates to page 10, page 12 (Next disabled with reason, Previous enabled), and
an out-of-range entry clamps.

**This fixture is for page-navigation testing only.** The editor still renders a
single active page; continuous multi-page scrolling remains a separate phase.

### Probe corrections — 2 probe defects vs 4 product defects

Two probe failures were investigated and classified as probe defects, and the
probe was corrected rather than the product bent to fit it.

**1. Wrong element for the stacking check.** The probe read `z-index` off the bar
element and got `auto`, calling it a regression. The z-index lives on the
positioning *wrapper* — the thing actually stacked against the drawer and the
object toolbar. The probe now walks up to the first non-`auto` ancestor.

**2. A hydration race that reported a fit-reserve regression that did not exist.**
The gate was `bar mounted && buttons >= 4`, which the *server-rendered* capsule
satisfies. On a cold route the next `clickBar('Fit page')` therefore landed on a
button React had not hydrated yet: the click was silently swallowed, the zoom
stayed at 100%, and i03 measured the **unfitted** page — `clearance = −157px`.

Evidence before touching anything:

- with the 1s gate, the click was dropped on **2 of 3** cold runs;
- with the page settled 4s, it succeeded **3 of 3**;
- a later check in the same run (`i03c`, the same assertion after a resize)
  passed at `clearance = 23`, i.e. the product's fit math was fine all along;
- the failing value `−157` is exactly the geometry of a 100%-zoom unfitted page.

The gate now proves hydration by **observing a state change only React makes**:
it clicks Fit page and requires `aria-pressed` to flip to `true`. A longer sleep
was rejected deliberately — the bug being guarded against *is* a timing
assumption, and a bigger sleep is the same assumption with a bigger number. The
click is idempotent (it sets a sticky mode) so retrying is safe, and the fit
state it leaves behind is exactly what i01–i03 want to measure. This added check
`i00b`, taking the probe from 70 to 71.

### The final visual refinements — and the half-applied one

Two cosmetic issues were identified from a real capsule close-up: group
separation was too subtle, and the Fit trigger used so much accent that it
competed with the active interaction tool.

Group separation is now a filled inset trough (`bg-editor-bg` + inset ring)
rather than a hairline outline — at this size a second ring inside the capsule's
own ring reads as clutter, while a trough reads as *one* control. At
`subtle/70` the grouping was invisible, which is why it is the solid inset tone.

The accent fix was **initially applied to only one of the two affected surfaces**,
and measuring computed styles caught it. The zoom/fit trigger had been toned down
to accent *text* on the group surface, but the standalone **Fit page button** was
still painting the filled chip — byte-identical to the active Select tool:

| Control | Background | Text |
|---|---|---|
| Select tool (active) | `rgb(243,238,255)` | accent |
| Fit page button (active) — **before** | `rgb(243,238,255)` | accent |
| Zoom/fit trigger (already fixed) | `rgb(255,255,255)` | accent |

So a Fit-page document still showed two equally-"selected" chips, and the actual
interaction tool lost its only visual claim to being active. `CapsuleButton` now
takes an `activeTone`:

- **`"tool"`** — an active interaction *mode* (Select/Hand, page overview,
  Inspector). Exactly one is active, and it changes what the pointer does, so it
  earns the filled accent chip.
- **`"state"`** — a sticky *view state* (Fit page). True at the same time as a
  tool, so it keeps the accent glyph on the group's raised surface instead of the
  accent fill.

Measured after the fix: Select `rgb(243,238,255)` is the only filled chip, both
Fit surfaces are `rgb(255,255,255)` + accent glyph, and `aria-pressed="true"` is
preserved on the Fit button — the emphasis changed, the semantics did not.

### Screenshots

`docs/screenshots/phase-i/` — all six recaptured after the final refinements
(source 18:56, screenshots 19:06–19:07), so none of them depict the
pre-refinement design:

`i01-bottom-controls-desktop` · `i02-bottom-controls-mid-page` ·
`i03-bottom-controls-zoomed` · `i04-bottom-controls-with-inspector` ·
`i05-bottom-controls-tablet` · `i06-bottom-controls-mobile`

### Responsive measurements

Eight widths, from the probe. Capsule inside the canvas region, nothing clipped
(`offscreen=0`), no page-level horizontal overflow, zoom and pages never dropped:

| Viewport | Capsule span | Canvas span | Capsule scrollW |
|---|---|---|---|
| 1920×1080 | 581–1195 | 176–1600 | 611 |
| 1600×900 | 425–1031 | 176–1280 | 603 |
| 1440×900 | 345–951 | 176–1120 | 603 |
| 1366×768 | 375–847 | 176–1046 | 469 |
| 1280×720 | 332–804 | 176–960 | 469 |
| 1024×768 | 364–836 | 176–1024 | 469 |
| 768×1024 | 302–642 | 176–768 | 338 |
| 390×844 | 25–365 | 0–390 | 338 |

### What the probe cannot do

It captures screenshots but cannot visually decode them. Every gate is a
measurement or a semantic assertion, never an aesthetic one. The visual
refinements above were reviewed by a human against a close-up, and where a claim
could be made objective (the two-identical-chips defect) it was checked by
reading computed styles rather than by eye.

### Deliberate omissions

- **No Fullscreen control.** This build integrates no Fullscreen API; an icon
  that did nothing would be exactly the fake affordance the phase forbids. The
  probe asserts its absence.
- **No continuous scrolling.** Out of scope by instruction.


---

## Phase J — Loading / Empty / Error UX

The phase's subject is the two moments a document editor is least forgiving:
while a document is arriving, and when it never does. The shipped build handled
both with a centred spinner and a panel that rendered whatever string the server
happened to send.

### Ground truth

What was inspected before anything was written, and what turned out to already be
correct — the phase deliberately did not rebuild these:

| Already correct | Evidence |
|---|---|
| The load state machine is a bounded, explicit phase machine | `documentLoadState.ts` `LoadPhase` + `POLL_POLICY` |
| A failed preparation is terminal, not polled forever | `phaseForFailure` |
| No infinite-polling design was ever intended | `shouldKeepPolling` checks both attempt and time budgets |
| Comments / Versions / Outline failures are Inspector-local | Phase H |
| The save watermark is `CommandHistory.revision` and advances only on success | Phase H / save-indicator work |
| The export watermark advances only after a completed handoff | `onExport`'s ordering |
| A standalone `EditorEmptyState` already existed | `StandaloneEditorShell.tsx` |
| Content routes never expose storage keys | `documentContent.ts` rules 1–3 |

What Phase J actually fixed:

1. Every failure looked the same. There was no classification, so an expired
   session, a denied document, a missing document and a dropped connection all
   produced one apologetic message with one Retry — including on the failures
   where retrying cannot possibly work.
2. Server diagnostics reached the screen. The panel rendered `error.detail ??
   error.message`, so ingestion text such as *"The stored bytes do not match the
   uploaded checksum"* was shown to customers.
3. A fetch rejection was indistinguishable from an application fault, because
   nothing recorded whether a response had ever arrived.
4. Loading was a bare spinner in an application whose entire subject is a page.
5. The `Skeleton` primitive's comment claimed reduced-motion support that no
   utility in its class list provided.
6. A failed save offered only *Dismiss*, leaving the user to hunt for the button
   they had just pressed.

### Load architecture

The existing machine was **extended, not replaced**. There is no second state
machine: `LoadPhase`, `POLL_POLICY`, `shouldKeepPolling` and `phaseForFailure` are
untouched, and Phase J added classification and presentation on top of them.

- Polling continues **only** from `processing-upload`, the one phase with
  something running behind it.
- Both bounds are enforced: 24 attempts **and** a 60s total budget. With backoff,
  an attempt cap alone would drift far past what a user will sit through, and a
  time cap alone would permit many attempts while delays are small.
- Every other outcome — success, failure, exhausted budget — leaves the loop.
  That is what makes an endless spinner unreachable rather than merely unlikely.
- `spinner` is true only for phases that have work behind them, so a terminal
  error never spins.

### Error classification

`classifyLoadError` maps evidence to one of eight kinds. Ordering is meaningful:
`network` and `timed-out` outrank status-based kinds, because an exhausted polling
budget arrives *with* preparation evidence attached and the user's problem at that
point is the waiting, not the preparation.

| Kind | Evidence | Heading | Retry |
|---|---|---|---|
| `auth` | HTTP 401 | Your session has expired | Sign in (no Retry) |
| `forbidden` | HTTP 403 | You don't have access to this document | no |
| `not-found` | HTTP 404 | Document not found | no |
| `content-unavailable` | `code === CONTENT_UNAVAILABLE`, or a real preparation state | varies by preparation | yes |
| `invalid-pdf` | bytes arrived, PDF.js refused them | We couldn't open this PDF | no |
| `network` | fetch rejection — no response at all | Connection problem | yes |
| `timed-out` | bounded polling budget exhausted | This is taking longer than expected | yes |
| `unknown` | anything unrecognised | Could not open this document | yes |

Two deliberate refusals:

- **401 and 403 stay separate.** One is a session the user can fix by signing in;
  the other is an authorization decision that signing in again will not change.
  Collapsing them would put a dead "Sign in" on a document the user simply cannot
  read.
- **There is no "permission was removed" kind.** A 403 does not say *why* access
  was denied, and the application cannot distinguish a revoked role from one never
  granted. Inventing that distinction would be both a guess and a disclosure.

`canRetryKind` exists so no failure gets a dead control: a Retry on a 404 asks
again for a document that was not found, and re-fetching identical damaged bytes
fails identically.

### 409 honesty — the phase's most important finding

The content route answers **409 with `CONTENT_UNAVAILABLE`** when a document has
no servable bytes. It would have been easy — and wrong — to read the status alone.

`mapWorkspaceError` (`src/application/services/workspaceHttp.ts:27`) answers
**409 with `WORKSPACE_OPERATION_REJECTED`** for *any* rejected domain operation.
Unrelated 409s therefore genuinely exist in this API.

**Therefore a bare 409 is not evidence of preparation.** Classification requires
the semantic code (or a real `preparation` value). Reading every 409 as "still
preparing" would tell a user their document was being prepared when the real
problem had nothing to do with preparation — and would attach a Retry that waits
for something that was never happening.

Verified in the browser both ways: a 409 carrying `CONTENT_UNAVAILABLE` classifies
as `content-unavailable` (j04), and a 409 carrying `WORKSPACE_OPERATION_REJECTED`
does **not**, and does not tell the user the document is being prepared (j04b/c).

### Safe copy

Every user-facing string is authored in `documentLoadState.ts`. The server's own
text is never passed through, and the mechanism is a **type-level** one rather
than a rule to remember:

- `LoadErrorFacts` carries `status`, `code`, `preparation`, `network`,
  `invalidPdf`, `timedOut` — and deliberately **no `detail`**.
- `DocumentErrorPanel` has no `detail`, `message` or `error` prop at all, so
  routing a raw exception to it is not discouraged, it is impossible.
- `presentLoad` has no `message` input, which is what removed the channel the
  shipped build used.

The diagnostic is not discarded — it goes to `console.error`, where a developer
can read the server's own words. The ingestion messages are bounded and safe, but
"safe" is not the same as "written for this panel": the moment a message is echoed
verbatim, the panel inherits whatever any future route decides to put in it.

### Network vs Abort

`loadWorkspaceDocument` now distinguishes **an HTTP response that failed** from
**a request that never produced a response**. `WorkspaceDocumentLoadError` carries
a `network` flag, set only on a fetch rejection, so a dropped connection is
reported as `network` instead of escaping as a raw `TypeError` and being presented
as an application fault.

`AbortError` remains **silent cancellation** and is never classified:

- The load effect aborts in-flight requests when a document's identity changes.
- React StrictMode's dev double-invoke aborts the first pass.

Classifying either as a failure would put a "connection problem" panel over a
document that is loading perfectly well. Aborts are rethrown untouched for the
caller's cancellation checks, and `isAbortError` is consulted on **every** failure
path in `EditorWorkspace` — including the defensive outer catch.

### Loading presentation

`DocumentLoadingOverlay` draws the page instead of a spinner.

- **A real page shape.** A white sheet at the page's aspect ratio with a border and
  the editor's page shadow. `loadingPageAspect` answers immediately with an A4
  default when dimensions are unknown and refines to the real ratio once the PDF is
  parsed — waiting to learn the size before drawing anything is how a skeleton
  degrades back into a spinner. The ratio is clamped to [0.4, 3] so a 14400pt
  banner cannot produce a skeleton taller than the viewport.
- **An overlay, not a layout participant.** The app bar, toolbar, rails, Inspector,
  status bar and the Phase I capsule keep their geometry underneath. Measured: the
  canvas box is byte-identical between loading and ready (`j03a`).
- **Bounded Pages-rail placeholders.** `placeholderThumbnailCount` returns a small
  fixed number while the page count is unknown and **zero** once it is known. One
  skeleton per page would cost more layout on a 200-page document than the
  thumbnails it stands in for, and would misstate how much is loading. Measured: 3
  placeholders during load, 0 once real page state exists.
- **Reduced motion.** `motion-reduce:animate-none` on every animated element,
  verified in the browser as a *computed* consequence: under
  `prefers-reduced-motion: reduce` the sheet has **0** animating elements, and with
  motion allowed it has **9** — so the opt-out is real and the animation is real.
- **Not a live region.** The single announcement lives in `EditorWorkspace`; the
  overlay is `aria-hidden` **except** when it holds a reachable Retry, because
  hiding a focusable control from assistive tech would make it unusable.

The `Skeleton` primitive in `components/app/primitives.tsx` had its reduced-motion
claim repaired narrowly — `motion-reduce:animate-none` added to the class list it
already claimed to have. This was not turned into a primitives redesign.

### Error presentation

`DocumentErrorPanel` is driven by `LoadErrorPresentation`, never by an exception.

- Safe heading, safe description, a kind-specific icon, and only actions that do
  something.
- **Focus moves once per distinct failure.** The effect keys on
  `presentation.kind`, not on every render. A load error replaces the content the
  user was waiting for, so leaving focus on the toolbar would leave a keyboard or
  screen-reader user unaware the wait ended in a failure — but re-stealing focus on
  rerender would yank it from someone who had already tabbed to Retry. Verified in
  the browser: focus lands on the heading (j10), Tab reaches the action (j10c), and
  a resize does **not** pull it back (j10d).
- `tabIndex={-1}` makes the heading a focus *destination* without adding a tab
  stop.
- `role="alert"` — appropriate here because a terminal failure genuinely should
  interrupt.
- The host passes its own "Back to Workspace" link as a `secondary` node rather
  than the module emitting a `back` action it could not implement. An action with
  no possible implementation is exactly the dead button this phase forbids.

### Error boundaries

Deliberately narrow, deliberately **no global catch-all**.

- `EditorErrorBoundary` wraps both editor mount sites **inside**
  `DocumentWorkbench`, so an editor render crash keeps the surrounding Workspace
  chrome alive, logs the defect, and offers a real remount — without rendering
  `error.message`.
- `app/editor/error.tsx` covers the standalone route, using Next's real segment
  `reset()`.
- **No `app/global-error.tsx` and no `app/error.tsx`.** A global boundary would
  replace the marketing site and every unrelated route with one apologetic card,
  which both hides real defects and overreaches enormously for a phase about editor
  loading states. `loadStatesContract` asserts their absence so this cannot be
  added by accident.

### Save Retry

The save-failure banner now offers a real Retry that calls the **same**
`onSaveToWorkspace` the button does — one persistence implementation, one watermark
rule, no second code path to drift.

- `disabled={save.kind !== "error"}` is what makes "one click, one retry" true: a
  second click cannot start a concurrent upload, so no duplicate document is
  created. Measured in the browser: **one click → exactly one upload request**.
- **The failed attempt does not call `setPersisted`.** This is the invariant that
  matters most: a failed save must never make the app bar claim the work exists in
  the Workspace, because that is the one error direction that produces a *false
  safe*. Verified positively — after a forced failure the indicator reads
  *"Save failed — …"* and never claims the document is in the Workspace.
- A **successful** retry does advance the state, through that same path.
- `revisionAtPersist` is captured **before** the await, so an edit made during the
  upload is not attributed to the uploaded file.

### Export honesty

Inspected, confirmed, and **left alone**. `onExport` calls
`onPersistedRef.current?.("file", revision)` inside the try, *after*
`downloadBytes` has handed the file off; the catch reports a failure and touches no
watermark. A structural test pins the ordering (`persistAt < catchAt`, and the
catch body contains no `onPersistedRef`) so a later edit cannot quietly invert it.

Export is entirely client-side — pdf-lib plus a download — so there is no request
to intercept and no honest way to force a *server* export failure. The browser
check therefore verifies the reachable part: the control is real, and no raw
exception text reaches the screen.

### Standalone invalid second open

Opening a bad PDF while a good document is open produces a **notice**, not the
error panel. Replacing the canvas with a full-page error would hide — and imply the
loss of — work that is perfectly intact, since the failed open changed nothing.

Verified in the browser with a deliberately non-PDF file: the notice appears with
bounded copy, no PDF.js internals leak, and the previously opened 12-page document
is still there (`Page 1 of 12`) with no error panel. A `PdfOpenError`'s message is
preserved because it is genuinely user-facing and actionable ("supports up to 200
pages — please split the PDF first"); anything else falls back to the
presentation layer's `invalid-pdf` copy so both paths word the same fault the same
way.

### Inspector isolation

Preserved from Phase H and re-verified: the document load does not wait on
secondary Inspector data, and Comments/Versions/Outline failures stay local to
their panel. The request audit recorded **0** comments and **0** versions requests
during these load scenarios — the main PDF never blocks on them.

### Mutation testing

Every guard in this phase was verified by breaking the real code and confirming the
suite noticed. Exact evidence:

| # | Mutation | Result | Detected by |
|---|---|---|---|
| 1 | `network` classified as `unknown` | **4 failed / 60 passed** | classification + copy tests |
| 2 | 401 and 403 collapsed into one kind | **3 failed / 61 passed** | separation + action tests |
| 3 | A terminal error allowed to spin | **4 failed / 45 passed** | `presentLoad` spinner invariant |
| 4 | Server `detail` leaked into user copy | **1 failed / 63 passed** | hostile-diagnostic test |
| 5 | One `motion-reduce:animate-none` removed | **initially PASSED — the guard was broken** | see below |

**The interrupted session.** The previous session ended *during* mutation 4, and
disk inspection at the start of this one confirmed the mutation was still active in
`components/editor/documentLoadState.ts` — a `leaked` projection reading a
`detail` field off the facts object via a double cast and substituting it for the
authored description.

Only that projection was reverted. The file also contains legitimate Phase J work
that does not exist in any older baseline, so a wholesale file reset would have
destroyed it. The restored file was then diffed against the pre-mutation backup and
confirmed identical, and the three focused suites were re-run: **90 passed**.

**Mutation 5 found a real defect in the test, not the product.** Removing a genuine
`motion-reduce:animate-none` from `DocumentLoadingOverlay`'s first placeholder line
left the suite **green**. The cause: the guard counted tokens in *raw source*, and
the component's own doc comment explains its reduced-motion policy by naming
`motion-reduce:animate-none` — a phantom opt-out that kept the ratio balanced while
a real one was missing. The same file's `readCode` helper had already been written
for exactly this class of false signal (the watermark test had once failed on its
own explanatory prose), so both reduced-motion assertions now read comment-stripped
code. Re-run with the mutation still active: **1 failed / 25 passed**, with an
accurate message reporting 6 animations against 5 opt-outs. The real code was then
restored and the suite is green.

That is the phase's most useful testing lesson: a guard that has never been seen to
fail is not known to work. This one had been passing on a comment.

No mutation remains in the worktree. The three focused suites were re-run green
after every restoration, and the changed files were reviewed for leftovers, debug
logging, `.skip`/`.only`/`.todo`, commented-out code and suppressions.

### Browser probe

`scripts/editor-load-states-probe.mjs` — CDP over a raw WebSocket, no Playwright,
matching the existing editor probes.

**102 checks, ALL CHECKS PASSED, exit 0, stable across three consecutive runs.**

Real states, produced honestly:

| Check | State | How it was produced |
|---|---|---|
| j00 | hydration gate | clicking *Create blank PDF* and requiring the overlay to actually disappear |
| j01 | standalone empty | real route, no document |
| j02 | opening | content request **delayed 9s**, then continued — a genuinely slow real load |
| j03 | ready | the same load, allowed to finish |
| j04 | content unavailable x4 | `CONTENT_UNAVAILABLE`, unrelated 409, failed preparation, and a real uninterceptable server failure |
| j05 | 401 | targeted response interception |
| j06 | 403 | targeted response interception |
| j07 | 404 | targeted response interception |
| j08 | network | `Fetch.failRequest` — a true fetch rejection, no status |
| j09 | retry | counted requests per click |
| j10 | focus | `document.activeElement`, before and after a rerender |
| j11 | live region | one load announcement across all regions |
| j12 | invalid PDF | a real non-PDF file through the editor's own file input |
| j13 | save failure | failed upload, then a **successful** retry |
| j14 | export | the real control |
| j15 | request audit | every `Network.requestWillBeSent` |
| j16 | responsive | eight widths, **with an error panel on screen** |
| j17 | console | classified, not hidden |

Interception is always **one targeted rule against one URL pattern**; everything
else is continued untouched, so the app shell is never broken out from under the
measurement.

**Hydration.** Phase I's lesson is carried forward: element presence is never
treated as readiness, because server-rendered markup exists before React attaches
handlers. The gate proves interactivity by observing a state change only React can
make, and no arbitrary long sleep stands in for readiness.

### Responsive QA

Eight widths — 1920x1080, 1600x900, 1440x900, 1366x768, 1280x720, 1024x768,
768x1024, 390x844 — each measured **while a terminal error panel was on screen**,
since a failure is exactly the surface a user meets on a phone.

At every width: no page-level horizontal overflow, the error panel fully on screen
with a working action, and the Phase I capsule still canvas-centred with zero
status-bar overlap.

### Request audit

- Longest unbroken run of one identical URL: **2** — no runaway loop.
- One Retry click → **exactly 1** content request; **0** further requests over the
  following 6 seconds, so there is no automatic retry loop.
- One Retry click → **exactly 1** upload request on the save path.
- Comments **0**, versions **0** during load scenarios — the main PDF never waits
  on secondary Inspector data.

### Phase I regression

`node scripts/editor-bottom-controls-probe.mjs` → **ALL CHECKS PASSED**, exit 0,
0 console errors. Phase J changed `EditorWorkspace`'s loading surfaces, so this was
re-run rather than assumed; no Phase I geometry invariant regressed, and Phase I was
not reopened.

### Screenshots

Nine retained files under `docs/screenshots/phase-j/`:

```
j01-editor-empty.png
j02-opening-document.png        (the real page-shaped skeleton, mid-load)
j03-document-ready.png
j04-content-unavailable.png
j05-auth-expired.png
j06-document-not-found.png
j07-invalid-pdf.png
j08-network-error.png
j09-save-failed.png
```

**`j10-export-failed.png` is deliberately absent.** Export is client-side, so there
is no safe targeted way to force a *server* export failure, and fabricating the
screenshot would be dishonest. The export invariant is covered by the structural
ordering test and by the browser check that the editor stays usable with no raw
exception on screen.

As with Phase H and I: these are retained for **human visual review**. The probe
asserts measurements and semantics; it does not judge aesthetics, and no claim of
pixel-perfect target matching is made.

### Probe corrections

Six defects were found in the probe itself. Recorded because the pattern matters —
most "failures" a brand-new probe reports are its own:

| Correction | Class |
|---|---|
| `\s` inside a plain template literal collapsed to `s`, so text normalisation silently deleted every letter *s* from measured copy | PROBE |
| `querySelector('main')` returned AppShell's outer main element in the Workspace, reporting a 72–88px "off-centre" capsule at every desktop width | PROBE |
| Hydration gate matched `/blank page/i`, which hit the empty state's description text instead of the *Create blank PDF* button | PROBE |
| Save banner and app-bar save indicator were matched by one selector, so a legitimate `role=status` indicator failed an "is it role=alert" assertion | PROBE |
| Focus was read in the same tick the panel mounted, racing the focus effect | PROBE |
| `--emptydoc` expected `content-unavailable` from a fixture whose version points at a synthetic storage key left by Phase H conflict testing | PROBE + damaged QA data |

The last one is worth stating plainly: that document returns **500** because the
content route resolves a version and then fails *reading* bytes that were never
written. That is damaged QA fixture data, not a product defect, and `unknown` is
the honest classification for a server failure that explains nothing about itself.
The check was rewritten to assert what is actually load-bearing — terminal state,
authored copy, a real action, and no 500 envelope on screen.

Only the first of these was a product-adjacent finding at all; the rest were purely
measurement errors. The one genuine *test* defect this phase found was mutation 5's
phantom reduced-motion opt-out, described above.

### A real environment defect found and fixed

The dev server was returning **404 for every route under
`/api/workspaces/[workspaceId]/documents/[documentId]/`** — content, versions,
metadata, outline — and for `documents/upload`, while the parent `documents` route
answered 200 and every route file existed on disk.

Cause: a **truncated generated dev route manifest** (`.next/dev/types/routes.d.ts`
held only 115 top-level entries and no nested routes at all). This is the stale
`.next/dev` artifact class the brief warned about.

It was **not** worked around in source and no generated file was hand-edited: the
PDFDadi dev processes were identified by command line and stopped (unrelated Node
services were left running), `.next/dev` was removed, and the server restarted. The
content route then served real PDF bytes with `200 application/pdf`.

Worth recording because it would have been easy to misread as a Phase J routing
defect — and because the fix is regeneration, not code.

### Test additions

| Suite | Tests |
|---|---|
| `components/editor/documentLoadState.test.ts` | 49 |
| `lib/editor/loadWorkspaceDocument.test.ts` | 15 |
| `components/editor/loadStatesContract.test.ts` | 26 |
| **Focused Phase J total** | **90** |

`loadStatesContract` is intentionally **source-structural**: Vitest runs in Node
here, with no DOM, no layout engine and no React renderer. Reduced-motion pairing,
the absence of a raw-error channel, the focus contract, the boundary scope and the
watermark ordering are all properties of what the source *says*, which is an honest
thing to read source for. They are **not** evidence of browser geometry — that is
what the CDP probe is for, and the file says so in its header.

### Final gates

| Gate | Result |
|---|---|
| `npx prisma validate` | schema valid |
| `npx prisma generate` | generated (after stopping only PDFDadi processes to release the query-engine DLL) |
| `npm run typecheck` | **0 errors**, exit 0, nothing filtered |
| `npm run lint` | **0 errors, 0 warnings** |
| `node scripts/next-build.js` | success, exit 0 |
| `npx vitest run` (post-build) | **205 files, 3987 tests, 0 failed, 0 skipped** |
| `lib/seo/publicBundles.test.ts` | **50 tests executed** — verified not skipped |
| `scripts/editor-load-states-probe.mjs` | **102/102, ALL CHECKS PASSED** |
| `scripts/editor-bottom-controls-probe.mjs` | **ALL CHECKS PASSED** (Phase I regression) |
| Editor-focused suites | 46 files, 1007 tests passing |

Baseline movement: the pre-Phase-I project baseline was 202 files / 3866 tests. The
final count is **205 files / 3987 tests** — up by 3 files and 121 tests across
Phases I and J. Nothing was deleted, skipped or weakened; there are no `.skip`,
`.only` or `.todo` markers in first-party code (the single `describe.skipIf` in
`publicBundles` is the pre-existing build-gated suite, and it executed).

Two genuine lint findings were fixed rather than suppressed: an invalid `\"` escape
inside a regex literal in the new probe, and two `eslint-disable` directives in
`documentLoadState.test.ts` that had become unnecessary — replaced with precise
`as string` / `as LoadErrorFacts` casts that keep the hostile-input assertions
fully intact.

`publicBundles` was confirmed to genuinely execute rather than skip: it is guarded
by `describe.skipIf(!built)`, so the final Vitest run was ordered **after** the
production build, and its 50 assertions were then re-run with `--reporter=verbose`
to see each one named individually.

### Limitations

- **No server-side export failure was induced.** Export is client-side (pdf-lib plus
  a download), so there is no request to intercept. Covered structurally and
  partially in-browser instead, and `j10-export-failed.png` is deliberately not
  fabricated.
- **Screenshots are not machine-verified.** The probe captures them but cannot
  visually decode them; every gate is a measurement or a semantic assertion.
- **`timed-out` was not reproduced in the browser.** It requires a 60-second bounded
  polling budget to be exhausted against a server that keeps answering "still
  preparing". The rule is covered by unit tests over `shouldKeepPolling`,
  `pollDelayMs` and `phaseForFailure`.
- **The Phase H QA fixture holds one damaged document** whose version manifest names
  a storage key that was never written, so it returns 500. Left as-is deliberately:
  it is useful evidence that an unexplained server failure presents honestly, and
  repairing it would remove that scenario.
- **Broader app loading inconsistency remains out of scope.** Other surfaces still
  use ad-hoc spinners; Phase J touched only the editor's own load/error surfaces plus
  the one narrow `Skeleton` reduced-motion repair.
- `documentLoadState` is deliberately decoupled from `loadPdf` — it reads error
  evidence structurally rather than via `instanceof` — so its rules stay checkable in
  plain Node without pulling pdfjs-dist into the test.

---

## Final P1 Visual + Responsive Audit — **OLD MEASURED DEFECTS (audit record)**

> **SUPERSEDED.** This section is the *audit* that opened the premium visual pass:
> the defects as they were measured before any of them were fixed. It is kept
> verbatim because the measurements are the evidence the fixes are judged against —
> **do not read its "Status", "What is NOT yet verified" or "Next session" text as
> current.** Every defect below is now implemented and verified; see
> **"Premium Visual Pass + History Wiring — IMPLEMENTED FIXES"** and
> **"FINAL VERIFICATION"** at the end of this file.

### Status (AS AT THE AUDIT — no longer true)

**This phase is OPEN.** The audit ran, produced measured ground truth, and found
three real defects. **No product code was changed.** The session ended before the
implementation, verification and gate stages, because the subagents dispatched for
the spacing/typography and z-index/focus source audits both terminated on an
infrastructure error (`API Error: 402 Insufficient credits`), and the remaining
budget was better spent recording reproducible evidence than starting edits that
could not then be verified or gated.

What follows is therefore **evidence, not a closure claim**. Every number below was
measured in a real browser against the shipped build.

**Nothing was regressed:** `components/`, `app/`, `lib/` and `src/` are byte-for-byte
unchanged (verified by mtime scan). The only new files are one probe and this
section, plus screenshots and two JSON measurement dumps.

### Ground truth

Baseline measured via `scripts/editor-audit.mjs` across the 8 audit widths, then
independently re-measured by the new probe. Both agree.

| Viewport | Canvas | Left rail | Inspector | Toolbar | Page overflow | Console |
|---|---|---|---|---|---|---|
| 1920x1080 | 1424 (74%) | 176 | 320 | 10 labelled | none | 0 |
| 1600x900 | 1104 (69%) | 176 | 320 | 10 labelled | none | 0 |
| 1440x900 | 944 (66%) | 176 | 320 | 10 labelled | none | 0 |
| 1366x768 | 870 (64%) | 176 | 320 | 10 labelled | none | 0 |
| 1280x720 | 784 (61%) | 176 | 320 | 15 icon-only | none | 0 |
| 1024x768 | 848 (83%) | 176 | drawer | 8 icon-only | none | 0 |
| 768x1024 | 592 (77%) | 176 | drawer | 8 icon-only | none | 0 |
| 390x844 | 390 (100%) | 0 | drawer | 8 icon-only | none | 0 |

Confirmed intact and **not** defects: no page-level horizontal overflow at any of
the 8 widths; the docked Inspector is exactly 320px and never scrolls horizontally
(inner scroll-x count 0); the capsule is centred on the canvas to within 0px at
every width and clears the status bar by 12px at every width; the context toolbar
stays inside the viewport at a page corner and never overlaps the dock; every
on-screen keyboard stop paints a visible focus indicator (26 stops tabbed); zero
unexplained console errors across the entire run.

### Defects found

#### P0-1 — Widening the viewport shrinks the canvas by 319px at the dock breakpoint

The invariant `editorPanelLayout.ts` names as the one rule "kept verbatim, because
it was a real bug fixed at real cost" — *widening the window must never shrink the
canvas* — **is violated in the shipped build.**

Measured canvas width across the breakpoint:

```
1150:974  1180:1004  1199:1023  |  1200:704  1240:744  1280:784  1340:844  1440:944
                                 ^^^^^^^^^^^ 1199 -> 1200 loses 319px
```

The canvas does not recover its 1199px width until roughly **1520px** of viewport.

Why the existing guard missed it: `editorPanelLayout.test.ts:91` asserts the
property over the **docked panel count** (0 or 1, monotonic), and that assertion is
true. But the user experiences **pixels**, and a 320px dock arriving at full width
the instant the breakpoint is crossed takes 320px while the viewport gained 1px.
The module's claim that a single dock makes the inversion "structurally impossible"
holds for the count and not for the geometry. This is the same class of error the
Phase H/I notes warn about — a guard that measures a proxy instead of the property.

#### P0-2 — The bottom capsule is fully operable through a modal drawer's scrim

At 1024px the Inspector opens as `role="dialog" aria-modal="true"` with a focus
trap and a scrim. The capsule remains clickable **through** the scrim.

Proven by interaction, not by reading z-index: with the drawer open and focus
trapped inside it, a real CDP click on the capsule's "Zoom in" button moved the
document from **100% to 125%**, and the drawer stayed open.

```
scrim   z-20   (absolute inset-0 bg-navy/20)
drawer  z-30   (absolute inset-y-0 right-0, aria-modal)
capsule z-30   <- its wrapper in PremiumEditorFrame, a sibling of neither
```

The capsule wrapper sits at `z-30` inside `<main>`, which is not the scrim's
stacking context, so it ties the drawer and outranks the scrim. A control that
looks live and mutates the document while a modal owns focus is a genuine
interaction defect, and `aria-modal="true"` is a false promise to assistive tech.

#### P1-3 — Five of eight tools are invisible and unreachable at 390px

The compact tool row degrades into an `overflow-x-auto scrollbar-none` scroller.
Measured at 390px: **178px of viewport over 407px of content**.

```
390px  visible 3/8  (Select, Hand, Text)  — hidden: Image, Rectangle, Ellipse, Draw, Eraser
360px  visible 3/8   229px of tools off-screen
414px  visible 4/8
768px  visible 8/8   (fits)
```

The hidden five are **priority-1 inline** tools, so `More` does not contain them —
`overflowTools` only collects priority > mode cut. They are in the DOM and
keyboard-reachable, but there is no visible affordance indicating the row scrolls
(`scrollbar-none`), so the editor reads as having exactly three tools on a phone.
`toolbarLayout.ts` documents this scroll as "the honest degradation"; measurement
shows it is silent, which is the opposite of honest.

#### P2-4 — Left rail tab labels are clipped (minor)

"Layers" and "History" are clipped in the 176px rail: client 43px vs scroll 47px
and 50px. The code comment at `EditorWorkspace.tsx` asserts all three "fit at 12px
in a 176px rail — measured, not assumed"; that is no longer true, most likely
because the collapse button was added to the same row afterwards.

Measured candidate geometries (rail width / collapse-button width / tab padding):

```
176 / 32 / 4  -> clipped: Layers, History   (SHIPPED)
176 / 28 / 2  -> clipped: History
176 / 32 / 2  -> clipped: History
180 / 28 / 2  -> clipped: none
176 / none    -> clipped: none
```

A fix exists that costs the canvas nothing, but it is cosmetic and correctly ranks
below the two P0s.

#### Dead code found — `resolveLeftRailWidth` is never called

`editorPanelLayout.ts:171` exports `resolveLeftRailWidth`, which steps the rail
184 -> 160 -> 148 as width gets scarce, and `editorPanelLayout.test.ts:187-204`
pins it with 12 assertions. **No product code calls it** (verified by repo-wide
grep); the rail is hardcoded `w-[176px]` in `EditorWorkspace.tsx:919`, a width the
function never returns. So 12 green assertions describe behaviour the user cannot
reach — and this function is also the natural remedy for P0-1, since stepping the
rail down at the breakpoint is exactly the compensation the canvas needs.

### Browser evidence

New probe: `scripts/editor-final-visual-probe.mjs` — 45 checks, **44 pass, 1 fail**
(f01, the canvas inversion). Gates are measurements and semantic assertions only;
no aesthetic judgement is encoded as a number.

Two harness defects were found and fixed in the probe itself, per the established
PRODUCT vs PROBE discipline:

- Attaching to the browser endpoint from `/json/version` instead of the **page**
  target from `/json/list` left `Runtime.evaluate` with no execution context, which
  presented as a product that never hydrated. Fixed to match the working probes.
- The f03 layering check read `zIndex` from the capsule element (`auto`) rather than
  its positioned wrapper (`z-30`), so it passed while testing nothing. **This check
  is still wrong in the committed probe** and must be repointed at the wrapper — the
  defect it should have caught was instead proven by the separate click experiment.

### Screenshot evidence

Ten files in `docs/screenshots/p1-final/`: `01-editor-1920` ... `08-editor-390`,
`20-context-toolbar-edge`, `21-drawer-open-1024`.

**HUMAN VISUAL REVIEW REQUIRED.** This environment could not decode the PNGs — the
Read tool returned no image for valid files (verified: correct PNG signature,
104,782 bytes). So **no aesthetic claim is made** about any surface: not canvas
dominance, page shadow, typography, colour, depth or density. Everything asserted
above is geometry or semantics. The remaining 10 planned screenshots (09-19) were
not captured.

### What is NOT yet verified (AS AT THE AUDIT — superseded by FINAL VERIFICATION)

No fixes were implemented, so none of the closure gates were run: Prisma
validate/generate, typecheck, lint, production build, post-build Vitest and
`publicBundles` were **all skipped**, and the existing Phase H/I/J probes were not
re-run (no changes existed to regress them). The test baseline is untouched at
205 files / 3987 tests.

Audit areas covered by measurement: top bar overflow, toolbar overflow/reachability,
left rail, canvas geometry, context toolbar clamping, Inspector width/stability,
bottom controls, responsive behaviour at all 8 widths, focus visibility, page-level
overflow, layering. Audit areas **not** covered: document tabs with many/long
filenames (the workbench tab strip needs a multi-document Workspace fixture, and
the standalone `/editor` route has no tab strip), selection chrome across all five
object kinds, Comments/Versions long-content wrapping, loading/error state visuals,
and the whole of the spacing/typography/colour review — the two subagents assigned
to the source-level spacing and z-index/focus audits died on the 402 error.

### Next session — ordered plan (ALL ITEMS NOW DONE — see the closure section)

1. **Fix P0-1.** Wire `resolveLeftRailWidth` into `EditorWorkspace` (it already
   exists and is tested), and/or stage the dock so crossing 1200px does not cost
   320px at once. Then **replace the proxy assertion** in
   `editorPanelLayout.test.ts:91` with one over predicted canvas pixels, and add
   the probe's f01 measurement as the browser-level guard. Mutation-test both.
2. **Fix P0-2.** Suppress or lower the capsule while a modal drawer is open — the
   capsule's own controls are meaningless when the canvas is scrimmed. Re-point the
   probe's f03 at the wrapper element and re-run the click experiment as the guard.
3. **Fix P1-3.** Give the 390px row an honest affordance: either move surplus tools
   into `More` at compact width, or make the scroll visible. Guard with the probe's
   f02 (already written and currently passing only because it tolerates
   `overflowX: auto`).
4. Optionally fix P2-4 (rail tab clipping) — `180 / 28 / 2` measured clean.
5. Re-run: the new probe, then `editor-bottom-controls-probe`,
   `editor-inspector-probe`, `editor-inspector-states-probe`,
   `editor-load-states-probe`, and the P0/source-text/context-toolbar probes.
6. Capture screenshots 09-19; run the full gate chain (Prisma, typecheck with
   `NODE_OPTIONS=--max-old-space-size=6144`, lint, `node scripts/next-build.js`,
   then `npx vitest run` **after** the build so `publicBundles` executes).
7. Complete the untouched audit areas listed above before claiming closure.

---

## Premium Visual Pass + History Wiring — IMPLEMENTED FIXES

**Status: CLOSED.** Everything in the audit section above is implemented and
browser-verified. This section is what changed; the next one is how it was proven.

### History wiring (the panel that displayed nothing)

`HistoryPanel` had a `historyLabels` prop it never rendered — the panel showed
generic rows while the labels the command layer already produced were dropped on
the floor.

- New pure module `components/editor/panels/historyPanelRows.ts` decides the row
  model: label resolution, the "Current" marker, the redo-able tail, and the
  clamp that keeps a long history bounded. **17 tests** in
  `historyPanelRows.test.ts`, Node-only, no DOM.
- `HistoryPanel.tsx` rewritten to render from that model.
- Browser evidence at 1600x900 after a real rectangle drag, a real move and a
  real text insert: rows read `["Added object", "Moved", "Added object",
  "Current"]`, `aria-selected="true"` on the History tab, 4 rows.

### The four audited defects

| Audit id | Fix |
|---|---|
| **P0-1** canvas inversion (1199 -> 1200 lost 319px) | `components/editor/canvasGeometry.ts` — a real-bound geometry module. The guard is now over **predicted canvas pixels**, not the docked-panel count proxy. `canvasGeometry.test.ts` pins monotonicity; `editor-responsive-probe` proves it in Chrome across 19 widths. |
| **P0-2** capsule operable through the modal scrim | The capsule is suppressed while a modal drawer owns focus. The probe check was re-pointed at the positioned **wrapper** (the old check read `zIndex: auto` off the inner element and passed while testing nothing). |
| **P1-3** 5 of 8 tools unreachable at 390px | The compact row's overflow is honest: 277px of hidden tools are reported by the probe as a measured scroll, the row is clustered, and no priority-1 tool is silently stranded. Verified at 390px in `editor-final-visual-probe` (`hiddenTools=277px`, no page-level overflow). |
| **P2-4** rail tab labels clipped | `LEFT_RAIL_WIDTH` **176 -> 180**, the geometry the audit measured clean (`180 / 28 / 2 -> clipped: none`). The test that encoded 176 was repaired, not deleted. |

`resolveLeftRailWidth` — the dead export the audit found — is no longer the
remedy for P0-1; `canvasGeometry` is, and it is called.

### The 15 approved premium findings

- **P1 toolbar** — one control rhythm from a single `rowControlBox()` (38px
  labelled / 44px icon modes), one disabled treatment (`opacity-40`, was two
  strengths), and a hover response on the active tool and the pressed toggle.
  Locked by `toolbarChrome.test.ts`.
- **P2 app bar** — token-driven chrome; logic extracted to `appBarLogic` (4 tests).
- **P3 canvas** — page-dominant surface, real page shadow, ruler alignment.
- **P4 left rail** — see P2-4 above, plus the label-truncation remedy below.
- **P5 Inspector rhythm** — shared control system, section spacing, and the
  Inspector **fit repair** (it no longer overflows its 320px dock).
- **P6 selection chrome** — 21 tests in `selectionChrome.ts`. The drag-core
  finding: the selection frame's own body was swallowing drags aimed at the
  object, so the chrome had to be made non-interactive except at its handles.
- **P7 text** — `textEditorGeometry` (19 tests). The baseline-alignment finding:
  the live editor's text baseline did not sit where the committed glyph would,
  so the caret jumped on commit. **Source-PDF text stays read-only.**
- **P7 image** — aspect handling via `aspectConstraint` (8 tests) and a real
  aspect-lock toggle in the Inspector (`Lock aspect ratio`, `aria-pressed`).
- **P8 accent hierarchy** — audited and locked: exactly **one** filled control in
  the row (Export), pale accent for the active tool, neutral for a pressed panel
  toggle, and no third "selected" look in menus.
- **Annotation wedge** — the wedge that made an annotation un-hittable is fixed.
- **Tailwind editor tokens** — `accent/accenthover/accentsoft/subtle/border/
  borderstrong/text/muted` + the radius scale, so the pass changed tokens rather
  than sprinkling hex.
- **Toolbar clustering** — 11 shapes and 3 draw tools collapse into 2 labelled
  cluster triggers; the zoom stepper and preset moved to the bottom capsule.
- **`TransformService`** +8 tests.
- **Bottom capsule** — deliberately **NOT** redesigned. It is the benchmark the
  rest of the pass was measured against.

### The toolbar overlap — the flex-in-scroller invariant

Measured, not hypothesised: the `role="toolbar"` row carried `min-w-0` inside an
`overflow-x-auto` scroller, so it **shrank below its own content while its own
`overflow-x` stayed `visible`**. At 1100px the row's box was 700.7px around 761px
of buttons. The scroller read the shrunken box, saw `scrollWidth === clientWidth`,
offered no scrollbar, and laid the later siblings **on top of** the spilled
content: "Crop image tool" occupied x 729-773 with "Organize pages" at x
725.7-769.7 directly over it, and DOM hit-testing gives ties to the later
sibling — so **clicking Crop opened the Pages panel**.

> **Invariant:** children of a scroller must be `shrink-0`. Only the scroller
> itself may be `min-w-0 flex-1`.

Three tests in `toolbarChrome.test.ts` hold it, including one that catches a
*third* group being added without `shrink-0`.

### P4's other half — no silent ellipsis on primary navigation

The labelled row overflowed from 1290px to about 1440px and clipped **"Organize
Pages"** 63px mid-word at 1366px — a flagship width for this redesign — reachable
only by scrolling the toolbar sideways.

The remedy allowed was "readable labels where width permits, **or** icon +
tooltip", never an ellipsis. This control takes the second branch, because it is
the only non-tool control in the row and the same command is reachable from the
rail's Pages tab and the capsule's page-overview toggle. `title` + `aria-label`
keep it named.

Measured consequence — the label was 139.8px, the widest control in the row:

```
labelled scroller content   1162px  ->  1060.3px   (-101.8px)
scroller float width      = container - 267.3px    (pinned cluster + gaps)
  1324 -> 1056.7  over by 3.6      1327 -> 1059.7  over by 0.6
  1325 -> 1057.7  over by 2.6      1328 -> 1060.7  FITS
  1326 -> 1058.7  over by 1.6      1330 -> 1062.7  fits
TOOLBAR_TABLET_MAX_WIDTH    1290  ->  1328
```

**The 1290 was a fiction** — derived from the same arithmetic an earlier
CORRECTION in `toolbarLayout.ts` already disowns (the 114px error). 1328 is the
first width that fits on **float** `getBoundingClientRect` geometry;
`clientWidth`/`scrollWidth` are integers by spec and cannot judge a 0.6px miss.

`ToolMenu`'s `flex-1 truncate` is deliberately exempt and measured never to fire:
with all three menus open at 1024/1100/1366/1600px the widest item ("Rounded
rectangle") reports `scrollWidth 152` against `clientWidth 152` — nothing clipped
in menus of 2, 3, 7, 11 or 14 items, and a menu can grow its own width where a
pinned row cannot.

---

## FINAL VERIFICATION

### Probes — 10 of 10 green, all re-run against a live server

| Probe | Result |
|---|---|
| `editor-shape-draw-probe --shots` | **46 PASS / 0 FAIL**, 0 console errors |
| `editor-responsive-probe` | ALL CHECKS PASSED, monotonic over 19 widths |
| `editor-final-visual-probe` | ALL CHECKS PASSED, 0 console errors |
| `editor-bottom-controls-probe` | ALL CHECKS PASSED |
| `editor-inspector-probe` | ALL CHECKS PASSED |
| `editor-inspector-states-probe` | 71 PASS, ALL CHECKS PASSED |
| `editor-load-states-probe` | 100 PASS, ALL CHECKS PASSED (12 console messages: 11 while a rule was armed, 1 probe-induced, **0 unexplained**) |
| `editor-object-toolbar-probe` | 19 PASS, ALL PASS |
| `editor-p0-probe` | 12 PASS, ALL PASS |
| `editor-source-text-probe` | 14 PASS, ALL PASS |

Responsive table from `editor-final-visual-probe` (canvas / rail / inspector /
hidden tools), with no page-level horizontal overflow at any width:

```
1920 canvas=1420 rail=180 inspector=320 hiddenTools=  0px
1600 canvas=1100 rail=180 inspector=320 hiddenTools=  0px
1440 canvas= 940 rail=180 inspector=320 hiddenTools=  0px
1366 canvas= 866 rail=180 inspector=320 hiddenTools=  0px
1280 canvas= 780 rail=180 inspector=320 hiddenTools=  0px
1024 canvas= 844 rail=180 inspector=  0 hiddenTools=  0px
 768 canvas= 588 rail=180 inspector=  0 hiddenTools=  0px
 390 canvas= 390 rail=  0 inspector=  0 hiddenTools=277px
```

Toolbar sweep across 17 widths (390 -> 1920), each rect **intersected with the
scroller box** before overlap testing: **ALL WIDTHS PASS**, 0 console errors. The
boundary, live: at 1327 the row is 533px of icons in a 1042px scroller; at 1328 it
is 1009.3px of labels in a 1061px scroller — no overlap, hit-test lands on the
intended tool.

### Two probe hazards worth keeping

1. **Vacuous green.** A dead dev server returns `curl` **000** and every
   measurement reads zero or undefined, which passes trivially. This session hit
   it for real — the machine rebooted mid-work, killing the server and wiping
   `/tmp` — and the `curl -s -o /dev/null -w "%{http_code}"` precheck caught it.
   Reject any green whose numbers are all zero.
2. **Clipped rects.** `getBoundingClientRect` returns **layout** rects for content
   a scroller clips, so a partly scrolled-out tool keeps a rect reaching under the
   pinned cluster. *Filtering* in-scroller controls is not enough — a false 22px
   "Image tool x Undo" overlap at 390px came from exactly that. **Intersect**
   each in-scroller rect with the scroller box.

Also: CDP `dispatchKeyEvent` needs `code` as a **string** (`"Escape"`) with the
numeric code in `windowsVirtualKeyCode`. Passing a number as `code` dispatches
nothing and reads as a product bug.

### Screenshots — 25 files in `docs/screenshots/p1-final/`

Responsive: `01-editor-1920` ... `08-editor-390`. Context: `20-context-toolbar-edge`,
`21-drawer-open-1024`. Shape/draw states (9): `shape-menu`, `shape-drag-preview`,
`shape-created`, `shape-selected`, `shape-click-default`, `draw-menu`,
`draw-active`, `draw-stroke-preview`, `draw-selected`. Premium states (6):
`toolbar-premium`, `text-editing-premium`, `properties-premium`, `history-premium`,
`pages-premium`, `image-selected-premium`.

All captured through **real CDP interaction** — shapes dragged, text typed, tabs
clicked — with the measured state printed beside each capture, e.g.
`text editing state: {"editor":"textarea","value":"Premium pass","objects":2,
"active":"textarea"}` and `properties state: {"tabSelected":"true","controls":18,
"sections":["Shape","Shape","Shadow","Position & size","Appearance"]}`. Nothing
was staged in the DOM.

**Honest note:** `shape-created.png` and `shape-selected.png` are byte-identical
(`cmp` reports IDENTICAL). That is not fabrication and not a defect — creating a
shape leaves it selected, so both probe hooks render the same state.

The audit section's "screenshots 09-19 not captured" is obsolete: those slot
numbers were never allocated by any probe. The named states above occupy them.

### Gates — run in the required order

| # | Gate | Result |
|---|---|---|
| 1 | `npx prisma validate` | valid, exit 0 |
| 2 | `npx prisma generate` | Prisma Client v6.19.3 generated, exit 0 |
| 3 | `NODE_OPTIONS=--max-old-space-size=6144 npm run typecheck` | **exit 0** (re-run after the lint fixes, so the chain is honest) |
| 4 | `npm run lint` | **exit 0 — 0 errors**, 5 pre-existing warn-level unused-vars |
| 5 | `node scripts/next-build.js` | Compiled successfully in 5.7s, exit 0 |
| 6 | `npx vitest run` **(after the build)** | **215 files / 4197 tests / 0 failed / 0 skipped** |

`lib/seo/publicBundles.test.ts` was confirmed to **execute**, not merely collect —
it names the built manifests it inspects and asserts per public route that
`pdfjs-dist`, `components/editor`, `components/workspaces`, `components/app`,
`src/application/editor` and `components/admin` stay out of the client bundle.
Those assertions require `.next` to exist, which is why vitest runs last.

Baseline was 210 files / 4086 tests. Net **+5 files / +111 tests**, no decrease.
Audited clean: **zero** `.skip` / `.only` / `.todo`, zero `xit`/`xdescribe`, zero
`@ts-ignore` / `@ts-nocheck`, and the only `eslint-disable` string left in the
repo is prose inside a comment explaining why a directive is *absent*.

Three lint **errors** were fixed properly rather than suppressed: `Buffer` added
to the `/* global */` declaration of two probe scripts that legitimately use it,
and a dead `eslint-disable-next-line react-hooks/exhaustive-deps` in
`hooks/editor/useEditorPanels.ts` replaced with prose — this config does not
install the react-hooks plugin, and a directive naming an unregistered rule is
itself an ESLint error.

Two earlier test repairs stand and must not be reverted: `toolbarLayout.test.ts`
(compact MUST cluster) and `shapeCreationPersistence.test.ts` (an explicit 30s
budget for pdf-lib's one-time init, **assertions unchanged**).

### Deliberate deviations (P8), reported rather than "fixed"

- Organize Pages renders `aria-pressed="true"` in the **neutral** tier
  `rgb(248,250,252)`, while the bottom capsule's pressed toggles use the
  **subtle accent** tier `rgb(243,238,255)`. Unifying them would either
  redesign the capsule (forbidden — it is the benchmark) or re-open the
  false-Select-active fix, which deliberately made "panel open" visually
  distinct from "tool active".
- Hover on an inactive tool is neutral grey, not accent-soft, so a hovered
  inactive tool can never read as active. That asymmetry is intentional.
- `components/workspaces/CommentsPanel.tsx` stays on the shadcn-style workspace
  token set by **scope decision** (Workspace P2 is out of scope). This is what
  produces the 27px/44px control histograms on the Comments and Versions
  Inspector states rather than the editor's own 32-36px rhythm.

### Limitations

- **No aesthetic claim is made by any probe.** Every number here is geometry or
  semantics. The 25 screenshots are evidence for human review.
- Continuous multi-page scrolling is **not** started (explicitly out of scope).
- Workspace P2, M8 and AI features are untouched. No AI Assistant, Add Link,
  Redact, Underline, Justify, Preview or Compare was added — `editor-inspector-probe`
  asserts the absence of Underline and Justify rather than assuming it.
- The document tab strip with many/long filenames is still unmeasured: the
  standalone `/editor` route has no tab strip, and a multi-document Workspace
  fixture would be needed.

### Environment

Node 26.7.0 (homebrew), deps via `npm ci`, Chrome for Testing 152.0.7977.54, dev
server `npm run dev -- --port 3001`. macOS, so the Windows caveat about a running
server locking the Prisma query-engine DLL does not apply; no processes were
killed. The machine rebooted mid-session, which wiped `/tmp` — so all throwaway
diagnostics from before the reboot are genuinely gone, and the ones written after
it were deleted at the end of the session. **No temp diagnostic was ever written
into the repo.**

Probes that need auth use the dedicated fixture account
`h-probe-1786967556505@pdfdadi.test` (workspace `cmsx6cfcg000hwh6syaf69ajx`, org
`cmsx6cfc6000fwh6supsubtj3`, document `cmsx6cnsi000nwh6sh9ywgh2k`). Its session
token was re-minted for this run and **deleted afterwards**. No real user data was
touched.
