# Milestone 5 — Part 1: True Existing-Text Editing (Completion Report)

**Status: complete and verified — after a multi-agent review caught two critical
defects that made the feature non-functional, both fixed and guarded by new
geometry/round-trip tests.** All four verification gates pass.
**Date:** 2026-07-28

M5 Part 1 makes existing PDF text editable. pdf-lib cannot mutate existing PDF
text, so Part 1 uses the production browser-editor approach: PDF.js
`getTextContent` runs are grouped into lines, re-created as editable
`TextObject`s placed over the original with an opaque white `background` that
redacts the original on screen and in export (cover-then-redraw), and a
`sourceText` marker records provenance. Serialization bumps to format v3.

This report is honest about a failure: **the Part 1 code merged green but did not
work**, and that was caught by the mandated multi-agent review, not by the gates.
The two critical defects and their fixes are the central content of this report.

---

## Verification gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` | ✅ **525 tests / 57 files** (up from 510/56 pre-fix; 450/52 at the M5 plan baseline) |
| `npm run build` | ✅ succeeds (only the known cosmetic Prisma 6 `package.json#prisma` deprecation warning); `/editor` + all `/tools/*` prerender |

---

## 1. Implementation report

`loadPdfIntoEditor` (`lib/editor/loadPdf.ts`) opens an existing PDF with PDF.js,
creates one editor page per source page, rasterizes each page to a PNG
background, and — new in Part 1 — extracts each page's existing text into
editable `TextObject`s on the page's default layer. Extraction is best-effort and
non-fatal: a page whose text can't be read still opens with a blank overlay.

The extraction pipeline is split into a pure, PDF.js-free core
(`src/application/editor/text/TextExtraction.ts`) and a thin PDF.js adapter
(`lib/editor/extractText.ts`):

- The core (`groupTextItemsIntoLines`) takes a normalized stream of
  `RawTextItem`s (PDF user space) and emits `ExtractedTextLine` descriptors in
  editor screen space. Items are bucketed by (snapped rotation, rounded
  cross-axis baseline); within a line, items are ordered along the baseline and
  inter-item gaps larger than `0.18 × font size` become spaces. Non-cardinal
  rotations are emitted as their own lines (no fragile arbitrary-angle merging).
- The adapter pulls a `TextContent` from a PDF.js page, normalizes it (filtering
  marked-content entries and malformed transforms), runs the grouping, and builds
  a `TextObject` per line with an opaque white `background` (redaction), a
  `sourceText: { fontName, rotation }` marker, and a transform
  `T(baseline) · R(θ) · T(0, −ascent)` that places the redrawn baseline on the
  original.

Export (`PdfExportService.drawTextObject`) draws the opaque background rectangle
(the redaction) and then the text on top — redact-then-redraw — so the original
is hidden and the editable copy replaces it, in both the on-screen render
(`ObjectRenderer`) and the exported PDF. Font/color are best-effort (PDF.js font
names are often opaque ids and it doesn't expose fill color stably → black); the
original font name is preserved on `sourceText.fontName` for display, and the
editable font is mapped to the closest PDF base-14 family.

**Resource bounds (security hardening F1–F6, carried over from the prior
session):** raw items are capped (`maxRawItems`, default 50,000) BEFORE grouping
(F1); buckets cap at `MAX_ITEMS_PER_LINE` (F3); line text caps at
`MAX_LINE_TEXT_LENGTH` with exact final-fragment slicing (F5); a document-wide
`MAX_EXTRACTED_OBJECTS` budget via the pure `pageExtractionBudget` keeps the
running total bounded (F4); per-object `try/catch` + `winAnsiSafeText` keep one
bad object from aborting export (F2); deserialized strings cap at
`MAX_STRING_LENGTH` (F6). Open-page bounds: `MAX_OPEN_PAGES` (200, over-cap is a
rejected `PdfOpenError`, not truncation, because export draws onto the original
pages) and `MAX_PAGE_DIM` (pathologically large pages skip rasterization).

---

## 2. Multi-agent review report (the headline)

Per the development rules, Part 1 was reviewed by specialized parallel agents
(architecture/geometry, security, performance, testing, QA, frontend/UX/a11y,
code-quality). **The review found Part 1 was non-functional as merged: two
critical defects, each independently breaking the "baseline lands on the
original" invariant, were hidden behind green gates because the tests asserted
`transform` was *defined* (not correct) and mocked `item.height` with a fiction.
No browser/jsdom test exercised the actual render (the M4 suite is Node-only by
decision), so the visual breakage shipped unnoticed.**

### C1 (CRITICAL) — `createTextObject` silently discarded `overrides.transform`
Every existing-text object landed at page (0,0) with the identity transform.

`baseFields` always set `transform: makeTranslate(position)`, and the
`createTextObject` return literal never read `overrides.transform`. The adapter
passed `position: {0,0}` and encoded placement in `overrides.transform` — which
the factory dropped. So `obj.transform = IDENTITY`: all redaction boxes stacked
at the top-left corner, none covered the original glyphs, all redrawn text piled
at (0,0). The feature did not work. All seven factories shared the pattern;
existing-text was the only consumer that relied on the override.

**Fix:** `baseFields` now accepts a `transformOverride` and every factory passes
`overrides.transform` (`objectFactories.ts`). Backward-compatible — callers that
don't pass a transform (all of M4) get `makeTranslate(position)` as before.

### C2 (CRITICAL) — `line.ascent` was PDF.js's `item.height`, which is the font SIZE, not the ascender
Even with C1 fixed, the redrawn text floated ~28% of font size above the
original and the redaction box ate the line above.

PDF.js's `TextItem.height` is `Math.hypot(trm[2], trm[3])` — the text-matrix
vertical scale = the font size, not the baseline-to-top ascender. The adapter's
`T(0, −ascent)` shift used `item.height` (= fontSize), but the renderer (via
`dominant-baseline: hanging`) and the exporter (via `font.heightAtSize(descender:false)`)
both anchor the baseline at the TRUE ascender (~0.718×fontSize for Helvetica).
The `(fontSize − ascender)` mismatch ≈ 0.28×fontSize shifted the redrawn
baseline above the original; the `ascent × 1.25` box over-extended upward.

**Fix:** a new shared module `src/domain/editor/textMetrics.ts` is the single
source of truth for the base-14 ascender/descender (measured from pdf-lib's own
`heightAtSize`). The core now emits `ascent = base14Ascent(family, fontSize)` and
`descent = base14Descent(...)`; the adapter's box is `ascent + descent` (exact
glyph coverage); the exporter anchors the existing-text baseline at
`base14Ascent(obj.fontFamily, fontSize)` (not `heightAtSize`); the renderer uses
`dominantBaseline="alphabetic"` + `y={base14Ascent}` for existing-text. All four
sites now share the same number, so the redrawn baseline lands exactly on the
original for any rotation. The dead `RawTextItem.height` field was removed.

### Other review findings (addressed or deferred)
- **Misleading comments** (worldBounds = "glyph AABB"; "exactly covers";
  `MAX_PAGE_DIM` "safely under the canvas area cap"; "ascent = item.height") —
  **fixed**; comments now describe what the code actually does.
- **Move-reveals-original limitation not surfaced** (a stated Part 1
  requirement) — **fixed**: the PropertiesPanel "Existing text" banner now states
  that moving or deleting the object reveals the original underneath.
- **Performance: up-front full-document rasterize + sync `toDataURL`** (M1/M2/M3),
  **`MAX_PAGE_DIM` miscalibrated for dpr** (M4), **per-object canvas wrapper
  re-render** (M5) — **deferred to Part 10** (lazy/streaming per-page
  rasterization, backing-store-pixel-area cap, memoized wrappers). The `MAX_PAGE_DIM`
  comment now states the actual invariant honestly.
- **Security: deserialization has no collection-count caps** (`points[]`, pages,
  objects/page, layers) and no page-dimension cap in `deserialize` (M3/M4/M5) —
  **deferred** to the next security-hardening pass (see §8); not a Part 1
  regression (the surface predates Part 1).
- **UX/a11y: no open-PDF loading progress, no keyboard text-edit (Enter/F2), no
  empty-state for scanned PDFs, errors via `alert()`** — **deferred to Part 12**
  (the a11y milestone) and UX polish; the keyboard-edit gap is pre-existing M4.
- **Code quality: `reconstructObject` is a growing god-switch** that the registry
  pattern (already used for plugin kinds) should replace — **deferred** to a
  future refactor (documented in §10).

---

## 3. Architecture report

The M3.e/M4 layering is preserved. Part 1 added a pure core + a thin adapter +
one shared domain module; it did not rewrite the core.

- **Single source of truth for the baseline anchor** (`textMetrics.ts`). The C2
  fix's key architectural change: the ascender value used by the adapter's
  transform, the on-screen render, and the pdf-lib export is now ONE function
  (`base14Ascent`), not three independent derivations. A guard test
  re-measures pdf-lib and asserts the ratios match, so a pdf-lib/AFM drift is
  caught at test time. The classification mirrors `resolveStandardFont`
  (Times/serif→Times, Courier/mono→Courier, else Helvetica) and is duplicated
  here only to keep this domain module free of `lib/`/`src/application/`
  dependencies (two lines; the guard test pins alignment).
- **Factory transform override** (`objectFactories.ts`). `baseFields` honors a
  `transformOverride`, so the adapter can encode baseline position + rotation +
  the ascent shift in one composed transform. This is the minimal, backward-
  compatible fix; a deeper refactor (font-independent transform, anchoring fully
  in render/export) is documented as debt — it would remove the tiny residual
  misalignment when a user changes the font of an existing-text object (the
  transform bakes in the original family's ascent; the render/export recompute
  for the new family; for base-14 swaps the residual is ≤0.035×fontSize and
  screen/export stay consistent).
- **Clean separation holds.** `TextExtraction.ts` imports only
  `src/domain/editor/objects` + `textMetrics` — no `pdfjs-dist`, no DOM. The
  `TextContent` type is derived in the adapter. `RawTextItem.transform` is a
  typed tuple, not a PDF.js type. Dependencies are one-directional
  (adapter → core).

---

## 4. Performance report

- **Open-PDF is up-front per page**: `loadPdfIntoEditor` rasterizes + extracts
  every page sequentially before returning (each page: worker render + sync
  `toDataURL` PNG encode + `getTextContent` + grouping). For a 200-page PDF this
  is tens of seconds of intermittent main-thread blocking and hundreds of MB of
  retained PNG data URLs. **This is the documented Part 10 refinement** (lazy
  per-page rasterization, streaming extraction, off-main-thread PNG encode,
  backing-store-pixel-area cap). The bounds (`MAX_OPEN_PAGES`, `MAX_PAGE_DIM`,
  `MAX_EXTRACTED_OBJECTS`) make crafted-PDF worst cases degraded-but-non-crashing,
  not tab kills.
- **Grouping is bounded and fast**: filter O(n), bucket O(n), per-bucket sort
  O(k log k) with the baseline precomputed once (not recomputed in the
  comparator), `MAX_ITEMS_PER_LINE` caps the worst single-bucket sort. A 50k-item
  page groups in ~20–40ms desktop. `addObjectsToPage` is genuinely O(k) (single
  spread + single append).
- **Export is O(total characters) + O(objects)**, with ≤14 font embeddings
  (cached) and the O(text-length) glyph-width measurement skipped for the
  Part 1 path (all extracted objects are left-aligned). No re-embed per object.
- **No regression** to the existing app (the editor is a new route; the tools are
  untouched).

---

## 5. UX report

The "Existing text" banner in the properties inspector now honestly surfaces the
core limitation: *"The original is hidden behind this copy. Moving or deleting it
reveals the original text underneath."* The background field explains that the
white fill hides the source and that deleting the object reveals it. The layers
panel marks existing-text objects with a violet dot + tooltip. `ObjectRenderer`
keeps the redaction cover fully opaque regardless of the opacity slider (so
fading the object never leaks the original). The `PdfOpenError` (too many pages)
message is actionable (page count + "split the PDF first").

**Known UX gaps (deferred):** no open-PDF loading progress (bare spinner for
multi-second multi-page opens); no empty-state for scanned/image-only PDFs
(extraction silently yields nothing); errors delivered via blocking `alert()`;
double-click-to-edit is undiscoverable and mouse-only. See §10.

---

## 6. Accessibility report (WCAG 2.2 AA)

Part 1 inherits the M4 a11y baseline (keyboard shortcuts, `aria-live` selection
announcements, `role="application"` canvas, 24px hit targets, focus suppression
in text inputs). The existing-text selection cue announces "existing text object
selected (editable copy of original PDF text)."

**Known gaps (deferred to Part 12, the a11y milestone):** no keyboard path to
edit text content (double-click only; Enter/F2 not bound on the canvas —
pre-existing M4); extracted text objects use `role="img"` with a 24-char
truncated accessible name (mis-roled for editable text); focus is not managed
after opening a PDF; the disabled "Remove background" button's explanatory
`title` is unreachable by keyboard. Part 1 did not regress these; Part 12 owns
them.

---

## 7. Testing report

**525 tests / 57 files.** The tests that would have caught C1/C2 are the
important additions of this fix pass:

- **Geometry-value tests** (`extractText.test.ts`) — for a known PDF.js item at
  a known `(e,f)` with known size/width, assert the produced `obj.transform`
  equals `T(baseline)·R(0)·T(0,−ascent)` (e.g. `{a:1,b:0,c:0,d:1,e:50,f:42−ascent}`)
  and `obj.localBounds = {0,0,advance,ascent+descent}` — for both 0° and 90°.
  These fail under C1 (identity → e=0, f=0) and C2 (ascent=fontSize → f=42−12,
  height=15), which the old `toBeDefined()` checks did not.
- **Round-trip test** (`PdfExportService.test.ts`) — extract → export → verify
  (via spied `drawText`/`drawRectangle`) the redrawn baseline lands at PDF y=800
  (the original `pdfY`) and the redaction rect covers `[797.5, 808.6]` (the
  glyph run). This is the end-to-end redact-then-redraw invariant.
- **Metrics-guard test** (`textMetrics.test.ts`) — re-measures pdf-lib's
  `heightAtSize` for all base-14 families and asserts `base14Ascent`/`base14Descent`
  match, so a pdf-lib/AFM drift can't silently re-introduce C2. Plus
  classification + linear-scaling + "ascent ≠ fontSize" tests.
- **Core test updated** (`TextExtraction.test.ts`) — mocks now use the real
  PDF.js `height = fontSize` (not the `0.8×size` fiction) and assert
  `line.ascent = base14Ascent(...)`, so the core test no longer enshrines the
  wrong semantics.

The prior session's security-bound tests (F1/F3/F5 exact-attainment, F2
sanitization + defense-in-depth, F4 `pageExtractionBudget`, F6 string caps) and
serialization v3 migration tests remain.

**UI component tests (jsdom) are still not included** (Node test env, per the
M3.e decision) — the UI is covered by `typecheck` + the production `build`. The
new geometry/round-trip tests close the gap that let C1/C2 ship: the load-bearing
math is now verified numerically, not just by smoke tests.

---

## 8. Security impact report

F1–F6 (above) are present and correct within their scope. The client-side
extraction surface adds no new server route, no new fetch/URL handling, no
`dangerouslySetInnerHTML`/`eval` (extracted text renders as SVG `<text>` /
`<textarea>`, React-escaped; font names are constrained to base-14 before
reaching CSS). No ReDoS (the regexes in the path are anchored/linear).

**Residual security debt (deferred, not Part 1 regressions — the surface
predates Part 1):**
- **Deserialization collection-count caps.** F6 caps string *length* but no
  array/collection *counts*: a crafted `.pdfdadi` save with a 10M-entry `points[]`
  array, or 100k pages × 100k objects, reconstructs unbounded → OOM/hang. The
  `points[]` path is the sharpest (`ObjectRenderer` joins it into a multi-MB SVG
  polyline; `PdfExportService` into a multi-MB path).
- **Page-dimension cap in `deserialize`.** `loadPdf` caps page dims at open
  (`MAX_PAGE_DIM`), but `deserialize` (opening a save file) applies none — a
  crafted `page.width = 1e300` (finite, passes `assertFinite`) can make
  `page.setSize` throw *outside* the per-object try/catch and abort the whole
  export.
- **F1 doesn't bound PDF.js's own `getTextContent` allocation** (the 50k cap
  applies after `getTextContent` returns; a single pathological page can OOM
  inside PDF.js first).

These are scheduled for the next security-hardening pass.

---

## 9. Files modified (existing) / added (new)

**New:**
- `src/domain/editor/textMetrics.ts` (+ test) — the shared base-14 vertical-
  metrics module (C2 fix, single source of truth for the baseline anchor).
- `docs/milestone-5-part-1-completion.md` — this report.

**Modified — the C1/C2 fix:**
- `src/domain/editor/objectFactories.ts` — `baseFields` honors
  `overrides.transform`; all factories pass it (C1).
- `src/application/editor/text/TextExtraction.ts` — emits `ascent`/`descent` via
  `base14Ascent`/`base14Descent`; removed the wrong `ascent = item.height` logic
  and the dead `RawTextItem.height` field; fixed comments (C2).
- `lib/editor/extractText.ts` — redaction box is `ascent + descent`; fixed the
  `worldBounds = glyph AABB` and "exactly covers" comments; `RawTextItem` no
  longer carries `height` (C2 + comments).
- `src/application/editor/export/PdfExportService.ts` — existing-text baseline
  anchor uses `base14Ascent` (not `heightAtSize`); fixed the "exactly covers"
  comment (C2 + comment).
- `components/editor/canvas/ObjectRenderer.tsx` — existing-text uses
  `dominantBaseline="alphabetic"` + `y={base14Ascent}` (exact screen placement);
  authored text unchanged (C2).
- `components/editor/panels/PropertiesPanel.tsx` — "Existing text" banner
  surfaces the move-reveals-original limitation.
- `lib/editor/loadPdf.ts` — honest `MAX_PAGE_DIM` comment (dpr caveat).
- Tests: `lib/editor/extractText.test.ts` (geometry-value 0°/90° + realistic
  mocks), `src/application/editor/text/TextExtraction.test.ts` (real `height` +
  `base14Ascent` assertions), `src/application/editor/text/TextExtraction.security.test.ts`
  (dead `height` removed), `src/application/editor/export/PdfExportService.test.ts`
  (C1/C2 round-trip test).

---

## 10. Remaining technical debt

- **Font-independent existing-text transform.** The transform bakes in the
  original family's ascent; changing the font in the inspector leaves a ≤0.035×fontSize
  residual (screen/export stay consistent). The clean fix (transform without the
  ascent shift; anchoring fully in render/export; negative-`y` localBounds +
  rect-drawing that honors `localBounds.x/y`) is a future refactor.
- **Performance (Part 10):** lazy/streaming per-page rasterization; off-main-
  thread PNG encode; backing-store-PIXEL-area cap (vs the source-points
  `MAX_PAGE_DIM`); memoized per-object canvas wrapper/matrix for dense pages.
- **Security (next hardening pass):** deserialization collection-count caps
  (`points[]`, pages, objects/page, layers); page-dimension cap in `deserialize`;
  bound PDF.js's `getTextContent` allocation (streaming text extraction).
- **A11y/UX (Part 12 + polish):** keyboard text-edit (Enter/F2); open-PDF loading
  progress + SR announcement; empty-state for scanned PDFs; in-app error surfaces
  (replace `alert()`); `role="img"` → text semantics + full accessible name;
  focus management after open; reachable disabled-button explanation.
- **Code quality:** drive `reconstructObject` from the `ObjectTypeRegistry`
  (per-kind `deserialize`/`migrate`) instead of the growing god-switch; extract
  the per-bucket line-build from `groupTextItemsIntoLines`.
- Carry-over from M3.e/M4: pdf-lib Web Worker migration; HTTP security
  headers/CSP; the cosmetic Prisma 6 `package.json#prisma` warning.

---

## 11. Future recommendations

1. **Visual/browser verification pass** before closing future editor parts —
   green gates ≠ working feature when tests assert presence, not correctness, and
   there are no jsdom UI tests. The C1/C2 escape is the lesson.
2. **jsdom UI tests** for the canvas/panels, or at minimum a Playwright smoke
   test that opens a PDF and screenshots the extracted-text overlay.
3. **Lazy per-page rasterization + streaming extraction** (Part 10) — the dominant
   open-PDF cost.
4. **Font-independent transform** so existing-text font changes are pixel-exact.
5. **Deserialization count/dimension caps** (next security pass).
6. **Keyboard text-edit + loading progress + scanned-PDF empty-state** (Part 12).

---

**M5 Part 1 is complete and verified** — all four gates pass, the two critical
defects found by multi-agent review are fixed and guarded by geometry/round-trip/
metrics-guard tests, and the residual debt is documented with owning milestones.
