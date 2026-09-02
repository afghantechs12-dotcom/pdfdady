# M3.a–M3.d Review & Consolidation (Report)

**Status:** Complete — reviewed, consolidated, verified.
**Date:** 2026-07-27

A pre-M3.e review of the entire optimization layer (M3.a OCR, M3.b WCAG, M3.c
server-tool pipeline, M3.d batch/streaming/zip/virtualization/abort). Goal:
consolidate duplicated code, simplify abstractions, and make the layer cohesive —
without adding new functionality (gap-filling is left for M3.e+).

## How the review was done

Two read-only exploration agents mapped M3.a (OCR) and M3.b (WCAG) end-to-end;
M3.c/M3.d were reviewed directly (recent work). Findings were triaged into:
**consolidations** (duplicated code → single source), **simplifications** (dead
complexity removed), **cohesion fixes** (half-applied patterns made consistent),
and **out-of-scope gaps** (genuinely new functionality — noted, not done).

## Consolidations applied (duplicated code → single source)

1. **Web↔Node stream bridge** — the `toNodeWeb`/`NodeWebReadableStream` cast was
   copied in 3 places (`LocalFileStorage`, `R2ObjectStorage`,
   `PdfToolWorkerHandler`). New `src/infrastructure/storage/streamBridge.ts`
   exports `webStreamToNodeReadable` + `nodeReadableToWebStream`; all three now
   import them. 3 → 1.
2. **Terminal job-status set** — `TERMINAL = new Set(["completed","failed","cancelled"])`
   was redeclared in `PdfToolJobService` + the SSE progress route + the cancel
   route. Now `TERMINAL_JOB_STATUSES` lives on the `Job` domain entity and all
   three import it. 3 → 1.
3. **Tool error message map** — the errorType→user-message switch was mirrored in
   the server route (`failureResponse`) and the client (`terminalErrorMessage`),
   with one message already drifting ("unexpected" differed). New isomorphic
   `lib/tools/jobError.ts` exports `ToolJobErrorType` + `toolErrorMessage`; the
   route keeps only the HTTP-status map, the client calls the shared function.
   2 → 1 (messages can no longer drift).
4. **Cancel-poller + job scaffolding** — the temp-dir + AbortController +
   cancel-poller + try/catch/finally was duplicated across the single + batch
   handlers. Extracted `runToolJob(deps, job, ctx, body)` which sets up
   cancellation + cleanup once and runs the body; both handlers are now thin
   bodies over it. Guarantees every tool-job handler wires cancellation +
   cleanup identically. 2 → 1.
5. **OCR language packs** — `eng/deu/fra/spa` was hardcoded in both
   `toolProcessing.ts` (`OCR_LANG_PACKS`) and `serverToolConfig.ts` (the
   `ocr-pdf` language options). Now `OCR_LANG_PACKS` (code+label) +
   `OCR_LANG_CODES` live in `data/serverToolConfig.ts` (shared, isomorphic); the
   UI options are derived from it and `sanitizeOcrLang` imports `OCR_LANG_CODES`.
   2 code copies → 1.

## Simplifications

- `recordFailure` returned a `Promise<boolean>` that no caller used; simplified
  to `Promise<void>`.
- `PdfToolJobService.ToolJobErrorType` is now a re-export from
  `lib/tools/jobError.ts` (single definition) — existing imports from the
  service still work.

## Cohesion fixes (M3.b — made the pass consistent)

- **`role="alert"` + `aria-live="polite"` conflict** in `UploadDropzone` removed
  (`role="alert"` already implies assertive live; the polite override was
  contradictory).
- **Focus-visible rings** added to `ToolCard` and the nav `Link`s in `Header`
  (desktop + mobile) + `Footer` (column links + social) — siblings already had
  `focus-visible:ring-2`; these were the inconsistent ones.
- **Header mobile menu**: `aria-controls="mobile-menu"` added to the toggle +
  `id="mobile-menu"` on the panel (was `aria-expanded` without `aria-controls`).
- **Admin search/filter inputs** in `ToolsManager` (search, category select, MIME
  draft) got `aria-label`s (were placeholder-only).
- **Footer social `aria-label`** now uses readable names ("Twitter"/"GitHub")
  via a label map instead of the raw lowercase provider keys.
- **OCR `ensureBinary("tesseract")`** added alongside `ocrmypdf` so a missing
  Tesseract surfaces as a clear 503 (`MissingDependencyError`) instead of a
  generic mid-run `CommandError` — consistent with the per-binary ensure pattern
  every other processor follows.

## Tests added

- `lib/server/toolProcessing.test.ts` — `sanitizeOcrLang` (single pack, unknown
  → eng, empty, `+`-combos, whitespace, sync with `OCR_LANG_CODES`). 7 tests.

## Documentation

- `docs/milestone-3a-completion.md` — retrospective M3.a completion doc (the OCR
  work shipped earlier without one; now matches the convention of the other
  milestone docs).

## Out-of-scope gaps (noted for M3.e+ — NOT done, they are new functionality)

These are real findings but adding them would be new work, not consolidation:

- **M3.b — dialog semantics / focus trap / Escape** on the admin mobile
  slide-over (`AdminShell`) and the tool editor (`ToolsManager.ToolEditor`): no
  `role="dialog"`/`aria-modal`, no focus trap, no Escape-to-close, no focus
  restoration. (WCAG 2.1.2 / 2.4.3.)
- **M3.b — admin skip link + `main` id**: `AdminShell` renders its own `<main>`
  with no `id` and no skip link, so the public `#main` skip target is dead on
  `/admin/*`.
- **M3.b — a11y test suite**: no axe-core / jest-dom a11y matchers / keyboard
  tests exist.
- **M3.b — color tokens mixed with raw palette**: `text-success` vs
  `text-green-700`/`text-green-600`, `text-red-700`/`-600`/`-500`; `green-600`/
  `red-500` are contrast-borderline on tinted backgrounds. Consolidating to
  tokens is safe for same-value swaps but risky for the differing values
  (contrast regression) — left for a dedicated a11y pass.
- **M3.b — shared `Field` component**: two local `Field`s (`ContactForm`,
  `SaveStatus`) + inline labels per tool runner; consolidating into one shared
  labeled-`Field` is a sizable refactor across many files — left for M3.e.
- **M3.a — `sanitizeOcrLang` coupled to runtime config**: an admin-added
  language not in `OCR_LANG_PACKS` still silently falls back to `eng` (the
  processor validates against the static whitelist, not the runtime-merged
  options). Coupling it to the runtime config is a contract change (the
  processor would need the merged config) — left for a future milestone.
- **M3.a — Dockerfile/SERVER_SETUP/README apt pack lists** are prose duplicates
  of `OCR_LANG_PACKS` (can't be consolidated with code); a comment in
  `serverToolConfig.ts` flags the sync requirement.
- **M3.a — stale `.kiro` design note** still describes OCR as "coming-soon"
  Tesseract.js (predates the shipped `ocrmypdf` approach).
- **M3.c — `TOOL_OUTPUT_TTL_MS` location**: `lib/server/toolJobSubmit.ts`
  imports it from `src/infrastructure/jobs/PdfToolWorkerHandler` (a slightly odd
  dependency direction); minor, left as-is.

## Build verification (all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 16 warnings (pre-existing baseline) |
| `npm run test` | 105/105 passed (21 files) — +7 new (OCR) |
| `npm run build` | exit 0 |

## Files

**New (4):** `src/infrastructure/storage/streamBridge.ts`,
`lib/tools/jobError.ts`, `lib/server/toolProcessing.test.ts`,
`docs/milestone-3a-completion.md`, `docs/milestone-3a-d-review-consolidation.md`.

**Edited (consolidations):** `src/infrastructure/storage/LocalFileStorage.ts`,
`src/infrastructure/storage/R2ObjectStorage.ts`,
`src/infrastructure/jobs/PdfToolWorkerHandler.ts` (`runToolJob` wrapper,
`recordFailure` void, bridge import),
`src/domain/entities/Job.ts` (`TERMINAL_JOB_STATUSES`),
`src/application/services/PdfToolJobService.ts` (re-export `ToolJobErrorType`,
shared terminal set),
`app/api/jobs/[id]/progress/route.ts`, `app/api/jobs/[id]/cancel/route.ts`,
`app/api/tools/[slug]/route.ts` (shared `toolErrorMessage` + status map),
`components/tools/runners/ServerToolRunner.tsx` (shared `toolErrorMessage`),
`data/serverToolConfig.ts` (`OCR_LANG_PACKS`/`OCR_LANG_CODES`),
`lib/server/toolProcessing.ts` (shared lang codes, `ensureBinary("tesseract")`,
exported `sanitizeOcrLang`).

**Edited (cohesion):** `components/upload/UploadDropzone.tsx`,
`components/tools/ToolCard.tsx`, `components/layout/Header.tsx`,
`components/layout/Footer.tsx`, `components/admin/ToolsManager.tsx`.

The optimization layer is now more cohesive: the Web↔Node stream bridge, the
terminal-status set, the tool-error message map, the job-cancellation
scaffolding, and the OCR language list each live in one place; the M3.b pass is
consistent on focus rings + the alert/aria-live contract; the OCR processor
follows the same dependency-guard pattern as its peers. No behavior changed
except the unified "unexpected" error message (now "Processing failed. Please
try again." on both server + client) and the clearer 503 for a missing
Tesseract.

Related: [[server-tool-pipeline]], [[preview-architecture]], [[platform-architecture]].
