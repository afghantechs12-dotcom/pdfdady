# Editor redesign — verified baseline findings (2026-08-15)

All facts below are from primary evidence: reading current code, and measuring the
REAL rendered editor at multiple widths via `scripts/editor-audit.mjs` (CDP).
Baseline audit JSON: `qa-screenshots/baseline/audit-before.json`.

## Baseline gates
- `npm run test`: **182 files / 3515 tests, all passing** (272s).
- Dev server: port 3001, `/editor` → 200.

## Measured layout, BEFORE (canvas width % of frame)

| Width | Canvas | % | Toolbar buttons | Labelled | Regions docked | Overflow |
|---|---|---|---|---|---|---|
| 1920×1080 | 1424×946 | 74% | 22 | **22** | Layers rail 176, Properties 320 | no |
| 1440×900 | 944×766 | 66% | 16 | **0** | Layers rail 176, Properties 320 | no |
| 1366×768 | 870×634 | 64% | 16 | **0** | Layers rail 176, Properties 320 | no |
| 1024×768 | 848×634 | 83% | 9 | **0** | Layers rail 176 | no |

### The single most important finding
`resolveToolbarMode` (toolbarLayout.ts:228-241) uses
`TOOLBAR_COMPACT_MAX_WIDTH = 1330`, `TOOLBAR_TABLET_MAX_WIDTH = 1900`.
So **icon+label ("desktop") only appears at container ≥1900px**. At 1440 and
1366 — the two most common laptop widths, and the reference screenshot's own
scale — the toolbar renders **icons only, zero labels**. The target design's
defining feature (labelled tool buttons) is therefore absent at the widths that
matter most. This is the primary spec gap, and it is a *threshold + button
geometry* problem, not a "rewrite the toolbar" problem.

Also: the left rail defaults to the **Layers** tab, not Pages (EditorWorkspace
~line 328-329: single-page docs keep Layers). The reference leads with Pages
thumbnails. With no document open, the rail shows Layers.

## What the spec asks for that DOES NOT EXIST (must not be faked)

Verified absent by exhaustive search:
- **Redact tool** — no tool, no service. "Redact" appears only in marketing copy
  (`components/home/HeroShowcase.tsx:364`) and in *text-redaction* internals for
  the replace-mode background box (a different concept).
- **Add Link** — no `link` object kind. Canonical kinds are exactly:
  text, image, shape, annotation, signature, highlight, drawing
  (`src/domain/editor/objects.ts:23-31`).
- **In-document text search / Ctrl+F** — does not exist. `SearchPanel.tsx` and
  `WorkspaceSearch.tsx` are **workspace-wide** search (they call
  `/api/workspaces/{id}/search`). The spec explicitly forbids using workspace
  search as document search, and forbids building a second search engine.
- **Client-side autosave** — no client code calls the autosave endpoints. The
  autosave API + `AutosaveService` + `AutosaveDraft` exist entirely server-side;
  no `fetch` in `components/` or `hooks/` targets them. The client's only
  "saved" concept is `dirty = canUndo` (EditorWorkspace:495) plus a per-tab
  `dirty`/`conflict` flag. **Therefore "✓ Saved / All changes saved" would be a
  LIE for local documents.** Spec §34 says "Do not fake save status."
- **Page grid/list toggle** in Pages panel — absent.
- **Left panel collapse** — absent.
- **Panel drag-resize** — absent (`drawerAfterResize` is about breakpoint
  changes, not dragging).
- **Collapsible property sections** — `FieldGroup` (InspectorControls.tsx:214)
  is a static title + children; no disclosure.
- **Version restore / compare / rename** in the inspector — versions render
  read-only (number, timestamp, label). No restore action wired.
- **Document rename from the editor app bar** — rename exists only in
  `DocumentFileManager` (workspace file list), not in the editor surface.
- **Notifications bell** — nothing behind it.
- **"Organize Pages"** as a distinct mode — page ops (insert/duplicate/rotate/
  delete/move) exist but only inside `PagesPanel`; there is no organize view.
- **Import page from file / "Insert PDF"** — `insertBlankPage` only.

## What DOES exist and must be preserved
- Tools: select, hand, text, image, signature, annotation(note), 11 shapes,
  draw, highlight, eraser, path(pen), crop (image-gated).
- Export: `exportEditorPdf` → `{name}-edited.pdf`, plus a `.pdfdadi.json` save.
  Only these two — no flatten, no "download original" variant.
- Comments: real threads with authorName, createdAt, reply, resolve/reopen
  (`CommentsPanel.tsx`).
- Outline + Versions tabs (`DocumentInspector.tsx:9-14`), outline navigates pages.
- Share: `DocumentSharingPanel` (workspace-backed, real API).
- Multi-doc tabs, split view, command palette, session restore (M7).
- **Readonly imported text** — `isReadonlySourceText` gate in
  `PropertiesPanel.tsx:238-290`: shows "Original PDF text", the source-font line,
  the reason, "Copy text", and SUPPRESSES all typography controls. This is the
  fixed duplication defect. DO NOT REGRESS.

## Design-system assets already present
- `editor-*` Tailwind namespace (tailwind.config.ts:56-68) + `styles/editor.ts`:
  bg #F4F6FB, surface #FFF, border #E6E9F2, accent #7C3AED, accentsoft #F3EEFF,
  shadows `page` / `editorfloating`. Radii: control 8, controllg 10, appcard 12,
  panel 16 — matches the spec's radius ladder.
- `PremiumEditorFrame` typed-slot shell, `FloatingCanvasControls`,
  `editorPanelLayout` contract (1600 dual / 1200 single / else drawers).

## Stage A1 result — MEASURED AFTER (audit-after-stageA.json + probe-fixed.json)

| Width | Canvas | % | Buttons | Labelled | Mode | Overflow |
|---|---|---|---|---|---|---|
| 1920 | 1416×950 | 74% | 10 | **10** | desktop | no |
| 1600 | 1096×770 | 69% | 10 | **10** | desktop | no |
| 1440 | 936×770 | 65% | 10 | **10** | desktop | no |
| 1366 | 862×638 | 63% | 10 | **10** | desktop | no |
| 1280 | 776×582 | 61% | 15 | 0 | tablet | no |
| 1024 | 840×630 | 82% | 15 | 0 | tablet | no |
| 768 | 584×887 | 76% | 8 | 0 | compact | no |
| 390 | 390×698 | 100% | 8 | 0 | compact | scrolls (intended) |

The primary spec gap is closed: 1366 and 1440 now render a fully labelled row
(0 → 10 labelled buttons). Achieved compositionally — 11 shapes + 3 draw tools
collapsed into 2 labelled cluster triggers, and zoom moved to the bottom capsule
— not by fudging a threshold.

### A defect I introduced and then caught by measuring
My first threshold was `TOOLBAR_COMPACT_MAX_WIDTH = 760`, taken from the tablet
row's TOOLS width alone. But the toolbar root spans the viewport and the pinned
undo/redo/Export cluster costs 257px, so the scrollable row only gets
`viewport − 257`. The 13-icon tablet row measures **761px** and therefore needs a
**~1018px** container. Measured: 1024 fits with 6px spare, 1010 overflows.

Consequence of the bad constant: every viewport from 768px up got an overflowing
13-icon row (768px viewport → 511px of row for 761px of tools). Worse, my own
test asserted `768 → tablet`, so the bug shipped inside a *passing* test. Fixed
constant to 1020 and rewrote the assertions against measured boundaries
(`1024 → tablet`, `1010/768 → compact`). Re-audited: overflow gone at both widths.

Lesson applied: thresholds get measured against the element that actually
scrolls, and a passing test proves nothing if it encodes the same wrong premise.

## Gates after Stage A1
- `npx tsc --noEmit`: clean.
- `npm run test`: **182 files / 3521 tests, all passing** (baseline 3515; +6 new).
- Real-browser audit: 0 console errors at all 8 widths.


I cannot view PNG images in this environment (Read returns empty for every PNG;
confirmed with a fresh subagent on a known-good 72KB file). Screenshots alone
cannot be my verification. `scripts/editor-audit.mjs` was written to compensate:
it measures canvas share, labelled-vs-icon-only button counts, docked regions,
computed colors/shadows, overflow, and console errors at each viewport. Visual
sign-off by the user is still required for anything genuinely aesthetic.

## Stage A2 result — honest app bar (verified in a real browser)

Built `appBarLogic.ts` (pure, 16 tests) + `DocumentIdentity.tsx`, wired through
`EditorWorkspace` -> `StandaloneEditorShell`.

### The save indicator never fabricates
Per the user's decision, states derive ONLY from observed facts (`dirty = canUndo`,
an in-flight upload, or a COMPLETED export/upload). Live DOM probe at 1440x900:

| Moment | Rendered | `/all changes saved/` in body? |
|---|---|---|
| Fresh load | "No changes yet - This document has no edits yet." | **false** |
| After drawing a rectangle | "Unsaved changes - Your edits exist only in this browser tab." | **false** |

Undo went `disabled: true -> false` ("Undo Resize") at the same moment, so the
indicator genuinely tracks document state.

The **decay rule** is the subtle half: a completed export sets `Exported`, but one
further edit returns it to `unsaved`. An indicator that keeps saying "Exported"
while the document drifts from the file on disk is the same lie with a slower
fuse. `onPersisted` fires only AFTER a successful download/upload - never on the
failure path.

### Rename
Inline edit on the filename; Enter commits, Esc cancels, focus returns to the
trigger (an inline edit ending with focus on `<body>` loses a keyboard user's
place). Offered only in the `editing` stage - naming the onboarding placeholder
would imply the blank page is a document the visitor chose to create. Verified
absent during onboarding, present after "Create blank PDF".

`sanitizeDocumentName` matters because the name becomes `${name}-edited.pdf` in a
download: strips control chars, path separators, Windows-forbidden chars, leading
dots, trailing dot/space; bounds length to 120; suffixes reserved device names
(`NUL` -> `NUL-doc`) rather than silently failing the save.

### Two defects I introduced and caught
1. **Traversal survived sanitisation.** `../../etc/passwd` produced
   `".. etc passwd"` - I stripped only a *leading* dot, but separators had already
   become spaces, pushing the dots inline. Now any whitespace-delimited run of
   pure dots is removed. Caught by a test written to be adversarial, not
   confirmatory.
2. **My probe lied to me before the code did.** `main svg` matched the 18px
   **rulers**, so my "edit" was clicking a ruler, and I briefly believed `dirty`
   was not propagating. The canvas is `main [role="application"]`. A negative
   result from an unvalidated probe is not evidence.

## Gates after Stage A2
- `npx tsc --noEmit`: clean.
- `npm run test`: **183 files / 3537 tests, all passing** (+16 appBarLogic).
- One intermediate run reported 2 file-level errors + 15 skipped; re-ran twice at
  the same commit -> 3537/3537, 0 skipped. Environment memory-pressure flakiness
  (see `local-dev-environment` memory), not a code regression.
- Real-browser audit: 0 console errors; toolbar still 10/10 labelled at 1440.
