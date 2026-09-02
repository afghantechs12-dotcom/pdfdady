# Editor UX — P0 Interaction Correctness

Scope of THIS pass: the P0 correctness items, verified in the browser, gates green.
P1 (toolbar/panels/canvas/tabs/loading), P2 (Workspace), and continuous scrolling
are follow-on passes per the agreed delivery order.

## Ground truth established (verified by reading code, not assumed)

Baseline re-measured: **186 test files / 3577 tests passing**.

| Brief's claim | Reality found |
|---|---|
| "Draw not convincing/complete" | Engine is **sound end-to-end** (gesture → `createDrawing` → serialize → pdf-lib export). Real gaps: (a) in-progress preview hardcoded to black `#0f172a` width 2 (`EditorCanvas.tsx:1119-1126`) ignoring brush/color/width/opacity; (b) `addDrawing(startPage, pts)` never passes `overrides` (`EditorCanvas.tsx:825`) though `useEditor.ts:205` supports them; (c) **no user control surface** for pen/color/width/opacity despite `drawingGeometry.ts` defining 4 brushes; (d) no pointercancel/lostpointercapture handling. |
| "Source text shows transform frame" | **Confirmed, and narrower than assumed.** `PropertiesPanel` *already* branches on `isReadonlySourceText` (hides typography, offers Copy text, `:245-291`). The contradiction is in two places only: `SelectionOverlay.tsx` is **capability-blind** — takes only `selectionBounds`, unconditionally draws 8 resize handles + rotate (`:33,83-147`); and `PositionSection`/`OpacitySection` render unconditionally for every object (`PropertiesPanel.tsx:144-145`), giving source text X/Y/W/H/Rotation/Opacity/Flip that do not apply. |
| "Add Image covers content" | **Confirmed root cause:** `EditorCanvas.tsx:1020` inserts at raw `dims.width/height` — natural pixels used as PDF points, no page-relative scaling. A 3000px photo → 3000pt object. |
| "Add Text feels low-level" | **Confirmed:** `objectFactories.ts:74` hardcodes `makeBounds(0, 0, 200, height)` — the arbitrary 200×20 box the brief names. |
| "Scrolling feels like page jumping" | **It IS discrete.** `EditorCanvas` renders ONE `activePage` into one `<svg>` (`:1049-1085`) inside `overflow-hidden` (`:1038`). No scroll container exists. `onWheel` (`:890-909`) converts `deltaY` → `viewport.pan`. Page change = `setActivePage` state swap (`EditorWorkspace.tsx:340-343`). Not tunable — deferred to its own pass by decision. |
| Toolbar "Add Link" + "Redact" | **Neither exists** in the canonical registry (`editorTypes.ts`). Redaction exists only as an opaque-background text property. Omitted by decision — no fake buttons. |

Invariant to protect: `CommandHistory.revision` export watermark semantics. No task
here touches history comparison; export-watermark tests must stay green.

## Work

### 1. Source PDF text selection semantics (P0-2)

Make read-only source text visually and semantically distinct from editable objects.

- New pure module `components/editor/canvas/selectionAffordances.ts`:
  `resolveSelectionAffordance(objects)` → `{ kind: "transform" | "source-text" | "multi", showHandles, showRotate }`.
  Pure + unit-tested; keeps the branch out of JSX.
- `SelectionOverlay.tsx`: accept the affordance. For `source-text` render a
  **text-range highlight** (translucent lavender fill + accent underline, text
  cursor), and **no resize handles, no rotate handle**.
- `PropertiesPanel.tsx`: gate `PositionSection` + `OpacitySection` behind the
  affordance so geometry/flip/opacity are absent for source text. Keep the
  existing "Original PDF text" explanation + Copy text.
- Source-text context actions limited to what genuinely exists: **Copy text**
  (already implemented), **Highlight**, **Comment**. No Redact.
- Guard: editable text must KEEP its handles (regression risk is inverting this).

### 2. Draw tool completion (P0-1)

- `DrawControls` contextual strip (brush: Pen/Marker/Highlighter/Pencil, color,
  width, opacity) driven by `drawingGeometry.ts` constants — no second source of truth.
- Thread brush/color/width/opacity through `addDrawing(..., overrides)`.
- Live preview renders with the **actual** brush spec via `deriveDrawingRender`,
  replacing the hardcoded black stroke.
- Pointer lifecycle: add `pointercancel` + `lostpointercapture`; `setPointerCapture`
  on stroke start so fast strokes leaving the page don't drop segments; Escape
  cancels the in-flight stroke; tool switch terminates cleanly (no stuck state).
- Draw state lives in a ref during the stroke; React state updates only per frame
  (avoids global re-render per raw pointer event).

### 3. Add Text professional workflow (P0-4)

- Page-relative default width (~40% of page width, clamped) instead of hardcoded 200.
- Click → create + **immediately enter edit mode with caret focused** (reuse
  existing `setEditingTextId` + `TextEditor.tsx`); drag → text area then edit.
- Escape exits editing; outside click commits; Delete removes when not typing.
- Suppress resize handles while actively typing (they interfere with editing).

### 4. Add Image professional workflow (P0-5)

- New pure module `src/application/editor/tools/imagePlacement.ts`:
  `resolveInsertedImageSize(natural, page)` → fits **≤40% of page area**, preserves
  aspect ratio, clamps inside page bounds, centers on the insertion point without
  hanging off-page. Pure + unit-tested (this is the actual bug, so it gets real tests).
- Wire into the insertion call site; select the image after insert.

### 5. Single right Inspector (P0-6)

- Change the panel contract so **one** Inspector docks at every width: tabs
  `Properties · Comments · Outline · Versions`. `resolvePanelMode`'s `dual` branch
  stops docking two panels; reclaimed width goes to the canvas, not another panel.
- Update `editorPanelLayout.test.ts` expectations to the new single-dock contract
  (adjusting a contract test to a deliberately changed contract, not weakening it).
- Inspector 320px default, 280–420 bounds, no horizontal scroll.

## Verification (not optional)

- `npx prisma validate && npx prisma generate && npm run typecheck && npm run lint && npm run test && npm run build`
- Test count must be **≥ 3577** and any movement explained.
- Live browser QA on **http://localhost:3001** via the existing CDP harness
  (`scripts/editor-audit.mjs`, `scripts/shot-region.mjs` — no Playwright in this repo).
- Screenshots this pass: `01-editor-default`, `02-add-text-editing`,
  `03-source-text-selected`, `04-image-selected`, `05-draw-mode`, `06-draw-result`.
  `03` must show a text-range highlight with **no transform/rotation handles** and
  the read-only inspector.
- Console must show 0 new errors.

## Explicitly NOT in this pass

Continuous scrolling re-architecture; Add Link; Redact; AI Assistant panel (omitted
or "Soon" only, never fake); Workspace dashboard/picker redesign; P1 visual redesign.
