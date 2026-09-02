# Milestone 5 — Advanced PDF Editing Engine (Plan)

Status: **in progress**. Builds on M1–M4 (the platform + the M4 premium visual editor at `/editor`).
Rules: extend, never rewrite; no placeholders/TODOs/fakes; every feature works; gates green after each part.

Baseline (verified before starting): typecheck 0, lint 0, **450 tests / 52 files**, build green.

## Guiding principle

M4 is an **overlay editor** (Acrobat/Canva model): edits draw onto copies of the original pages,
preserving the source. M5 keeps that integrity guarantee and extends what is editable. The one
hard limit that shapes Part 1 — **pdf-lib cannot mutate existing PDF text** — is solved the way
production browser PDF editors solve it: extract existing text runs (PDF.js), convert them into
editable replacement objects positioned over the original, and redact-and-redraw on export. This
is the user-approved "editable replacement object" model, not a fake.

## Extension mechanics (how each part stays additive)

- **New fields on an existing kind** → bump `EDITOR_FORMAT_VERSION` + `registerMigration` + extend
  serializer reconstruction + factory defaults. (Used by Part 1, 2, 3, 4.)
- **New object kind** → register via `ObjectTypeRegistry` (serialize/deserialize/create) and add an
  optional **PDF export renderer** extension point to `PdfExportService` so plugin kinds can export.
  (Used by Part 5 tables, 7 annotations, 8 forms, 9 stamps where they don't fit a built-in kind.)
- **New service/engine** → port + service + DI/client-factory wiring. (Used by text extraction,
  typography, snapping/guides, page ops, forms, signatures.)
- **UI** → new toolbar tools, panels, and canvas renderers on the existing workspace shell.

## Parts

1. **True existing text editing** — PDF.js `getTextContent` extraction → line grouping → editable
   `TextObject`s with `background` (redaction) + `sourceText` marker; export redacts-then-redraws.
   Format v3. Honest about font/color best-effort + move-reveals-original limit.
2. **Advanced typography** — rich text runs (kerning/tracking/baseline-shift/super/sub/decoration/
   outline/fill/stroke/opacity), paragraph spacing, bullet/numbered lists, columns, valign, frame
   padding, text wrap, auto-resize vs fixed frame + overflow indicator. Extends text model.
   **Status: in progress (slice-based).** Slice 1 (v4 text persistence contract: `content`/`frame`
   model, format v4, v3→v4 migration, bounded reconstruction) is complete and verified — see
   `docs/milestone-5-part-2-slice-1-completion.md`. Remaining slices: 2 TextLayoutEngine, 3 rich
   model adoption by extraction, 4 preview/export parity, 5 rich editor UI.
3. **Professional shapes** — stars/arrows/callouts/speech bubbles/diamonds/clouds/freeform polygons,
   Bezier curves, boolean ops (union/subtract/intersect/exclude), corner radius, dash styles,
   gradient/pattern fills, shadow/glow/blur. Extends `ShapeKind` + style.
4. **Advanced image editing** — crop handles + live preview, aspect lock, replace, mask, rounded
   corners, border, shadow, filters (brightness/contrast/saturation/grayscale/sepia/blur), rotate/
   flip, opacity, blend modes. Extends `ImageObject`.
5. **Tables** — full table editor: insert, merge/split cells, row/col sizing, alignment, background,
   border, padding, font, copy/paste/duplicate/resize. New `table` kind + export renderer.
6. **Page management** — drag reorder, multi-select, duplicate, extract, split, merge, rotate,
   delete, replace, insert blank, insert from PDF, page labels, thumbnails, continuous scroll,
   zoom presets. Document-model commands + page panel.
7. **Annotation system** — sticky notes, comments + reply threads + resolved, review mode,
   highlight/underline/strikeout, ink, stamp, date, callout, measurement, bookmark, link,
   attachments. New annotation kinds + review model.
8. **Forms** — text/checkbox/radio/dropdown/list/signature/date fields, validation, required, tab
   order, field calculation, FDF import/export, flatten. pdf-lib AcroForm support.
9. **Digital signatures** — draw/type/upload, saved signatures + initials library, certificate
   signatures + timestamp, appearance customization. Visual + library; crypto limits documented.
10. **Editor performance** — 500-page / 1000-object targets: virtualized + lazy rendering, smooth
    drag/zoom, background rendering, incremental saves, memory + worker optimization.
11. **UX polish** — smart snapping/guides, equal spacing + distribution, smart alignment, spacebar
    hand/pan, zoom-to-cursor + animation, selection animation, magnetic guides.
12. **Accessibility** — WCAG AA: keyboard, screen readers, touch + mobile editing, high contrast,
    reduced motion.
13. **Export** — preserve fonts/images/metadata/bookmarks/annotations/forms/links/rotation,
    compression, size optimization, PDF/A where feasible.
14. **Testing** — 600+ tests: unit, integration, rendering, geometry, commands, history,
    serialization, export, import, editor, performance, accessibility.
15. **Documentation** — implementation/architecture/performance/testing/security/accessibility/UX
    reports, modified-files list, technical debt, future recommendations; memory updated.

## Gates (run after every part; do not continue until green)

`npm run typecheck` · `npm run lint` · `npm run test` · `npm run build`
