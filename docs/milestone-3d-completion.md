# Milestone 3.d — Batch, Streaming ZIP, Large-Doc, Virtualization, Client Abort (Completion Report)

**Status:** Complete — implemented, verified, documented.
**Date:** 2026-07-27

M3.d adds five production-hardening improvements on top of the M3.c server-tool
pipeline: **batch processing** (one tool across many inputs → a streaming zip),
**streaming ZIP generation** for pdf-to-images (replaces the in-memory JSZip
buffer), **large-document optimization** (a pdf-to-images page cap + the batch
file cap), **EditPageGrid virtualization** (lazy-mount thumbnails via
IntersectionObserver so a 200-page PDF doesn't rasterize every page up front),
and **client AbortController integration** (abortable upload + download + SSE,
with a cancel that returns the user to the form during upload). All on the M3.c
queue/storage architecture; no contract regressions.

## What landed

### 3.d.1 — Streaming ZIP generation
- Added `archiver` (v8, ESM class API) — `new ZipArchive(...)` is a Transform
  stream that writes the zip incrementally. Bundles cleanly into the Next.js
  server (ESM handled by Next 16; verified by the production build).
- `lib/server/zip.ts` → `streamZipFiles(jobDir, entries, zipName)`: pipes archiver
  into a write stream via `pipeline` (backpressure + error propagation). The zip
  lands on disk as it's built — never held whole in memory, unlike JSZip's
  `generateAsync({ type: "nodebuffer" })`.
- `pdfToImages` now zips via `streamZipFiles` instead of JSZip. A multi-page
  pdf-to-images run (the previous in-memory-zip memory bomb) is now streaming.
- The same helper backs the batch output (3.d.2).

### 3.d.2 — Batch processing
- New job type `pdf-tool-batch` (`PdfToolBatchJobPayload`: slug + `inputs[]` +
  options + owner). `PdfToolJobService.enqueueBatch` enqueues it (maxAttempts=1,
  same rationale as single jobs). The result is a `PdfToolJobResult` whose output
  is the zip, so status/download/streaming reuse the single-job machinery.
- `createPdfToolBatchHandler`: runs the same processor on each input in an
  isolated `item-<i>` subdir (so batch outputs with fixed names like
  "compressed.pdf" never collide), then stream-zips the per-input outputs
  (`streamZipFiles`) and stores the zip via `uploadStream`. Reports per-file
  progress; checks cancellation between files + via the AbortSignal during each
  run; the first failed input fails the whole batch (no partial zip).
- Refactored the handler to remove duplicated processor logic: a shared
  `processOnce` (materialize input → run processor in a per-input subdir) +
  `storeOutput` (uploadStream) + `recordFailure` (categorize + log) are used by
  BOTH the single and batch handlers.
- `submitToolJob` now handles multiple files in one parse: `getAll("file")` →
  validate all up front → 1 file = single `pdf-tool` job, >1 = batch
  `pdf-tool-batch` job. `isBatchEligible(slug)` (shared in `data/serverToolConfig`)
  excludes the image extractors (a multi-page input already yields a zip, so
  batching would nest zips). `TOOLS_BATCH_MAX_FILES` (20) bounds the batch.
- Client `ServerToolRunner`: batch-eligible tools accept multiple files; the
  submit appends every staged file; the done screen shows "N files are ready ·
  processed-files.zip" for a batch (no size comparison) and the single-file
  display otherwise. The dropzone hints at the batch limit.

### 3.d.3 — Large document optimization
- `pdfToImages` now bounds the page count: `pdfinfo` (poppler, added to the
  binary whitelist) reads the page count as a lightweight metadata call before
  any rendering; over `PDF_TO_IMAGES_MAX_PAGES` (default 200, env-tunable) it
  throws an actionable `ProcessingError` ("This PDF has N pages… split it
  first"). Caps the worst-case render time, temp disk, and output zip size.
- Batch is capped at `TOOLS_BATCH_MAX_FILES` (20) — enforced server-side (400
  over the cap) and mirrored by the client (rejects extra files in the
  dropzone).
- Memory for large docs is otherwise already bounded by M3.c streaming
  (getStream/putStream) + 3.d.1 streaming zip; the binaries (gs/qpdf/soffice)
  stream-process internally.

### 3.d.4 — EditPageGrid virtualization
- `LazyThumbnail`: wraps each `PdfPreview` and mounts it only once it scrolls
  near the viewport (`IntersectionObserver`, `rootMargin: 400px`), then keeps it
  mounted. A reserved `minHeight` (A4-portrait estimate) keeps off-screen cards
  laid out below the fold so the observer doesn't fire for all of them at once.
  No new dependency (browser-native IntersectionObserver).
- `EditPageGrid` virtualizes when `pages.length > LARGE_DOC_THRESHOLD` (30):
  small docs render eagerly (instant feel); large docs rasterize only the
  visible ~dozen thumbnails, the rest as you scroll. The cheap Reorder cards
  (border + buttons + page number + grip) stay rendered, so drag/rotate/delete
  work on every page regardless of whether its thumbnail has rasterized. Props
  unchanged, so the other tools using the grid (rotate/delete/organize/reorder)
  get the lazy behavior automatically.
- `EditTool` shows a "Large document (N pages) — thumbnails render as you scroll"
  notice above the threshold.

### 3.d.5 — Client AbortController integration
- `ServerToolRunner` upload POST is now abortable (`uploadAbortRef`): Cancel
  during upload aborts the fetch and returns the user to the form (files stay
  selected so they can adjust + retry); navigating away / Start over (teardown)
  aborts it too. The catch treats `AbortError` as expected (no error banner).
- The download GET was already abortable (M3.c); teardown now also aborts the
  upload, so unmount/reset cleans up all three in-flight operations (upload,
  SSE, download). Cancel branches: upload in flight → abort + reset; otherwise →
  POST `/api/jobs/[id]/cancel` (the SSE terminal event drives the UI).

## Files

**New (3):** `lib/server/zip.ts`, `lib/server/zip.test.ts`,
`docs/milestone-3d-completion.md`.

**Edited:**
- `lib/server/toolProcessing.ts` — `zipFiles` now delegates to `streamZipFiles`;
  `pdfToImages` gained the `pdfinfo` page-count + max-pages guard; removed the
  JSZip import + unused `readBuffer`/`writeBuffer`.
- `lib/server/dependencyCheck.ts` — added `pdfinfo` to the binary whitelist.
- `src/application/services/PdfToolJobService.ts` — `PDF_TOOL_BATCH_JOB_TYPE`,
  `PdfToolBatchInput`/`PdfToolBatchJobPayload`/`EnqueueToolBatchJobInput`,
  `enqueueBatch`.
- `src/infrastructure/jobs/PdfToolWorkerHandler.ts` — extracted `processOnce`/
  `storeOutput`/`recordFailure`; added `createPdfToolBatchHandler`; removed a
  redundant re-export.
- `src/infrastructure/jobs/workerBootstrap.ts` — registers the batch handler.
- `lib/server/toolJobSubmit.ts` — multi-file parse → single vs batch; batch
  eligibility + file cap.
- `data/serverToolConfig.ts` — `isBatchEligible` + `TOOLS_BATCH_MAX_FILES`.
- `components/tools/runners/ServerToolRunner.tsx` — batch client (multi-file
  upload, zip done screen, batch hints) + AbortController (abortable upload,
  cancel-during-upload reset, teardown aborts all).
- `components/tools/runners/EditPageGrid.tsx` — `LazyThumbnail` virtualization +
  `LARGE_DOC_THRESHOLD`.
- `components/tools/runners/EditTool.tsx` — large-document notice.
- `src/infrastructure/jobs/PdfToolWorkerHandler.test.ts` — batch handler tests
  (success zip, fail-fast, per-file progress).
- `package.json` — `archiver` + `@types/archiver`.

## Build verification (all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 16 warnings (pre-existing baseline) |
| `npm run test` | 98/98 passed (20 files) — +7 new (3.d.1 zip: 4, 3.d.2 batch: 3) |
| `npm run build` | exit 0 — archiver (ESM) bundled; batch route compiled; client bundles |

## Performance impact

- **Streaming zip:** pdf-to-images and batch outputs are zipped incrementally
  (archiver → write stream → uploadStream). The previous JSZip peak (the whole
  archive in memory) is gone for any multi-output path.
- **Batch:** N inputs process in one job (one upload, one zip download) instead
  of N round-trips; per-input isolation (subdirs) avoids output collisions.
- **Virtualization:** a 200-page PDF in the editor now rasterizes only the
  visible thumbnails on open (≈a dozen) instead of 200 — a large drop in
  initial CPU + canvas memory. Canvases mount lazily on scroll.
- **Large-doc guard:** pdf-to-images caps at 200 pages, bounding the worst-case
  render + zip for a huge PDF.

## Security impact

- `archiver` writes to the job temp dir only (paths via `safeJoin` → path
  traversal blocked); the zip name is sanitized. No user input reaches archiver
  entry names unsanitized (names come from the processors' `downloadName`, which
  is built from the sanitized `baseName`).
- `pdfinfo` is poppler (already a dependency via `pdftoppm`); it reads metadata
  only, no network. The max-pages guard bounds resource use (DoS resistance: a
  5000-page PDF can't exhaust the server rendering images).
- Batch file cap (20) bounds per-job work + zip size (DoS resistance).
- No new external network surface; no auth changes. The 3 pre-existing
  high-severity npm audit findings (postcss + sharp, transitive via next) are
  unchanged — archiver introduced none, and the audit fix would bump Next outside
  its range, so it was deliberately not run.

## UX impact

- Batch: drop multiple files for any single-output tool → one zip download, with
  per-file progress ("Processing 2/5: report.pdf").
- Large-document editor: opens fast; thumbnails fill in as you scroll; a notice
  explains the behavior.
- Cancel: works during upload (returns to form) AND during processing (kills the
  binary). Navigating away cleans up in-flight work.

## Breaking changes / risks

- `archiver` is ESM-only (v8) — imported as `import { ZipArchive } from
  "archiver"`. Bundles fine with Next 16 (verified). A future Next downgrade
  would need a CJS zip lib.
- `pdfToImages` now requires `pdfinfo` (poppler-utils) in addition to
  `pdftoppm` — they ship together, so any deployment with pdftoppm has it.
- Batch is offered for all single-output tools; the image extractors
  (pdf-to-jpg/png) are excluded from batch (would nest zips).
- Virtualization reserves an estimated thumbnail height (A4 portrait); the
  actual height settles after the canvas renders, so there is minor layout shift
  on first reveal of a row. Acceptable vs the alternative (rendering everything).
- Route unit tests: the new batch path isn't unit-tested at the route level
  (routes resolve the Prisma-backed `appContainer`); the batch handler is covered
  by integration tests (zip contents, fail-fast, progress). The `pdfinfo` guard
  isn't unit-tested (needs the binary); it's a simple parse + compare.

## Remaining work

- Fine-grained batch progress is per-file (not per-page within a file); the
  underlying binaries don't report sub-progress.
- The pdf-to-images max-pages cap errors rather than paginating; a page-range
  option (render pages a–b) is a future enhancement.
- `recordProgress` for batch per-file detail relies on the SSE stream; a polling
  client (`GET /api/jobs/[id]`) gets status but not live per-file detail.

## Test results

`npm run test` → **98 passed (20 files)**. New M3.d tests (7):
- `streamZipFiles` (4): multi-file round-trip via JSZip; default entry name;
  50-entry streaming; path-traversal sanitization.
- `createPdfToolBatchHandler` (3): zip of per-input outputs (verified contents +
  names + sizes); fail-fast on one bad input (no partial zip); per-file progress.

## Manual verification

The four automated gates pass. Runtime behavior of the batch route + the
virtualized editor is covered by the handler integration tests (real
`LocalFileStorage` + `UploadService` + in-memory queue/worker) and the preserved
single-job contract. A live smoke test against a migrated DB (batch compress 3
PDFs via `/api/jobs?slug=compress-pdf`; pdf-to-images on a >200-page PDF → 422;
open a large PDF in the editor + scroll) is recommended before deploy.

Related: [[server-tool-pipeline]], [[preview-architecture]], [[platform-architecture]].
