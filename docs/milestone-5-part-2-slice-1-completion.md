# Milestone 5 — Part 2, Slice 1: v4 Text Persistence Contract (Completion Report)

**Status: complete and verified.** This is the first slice of M5 Part 2
(Advanced typography). It ships **only the persistence and versioning
foundation** for rich text — the normalized content model, the frame layout
intent, and the v3→v4 migration. It deliberately does **not** introduce a
layout engine, change rendering or export, or touch the typography UI. Those
belong to later slices.
**Date:** 2026-07-29

A previous multi-agent review found that the exposed text-tracking control was
dropped by PDF export, that the scalar `<textarea>` could not safely evolve
into rich text, and that there was no canonical layout source of truth. Slice 1
addresses the root of those concerns — the schema — before any higher-risk
rendering or UI work is layered on. The contract is additive and inert in the
current renderer: v3 scalar `text` stays as the compatibility projection, while
v4 stores normalized paragraph/run content and frame configuration for the later
shared layout engine.

---

## Verification gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` | ✅ **533 tests / 58 files** (up from 525/57 at M5 Part 1) |
| `npm run build` | ✅ succeeds (only the known cosmetic Prisma 6 `package.json#prisma` deprecation warning); `/editor` + all `/tools/*` prerender |

---

## 1. Implementation report

The slice is intentionally narrow: one new domain module, two additive fields
on `TextObject`, a format bump, a real migration, and bounded reconstruction.
No render, export, command, or UI path changed.

- **New domain surface** (`src/domain/editor/textContent.ts`) — additive v4
  value types: `TextRun`, `TextParagraph`, `TextContent`, `TextFrame`, plus
  the `TextFramePadding` / `TextColumnConfig` / `TextRunStyle` / `TextParagraphList`
  shapes and the `TextDecoration` / `TextListKind` / `TextVerticalAlign` /
  `TextWrapMode` / `TextSizingMode` enums. Three pure helpers:
  `createPlainTextContent` (single-paragraph/run tree for legacy text),
  `createDefaultTextFrame` (fresh frame so objects never share mutable
  arrays), and `textContentToPlainText` (ordered paragraph+run projection).
  The module imports only `EditorColor` from `./objects` — no `pdfjs-dist`,
  no DOM, no `lib/`/`src/application/` dependencies. It is pure domain.
- **Text object extension** (`src/domain/editor/objects.ts`) — `TextObject`
  now carries required `content: TextContent` and `frame: TextFrame`. The
  legacy scalar `text` is retained and documented as the compatibility
  projection for the current M4 renderer, the M5 Part 1 extraction/export
  path, and accessibility consumers.
- **Factory invariants** (`src/domain/editor/objectFactories.ts`) —
  `createTextObject` normalizes `content` from legacy `text` via
  `createPlainTextContent` when `content` is not supplied, and sets
  `text = textContentToPlainText(content)` so the scalar projection is
  always derived from the canonical tree. The same synchronization holds in
  the test factory (`testFactories.makeTextObject`), preventing fixtures
  from constructing inconsistent v4 objects.
- **Format bump + migration** (`src/domain/editor/document.ts`,
  `SerializationService.ts`) — `EDITOR_FORMAT_VERSION` 3 → 4, with a real
  `registerMigration(3, …)` that gives every legacy text object a
  single-paragraph/run `content` tree and a default `frame`. The migration
  deliberately preserves the legacy `text` projection, so existing M4/M5
  Part 1 consumers continue to read a compatible field after load.
- **Bounded v4 reconstruction** (`SerializationService.ts`) —
  `reconstructTextContent`, `reconstructTextFrame`,
  `reconstructTextFramePadding`, and `reconstructTextRunStyle` validate and
  bound every v4 payload before it enters the live object model. Limits:
  10k paragraphs, 20k runs, 200k total characters, 12 columns, and bounded
  numeric ranges for font size / weight / letter spacing / baseline shift /
  stroke width / spacing / list level. Reconstructed text objects rebuild
  `text = textContentToPlainText(content)` on load, so a crafted save
  cannot present one string to the legacy projection and a different string
  to the canonical content tree.

---

## 2. Architecture report

The M3.e/M4/M5 Part 1 layering is preserved. Slice 1 added one pure domain
module and two additive fields; it rewrote no core path.

- **Single source of truth is the content tree, not the scalar.** The
  architectural decision that makes later slices tractable: `text` is no
  longer authoritative. It is a *projection* of `content`, regenerated at
  construction, deserialization, and migration. When a future rich-text
  editor edits runs, the projection follows automatically; when the current
  scalar renderer reads `text`, it reads a value that is always consistent
  with the canonical tree. This is the property the prior review found
  missing.
- **Layout intent vs. layout result.** `TextFrame` persists *intent*
  (padding, vertical alignment, wrap mode, sizing mode, columns). It does
  not persist layout *results* — wrapped lines, positioned fragments,
  auto-size outcomes, or overflow state. Those are derived by the
  forthcoming `TextLayoutEngine`, which is the sole authority for them.
  Keeping derived values out of the persisted shape means a layout fix never
  invalidates saved documents.
- **Backward compatibility holds.** v1 → v2 → v3 → v4 migrations chain
  cleanly; a v1 save loads through three migrations into a v4 document with
  no loss of M4/M5 Part 1 behavior. The migration is additive (new fields
  defaulted) and the legacy projection is preserved, so no consumer breaks.
- **Client safety holds.** No new `lib/` or server import was added to the
  domain or serialization path. `textContent.ts` is pure TypeScript with
  one type-only import; the serializer changes are pure logic. The client
  `createEditorInstance` factory is unaffected.

---

## 3. Testing report

**533 tests / 58 files.** The additions are focused on the new contract and
its persistence boundary:

- **`src/domain/editor/textContent.test.ts`** (3 cases, new) — asserts
  `createPlainTextContent` produces the normalized single-paragraph tree,
  `createDefaultTextFrame` returns independent (non-shared) frames, and
  `textContentToPlainText` projects ordered rich paragraphs and runs as
  plain text (multi-paragraph, multi-run, with list/style metadata).
- **`objectFactories.test.ts`** (extended) — a v4 factory test asserting
  `createTextObject` normalizes `content` and derives `text` from it, so
  the projection invariant holds at construction.
- **`SerializationService.test.ts`** (extended with a v4 round-trip suite) —
  rich-run and frame persistence across serialize/deserialize; canonical
  projection tamper resistance (mutating the scalar `text` on a save does not
  change restored content); and malformed / resource-exhausting payload
  rejection (oversized run strings, oversized paragraph/run counts, bad
  numeric ranges, out-of-range opacity). The F6 hardening test was retargeted
  at the canonical run payload rather than the obsolete scalar projection,
  preserving the same 200k-character safety guarantee against the
  authoritative field.

The focused v4 suite (3 files) passes 36 tests. UI component tests remain
Node-only per the M3.e decision; the UI is covered by `typecheck` and the
production `build`. Slice 1 adds no UI, so this is not a gap here.

---

## 4. Security impact report

The v4 reconstruction helpers close the most direct new attack surface
introduced by the schema: a crafted `.pdfdadi` save could otherwise embed an
unbounded `content` tree (millions of paragraphs, runs, or characters) and
OOM the editor on load. The bounds (10k paragraphs, 20k runs, 200k total
characters, 12 columns, bounded numerics) make crafted-PDF worst cases
degraded-but-non-crashing, consistent with the F1–F6 bounds carried since M5
Part 1. The tamper-resistance test verifies the projection cannot be
desynchronized from the canonical content by a crafted save.

**Residual security debt (deferred, not a Slice 1 regression — the surface
predates this slice):** deserialization collection-count caps for non-text
arrays (`points[]`, pages, objects/page, layers); page-dimension cap in
`deserialize`; bounding PDF.js's own `getTextContent` allocation. These
remain scheduled for the next security-hardening pass, as documented in the
M5 Part 1 report §8.

---

## 5. Files modified (existing) / added (new)

**New:**
- `src/domain/editor/textContent.ts` — the v4 value types and pure helpers.
- `src/domain/editor/textContent.test.ts` — contract tests.
- `docs/milestone-5-part-2-slice-1-completion.md` — this report.

**Modified:**
- `src/domain/editor/objects.ts` — `TextObject` carries `content` + `frame`.
- `src/domain/editor/document.ts` — `EDITOR_FORMAT_VERSION = 4` + the v4
  doc comment.
- `src/domain/editor/objectFactories.ts` — `createTextObject` normalizes
  `content` and derives `text`.
- `src/domain/editor/testFactories.ts` — `makeTextObject` derives scalar
  `text` from normalized content (fixture invariant).
- `src/domain/editor/objectFactories.test.ts` — v4 factory test.
- `src/application/editor/serialization/SerializationService.ts` — v3→v4
  migration + bounded `reconstructText*` helpers + projection rebuild on load.
- `src/application/editor/serialization/SerializationService.test.ts` — v4
  round-trip, tamper-resistance, and malformed-payload suites; F6 retargeted.

---

## 6. Explicit slice boundaries (what this slice does NOT do)

Honest scoping is the point of slicing Part 2. These are intentionally
deferred to named later slices:

- **No layout engine.** `TextLayoutEngine` (Slice 2) is the next slice and
  the sole authority that may derive wrapped lines, positioned fragments,
  auto-size results, or overflow state from v4 `content` / `frame`. None of
  those derived values are persisted in Slice 1.
- **No rendering/export changes.** The current SVG and pdf-lib paths
  continue to read the legacy scalar `text` field. Preview/export parity
  with the v4 model is Slice 4.
- **No UI changes.** Typography controls remain scalar-only. The rich
  editor UI is Slice 5 and follows the layout engine.
- **No existing-text extraction change.** M5 Part 1 extraction still
  builds scalar text objects; it will adopt v4 `content` in a later slice
  once the layout engine exists.

---

## 7. Remaining technical debt and future recommendations

1. **`TextLayoutEngine` (Slice 2).** Implement the canonical layout
   engine: line breaking against `frame` width + padding + columns,
   fragment positioning, auto-height resolution, vertical alignment, and
   overflow indication. This is the prerequisite for every remaining Part 2
   slice.
2. **Carry-over debt from M5 Part 1 §10.** Font-independent existing-text
   transform; lazy/streaming per-page rasterization (Part 10);
   deserialization count/dimension caps (next security pass); keyboard
   text-edit + loading progress + scanned-PDF empty-state (Part 12);
   `reconstructObject` → `ObjectTypeRegistry` refactor.
3. **Revisit F6 scope.** The F6 string-length cap now also guards the
   canonical run payload; a future pass should add a dedicated
   per-document v4 content budget (total characters across all text
   objects) so a document with many moderate text objects cannot
   cumulatively OOM.

---

**M5 Part 2 Slice 1 is complete and verified** — all four gates pass, the v4
content/frame model and v3→v4 migration are in place with bounded
reconstruction, the legacy scalar projection is preserved for M4/M5 Part 1
consumers, and the layout engine, render/export parity, and rich UI are
explicitly scoped to later slices.
