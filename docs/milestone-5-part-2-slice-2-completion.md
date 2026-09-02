# Milestone 5 — Part 2, Slice 2: TextLayoutEngine (Completion Report)

**Status: complete and verified.** This is the second slice of M5 Part 2
(Advanced typography). It ships the **canonical text layout engine** — a pure
application-level module that consumes v4 `TextContent` and `TextFrame`, performs
deterministic line breaking, calculates fragment positions, handles padding and
alignment, and exposes resolved layout objects. The engine becomes the single
source of truth for text layout, with all consumers (SVG renderer, PDF export,
auto-sizing, future accessibility) using the resolved layout.

**Date:** 2026-07-30

---

## Verification gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` | ✅ **576 tests / 59 files** (up from 533/58 at Slice 1) |
| `npm run build` | ✅ succeeds; `/editor` + all `/tools/*` prerender |

---

## 1. Implementation report

The slice adds one new application module and a comprehensive test suite. No
render, export, command, or UI path changed.

- **`src/application/editor/text/TextLayoutEngine.ts`** — the canonical layout
  engine. Pure application-level code with no React, Canvas, or pdf-lib
  dependencies. Consumes v4 `TextObject` (with `content: TextContent` and
  `frame: TextFrame`), accepts a platform-specific `FontMeasureFn` for font
  measurement, and produces `ResolvedTextLayout` objects.

  **Key types:**
  - `TextLayoutFragment` — positioned fragment with text, x, width, runIndex,
    paragraphIndex
  - `TextLayoutLine` — ordered fragments with y, height, width, paragraphIndex,
    paragraphSpacingBefore/After
  - `ResolvedTextLayout` — lines, contentHeight, contentWidth, overflow, autoHeight
  - `FontMeasureFn` — platform-independent font measurement callback
  - `LayoutOptions` — availableWidth, availableHeight, measure function
  - `TextOverflow` — "none" | "clip"

  **Key features:**
  - Word-based line breaking with whitespace token preservation
  - Padding reduces content area (horizontal and vertical)
  - Horizontal alignment (left/center/right) applied per-line
  - Column layout with configurable count and gap
  - Auto-height mode (grows to fit content) vs fixed sizing mode
  - Overflow detection for content exceeding available height
  - Deterministic caching by content/frame/options signature
  - Cache invalidation by object id

- **`src/application/editor/text/TextLayoutEngine.test.ts`** — 43 test cases
  covering: basic wrapping, nowrap mode, word boundary breaking, whitespace
  preservation, horizontal alignment, padding effects, overflow detection,
  auto-height vs fixed mode, deterministic output, cache correctness,
  invalidation, multiline/paragraph handling, column distribution, fragment
  metadata, contentWidth reporting, and edge cases (zero width, narrow width,
  empty text, whitespace-only).

---

## 2. Architecture report

The M3.e/M4/M5 Part 1 layering is preserved. Slice 2 added one pure
application module and its test suite; it rewrote no core path.

- **Single source of truth for layout.** The `TextLayoutEngine` is the sole
  authority that may derive wrapped lines, positioned fragments, auto-size
  results, or overflow state from v4 `content`/`frame`. No other module may
  compute these values. This is the architectural property that makes
  preview/export parity tractable in Slice 4.

- **Platform independence.** Font measurement is injected via `FontMeasureFn`,
  keeping the engine free of DOM, Canvas, or pdf-lib dependencies. The SVG
  renderer can use canvas `measureText`, the PDF exporter can use pdf-lib
  `widthOfTextAtSize`, and tests use a deterministic mock.

- **Deterministic caching.** Layout results are cached by a signature that
  combines the object id, content signature, frame signature, typography
  properties, and layout options. Identical inputs produce identical cache keys
  and identical outputs. Cache invalidation is by object id, supporting
  efficient incremental updates.

- **Vertical alignment deferred.** The engine returns top-aligned lines by
  default. Vertical alignment offsets are applied by consumers (renderer,
  accessibility) using the resolved `contentHeight` and `autoHeight`. This keeps
  engine output stable (same content → same lines) and avoids duplicating
  alignment logic.

- **No render/export changes.** The current SVG and pdf-lib paths continue to
  read the legacy scalar `text` field. Preview/export parity with the v4 model
  is Slice 4.

- **No UI changes.** Typography controls remain scalar-only. The rich editor
  UI is Slice 5 and follows the layout engine.

---

## 3. Testing report

**576 tests / 59 files.** The additions are focused on the new engine:

- **`src/application/editor/text/TextLayoutEngine.test.ts`** (43 cases, new) —
  comprehensive coverage of all engine features: wrapping, alignment, padding,
  overflow, auto-height, deterministic output, cache correctness, invalidation,
  multiline handling, columns, fragment metadata, contentWidth, and edge cases.

- **Regression:** Full suite passes with no failures. The 43 new tests bring the
  total from 533 to 576.

---

## 4. Security impact report

No new security surface. The engine operates on already-validated v4 content
trees (bounded reconstruction from Slice 1) and accepts numeric options that
are bounded by the caller. The deterministic mock measurer in tests has no
security implications.

**Residual security debt (unchanged from Slice 1):** deserialization
collection-count caps for non-text arrays, page-dimension cap, and PDF.js
`getTextContent` allocation bounds. These remain scheduled for the next
security-hardening pass.

---

## 5. Files modified (existing) / added (new)

**New:**
- `src/application/editor/text/TextLayoutEngine.ts` — the canonical layout engine.
- `src/application/editor/text/TextLayoutEngine.test.ts` — 43 test cases.
- `docs/milestone-5-part-2-slice-2-completion.md` — this report.

**Modified:**
- None (all changes are additive).

---

## 6. Explicit slice boundaries (what this slice does NOT do)

Honest scoping is the point of slicing Part 2. These are intentionally deferred
to named later slices:

- **No rendering/export changes.** The current SVG and pdf-lib paths continue to
  read the legacy scalar `text` field. Preview/export parity with the v4 model
  is Slice 4.
- **No UI changes.** Typography controls remain scalar-only. The rich editor UI
  is Slice 5 and follows the layout engine.
- **No existing-text extraction change.** M5 Part 1 extraction still builds
  scalar text objects; it will adopt v4 `content` in a later slice once the
  layout engine exists and is integrated.

---

## 7. Remaining technical debt and future recommendations

1. **Preview/export parity (Slice 4).** Wire the `TextLayoutEngine` into the
   SVG renderer and PDF export path so they consume `ResolvedTextLayout`
   instead of the legacy scalar `text`. This is the prerequisite for rich text
   rendering.
2. **Rich editor UI (Slice 5).** Build the rich text editing interface on top
   of the layout engine, allowing users to edit runs, paragraphs, and frame
   properties.
3. **Existing-text extraction adoption (Slice 3).** Update M5 Part 1 extraction
   to produce v4 `content`/`frame` objects that the layout engine can process.
4. **Carry-over debt from M5 Part 1 §10.** Font-independent existing-text
   transform; lazy/streaming per-page rasterization (Part 10); deserialization
   count/dimension caps (next security pass); keyboard text-edit + loading
   progress + scanned-PDF empty-state (Part 12);
   `reconstructObject` → `ObjectTypeRegistry` refactor.

---

**M5 Part 2 Slice 2 is complete and verified** — all four gates pass, the
canonical `TextLayoutEngine` is in place as the single source of truth for text
layout, and rendering/export parity, rich UI, and extraction adoption are
explicitly scoped to later slices.
