### 1. Starting state and recording inspected

Backup preceded fixes. The verified source archive is `pdfmaster-source-before-fixes-2026-09-06.tar.gz`, with its SHA-256 file beside this report. It contains the source, Git history, ignored local data and uncommitted files; only `.next` and `node_modules` were excluded. An earlier full snapshot reported disappearing development-cache files and is not the verified backup.

Original repository: `/Users/faisalarifi/Downloads/pdfmaster`; branch `production-acceptance`; HEAD and merge base `760821151f53b8c16ad19664244ae6295f35825a`; accepted ancestor `1b45f1b` present. Initial modifications: `.gitignore`, `CLAUDE.md`, `data/admin/store.json`, `package.json`, `scripts/tool-runtime-matrix-probe.mjs`, `scripts/workflow-completeness-probe.mjs`, `src/infrastructure/persistence/PrismaDocumentRecordRepository.ts`. Untracked: `docs/qa/p1/office-fixture.docx`, `docs/qa/p1/office-fixture.pptx`, `docs/qa/p1/office-fixture.xlsx`, and `scripts/mysql-schema.mjs`. A subsequent read found `scripts/phase1-workspace-reliability-probe.mjs` also modified.

With explicit user permission, the clean isolated copy began from that exact accepted commit on `recording-ui-ux-performance-closeout`, at `/Users/faisalarifi/Documents/Codex/2026-09-06/files-mentioned-by-the-user-0826/work/pdfmaster`. None of those original changes was absorbed or edited. Runtime code tip: `4777fb1bfedbb6d8a2a8a089596fa2772ec01224`. Later documentation-only commits are listed in the delivered commit manifest.

Correct recording: `/Users/faisalarifi/Movies/CapCut/0826(15).mp4`, 475.428571 seconds, 1114×720, 30 fps, video/audio streams. Audio was not evaluated. Reviewed whole-recording contact sheets at 15-second intervals, plus 115–120s at 2 fps, 162–163.2s at 10 fps, 207–210s and 209.5–212.5s at 4 fps, and native-sized frames around 162.2–162.5s. This is sampled visual review, not continuous playback or every-frame review of all journeys. The earlier `0826(14).mp4` is excluded.

### 2. Recording-derived audit

The audit was committed before implementation (`392c4c8`). Its initial findings are preserved below; final dispositions follow.

| Time | Surface | Severity | Classification | Finding / disposition |
| --- | --- | --- | --- | --- |
| 00:00–00:23 | Public home / menu | Medium | Visual/usability weakness | Repeated purple emphasis and dense secondary copy; inspect token ownership before any refinement. Hover menu intent needs live reproduction. |
| 00:23–01:26 | Edit, Watermark, Compress | Medium | Visual/usability weakness | Narrow task surface, weak file/result hierarchy, large unused areas. Keep real capability/privacy copy. |
| 01:26–01:40 | Account creation | Low | Visual/usability weakness | Narrow form against a large promotional surface; password-manager UI is external. |
| 01:40–02:00 | Workspace / document open | High | Performance symptom requiring measurement | Sparse center-loader precedes the editor skeleton. The global Workspace rail remains visible in the sampled transition; the entire application does not disappear. Replace editor fallback with reserved geometry. |
| 02:00–04:41 | Editor | Medium | Visual/usability weakness | Side surfaces consume canvas width; tool state and precision controls need clearer emphasis. Existing panel collapsing must be inspected before adding competing behavior. |
| 02:42.0–02:42.5 | Shape creation | High | Confirmed product defect | Dashed rectangle appears during drag, hexagon only after release. Fix actual geometry preview. |
| 03:27–03:30.25 | Eraser | High | Confirmed product defect | Contact removes the complete freehand object. Replace deletion with partial ink subtraction. |
| 04:41–05:03 | Blank editor / settings | Medium | Visual/usability weakness | Sparse entry state and small status controls; preserve existing onboarding actions. |
| 05:03–05:50 | Conversion | Medium | Performance symptom requiring measurement | Apparent waits need application traces. Native Preview/Pages and file pickers excluded from product latency. |
| 05:03–05:50 | Downloads / viewers | — | External/macOS behavior | Recording cannot establish whether an inline viewer was product-opened or user-opened. Do not relabel Download without checking implementation and live behavior. |
| 05:50–06:06 | Pricing | Low | Visual/usability weakness | Hierarchy can improve without changing prices, billing availability or plan claims. |
| 06:06–07:55 | Admin | Medium | Visual/usability weakness | Small form/row labels and long pricing forms; save feedback should remain visible and describe unsaved edits. |
| Entire | Accessibility / mobile | — | Not assessable from recording | Keyboard, screen reader, 200% zoom, forced colors, reduced motion and touch require independent tests; desktop mouse footage proves none of them. |


Implemented dispositions: actual shape previews; partial ink erasing; reserved editor import/open skeleton; focused canvas; clearer tool/result/auth/Workspace hierarchy; pricing dirty state and a functioning sticky save action. Code inspection additionally found the old bottom pricing SaveButton had no submit form or click handler; that reproduced wiring defect is fixed. Native transition frames show the global Workspace rail remains present, disproving the claim that the whole app disappears.

Unresolved dispositions: menu hover and download/viewer behavior need live reproduction; homepage/global emphasis, broad admin layout/table states, public pricing layout, precision/status readability and physical accessibility need further live assessment. External Preview, Pages, file pickers and password-manager overlays are not counted as product defects or latency.

### 3. Eraser root cause and fix

`EditorCanvas.tryErase` previously called `topmostErasableAt` and `RemoveObjectsCommand` on hits, including non-ink bounding boxes. Grouping history did not prevent document notifications during the drag.

`PartialInkGesture` now holds page-local ephemeral replacements for visible, unlocked DrawingObjects in visible, unlocked layers (including freehand highlighter). `eraseStroke` intersects stroke segments with swept capsules, splits survivors and preserves style, transform, page/layer and paint slot. Pressure widths are interpolated; constant-width smoothing is flattened with a 0.05-page-point tolerance; pencil jitter is compensated. Centerline fragments shorter than 0.05 page points are discarded as deterministic dust. No whiteout or annotation rasterization is used.

Text, images, shapes, signatures, rectangular highlights, forms and baked PDF content are excluded. Diameter control is 8–128 page points; the cursor uses the same radius multiplied by zoom. One release applies `EraseInkCommand` once; a near miss/cancel commits nothing, undo restores exact originals and redo exact fragments. Tests execute the canvas handlers and assert no canonical changes or notifications during movement. Serialization and PDF content-stream tests pass; Workspace publish/reopen is unverified.

Geometric limitation: stroke-width expansion uses the largest transform scale and segment endpoint width. It can erase beyond the circular footprint for anisotropic transforms or strongly changing pressure. Render fidelity of those cases still needs refinement and browser acceptance; the mandatory exact-footprint requirement is not fully closed.

### 4. Shape-preview root cause and fix

The old draft branch painted a generic SVG rectangle while `commitShape` constructed the actual geometry only at release. `resolveShapeDraft` now supplies the same canonical object to `InteractionLayer.ShapeDraft`/`ObjectRenderer` and commit, including fill, stroke, opacity, width, dash and polygon sides.

Reverse drags normalize bounds; Shift constrains box shapes or snaps lines/connectors to 45 degrees; Escape and pointer cancellation discard the draft. Click creates a visible default square sized at 18% of the smaller page dimension, bounded to 48–180 page points and clamped to fit the page. A quiet width × height label accompanies the preview; handles appear after commit. Future-shape controls are independent of selected-object edits. rAF updates stay outside canonical scene state.

Executed SSR geometry and handler tests cover real paths, style, reverse/Shift, edges, cancellation and preview/commit identity. They do not establish actual input-to-paint timing, touch behavior or frame-perfect browser rendering. Arrow retains the existing horizontal shape-in-a-box semantics; the label may need edge clamping after visual replay.

### 5. Loading-state system

- `AsyncStatus` defines idle/pending/success/empty/error/retrying/cancelled presentation with real optional page/byte/job progress. Text appears immediately; only the decorative busy mark waits 150 ms. Reduced motion stops its spin.
- `DocumentWorkbench` uses `EditorOpeningSkeleton` while importing/preparing the editor, keeping the surrounding Workspace shell and reserving header, toolbar, page and rail space. Filename remains visible.
- Local editor load reports actual reading/preparing/rendering phases and completed/total pages. The existing single document-load announcement includes the filename. Export uses a truthful indeterminate phase and filename.
- `Button` disables while loading. `usePdfProcessor` rejects duplicate submissions through an in-flight ref and retains a prior result after a failed retry.
- Pricing saves keep dirty/error context and disable fields/actions during a batch; successfully persisted plans are acknowledged individually even if a later save fails.

Existing Workspace load retries, save/conflict/revision states, publish and domain-specific job cancellation remain with their current owners. No fake cancel or progress was added. General route/admin-list loading and all requested async surface integrations are not finished; actual feedback/focus timing is unmeasured.

### 6. Performance work

Host: Apple M4 Max, Darwin 25.6.0, Node v26.7.0. The retained before/after experiment compares the new partial-eraser implementation before and after geometry caching on the same host and fixture. It is **not** accepted-baseline-vs-candidate browser evidence. The earlier JSON HEAD names the then-current audit commit while implementation edits were uncommitted; it is not an immutable artifact identifier for that implementation.

| Fixture (one page, 40 points/stroke, 100 swept samples) | Before geometry p95 ms | Final geometry p95 ms | Final max geometry ms | Final commit ms |
| --- | ---: | ---: | ---: | ---: |
| 20 smoothed strokes | 0.384 | 0.011 | 0.192 | 0.114 |
| 1000 smoothed strokes | 6.360 | 0.345 | 0.549 | 0.349 |

Optimizations: WeakMap rendered-geometry cache, per-page eligibility and bounding-box rejection, queued/coalesced pointer processing, isolated draft rendering, reuse of the initial PDF byte read, lazy thumbnail image decoding/loading. The geometry probe retains every raw sample.

| Required browser metric | Result |
| --- | --- |
| Stable shell/skeleton and document-to-shell | NOT EXERCISED |
| First page and first interactive edit | NOT EXERCISED |
| Result handoff | NOT EXERCISED |
| Shape/eraser input-to-painted-frame p95 and long tasks | NOT EXERCISED |
| Multipage thumbnails | NOT EXERCISED |
| Save/publish/export time-to-feedback | NOT EXERCISED |
| CLS, console/rejection/request/hydration errors | NOT EXERCISED |

The permanent `recording-ui-ux-probe.mjs` currently provides the CPU benchmark and explicitly unavailable browser fields, with verdict INCOMPLETE. It still needs a browser journey implementation and a multipage stress fixture. No under-50-ms paint, 100-ms feedback, 200-ms shell or CLS-under-0.1 pass is claimed. Page rasterization remains eager; lazy image decoding does not solve that bottleneck.

### 7. Editor UI/UX refinement

Focused canvas hides both local side panels and remembers the preference locally without altering document data. Existing panel controls restore access. The global Workspace rail remains. A named focus toggle uses the shared control-size helper; eraser size and future-shape settings are explicit.

Existing grouped toolbar, active/one-shot/pinned tool semantics, selection toolbar placement, inspector ownership and save-state subsystem were retained. Their earlier acceptance is historical; the newly added controls have not been measured at 1114×720 or narrow widths. Canvas area gain, selection-toolbar overlap, status hierarchy and precision-control readability are not accepted yet.

### 8. Public tools, Workspace, admin, pricing and auth

Tool pages use a tighter, left-aligned heading and stable task-card minimum height. Results emphasize output filename and align next actions; success announcements exclude the entire interactive action group. These are refinements, not reproduced functional defects.

Workspace prioritizes recent documents before folders and increases filename/metadata hierarchy. Auth uses a wider form surface and neutral application background. Plan prices, checkout/account recovery/email capability and privacy language were not invented or changed.

Admin pricing now saves the edited plan snapshots through the existing API; the formerly unwired bottom action is a real sticky Save changed plans control with dirty count, per-plan saves, pending disablement, partial-batch success tracking and retained errors. Destructive confirmation remains. General admin labels/statuses improve, but grouped navigation, standardized tables/filter/pagination and all long CMS forms still need a broader pass. Public pricing and homepage were not restyled in this candidate.

### 9. Accessibility and responsive verification

Structural/SSR checks cover accessible names, statuses, busy/disabled markup, quiet draft dimensions and reduced-motion classes. The skeleton introduces no second main landmark. These are implementation checks, not measured accessibility acceptance.

320, 390, 768, 1024, 1114, 1440 and 1920 CSS-pixel replay: NOT EXERCISED. Keyboard traversal, focus/skip link behavior, token contrast measurements, 200% zoom, forced colors, actual reduced-motion rendering and real touch/pen/screen-reader use: NOT EXERCISED. Pointer cancellation is covered in handler tests only. No claim of physical-device or human visual approval is made.

### 10. Tests added

The new/revised behavioral set contains 32 tests: eraser geometry/history/serialization 10; shape resolver and rendered geometry 9; actual canvas handlers with a controlled hook/rAF harness 4; async primitives/result retention/disablement 5; pricing snapshot/batch behavior 3; scene-reload PDF content-stream fidelity 1. The hook harness does not emulate browser layout or native pointer capture.

Final focused run adds the existing load, persistence-wiring and toolbar contracts: **9 files, 141 tests passed**. Two existing source-contract assertions were updated for the new progress callback and shared filename announcement; toolbar code was corrected to use the shared target-size helper. No new broad source-snapshot suite was added. Local serialized scene and real PDF export are verified; Workspace transport/publish/reopen remains unverified.

### 11. Browser replay of the recording

No new live journey completed. The server launch failed with `listen EPERM` on port 3107. Corrected Phase 3 and Phase 2 probes could not obtain Chrome debug ports; other browser probes could not reach the server. Therefore recorded shape creation, partial erasure, undo/redo, save/reopen, export, public/tool flow, Workspace and admin journeys at 1114×720 and 390×844 are all NOT EXERCISED. No after screenshots or screenshot acceptance is claimed.

### 12. Mutation testing

| Mutation | Gate that failed | Restoration |
| --- | --- | --- |
| M1 whole-stroke removal | `eraserGesture.test.ts`: 7 failed, 3 passed | Exact source restored; 10 passed |
| M2 rectangle-only shape preview | `shapeDraft.test.ts`: 5 failed, 4 passed | Exact source restored; 9 passed |
| M3 command per pointer move | `recordingGestures.test.ts`: 2 failed, 2 passed, including “M3: eraser pointer moves never notify persistence or change canonical state” | Exact source restored; 4 passed |
| M4 blank loading fallback | `asyncStatus.test.ts`: 1 failed, 4 passed | Exact source restored; 5 passed |
| M5 control clipped at 390 px | NOT EXERCISED: requires live geometry/reachability gate | Never applied |

Mutations were applied individually, reverted byte-for-byte, and rerun green. Exact logs and machine-readable summary are retained in the evidence archive. No mutation remains in the candidate.

### 13. Regression verification

| Gate | Exact current outcome |
| --- | --- |
| Focused tests | 9 files / 141 tests passed |
| Full suite | Attempted; stalled at the ingress socket test under bind restrictions; interrupted, exit 130; no full-suite pass |
| Supplemental suite, only `ingress/guard.test.ts` excluded | 14 files failed, 382 passed, 1 skipped; 4 tests failed, 7,404 passed, 162 skipped; 7,570 total reported |
| TypeScript `tsc --noEmit` | Passed, empty diagnostic output |
| ESLint | 0 errors, 7 warnings |
| Production build | Failed: Inter could not be fetched from Google Fonts; no new production artifact |
| Prisma generate | Completed, v6.19.3, isolated dependencies |
| Prisma validate | First run failed without DATABASE_URL; explicit local SQLite URL run passed; no migration or runtime DB acceptance |
| Phase 6 UI | Exit 2, environmental, no server; no scenario passed |
| Phase 5 workflow | Exit 1, no server |
| Phase 4 capability | Exit 1, no server; corrected positional-origin invocation |
| Phase 3 round-trip | Exit 1, Chrome debug port unavailable; corrected tsx invocation |
| Phase 2 save-state | Exit 1, Chrome debug port unavailable |
| Phase 1 Workspace | Exit 1, no server |
| Export fidelity browser probe | Exit 1, listen EPERM; distinct from the passing PDF content-stream unit test |
| Recording probe | CPU measurement completed; overall INCOMPLETE; browser metrics NOT EXERCISED |
| Static/security harness, offline, explicit local SQLite URL | 49 PASS, 11 MANUAL REVIEW REQUIRED, 19 ENVIRONMENTAL, 6 NOT EXERCISED; 85 rows; non-pass rows do not count as PASS |

The supplemental suite's four failures are: deployment artifact absent (`.next/standalone`), historical reconciliation evidence retaining absolute original-checkout paths, usage-readiness test expecting an untracked `.env`, and usage-readiness subprocess denied a tsx IPC socket. Eleven test files additionally fail Prisma migration setup. These files were not changed to suppress failures; no historical evidence was rewritten. The earlier static harness run without DATABASE_URL reported K4 as PRODUCT FAILURE; the separate schema validation and explicit-URL harness rerun are retained alongside it.

No API, schema, migrations, package/dependency, deployment, billing, authorization, privacy or security policy source was changed. Runtime security acceptance remains unverified; offline static checks cannot substitute for it.

### 14. Files changed

Implementation, tests and audit paths relative to the isolated repository:

- `components/admin/PricingManager.tsx`
- `components/admin/SaveStatus.tsx`
- `components/admin/pricingPersistence.test.ts`
- `components/admin/pricingPersistence.ts`
- `components/auth/AuthShell.tsx`
- `components/editor/EditorCanvas.tsx`
- `components/editor/EditorOpeningSkeleton.tsx`
- `components/editor/EditorToolbar.tsx`
- `components/editor/EditorWorkspace.tsx`
- `components/editor/ShapeControls.tsx`
- `components/editor/canvas/InteractionLayer.tsx`
- `components/editor/canvas/recordingGestures.test.ts`
- `components/editor/loadStatesContract.test.ts`
- `components/editor/panels/PagesPanel.tsx`
- `components/editor/persistenceWiring.test.ts`
- `components/tools/ResultActions.tsx`
- `components/tools/ToolPageTemplate.tsx`
- `components/ui/AsyncStatus.tsx`
- `components/ui/Button.tsx`
- `components/ui/asyncStatus.test.ts`
- `components/workspaces/DocumentWorkbench.tsx`
- `components/workspaces/WorkspaceDashboard.tsx`
- `docs/RECORDING_UI_UX_AUDIT.md`
- `hooks/usePdfProcessor.ts`
- `lib/editor/loadPdf.ts`
- `lib/pdf/render.ts`
- `scripts/editor-shape-draw-probe.mjs`
- `scripts/recording-ui-ux-probe.mjs`
- `src/application/editor/commands/EraseInkCommand.ts`
- `src/application/editor/export/recordingInteractionExport.test.ts`
- `src/application/editor/tools/eraserGesture.test.ts`
- `src/application/editor/tools/partialEraser.ts`
- `src/application/editor/tools/shapeCreation.ts`
- `src/application/editor/tools/shapeDraft.test.ts`
- `src/application/editor/tools/shapeDraft.ts`

Documentation closeout also appends `docs/PDFDADI_FEATURE_LEDGER.md` and `docs/PRODUCTION_GO_LIVE_CHECKLIST.md`, adds this report and concise `docs/evidence/recording-ui-ux/` JSON results. Large raw artifacts stay outside Git.

### 15. Commits and working tree

Runtime/audit commits in order:

```text
392c4c8 Document recording evidence and interaction root causes before fixes
d9e2f9c Subtract swept eraser capsules from canonical ink with exact undo
164b7a6 Preserve the editor shell during preparation and share truthful async feedback
744d55c Report real PDF loading phases and guard repeated local processing
22cfec6 Paint canonical shape drafts and expose focused canvas and ink controls
a975486 Make pricing changes persist through an accessible sticky save action
4945ba8 Improve task, result, authentication and recent document hierarchy
ea2d63b Cache ink geometry and verify fragment export with a reproducible probe
1f2fba2 Exercise canvas gesture handlers and preserve loading and toolbar contracts
4777fb1 Remove the unused loading icon import
```

The delivered `commits.txt` includes the final documentation-only commit and final HEAD. Final verification records a clean isolated working tree with no remotes. The source original remains untouched. Nothing was pushed, merged, tagged or deployed; Stage 15 did not begin. The incremental Git bundle requires accepted base `760821151f53b8c16ad19664244ae6295f35825a`; the patch provides the same cumulative reviewable changes.

Historical production reports and counts remain intact. This changed runtime tip supersedes the previously measured candidate for future acceptance; it requires a new build and fresh production acceptance.

### 16. Remaining limitations

Browser replay and measured responsive/a11y gates remain blocked. The eraser's conservative width/transform approximation requires additional fidelity work. Eager page rasterization, multipage performance, the full browser probe and M5 are unfinished. Shape edge-label placement and complete pen/touch/rotation/DPI interaction need live verification. Local geometry/serialization/export tests do not prove Workspace publish/reopen. Broad public/admin refinements and asynchronous-state coverage are partial. Full-suite and production-build acceptance are not green. Human visual and device acceptance have not occurred.

### 17. Verdict

RECORDING UI/UX CLOSEOUT INCOMPLETE — INTERACTION OR PERFORMANCE BLOCKERS REMAIN
