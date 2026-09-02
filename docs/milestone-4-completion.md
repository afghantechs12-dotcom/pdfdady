# Milestone 4 — Premium Visual PDF Editor (Completion Report)

**Status: 100% complete and verified.** All four verification gates pass.
**Date:** 2026-07-28

Milestone 4 turns PDFDadi's headless M3.e editor core into a working professional
visual editor — the flagship surface — live at **`/editor`**. It adds the
presentation, interaction, and real-editing layer on top of the immutable object
model + command/undo architecture, plus a pdf-lib export pipeline that draws
edits onto a PDF. M1–M3.e remain untouched except for additive, justified
extensions (Part 5/6 features, a v2 serialization migration).

---

## Verification gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` | ✅ 450 tests / 52 files (up from 253 / 36 at M3.e) |
| `npm run build` | ✅ succeeds (only the known cosmetic Prisma 6 `package.json#prisma` deprecation warning); `/editor` prerenders |

---

## 1. Implementation report

A dedicated, client-side editor workspace at `/editor` (a new route that does
not touch the existing `/tools/*`). It is built on the M3.e facade
(`EditorDocumentService`) via a React binding (`useEditor` + `EditorContext`),
and renders objects as an SVG overlay on a PDF.js page background.

**Part 1 — Text editing.** Double-click a text object → an inline `<textarea>`
overlay (`TextEditor`) matching the object's screen rect + font; commits via
`SetPropertyCommand`. Inspector controls for font (base-14 list with substitution
feedback), size, weight, color, align, line height, letter spacing, opacity.
Insert/delete/duplicate/move/resize/rotate all go through the transform/selection
services. Safe font substitution (`resolveFont`) maps non-base-14 families to the
nearest standard font with a user-facing reason.

**Part 2 — Image editing.** Move/resize/rotate/flip (H/V)/replace/crop/duplicate/
delete. Crop is a per-object `crop` rect (natural px); the renderer maps the crop
region into the object's bounds via an SVG clip; the inspector exposes numeric
crop + reset. Replace via a file picker. Flip uses the rotation-aware
`flipObject`. (Aspect-ratio lock on resize + a visual crop-drag mode are
documented refinements — see debt.)

**Part 3 — Object selection.** Single click, shift-toggle, ctrl/shift-add,
marquee drag-select (geometric via `HitTestService`), 8 resize handles + a rotate
handle with 24px hit targets. Selection is transient (not undoable), with a
`primaryId` anchor.

**Part 4 — Smart alignment.** Real snapping via 5 strategies (`PageSnap`,
`MarginSnap`, `ObjectSnap`, `GuideSnap`, `CenterSnap`) combined in a
`CompositeSnapEngine`; active snap guides render during drag. Real `IRulerEngine`
(`SmartRulerEngine`, nice ticks that adapt to zoom) drives ruler bars. Real
`IAlignmentEngine` powers align/distribute in the inspector.

**Part 5 — Layers.** A layers panel lists layers (top-first) + their objects
(paint order), with rename / hide / lock / duplicate / delete / reorder, and
per-object select / hide / lock / rename / z-order. New `SetLayerPropertyCommand`
+ `DuplicateLayerCommand` keep these undoable; layer order stays synchronized
with rendering (paint order = the layer arrays).

**Part 6 — History.** A history panel shows the undo/redo stacks (named entries)
and supports click-to-jump navigation via a new `CommandHistory.jumpTo` (one
notification). Unlimited undo/redo bounded only by `maxStackDepth` (100 by
default, configurable).

**Part 7 — Properties inspector.** Dynamic by selection: text / image / shape /
highlight / drawing / annotation / signature controls, plus multi-select
align/distribute + opacity. Uses the color + font helpers.

**Part 8 — Keyboard shortcuts.** A centralized `ShortcutResolver` (pure,
node-testable) maps normalized keys → action ids; `useShortcuts` dispatches them
to the facade + high-level actions, suppressed while typing in inputs. Full
clipboard (Ctrl+C/X/V), duplicate (Ctrl+D), delete, undo/redo, select-all,
z-order (Ctrl+[/]), group/ungroup (Ctrl+G/Shift+G), nudge (arrows / Shift),
zoom (Ctrl±/0), save/export, + single-letter tool switches.

**Part 9 — Context menu.** Right-click → copy/paste/duplicate/delete, bring
forward/backward/front/back, lock/hide, group/ungroup — gated by selection.
Grouping is real (objects share a `metadata.groupId`; group/ungroup are
undoable composites; selecting a group member expands the selection).

**Part 10 — Performance.** Object renderers are `React.memo`'d (skip re-render
on unrelated-object changes); live gestures coalesce into one undo entry; the
canvas renders only the active page; PDF.js rasterizes in a Web Worker; pdf-lib
is dynamic-imported (code-split) for export. See §3.

**Part 11 — Accessibility.** See §5.

**Part 12 — Mobile.** See §5.

**Part 13 — Testing.** See §6.

**Part 14 — Documentation.** This report + the plan doc + memory updates.

### Open-PDF + export (the real editing payoff)
`loadPdfIntoEditor` opens an existing PDF with PDF.js, creates one editor page
per source page (sized to the page's point dimensions), rasterizes each page to
a PNG background, and keeps the source bytes. `PdfExportService` then draws the
overlay objects onto copies of the original pages with pdf-lib — preserving the
original content (the "preserve document integrity" requirement). Standalone
editing (blank page → export) also works.

---

## 2. Architecture report

The M3.e layering is preserved: Domain (`src/domain/editor/`) → Application
(`src/application/editor/`) → Presentation (`hooks/editor/`, `components/editor/`,
`app/editor/`). M4 added **presentation** + a few **additive application/domain**
pieces; it did not rewrite the core.

- **React binding.** `useEditor` creates one `EditorDocumentService` per surface
  via a **client-safe factory** (`createEditorInstance`) that builds the same
  deps the DI factory does — without the server-only `appContainer` (whose
  top-level imports of Prisma/R2/ioredis would break a client bundle). State is
  mirrored into React with `useSyncExternalStore`; the facade is the single
  source of truth. `EditorContext` shares the binding across the tree.
- **Canvas.** `EditorCanvas` renders the active page (background + SVG overlay of
  objects in paint order) and runs the pointer state machine (select/marquee/
  move/resize/rotate/create/draw) using `CoordinateSpace` (screen↔page↔pdf-lib),
  `HitTestService`, and the snap engine. Each object is `<g transform="matrix(a,b,c,d,e,f)">`
  around an `ObjectRenderer` — a one-liner placement from the affine model.
  Gestures build absolute `TransformObjectsCommand`s with a `gestureKey` so they
  coalesce into one undo.
- **New commands.** `SetLayerPropertyCommand`, `DuplicateLayerCommand`
  (Part 5), and the facade methods `selectMany`/`flipSelection`/`setObjectSize`/
  `alignSelection`/`distributeSelection`/`jumpTo` (Parts 5–7) — all additive,
  symmetric before/after, undoable.
- **Engines.** The M3.e no-op/extension points are filled with real
  implementations (`SmartAlignmentEngine`, `SmartRulerEngine`, the 5 snap
  strategies) as standalone tested modules. The canvas builds its own
  `CompositeSnapEngine` from live page context; the `PluginRegistry` extension
  points remain for plugins.
- **Export.** `PdfExportService` dynamic-imports pdf-lib, maps screen space
  (top-left/y-down) → pdf-lib (bottom-left/y-up), and draws every built-in kind.

### Model changes (format v2)
`TextObject.letterSpacing`, `ImageObject.crop` (both optional, defaulted on read),
and grouping via `metadata.groupId`. `EDITOR_FORMAT_VERSION` bumped to 2 with a
real v1→v2 migration (`registerMigration`) that backfills the new fields. v1
saves upgrade cleanly.

---

## 3. Performance report

- **Object rendering** is `React.memo`'d per object — a mutation to one object
  doesn't re-render the others (the canvas maps over objects; React reconciles
  per-id).
- **Live gestures** (drag/resize/rotate) emit coalesceable `TransformObjectsCommand`s
  that merge into a single undo entry, so the history doesn't grow per pointer
  event and the cost is O(1) per gesture on the stack.
- **Single-page rendering**: the canvas renders only the active page's objects,
  so a 100-page document doesn't render 100 pages worth of SVG.
- **PDF.js** rasterizes in a Web Worker (unchanged from M3.e); **pdf-lib** is
  dynamic-imported for export, so it's code-split out of the main bundle.
- **Snapping** runs the 5 strategies per move event over the on-page objects;
  for very large object counts this is O(n) per move — acceptable for typical
  documents, documented as a refinement target (spatial index) for huge pages.

No regressions to the existing app (the editor is a new route; the tools are
untouched).

---

## 4. UX report

The workspace mirrors Figma/Canva/Acrobat conventions: a top toolbar (tools +
undo/redo + zoom + open/export), a left rail (layers + history), a center canvas
with rulers + snap guides, and a right inspector. Pointer-driven interactions use
pointer events (mouse + touch). The competitive benchmark (Acrobat, Canva, Figma)
informed: marquee + shift/ctrl multi-select, 8 handles + rotate handle, live snap
guides (pink), named history with jump navigation, a dynamic inspector, and a
right-click menu. All original implementations — no proprietary designs copied.

---

## 5. Accessibility report (WCAG 2.2 AA)

- **Keyboard for every action.** The centralized shortcut manager covers
  clipboard, delete, undo/redo, select-all, z-order, group/ungroup, nudge,
  zoom, save/export, + tool switches. Selection is reachable via the keyboard-
  navigable layers panel (object rows are buttons); once selected, all object
  actions are keyboard-driven.
- **Screen-reader announcements.** An `aria-live="polite"` status region
  announces the selection count + undo/redo availability on every change.
- **Semantics.** Canvas `role="application"` + `aria-label`; objects
  `role="img"` + `aria-label`; toolbar `role="toolbar"` with `aria-pressed`;
  context menu `role="menu"` / `menuitem` with `aria-label`; panels use heading
  hierarchy.
- **Target size (2.5.8).** Selection handles have a 24px transparent hit target
  behind the 9px visual, meeting the 24px minimum.
- **Focus.** Shortcut handling is suppressed while typing in inputs/textareas/
  contenteditable (flagged via `data-editor-text-input`), so editor typing isn't
  hijacked.
- **No regressions.** The M3.e a11y wins (focus trap, Modal, skip link) are
  untouched.

### Mobile
Pointer events drive all interactions (touch works). The canvas is
`touch-none` (no scroll hijack). Panels collapse on small screens (layers/
history hidden below `md`, properties below `lg`) so the canvas gets the viewport
on phones. **Known limitation:** the panels are hidden (not adapted into mobile
bottom sheets) on small screens — see debt.

---

## 6. Testing report

**450 tests / 52 files** (up from 253 / 36). No previous coverage reduced.

- **Phase 1 (parallel specialist agents), 169 new tests:** alignment engine +
  ruler engine (32), snap strategies (23), clipboard + grouping (22), coordinate
  space + hit-testing (26), PDF export (22), shortcut resolver + color + font
  substitution (44). Each module is pure logic, node-testable.
- **Phase 3 (lead), 27 new tests:** grouping metadata helpers, object factories,
  layer commands (`SetLayerPropertyCommand`/`DuplicateLayerCommand` apply/invert),
  `CommandHistory.jumpTo` + label accessors, and the facade's M4 methods
  (selectMany, setLayerProperty, duplicateLayer, flipSelection, setObjectSize,
  align/distribute, jumpTo) + a v2 round-trip.
- **Phase 0:** the real v1→v2 migration is tested (backfills `letterSpacing`/
  `crop` defaults; version lands at 2).

**UI component tests** (jsdom) are not included: the vitest suite runs in a Node
environment (per the M3.e decision, to avoid unverified browser worker bundling).
The UI is covered by `typecheck` + the production `build` (the `/editor` route
prerenders). Adding jsdom per-file UI tests is a documented follow-up.

---

## 7. Security impact report

- **No new server surface.** The editor is client-side. The "Open PDF" flow reads
  the file with PDF.js in the browser; the source bytes are held in memory for
  export, never uploaded. Export runs pdf-lib client-side. No new API routes, no
  new server-side file handling, no new SSRF/OOM vectors.
- **Client-side PDF parsing** uses the same pinned, workerized PDF.js the rest of
  the app already trusts; the ref-counted doc cache (M3.e) is reused.
- **No `dangerouslySetInnerHTML`**; object text is rendered as SVG `<text>` /
  `<textarea>` values (React-escaped). Data-URL images are rendered via SVG
  `<image href>`. No `eval` or dynamic string evaluation.
- **No new dependencies** (uses existing pdf-lib, pdfjs-dist, framer-motion,
  lucide-react, zod).
- **Export honesty:** pdf-lib can't apply letter spacing, image crop, or rounded
  corners — these are rendered on-screen but exported without the unsupported
  feature (never via a fake option that throws). Non-WinAnSI text throws at
  encode time rather than silently producing wrong output.
- The M1–M3.e security posture (admin auth, rate limits, atomic store, etc.) is
  unchanged.

---

## 8. Files modified (existing) / added (new)

**Modified — model/serialization/commands/services (additive):**
`src/domain/editor/objects.ts` (letterSpacing, crop, grouping helpers),
`src/domain/editor/document.ts` (format v2),
`src/domain/editor/testFactories.ts` (new default fields),
`src/application/editor/serialization/SerializationService.ts` + `.test.ts`
(v1→v2 migration, optional-field reconstruction, migration tests),
`src/application/editor/commands/commands.ts` (SetLayerPropertyCommand,
DuplicateLayerCommand, duplicateLayerCommand),
`src/application/editor/commands/CommandHistory.ts` (undoLabels, redoLabels, jumpTo),
`src/application/editor/layers/LayerService.ts` (setLayerProperty, duplicateLayer),
`src/application/editor/ports/ILayerService.ts` (new method signatures),
`src/application/editor/EditorDocumentService.ts` (selectMany, setLayerProperty,
duplicateLayer, flipSelection, setObjectSize, alignSelection, distributeSelection,
jumpTo, undoLabels, redoLabels, undoDepth).

**New — Phase 1 modules (+ tests):**
`src/application/editor/extensions/{AlignmentEngine,RulerEngine,SnapStrategies}.ts` (+tests),
`src/application/editor/clipboard/ClipboardService.ts` (+test),
`src/application/editor/grouping/GroupService.ts` (+test),
`src/application/editor/coordinates/CoordinateSpace.ts` (+test),
`src/application/editor/hitTesting/HitTestService.ts` (+test),
`src/application/editor/export/PdfExportService.ts` (+test),
`src/application/editor/shortcuts/ShortcutResolver.ts` (+test),
`lib/editor/color.ts` (+test), `lib/editor/fontSubstitution.ts` (+test).

**New — Phase 0/2/3 (lead):**
`src/domain/editor/objectFactories.ts` (+test),
`src/domain/editor/grouping.test.ts`,
`src/application/editor/commands/{commands.layer.test.ts,CommandHistory.jump.test.ts}`,
`src/application/editor/EditorDocumentService.m4.test.ts`,
`lib/editor/createEditorInstance.ts`, `lib/editor/exportClient.ts`,
`lib/editor/loadPdf.ts`,
`hooks/editor/{useEditor,useEditorActions,useShortcuts}.ts`,
`components/editor/EditorContext.tsx`, `editorTypes.ts`, `EditorToolbar.tsx`,
`EditorCanvas.tsx`, `EditorWorkspace.tsx`,
`components/editor/canvas/{ObjectRenderer,SelectionOverlay,TextEditor,ContextMenu,Rulers}.tsx`,
`components/editor/panels/{LayersPanel,HistoryPanel,PropertiesPanel}.tsx`,
`components/editor/InspectorControls.tsx`,
`app/editor/page.tsx`, `docs/milestone-4-plan.md`, this report.

---

## 9. Remaining technical debt

- **PDF export limitations (pdf-lib):** letter spacing, image crop, and rounded
  rect corners are rendered on-screen but not in the exported PDF (pdf-lib lacks
  the options). Image crop export would need client-side sub-image rasterization.
- **Deep content-editing of original PDF text** (true reflow of existing text
  runs) is not implemented; M4 edits an overlay layer on the PDF (the
  Acrobat/Canva model), preserving the original content. Converting an existing
  text run to an editable overlay object is a near-term enhancement.
- **Mobile panels** are hidden on small screens rather than restructured into
  bottom sheets.
- **Aspect-ratio lock on image resize** + a visual crop-drag mode (vs. numeric
  crop) are refinements.
- **UI component tests (jsdom)** not added (Node test env). The pure logic is
  fully tested; the UI is covered by typecheck + build.
- **Background rendering** for opened PDFs is up-front per page; lazy per-page
  rasterization (the M3.d virtualization pattern) is a perf refinement for very
  large PDFs.
- **Snapping** is pointer-based; object-edge snapping (snap the dragged object's
  edges to targets, not just the pointer) is a refinement.
- Carry-over from M3.e: pdf-lib Web Worker migration; HTTP security headers/CSP;
  multi-instance rate-limit/concurrency; OS temp-dir sweeper; the cosmetic
  Prisma 6 `package.json#prisma` warning.

---

## 10. Future recommendations

1. **Lazy PDF background rendering** + page virtualization for large documents.
2. **Visual crop-drag mode** + aspect-ratio lock for images; client-side sub-image
   rasterization so crop exports correctly.
3. **Rich text** (multi-run text with per-run font/color) — the model is ready
   (`localBounds` grows with content); the renderer + inspector would extend.
4. **Original-text → editable overlay** conversion (click existing PDF text →
   editable text object over the covered original).
5. **jsdom UI tests** for the canvas/panels (add jsdom dev dep + per-file
   environment).
6. **Object-edge snapping** + more guide types (baseline, equal-spacing hints).
7. **Rulers** with click-to-place guides (the guide engine is functional; wiring
   ruler clicks to `addGuide` is the last mile).
8. **Plugin tool controllers** — the M3.e `ToolDefinition`/`PanelDefinition`
   surfaces are ready; M4's tools are built-in, but a plugin could now register
   a new tool/panel end-to-end.

---

**Milestone 4 is 100% complete and verified** — all four gates pass, every part
(1–14) is implemented, and the editor is live at `/editor`.
