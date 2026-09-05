# Recording UI/UX audit — 2026-09-06

## Starting evidence (before implementation)

Original repository: `/Users/faisalarifi/Downloads/pdfmaster`, branch
`production-acceptance`, HEAD and merge base `760821151f53b8c16ad19664244ae6295f35825a`.
Accepted code ancestor `1b45f1b` is present. Original tree was dirty. The user
explicitly authorized an isolated copy from the accepted commit. This copy began
clean on `recording-ui-ux-performance-closeout`; its local clone remote was removed.
The original checkout is not modified by this work.

A full backup encountered disappearing `.next` development cache files. A second
source backup including Git history, ignored local data and uncommitted files,
excluding only `.next` and `node_modules`, completed and its tar manifest and
SHA-256 were verified outside the repository. No backup contents are committed.

Correct recording: `0826(15).mp4`, duration 475.428571 seconds, 1114×720, video
and audio streams present. Audio was not evaluated. The first supplied `0826(14)`
was a different 200.899048-second recording and is not the basis of this audit.
Reviewed: whole-recording contact sheets sampled at 15-second intervals; close
sequences at 115–120s (2 fps), 162–163.2s (10 fps), 207–210s (4 fps), and
209.5–212.5s (4 fps). These are sampled visual inspections, not continuous playback
or a claim to have inspected every frame of the seven-minute recording.

## Findings and initial disposition

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

## Root causes established before changes

`components/editor/EditorCanvas.tsx:tryErase` calls `topmostErasableAt`, then
`RemoveObjectsCommand` for every hit. That hit tester explicitly includes
non-drawing objects by bounding box. Transactions group history but canonical
state and service notifications still change during pointer movement.

The same file's shape draft render branch unconditionally returns an SVG `rect`
with draft tint/dash. It never calls `ObjectRenderer` / `shapePathData` for the
selected shape. `commitShape` separately creates the canonical shape, explaining
the visual swap on release.

## Interaction pipeline

`EditorCanvas` converts client positions through `screenToPage` and
`unrotatePagePoint`; SVG applies the matching page rotation and viewport transform.
DPR does not enter CSS-pointer coordinates. Each freehand gesture is one
`DrawingObject` polyline with optional pressure widths, smoothing and brush;
freehand highlighter is a drawing brush. Rectangular highlights, shapes, text,
images, signatures and annotations are distinct canonical kinds. PDF backgrounds
are separate rasters, not editable ink.

`useEditor` factories create canonical objects; `EditorDocumentService.execute`
applies commands via `CommandHistory` and notifies subscribers. History snapshots
and persistence consume document changes, so ephemeral gestures must avoid service
commands until release. Page layer ID arrays own paint order. Existing removal
undo appends objects; partial replacement needs exact layer-position restoration.

Local drafts and Workspace scenes serialize the same document model. Workspace
publish exports bytes and the captured scene/revision together. `ObjectRenderer`
and `PdfExportService` share `shapeGeometry` and `deriveDrawingRender`. Fragment
geometry must retain that contract, including smoothed/pressure/pencil ink.

## Async inventory before changes

Times below are **unmeasured**, not zero. The local server launch was denied by
the execution sandbox (`listen EPERM`, port 3107); no browser baseline is claimed.

| Trigger / owner | Known progress and presentation | Cancellation / threading / repeated work |
| --- | --- | --- |
| Route / AppShell, DocumentWorkbench dynamic import | Generic editor import fallback; no measurable percentage | Import cannot be cancelled; preserve shell |
| Tool selection/upload / tool and job clients | Local file selection or real network upload; job polling knows server state | Cancel only where abort is implemented; FileReader/worker boundaries require runtime trace |
| Local PDF / loadPdfIntoEditor | Reading, PDF.js initialization, sequential page rasterization and text extraction | All page backgrounds currently eager; PDF.js worker parses, canvas raster work still costs client resources |
| Editor thumbnails / PagesPanel | Page-specific thumbnail rendering | Inspect existing viewport observation before changing it |
| Result handoff / StandaloneEditorShell | Handoff claim then local open | Existing identity/claim fencing must remain intact |
| Workspace load / loadWorkspaceDocument, EditorWorkspace | Content fetch, scene fetch, preparation polling, page skeleton; retry/error classification already exists | AbortController fences superseded loads; verify repeated parsing with traces |
| Local/Workspace draft / persistence coordinator | Pending/saved/offline/conflict states | Revision and CAS boundaries already owned by persistence; no per-pointer draft notifications allowed |
| Publish / DocumentWorkbench | Export then publish version | Preserve captured revision/scene; no fake percentage or cancellation |
| Export / EditorWorkspace | Boolean exporting and retained document on failure | Client export; no real progress percentage/cancel |
| Admin lists / managers | Loading/empty/error vary by owner | Fetch-owned errors; no general cancellation claim |
| Admin mutation / SaveStatus and managers | Saving/saved/error; dirty context inconsistent | Prevent repeat submit while saving; retain form on failure |

## Acceptance status

Implementation and measured acceptance are separate. Browser input-to-paint,
CLS, shell timing, publish/reopen and physical device/screen-reader gates remain
open until actually run. Historical production evidence remains historical.
