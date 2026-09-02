# Editor P1 Phase H — Inspector redesign: research + handoff

**Status: PLANNING INCOMPLETE.** This document is the verified ground truth
gathered before the plan was written, plus the four scope decisions taken, plus
the blockers that still have to be resolved before an implementation plan can be
written honestly. It is not itself a plan.

Date: 2026-08-17. Predecessor: P1 Phase G (floating object toolbar), complete.

---

## 0. Provenance caveat, recorded deliberately

Two research subagents were dispatched during this session. **Neither returned a
report** — one died on a `502` gateway quota error, the other never notified.
Mid-session I twice wrote that "both agents have reported back"; that was false
and is retracted here.

**Every fact in this document was verified by reading the files cited.** Nothing
below rests on a subagent's summary. Where something was NOT verified it says so
explicitly.

---

## 1. Recovering the Phase H brief

The brief is **not in the repository**. It is a single 26,879-character user
message in the session transcript:

```
C:\Users\Faisal Arifi\.claude\projects\d--AndroidStudioProjects-Backup-PDFMaster\
  0725af85-84e2-4584-8c9a-188565ae13e5.jsonl
```

Extract it by parsing the JSONL and filtering `message.content` text parts for
`PHASE H: ULTRA-PREMIUM`. It contains requirements **H1–H48**, the required
screenshot list (`h01`–`h12`), the regression list, the quality gates, and the
success criteria.

**Tooling note:** `grep -o "PATTERN.\{0,3000\}"` on these transcript files hangs
(it was killed at the 120s timeout). Use Node to parse the JSONL instead.

---

## 2. Verified baseline

| Item | Result |
|---|---|
| Test files / tests | **192 files / 3665 tests** — 3650 passed, 15 skipped |
| Matches brief's stated baseline | Yes (192 / 3665) |
| Failing files | 2, both pre-existing and environmental |
| Dev server | Running, `http://localhost:3001/editor` → HTTP 200 |

### How to run the suite here

Plain `npm run test` crashes a worker on this host
(`Error: Worker exited unexpectedly`) because of memory pressure while the dev
server is also running. Use a constrained pool:

```bash
npx vitest run --pool=threads --poolOptions.threads.maxThreads=3
```

That completes in ~67s and reports a clean count.

### The 2 failing files are NOT code faults

- `prisma/provision-workspaces.test.ts`
- `src/application/services/AccountProvisioningService.test.ts`

Both fail with `FATAL ERROR: … Allocation failed - process out of memory` raised
inside a **Prisma subprocess** (`prisma migrate deploy`). Confirmed environmental
by running the two files **in isolation** — they still OOM, so it is not
cross-test interference. This matches the documented host-memory behaviour in
[[local-dev-environment]].

**Reporting rule for this phase: state these two honestly. Do not describe the
suite as "all green", and do not attempt to "fix" them.**

Not yet confirmed: whether the **15 skipped** tests are all pre-existing and
intentional. Check before claiming no regression.

---

## 3. Architecture as it exists today

### The single Inspector

`components/editor/EditorInspector.tsx` (139 lines) — the one right-hand dock.

- Flat tab strip, `TAB_META` maps each tab to a label + lucide icon.
- Correct WAI-ARIA tabs: `role="tablist"`, `role="tab"`, `aria-selected`,
  `aria-controls`, roving `tabIndex`, Arrow/Home/End handling.
- Labels are hidden on narrow docks via `max-[1320px]:hidden`, leaving icon +
  `title` + accessible name.
- The tabpanel carries `min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden`.
- Body switch is one line: `activeTab === "properties" ? <PropertiesPanel /> : documentPanel`.

### The redesign target

`components/editor/panels/PropertiesPanel.tsx` (685 lines). Three top-level
states plus eight per-kind blocks:

| State / block | Location | Notes |
|---|---|---|
| No selection | ~L75–88 | Disabled W/H + "Select an object to edit its properties." |
| Multi-selection | ~L90–119 | Align 6-grid, Distribute 2-grid (disabled < 3), Opacity |
| `PanelHeader` | ~L166 | `Properties · {name}` |
| `PositionSection` | ~L193 | **Titled "Size"** — W/H/Rotation only, **no X/Y** |
| `OpacitySection` | ~L214 | Titled "Appearance" — Opacity + Flip H/V |
| `TextControls` | ~L278 | Source-text notice, Font/Size/Weight/Align/Color/Leading/Track, Background |
| `ImageControls` | ~L425 | Replace image + Crop (natural px) |
| `ShapeControls` | ~L490 | Fill/Stroke/Stroke width/Dash/Radius, per-kind params, Shadow |
| `HighlightControls` | ~L620 | Color + Opacity |
| `DrawingControls` | ~L630 | Brush/Stroke/Width/Smoothing |
| `AnnotationControls` | ~L661 | textarea + Size + Color |
| `SignatureControls` | ~L677 | Signer + "Visual signature (not cryptographic)." |

Geometry/appearance are gated on `primaryAffordance.allowsGeometry` (~L155) —
that is the P0 invariant and must survive.

**Note the brief's H25 asks for an X/Y grid. `PositionSection` currently has no
X/Y fields at all** — adding them is new behaviour (needs a move/translate
commit path), not a re-layout.

### The control system

`components/editor/InspectorControls.tsx` (223 lines) — `NumberField`,
`SelectField`, `ColorField`, `Slider`, `FieldGroup`, built on three constants:

```
ROW     = "flex min-w-0 items-center gap-1.5 text-xs text-editor-muted"
LABEL   = "w-[52px] shrink-0 text-editor-muted"
CONTROL = "h-7 min-w-0 flex-1 rounded-control border border-editor-border px-1.5 …"
```

`CONTROL` is **`h-7` = 28px**; the brief (H5) asks for 32–36px. Only two files
consume this module: `PropertiesPanel.tsx` and `propertiesOverflow.test.ts`.

### Shell + layout

- `EditorWorkspace.tsx` (1105 lines) — docked `<aside className="flex w-[320px] …">`
  (~L761); drawer copy (~L1067); bridge built at ~L374–386.
- `editorPanelLayout.ts` — `PanelMode = "overlay" | "docked"`, one breakpoint at
  **1200px**, `resolveInspectorTabs(hasDocumentPanel)`,
  `resolveActiveInspectorTab` falls back to `properties`, `INSPECTOR_DOCK_KEY`.
- `useEditorPanels.ts` — dock preference persisted; drawer + active tab
  session-only; `selectTab` also reveals the panel.
- `PremiumEditorFrame.tsx` — pure presentation slots, `min-w-0`/`min-h-0`
  discipline, root `overflow-hidden`.
- `EditorPanelDrawer.tsx` — real dialog: `useFocusTrap`, Escape, scrim.

### Phase G is not at risk from this redesign

Every property action the floating toolbar offers
(`replace`/`fill`/`stroke`/`color`/`width`/`opacity`) resolves to exactly
`panels.selectTab("properties")` (`EditorWorkspace.tsx` ~L700–710). There is
**no DOM-focus contract, no `data-*` selector, no element ref** from the toolbar
into the Inspector's internals. Restructuring the panel cannot break it.

### The document tabs

`components/workspaces/DocumentInspector.tsx` (459 lines) — renders no tab strip;
`tab` prop selects the body. Three tabs each fetch independently with their own
`loading`/`error`/`attempt` state, through a shared `PanelState`
(loading → error+retry → empty → children).

- **Outline** — `OutlineItemView {id, title, pageNumber, depth}`; indents via
  inline `paddingLeft: 12 + min(depth,5)*12`; empty string is exactly
  `"This document has no outline."`; rows disabled when `onNavigateToPage` absent.
- **Comments** — delegates to `CommentsPanel`; re-reads after every mutation
  (`mutate` → `load`).
- **Versions** — `VersionView {id, versionNumber, origin, label, pageCount,
  sourceByteSize, createdAt, manifestDegraded}`; `Intl.DateTimeFormat`
  medium/short; `formatBytes`; empty string is exactly
  `"This document has no saved versions yet."`; **read-only, no actions.**

`CommentsPanel.tsx` (497 lines) is otherwise solid (plain-text bodies, live
regions, no `alert()`), but:

- **L349** — `{entry.authorName ?? entry.authorId}` → renders a **raw ID**
- **L352** — `{entry.createdAt.slice(0, 16).replace("T", " ")}` → raw ISO slice

---

## 4. Capability audit — what is real vs. fake

The rule: never build UI for a capability that does not exist.

| Control asked for | Verdict | Evidence |
|---|---|---|
| **Bold** | **REAL** | `fontWeight` on `TextObject`; export selects bold at ≥600 |
| **Italic** | **PARTIAL** | Base-14 exposes `Helvetica-Oblique`, `Times-Italic`, `Courier-Oblique` etc. as separate **families** (`Extensions.ts:135-152`). Export honours `/italic|oblique/` on the family (`PdfExportService.ts:170,185-203`). **The SVG canvas never sets `fontStyle`** (`ObjectRenderer.tsx:147`) → no slant on screen |
| **Underline** | **DEAD** | `TextDecoration = "none"｜"underline"｜"line-through"` exists (`textContent.ts:14`) and is serialized (`SerializationService.ts:392`), but **zero** renderer or export references |
| **Justify** | **ABSENT** | `align: "left" | "center" | "right"` (`objects.ts:218`) |
| Line height / tracking | REAL | `lineHeight`, `letterSpacing` |
| **Aspect-ratio lock** | **DOES NOT EXIST** | `resizeObject` (`TransformService.ts:118`) computes `nsx`/`nsy` independently; no aspect flag anywhere |
| Crop | REAL | natural px; `resolveCropEligibility` + `cropMath` |
| Flip H/V | REAL | `flipSelection(axis)` — general, not image-only |
| **Group / Ungroup** | **REAL** | `GroupService.group` requires **≥2 ids**; Ctrl+G / Ctrl+Shift+G; exposed as `handlers.group()` |
| Align / Distribute | REAL | `alignSelection(target)`, `distributeSelection(axis)` |
| Delete | REAL | `handlers.delete()` |
| **Page rotate / duplicate / delete / move** | **REAL** | `EditorDocumentService.ts:393,400,408,425`; `service` is on the editor context, so the Properties panel can reach them |
| **Named page size ("A4")** | **NO LOOKUP EXISTS** | `createPage` defaults 595×842 (`document.ts:113`); no A4/Letter table anywhere. Would be a new pure derivation |
| Filename / page count on context | **NOT on context** | `UseEditorResult` = `{state, service, activePage, selection, canUndo/Redo, undoLabel/redoLabel, undoDepth, revision, actions}`. Filename lives in `EditorWorkspace` |
| **Comment author name** | **NO API RETURNS IT** | `toCommentMessageResponse` (`commentHttp.ts:54-72`) emits `authorId` only. `User.name` exists but is **nullable** (`schema.prisma:94`) |
| **Version restore** | **ENDPOINT REAL** | `POST …/versions/{n}/restore`, body `{organizationId, expectedRevision}`. Creates a **new** version carrying the old artifacts — it does **not** rewind |
| Version preview / compare | **NO COMPARE ENDPOINT** | Single-version `GET …/versions/{n}` exists; no compare route |
| Outline add / edit / delete | **REAL** | `POST` outline, `PATCH`/`DELETE …/outline/{id}`. "Embedded outlines are read-only" — Workspace items are mutable. GET also supports `?shape=tree` (the inspector currently uses the flat+`depth` form) |

---

## 5. Scope decisions taken by the user

1. **Implement Italic for real** — set `fontStyle` on the canvas `<text>` and map
   family→oblique variant so screen and export agree. **Omit Underline and
   Justify entirely** (no disabled placeholders).
2. **Extend the comments API** to join `User.name` so real names render instead of
   raw IDs.
3. **Wire real Restore** in the Versions tab (disabled on the current version).
4. **One pass**, verify at the end (no mid-way checkpoint).

Decisions 1–3 are genuine behaviour changes beyond a pure visual redesign, so
each needs its own tests, and the phase report must describe them as such.

---

## 6. Blockers — must be resolved before writing the plan

### B1. `expectedRevision` for Restore (was mid-verification when interrupted)

`VersionService.restoreVersion` (`VersionService.ts:350-362`) compares the
**document's current** revision against `expectedRevision` and rejects a
mismatch. Facts established:

- `DocumentWorkbench` never fetches or holds a document revision (grep: no hits).
- `DocumentInspector` is not given one.
- The versions list **does** include a per-version `revision`
  (`versionHttp.ts:44`), but that is the document revision **at that version's
  creation** — not necessarily current.

Still to decide: where the current revision comes from (a document GET? the
newest version's revision?) and how a **409/conflict** is surfaced. Unresolved —
do not guess.

### B2. How Italic is represented

Two materially different options:

- **New `italic` boolean on `TextObject`** — clean model, but bumps
  `EDITOR_FORMAT_VERSION` 6 → 7 and needs a migration; the brief excludes
  schema/domain changes.
- **Select the oblique family** (`Helvetica` → `Helvetica-Oblique`) — no schema
  change, but "Bold + Italic" becomes family arithmetic over the base-14 matrix,
  and `resolveFont`/`availableFonts` currently present all 14 as flat choices.

### B3. Fallback when `User.name` is null

The column is nullable by design (pre-signup-form and Clerk-mirrored users).
Need a rule: email local-part? "Unknown user"? Must not invent an identity.

---

## 7. Constraints the redesign must not break

`components/editor/panels/propertiesOverflow.test.ts` is a source-asserting
guard. It requires:

- the scrolling `<fieldset>` keeps `min-w-0`, `overflow-x-hidden`, `overflow-y-auto`
  (a fieldset's default `min-inline-size: min-content` is what caused the original
  horizontal scrollbar);
- `ROW` keeps `min-w-0`; `CONTROL` keeps `min-w-0` **and** `flex-1`;
- **no** `w-[NNNpx]` on a control input (label columns may be fixed);
- the source-font notice keeps `break-words`; the `<select>` keeps `truncate`;
- the docked aside width stays within **300–360px**;
- the Inspector tabpanel keeps `min-w-0` + `overflow-y-auto` + `overflow-x-hidden`.

Raising `CONTROL` from `h-7` to 32–36px is compatible — the test asserts
`min-w-0`/`flex-1`, not the height.

Other invariants: single Inspector; widening the window must never shrink the
canvas; `CommandHistory.revision` export-watermark semantics; the Phase G gesture
**state mirror** (never read `gestureRef` during render).

Read-only source text keeps: range highlight, no handles, no rotate, no
geometry/opacity/flip, no drag-move, no "Edit" button, and an `aria-live` string
derived from `resolveSelectionAffordance` (guarded by
`sourceTextHonesty.test.ts`, which scopes its match to the `aria-live` JSX block).

---

## 8. Browser-probe notes

No Playwright in this repo — CDP scripts only (`scripts/editor-*-probe.mjs`).

- Chrome: `C:/Program Files/Google/Chrome/Application/chrome.exe`, `--headless=new`.
- Existing probes use ports 9427 (toolbar) etc.; emulate 1600×900.
- **Hold clicks ~110ms.** CDP dispatches press+release in the same millisecond,
  which hides render-ordering bugs.
- **Toolbar gotcha:** Draw and Rectangle live inside `Draw ▾` / `Shapes ▾` cluster
  menus — clicking by label opens the MENU. Use keyboard `D` / `R`.
- **Two tabpanels exist** (left rail + Inspector). Scope DOM reads through
  `[role="tablist"][aria-label="Inspector"]` → `aria-controls`.
- Read-only imported runs render a **`fill="transparent"` rect**, not `<text>`.
  Click `main svg rect[fill=transparent]`; the only `<text>` nodes on an imported
  page are ruler labels.
- `npx prisma generate` fails with `EPERM` on the query-engine DLL while the dev
  server holds it. Expected; the schema is untouched, so
  `node scripts/next-build.js` builds directly.

---

## 9. Remaining work to finish planning

Blocking: **B1**, **B2**, **B3** above.

Non-blocking but needed for a complete plan:

1. Confirm the 15 skipped tests are pre-existing/intentional.
2. Decide whether section collapse state is session-only or persisted.
3. Enumerate the new test files (section visibility per object kind, source-text
   read-only fields, multi-select shared properties, no-selection page state, tab
   switching, a11y semantics) — avoiding brittle full-DOM snapshots.
4. Decide whether the Outline tab moves to `?shape=tree` or keeps flat+`depth`.
5. Write `docs/plans/editor-p1-phase-h-plan.md`, then implement.
