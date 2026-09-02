# Milestone 3.e — Final Platform Optimization + Premium PDF Editor Foundation

**Status:** Complete — all four verification gates pass.
**Date:** 2026-07-28

Milestone 3.e is the final optimization phase before new major features. It adds
no AI and does not redesign the UI. It (1) introduces the architecture for a
future professional editor, (2) completes the deferred accessibility items from
the M3.a–d consolidation pass, (3) cleans the code-quality backlog, and (4)
reviews performance, worker offloading, and mobile polish against an
already-optimized M3.d baseline.

---

## Verification gates

| Gate | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 0 warnings (down from 16 baseline warnings) |
| `npm run test` | ✅ 253 tests / 36 files (up from 105 / 21) |
| `npm run build` | ✅ succeeds (only the known cosmetic Prisma 6 `package.json#prisma` deprecation warning) |

---

## Part 5 + 6 — Premium editor foundation + extension points

A new Clean-Architecture editor core under `src/domain/editor/` and
`src/application/editor/`, wired through the existing DI container. It is
**additive** — the existing app (`app/`, `lib/`, `components/`) is untouched and
remains the working product. The foundation is infrastructure that future
milestones (text/image editing, layers panel, snapping, rulers, AI) plug into
without core rewrites.

### Design decisions and why

**Immutable, normalized state.** Each page owns a flat `objects: Record<id,
EditorObject>` map (O(1) lookup + O(1) "replace one object") plus a `LayerStack`
that holds only ordered ids. Geometry/properties live in the map; paint order
lives in the layer arrays. An edit to one object never reallocates the others.
This is the Figma-style split; chosen so undo/redo is a stack of pure state
transitions and React can hold editor state in one `useState`.

**Affine-transform object model.** Every object carries an `AffineTransform`
(local→page) and a `localBounds` (its natural size in local space). Editing
mutates the transform; the local geometry stays stable, which keeps
resize/rotate composable and undo tractable. The screen-space origin is
top-left (matching the existing PDF preview); a future mapping layer translates
to pdf-lib's bottom-left user space, preserving the `visualFractionToUserSpace`
coordinate contract the interactive tools already rely on.

**Command pattern with pure apply/invert.** A `Command` is a pure
`(EditorState) => EditorState` for both `apply` and `invert`. The
`CommandHistory` owns the undo/redo stacks and never mirrors the document — the
document lives in the caller — so there is no hidden state to drift. Most
commands use a symmetric before/after shape so `invert` is a mirror of `apply`
and round-trips stay exact across arbitrary undo/redo cycles.

**Coalescing + transactions.** A live drag emits many micro-`TransformObjects`
commands sharing a `coalesceKey`; the history merges them (keeping the
gesture-start `before` and the latest `after`) so a whole drag is one undo.
`beginTransaction`/`commit` buffer commands into a single `CompositeCommand`
(group ops); `rollback` inverts and discards.

**Selection is transient, not undoable.** Selection lives in `EditorState` but
is NOT recorded on the undo stack (you don't "undo" clicking a different
object). Multi-selection keeps an ordered id list + a `primaryId` anchor (the
object the transform handles align to and the inspector reads).

**Rotation-aware resize.** `resizeObject` keeps the opposite handle fixed and
solves for the new scale by projecting the drag onto the object's local axes —
correct for rotated objects. The construction is
`newT = translate(fixed) · rotate(θ) · scale · translate(−fixedLocal)`; the
scale-before-rotate order is load-bearing (swapping skews rotated objects).

**Versioned serialization.** Envelope `{ format: "pdfdadi-editor", version, … }`,
zod-validated, with a `registerMigration(fromVersion, step)` registry so older
saves upgrade to the current format. Newer-than-supported versions are rejected.
Plugin object kinds round-trip through the `ObjectTypeRegistry`; unknown kinds
survive a generic restore so a save never loses data.

**Plugin architecture with ownership-tracked teardown.** `EditorPlugin.activate`
receives an `EditorPluginApi` (register object types, tools, commands, snap
strategies, panels, components; replace the guide/ruler/alignment/font engines).
The `PluginRegistry` tags every contribution with its plugin and removes them
all on `deactivate`, restoring replaced engines to defaults. A plugin may also
return a cleanup function for side effects the registry can't reverse. This is
the ONLY mechanism by which the editor gains new object kinds/tools/engines —
the core never imports a plugin.

**Extension points (Part 6).** `ISnapEngine` + `CompositeSnapEngine` + a
ready-made `GridSnapStrategy`; `IGuideEngine` (in-memory default), `IRulerEngine`
+ `NoopRulerEngine`, `IAlignmentEngine` + `NoopAlignmentEngine`,
`IFontProvider` + `StandardFontsProvider` (the 14 PDF base fonts),
`IComponentLibrary` (in-memory default). Each ships a working default so the
editor runs with no plugins; honest no-ops where the logic is genuinely future
work (ruler ticks, smart alignment).

**Headless facade + DI.** `EditorDocumentService` owns state + history, exposes
the operations a UI needs, and notifies subscribers (a React hook subscribes and
re-renders). It is created per-surface via an `EditorServiceFactory` (singleton
in DI) so each editor gets its own `CommandHistory` + state. The serializer is
wired to the plugin registry's object-type registry so plugin kinds round-trip.

### Files (editor foundation)

Domain: `src/domain/editor/geometry.ts`, `objects.ts`, `layers.ts`,
`document.ts`, `ids.ts`, `testFactories.ts` (+ tests for each).

Application: `src/application/editor/commands/{types,CommandHistory,commands}.ts`
(+ test), `selection/SelectionService.ts` (+ test), `transform/TransformService.ts`
(+ test), `serialization/SerializationService.ts` (+ test),
`layers/LayerService.ts` (+ test), `plugins/{types,PluginRegistry}.ts` (+ test),
`extensions/{Snapping,Extensions}.ts` (+ tests), `EditorDocumentService.ts`
(+ test, + `editor.di.test.ts`), `registry.ts`, and the ports
`ISelectionService`, `ILayerService`, `ISerializer`.

DI: `src/application/di/tokens.ts` + `container.ts` (EditorSelectionService,
EditorLayerService, EditorSerializer, EditorPluginRegistry, EditorServiceFactory).

**Editor-foundation tests: 141** (geometry 18, objects 4, layers 9, document 9,
commands/undo-redo 20, selection 10, transform 12, serialization 10,
layers-service 8, snapping 7, extensions 7, plugins 8, facade 13, DI 3 — some
counts overlap by file).

---

## Part 3 — Accessibility completion (WCAG 2.2 AA)

Completed the deferred items from the M3.a–d consolidation pass.

- **Focus-trap utility** (`lib/a11y/focusTrap.ts`): the tab-cycle core
  (`nextFocusTarget`) is pure and unit-tested (7 tests); the `useFocusTrap` hook
  wires it to keydown events, focuses the first element on open, and restores
  focus to the opener on close.
- **AdminShell mobile slide-over**: `useFocusTrap` + Escape-to-close +
  `role="dialog"`/`aria-modal` (applied only while the mobile slide-over is
  open; the desktop sidebar stays a static landmark).
- **Skip link + main landmark**: a "Skip to content" link and `id="admin-main"`
  on the admin `<main>`.
- **Reusable `Modal`** (`components/ui/Modal.tsx`): backdrop + `role="dialog"`/
  `aria-modal` + focus trap + Escape + body-scroll lock. The ToolsManager editor
  is now wrapped in it, giving the flagged editor dialog semantics.

The existing `Field` (in `SaveStatus`) already uses the wrapping-`<label>`
association pattern with hint + error, so the "shared labeled-Field" item is
satisfied.

**A11y tests: 7** (focus-trap tab cycle).

---

## Part 7 — Code quality

Cleared all 16 baseline `no-unused-vars` warnings the
`pending-security-hardening` memory had flagged as a follow-up. Lint is now
**0 errors / 0 warnings**. Removed genuinely-unused imports/vars (and one wasted
`getAiTools()` fetch on the admin dashboard); kept imports that ARE used
(`BlogFaqItem`, `Save`) after verifying with the compiler.

---

## Part 1 — Performance

- **`React.memo` on `ToolCard`**: the tools catalog re-renders all cards on
  every filter-tab change; `ToolCard` is a pure component receiving a single
  stable `tool` prop, so memoizing it skips re-rendering unchanged cards (and
  their lucide SVG `Icon`s) on tab switches.
- **Already-optimized baseline (reviewed, not re-touched)**: PDF.js rasterizes
  in a Web Worker; pdf-lib is dynamically imported (code-split) per operation;
  the doc cache is ref-counted (no worker-memory leak); `PdfPreview` only
  re-rasterizes on (file/page/rotation/width) change — not on parent re-render;
  `EditPageGrid` lazy-loads framer-motion and virtualizes thumbnails above
  `LARGE_DOC_THRESHOLD`; uploads/processing use `AbortController`. Forcing
  further memoization on the interactive editor risks stale-closure bugs for
  marginal gain, so it was deliberately left as-is.

---

## Part 2 — Worker threads

Reviewed every heavy operation. **The heaviest work — PDF.js page
rasterization — is already off the main thread** (Web Worker, pinned to match
the API version). `jpgToPdf` EXIF orientation is already offloaded to the
browser's image decoder via `createImageBitmap({ imageOrientation: "from-image"
})`. The remaining pdf-lib operations (merge/save/edit/split/…) are code-split
and run on the main thread.

A pdf-lib Web Worker migration (with a main-thread fallback) was designed and
assessed. It was **deferred** because it cannot be safely verified in this pass
— the vitest suite runs in a Node environment and cannot exercise browser
worker bundling/execution, and shipping an unverified worker risks mis-bundled
or dead code (the fallback would always fire). That would violate "never
sacrifice stability" and "no partially implemented features." The migration is
the identified next optimization, scoped and documented, to be done with browser
integration tests.

---

## Part 4 — Mobile polish

Verified the app is already responsive (sm/lg breakpoints throughout) and that
all interactive elements meet WCAG 2.2 AA target size (2.5.8, 24px minimum):
icon buttons are h-8 (32px) or h-9 (36px), mobile toggles are h-10 (40px). No
sub-24px interactive elements were found. Bumping 32px admin icon buttons to
36px was considered and skipped — it is a desktop-oriented surface, the change
would touch many files with layout-shift risk, and 32px already meets AA.

---

## Part 8 — Testing

- **148 new tests** (editor foundation 141 + a11y 7), bringing the total from
  105 to **253** across 36 files.
- All previous tests continue to pass (no coverage reduced).
- New coverage: affine geometry + bounds math, object model, layer
  reorder/move, document normalization, command pattern + undo/redo +
  coalescing + transactions, selection + multi-select + selection bounds,
  rotation-aware resize + multi-object selection scaling, versioned
  serialization round-trips + migrations + plugin-kind round-trip + malformed
  input rejection, layer service, snapping (grid + composite), extension
  defaults, plugin lifecycle + ownership-tracked teardown, the headless facade
  end-to-end, DI wiring, and the focus-trap tab cycle.

---

## Files modified (existing) / added (new)

**New — editor foundation:** `src/domain/editor/{geometry,objects,layers,document,ids,testFactories}.ts` + 4 tests;
`src/application/editor/{registry.ts, EditorDocumentService.ts (+test, +di.test)}`;
`src/application/editor/commands/{types,CommandHistory,commands}.ts` (+test);
`src/application/editor/selection/{SelectionService}` (+test);
`src/application/editor/transform/TransformService.ts` (+test);
`src/application/editor/serialization/SerializationService.ts` (+test);
`src/application/editor/layers/LayerService.ts` (+test);
`src/application/editor/plugins/{types,PluginRegistry}.ts` (+test);
`src/application/editor/extensions/{Snapping,Extensions}.ts` (+2 tests);
`src/application/editor/ports/{ISelectionService,ILayerService,ISerializer}.ts`.

**New — a11y:** `lib/a11y/focusTrap.ts` (+test), `components/ui/Modal.tsx`.

**Modified — DI:** `src/application/di/tokens.ts`, `src/application/di/container.ts`.

**Modified — a11y/admin:** `components/admin/AdminShell.tsx` (skip link, main id,
focus trap, Escape, dialog semantics), `components/admin/ToolsManager.tsx`
(editor wrapped in Modal).

**Modified — lint cleanup:** `app/admin/page.tsx`, `components/admin/{BlogManager,CategoriesManager,NavForm,SeoForm,PagesManager,ToolsManager}.tsx`,
`data/admin/index.ts`, `data/tools.ts`.

**Modified — perf:** `components/tools/ToolCard.tsx` (React.memo).

---

## Remaining technical debt

- **pdf-lib Web Worker migration** — scoped and designed; deferred pending
  browser integration tests (see Part 2). The heaviest work is already
  workerized.
- **Editor → UI wiring** — the foundation is headless and DI-registered but not
  yet connected to a page (intentional; future milestone builds the editor
  surface on top of it).
- **HTTP security headers / CSP** — still open from M1 (Phase 2b).
- **Multi-instance rate-limit/concurrency** — still single-instance/in-process
  (M2 Redis follow-up).
- **OS temp-dir sweeper** for orphaned job dirs on hard crash (security P2).
- The known cosmetic Prisma 6 `package.json#prisma` deprecation warning
  (migrating to `prisma.config.ts` is a Prisma 7 prerequisite, deferred).
