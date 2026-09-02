# Editor P1 Phase H — Ultra-premium single Inspector: implementation plan

**Status: READY TO IMPLEMENT.** Supersedes the blockers in
[editor-p1-phase-h-research.md](./editor-p1-phase-h-research.md). All three
blockers (B1/B2/B3) are resolved below with cited evidence. Every claim here was
verified by reading the file named; nothing rests on a subagent report.

Date: 2026-08-17. Predecessor: P1 Phase G (floating object toolbar), complete.
Brief: recovered from the session transcript (26,879 chars, requirements H1–H48).

---

## 0. Baseline correction — the suite is green

The handoff said "3650 passed, 15 skipped, 2 failing (OOM)". A full run with the
JSON reporter says otherwise:

```
npx vitest run --pool=threads --poolOptions.threads.maxThreads=3 \
  --reporter=json --outputFile=D:/Temp/vitest-h.json
```

| Metric | Value |
|---|---|
| Test files | **192** |
| Tests | **3665** |
| Passed | **3665** |
| Failed | **0** |
| Skipped / pending / todo | **0** |
| Suites | 933 passed / 933 |

Both previously-OOM files **passed** in this run
(`prisma/provision-workspaces.test.ts` 6 tests,
`AccountProvisioningService.test.ts` 9 tests). `lib/seo/publicBundles.test.ts`
ran **50 tests, not skipped**, because `.next/server/app` exists from an earlier
build — its `describe.skipIf(!built)` is the only conditional skip in the repo
(`publicBundles.test.ts:80-82`), and it is what produced the "15 skipped" in
earlier runs.

**Consequences for this phase, and they are strict:**

- The baseline is **3665/3665 green**, matching the brief exactly.
- The 2 OOM failures are **flaky under memory pressure**, not permanently broken.
  If they OOM again during verification, report them as *environmental flake with
  a green counter-example in this session* — do not report them as pre-existing
  failures, and do not report them as green without re-running.
- `publicBundles` skip count is **build-state dependent**. Run the suite *after*
  `npm run build` so those 50 tests execute, and state which it was.

---

## 1. Blocker resolutions

### B1 — `expectedRevision` for Restore: RESOLVED

The current document revision comes from **`GET /api/workspaces/{ws}/documents/{id}`**,
which returns the full record (`route.ts` GET → `documents.get(...)` →
`NextResponse.json({ document })`), and `DocumentRecord.revision` is a real field
(`DocumentRecord.ts:17`).

Why not the versions list: `versionHttp.ts:24` exposes a per-version `revision`,
but `VersionService.commit` writes the version row at `revision` and then advances
the document to **`revision + 1`** (`VersionService.ts:178`). So the newest
version's `revision` is always **one behind** the document's current revision.
Using it would guarantee a conflict on every restore. **Do not derive it from the
version list.**

Restore semantics confirmed (`VersionService.ts:350-400`): compare-and-swap on
`revision !== expected` → `DomainError` → **HTTP 409**
`WORKSPACE_OPERATION_REJECTED` (`workspaceHttp.ts:27`), with the message
"Document revision N does not match the expected revision M. Reload and retry."
Restore creates a **new** version (`origin: "restore"`,
`restoredFromVersionId`); it never rewinds. A `manifestDegraded` version is
refused outright.

**Design:**

- The Versions tab fetches the document record alongside the version list and
  holds `documentRevision`.
- Restore posts `{ organizationId, expectedRevision: documentRevision }`.
- On **409**: surface the server's message inline (it already says "Reload and
  retry"), keep the panel mounted, offer **Reload versions** which refetches both
  and clears the error. Never auto-retry — a silent retry with a refreshed
  revision would defeat the compare-and-swap the domain deliberately enforces.
- On success: refetch the list (a new version now exists) and announce via the
  existing live region.
- **Restore is disabled on the newest version** (H36) and on
  `manifestDegraded` rows, each with a `title` reason (H24).
- Wording must not imply a rewind. Row action label: **Restore**; helper on the
  confirm affordance: *"Creates a new version from this one. History is kept."*

### B2 — Italic representation: RESOLVED, no schema change

**Chosen: family-based italic.** No new field, `EDITOR_FORMAT_VERSION` stays **6**,
no migration — which is what the brief requires (schema/domain changes excluded).

The "family arithmetic" worry from the research doc is unfounded. The exporter
already derives the two axes **independently**
(`PdfExportService.ts` `resolveStandardFont`):

```
const bold = fontWeight >= 600 || /\bbold\b/.test(family);
const wantsItalic = /italic|oblique/.test(family);
```

Bold comes from `fontWeight` **or** a family token; italic comes from the family
token. So `fontWeight` remains the sole bold control and italic rides on the
family — they compose without conflict, and all four permutations already map to
real base-14 fonts (`Helvetica`/`-Bold`/`-Oblique`/`-BoldOblique`, and the Times
and Courier equivalents).

Vertical metrics are already posture-agnostic: `base14Family()`
(`textMetrics.ts:68-73`) classifies on the base family only, so toggling to an
oblique family cannot shift layout — every variant of a family shares one
ascender/descender, as documented there.

**Work required:**

1. `lib/editor/fontSubstitution.ts` — add two pure helpers:
   `familyIsItalic(family)` (mirrors `/italic|oblique/`) and
   `withItalic(family, on)` mapping within the base-14 matrix
   (`Helvetica ↔ Helvetica-Oblique`, `Helvetica-Bold ↔ Helvetica-BoldOblique`,
   `Times-Roman ↔ Times-Italic`, `Times-Bold ↔ Times-BoldItalic`, Courier
   likewise). `Symbol`/`ZapfDingbats` have **no** italic variant → return the
   input unchanged and report unsupported.
2. `components/editor/canvas/ObjectRenderer.tsx` — `TextContent` currently sets
   no `fontStyle` (confirmed at the `<text>` element, ~L147). Add
   `fontStyle={familyIsItalic(resolved.family) ? "italic" : undefined}` so the
   canvas finally slants. Same in `TextEditor.tsx`, which also calls
   `resolveFont`, so the live editing overlay agrees.
3. The **I** button toggles via `withItalic` on `fontFamily`; **B** keeps writing
   `fontWeight`. Disable **I** for Symbol/ZapfDingbats with a reason (H24).
4. The Font `<select>` keeps listing all 14 (unchanged) — B/I simply move the
   selection within the matrix, so the dropdown and the segmented control stay
   consistent.

**Underline and Justify are omitted entirely** — no disabled placeholders. H7/H10
list U and H11 lists Justify, but `TextDecoration` has zero renderer/export
references and `align` has no `"justify"` member (`objects.ts:218`). Building
either would be fake UI, which the brief forbids more strongly than it requests
the buttons. **This is a deliberate, reported deviation from H7/H10/H11.**

### B3 — Null `User.name` fallback: RESOLVED by existing precedent

No rule needs inventing. `src/application/services/memberDirectory.ts` already
solves this exact problem and is the pattern to reuse:

- `memberIdentities(userIds)` (L103) — one batched `prisma.user.findMany`,
  selecting **only** `{id, email, name}` ("never `passwordHash`"), best-effort:
  on failure it returns an empty map and the caller degrades to ids.
- `memberDisplayName(identity, userId)` (L129) — **name → email → `Unknown user ·
  {id.slice(0,8)}`**.
- `memberInitials(identity, userId)` (L138) — initials for the avatar, which H30
  asks for.

**Design:** resolve names **server-side** in the comments route using
`memberIdentities`, add `authorName: string | null` (+ `authorEmail`) to the
message response, and let `CommentsPanel` render
`memberDisplayName`/`memberInitials`. The panel's `authorName?: string` field
(`CommentsPanel.tsx:33`) already anticipates this. Batching matters: a thread with
30 messages must not issue 30 `getById` calls — the helper's own doc comment makes
this point.

`toCommentMessageResponse` (`commentHttp.ts:54-72`) is a **pure** function over a
`CommentMessage`, so identity is injected at the route/service layer rather than
by making the serializer async and DB-aware.

---

## 2. Non-blocking decisions

| # | Decision |
|---|---|
| 1 | **Skips:** 0 skipped in a post-build run; the only conditional skip is `publicBundles`. Report the build state alongside the count. |
| 2 | **Section collapse:** **session-only** React state, no `localStorage`. H4 asks for "stable state", not persistence; the dock preference is the one thing `useEditorPanels` persists and adding a second key invites divergence. |
| 3 | **Outline shape:** **keep flat + `depth`.** `?shape=tree` exists but the flat form already renders the indentation H33 wants; switching data shapes is churn with no visible gain. Outline **mutations stay out of scope** (H34 says expose Add only if supported — it is, but adding CRUD is a new feature, not Inspector polish). |
| 4 | **Aspect lock (H14):** **implement, panel-local.** No transform change needed: `setObjectSize(id, w, h)` (`EditorDocumentService.ts:275-288`) already takes both dimensions, so a locked edit computes the partner value from the current ratio and passes both in one call — one undo entry, no new command. Lock state is session-only panel state, default **on for images**, off elsewhere. |
| 5 | **X/Y (H25):** **implement** via `actions.moveSelection({x: dx, y: dy})` (`useEditor.ts:113`), committing a delta from the object's current `worldBounds` to the typed absolute value. No new service method. |
| 6 | **Page size name (H23):** new **pure** helper `describePageSize(w,h)` → `"A4"`, `"Letter"`, `"Legal"`, `"A3"`, `"A5"`, `"Tabloid"` within ±1pt, else `"Custom"`. Always show the exact `W × H pt` beside it, so the label can never overstate. |
| 7 | **Filename (H23):** the editor context has **no** filename (`UseEditorResult` lacks it) — it lives in `EditorWorkspace`. Pass it into the Inspector as an **optional prop**; when absent (standalone `/editor`) the Document block simply omits it. No context change. |
| 8 | **Version author name (H35):** same `memberIdentities` treatment as comments, applied to `createdById`. |
| 9 | **Preview / Compare (H35):** **omitted** — no endpoint. Reported. |

---

## 3. Work plan

### Stage 1 — Control system (H5, H6, H12, H26, H27)

`InspectorControls.tsx`: raise `CONTROL` from `h-7` (28px) to **`h-8` (32px)**,
the low end of the brief's 32–36px so Inspector density survives at 320px.
Normalize padding/border/radius/focus ring (indigo, H40) and disabled styling.
`LABEL` grows `w-[52px]` → `w-[58px]` for "Rotation"/"Opacity" (H6: avoid cryptic
abbreviations). Add:

- `NumberPairRow` — the 2-up grid for X/Y and W/H (H25).
- `SegmentedControl` — shared by B/I and alignment, with `aria-pressed` (H10) and
  real `role="group"` labelling (H11, H44).
- `InspectorSection` — one collapsible section: `<button aria-expanded>` +
  chevron, keyboard-operable, session-only state (H4).

**Invariant:** `ROW` keeps `min-w-0`; `CONTROL` keeps `min-w-0 flex-1`; no
`w-[NNNpx]` on any control. `propertiesOverflow.test.ts` asserts exactly these
and is height-agnostic, so 32px is safe.

### Stage 2 — Properties panel restructure (H3, H7, H13, H16–H19, H22–H25, H41, H42)

Rebuild `PropertiesPanel.tsx` on `InspectorSection`, preserving the
`primaryAffordance.allowsGeometry` gate exactly as-is:

- Contextual header (H3): `Text`/`Image`/`Shape`/`Drawing`/`Annotation`/
  `Signature`/`Original PDF text`/`Page`/`N objects selected` — replacing
  `Properties · {name}`, which H41 flags as a redundant heading.
- Text: `TEXT` (Font, Size, Weight, **B / I**, alignment segmented, Color,
  Line height, Tracking) → `POSITION & SIZE` (X/Y, W/H, Rotation) →
  `APPEARANCE` (Opacity, Background).
- Image: `IMAGE` (Replace, Crop as secondary buttons per H15) →
  `POSITION & SIZE` (+ **aspect lock**) → `APPEARANCE` (Opacity, Flip H/V).
- Shape / Drawing / Annotation / Signature: as the brief lists, real fields only.
  Signature keeps the exact "Visual signature (not cryptographic)." wording (H19).
- **Source text (H20/H21):** `ORIGINAL PDF TEXT`, a short preview, source
  font/size **only when known**, and actions **Copy text / Highlight / Comment**
  (all three already exist — `actions.addHighlight`, `actions.addAnnotation`,
  clipboard). No geometry, no opacity, no flip, no "Edit". Redact omitted (not
  real). The `aria-live` string stays derived from `resolveSelectionAffordance`
  so `sourceTextHonesty.test.ts` keeps passing.
- **Multi-select (H22):** count header, Align / Distribute / **Group** /
  Delete, shared Opacity. Group is real (`GroupService.group`, ≥2). No
  single-object properties.
- **No selection (H23):** `PAGE` — size name + `595 × 842 pt`, Rotation, and
  Rotate / Duplicate / Delete (real on `EditorDocumentService.ts:393-425`) —
  plus a small `DOCUMENT` block (page count, filename when provided).

### Stage 3 — Tabs, shell, document tabs (H1, H2, H28–H38, H45, H46)

- `EditorInspector.tsx`: indigo active text + 2px bottom indicator, neutral
  inactive, soft hover, consistent hit areas; keep every existing ARIA
  attribute and the roving-tabindex handler untouched. Sticky tab bar (H29) via
  the existing scroll container.
- `EditorWorkspace.tsx`: keep `w-[320px]`; **no** resize handle (H39 says don't
  expand scope). Pass `fileName` into the Inspector.
- Comments (H30–H32): avatar + real name + relative time ("2m", "Today, 12:42"),
  replacing the raw-ID render at `CommentsPanel.tsx:349` and the raw ISO slice at
  `:352`. Reply/Resolve/More only where already real. Empty state per H31.
- Outline (H33/H34): chevron + title + page number, existing indentation, current
  page highlighted using the `{currentPage}` already on the bridge. Empty-state
  copy stays honest.
- Versions (H35–H37): current-version badge, author name, origin label, local
  skeleton only (H37 — never remount the editor), Restore per B1.

### Stage 4 — Tests

New files, behaviour-asserting (no full-DOM snapshots):

| File | Covers |
|---|---|
| `inspectorSections.test.tsx` | section visibility per kind; collapse toggles + `aria-expanded` |
| `inspectorTextControls.test.tsx` | B/I toggling incl. the four permutations; **no** U/Justify in the DOM |
| `italicFamily.test.ts` | `withItalic`/`familyIsItalic` round-trips; Symbol/Dingbats unchanged |
| `inspectorGeometry.test.tsx` | X/Y commits a correct delta; aspect lock preserves ratio |
| `inspectorSourceText.test.tsx` | no geometry/opacity/flip/Edit; read-only label; actions present |
| `inspectorMultiSelect.test.tsx` | count header, shared ops only, no single-object fields |
| `inspectorPageState.test.tsx` | page size naming incl. Custom; real page actions |
| `pageSizeName.test.ts` | pure `describePageSize` incl. ±1pt tolerance |
| `commentAuthorNames.test.ts` | name → email → `Unknown user ·` precedence; batching |
| `versionRestore.test.tsx` | disabled on current + degraded; 409 surfaces message; no auto-retry |
| `inspectorA11y.test.tsx` | tablist/tab/tabpanel, labelled inputs, `aria-pressed` |

Extend `propertiesOverflow.test.ts` for the new grid rows.

### Stage 5 — Browser probes + screenshots (H48)

Extend the CDP scripts (no Playwright). Chrome at
`C:/Program Files/Google/Chrome/Application/chrome.exe`, `--headless=new`, fresh
port, 1600×900. Capture `h01`–`h12`. Scope DOM reads through
`[role="tablist"][aria-label="Inspector"]` → `aria-controls` (two tabpanels
exist). Hold clicks ~110ms. Use keyboard `D`/`R` for Draw/Rect (toolbar clusters).
For source text, click `main svg rect[fill=transparent]`. Measure Inspector width,
`scrollWidth === clientWidth` (zero horizontal overflow), control heights, tab
count/semantics, field visibility per kind, and console errors.

**I cannot visually decode the screenshots. The report will say so and state that
human visual review is still required** (the brief explicitly demands this).

### Stage 6 — Gates + report

`npx prisma validate`, `npx prisma generate` (EPERM while the dev server holds
the DLL is expected — report, don't "fix"), `npm run typecheck`, `npm run lint`,
the suite, `node scripts/next-build.js`. Then append **## Phase H — Inspector**
to `docs/editor-p1-premium-polish.md` covering every item the brief lists,
including omissions (U, Justify, Preview, Compare, outline CRUD, resize) and
anything unverified.

---

## 4. Invariants I will not break

1. **One** right Inspector; no second document dock.
2. `resolveSelectionAffordance` stays the single verdict for canvas + inspector +
   `aria-live`; source text keeps every P0 restriction.
3. Widening the window never shrinks the canvas.
4. `CommandHistory.revision` remains the export watermark — never `undoDepth`.
5. Never read `gestureRef` during render (Phase G); use the state mirror.
6. No `.skip`/`.only`, no weakened assertions, no lint/TS suppression; test count
   must not silently drop from 3665.
7. `EDITOR_FORMAT_VERSION` stays 6; no schema/domain changes.
8. No fake UI: if a capability isn't real, it isn't rendered.
9. No claiming a fix without testing the counterfactual.
