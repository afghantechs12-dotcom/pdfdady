# Milestone 4 — Premium Visual PDF Editor (Plan)

**Status:** In progress. Builds on the M3.e headless editor foundation
(`src/domain/editor/` + `src/application/editor/`). M4 adds the presentation,
interaction, and real-editing layer on top of that core, plus a pdf-lib export
pipeline. M1–M3.e remain untouched unless required.

## What exists (M3.e, headless)

- Immutable object model: `EditorObject` union (text/image/shape/annotation/
  signature/highlight/drawing + plugin), `AffineTransform` [a,b,c,d,e,f],
  `localBounds`, flat `objects` map + `LayerStack` (paint order = two arrays).
- Commands: `SetPropertyCommand` (partial patch, no `kind`), `TransformObjects`
  (coalesceable), `CompositeCommand`, add/remove/reorder/layer/page commands.
- `CommandHistory`: undo/redo, coalescing, transactions, `maxStackDepth` (100).
- `TransformService`: 8 `ResizeHandle`s, rotation-aware resize, flip, selection scaling.
- `SelectionService`: pure single/multi/primary, `selectionBounds`.
- `SerializationService`: zod envelope, `registerMigration`, `EDITOR_FORMAT_VERSION=1`.
- Extensions: `CompositeSnapEngine` + `GridSnapStrategy`; `NoopRulerEngine`,
  `NoopAlignmentEngine` (to be filled in); `InMemoryGuideEngine`;
  `StandardFontsProvider` (14 base fonts); `InMemoryComponentLibrary`.
- `EditorDocumentService` facade (subscribable) + `EditorServiceFactory` (per-surface).
- DI wired (`Tokens.EditorServiceFactory` etc.). **No UI, no editor route, no barrel files.**
- Vitest **node** env (no DOM); use per-file `// @vitest-environment jsdom` for UI tests.

## Coordinate contract

Screen space = top-left, y-down (matches `PdfPreview`). pdf-lib = bottom-left.
M4 builds the mapping layer (screen ↔ pdf-lib user space) at export time, reusing
the `visualFractionToUserSpace` idea. `AffineTransform` maps straight to SVG
`transform="matrix(a,b,c,d,e,f)"`, so rendering is a one-liner per object.

## Model changes (Phase 0) — bump to format v2 + v1→v2 migration

- `EditorObjectBase.groupId: string | null` (default null) — for Part 9 grouping.
- `TextObject.letterSpacing: number` (default 0) — Part 1 letter spacing.
- `ImageObject.crop: Bounds | null` (default null, natural-pixel rect) — Part 2 crop.
- Update `reconstructBase`/`reconstructObject` to default missing optional fields.
- Register v1→v2 migration (bump version + add defaults to raw objects).
- Add `src/domain/editor/objectFactories.ts` (`createTextObject`, `createImageObject`,
  `createShapeObject`, `createHighlight`, `createDrawing`, `createAnnotation`,
  `createSignature`) with all defaults; update `testFactories.ts`.

## New pure-logic modules (Phase 1 — parallel specialist agents)

Each agent creates a new file (+ test) under `src/application/editor/...` with a
precise contract; none touch shared files. Integration/wiring is done by the lead.

- **AlignmentEngine** (`extensions/AlignmentEngine.ts`) — real `IAlignmentEngine`:
  align left/right/top/bottom/centerX/centerY + distribute H/V. + test.
- **RulerEngine** (`extensions/RulerEngine.ts`) — real `IRulerEngine`: nice tick
  intervals from zoom + viewport span. + test.
- **SnapStrategies** (`extensions/SnapStrategies.ts`) — `PageSnap`, `MarginSnap`,
  `ObjectSnap`, `GuideSnap`, `CenterSnap` strategies (Part 4). + test.
- **Clipboard + Grouping** (`clipboard/ClipboardService.ts`, `grouping/GroupService.ts`)
  — copy/paste/cut/duplicate (in-memory, offset paste); group/ungroup commands +
  group-aware selection helpers. + tests.
- **CoordinateSpace + HitTest** (`coordinates/CoordinateSpace.ts`,
  `hitTesting/HitTestService.ts`) — screen↔page mapping (zoom/pan/page rotation);
  point→topmost-object + marquee→objects. + tests.
- **PdfExport** (`export/PdfExportService.ts`) — `EditorState`→`PDFDocument` (load
  source PDF bytes optional, draw objects, screen→pdf-lib mapping, font
  substitution to base-14). + test (pdf-lib in node).
- **ShortcutResolver + color/font helpers** (`shortcuts/ShortcutResolver.ts`,
  `lib/editor/color.ts`, `lib/editor/fontSubstitution.ts`) — pure key-event→action
  resolver (testable in node); EditorColor↔CSS; font→base-14 substitution + feedback. + tests.

## UI layer (Phase 2 — built coherently by lead)

New dedicated route `app/editor/page.tsx` (does not touch `/tools/edit-pdf`).
Client-side: load PDF via pdfjs (`usePdfDocument`) for page backgrounds; edit
overlay objects; export client-side via pdf-lib (dynamic import).

- `hooks/editor/useEditor.ts` — create/resolve `EditorDocumentService`, subscribe,
  expose `state` + typed action wrappers.
- `hooks/editor/useShortcuts.ts` — bind `ShortcutResolver` to the facade (gated by
  focus: no shortcuts while typing in inputs/text edit).
- `components/editor/EditorWorkspace.tsx` — shell: toolbar + canvas + left/right panels.
- `components/editor/EditorToolbar.tsx` — tools: select, text, image, shapes,
  highlight, draw, signature, annotation; undo/redo; zoom; export.
- `components/editor/EditorCanvas.tsx` — pdfjs page background + SVG overlay
  (objects in paint order) + selection overlay + rulers + guides + marquee.
  Pointer-event interactions (mouse + touch). Zoom/pan.
- `components/editor/canvas/ObjectRenderer.tsx` — per-kind SVG (text/image/shape/
  highlight/drawing/annotation/signature) via `matrix(a,b,c,d,e,f)`.
- `components/editor/canvas/SelectionOverlay.tsx` — 8 handles + rotate handle +
  marquee + active snap guides.
- `components/editor/canvas/Rulers.tsx` — ruler bars via `RulerEngine`.
- `components/editor/canvas/TextEditor.tsx` — inline edit (double-click) →
  contenteditable/textarea; commit via `SetPropertyCommand`.
- `components/editor/canvas/ContextMenu.tsx` — right-click actions (Part 9).
- `components/editor/panels/{LayersPanel,HistoryPanel,PropertiesPanel}.tsx` +
  `PanelShell.tsx`.
- `components/editor/InspectorControls.tsx` — text/image/multi-select property
  controls (font, size, color, spacing, opacity, align, distribute).
- `lib/editor/exportClient.ts` — dynamic-import pdf-lib, run `PdfExportService`,
  trigger download.

## Phase 3 — quality

- A11y: keyboard for every action (shortcuts + tabbable canvas objects with
  role/aria-label), aria-live announcements for selection/undo/redo, focus mgmt.
- Mobile: pointer events (touch), responsive panel collapse, touch-sized handles.
- Performance: memoize object renderers, virtualize off-screen pages (M3.d pattern),
  coalesce live gestures (already in core), throttle guide computation.
- Tests: expand to cover all new logic + key UI behaviors (jsdom where needed).
- Docs: completion report + architecture doc + memory update.

## Verification gates (must all pass)

`npm run typecheck` · `npm run lint` (0/0) · `npm run test` · `npm run build`
