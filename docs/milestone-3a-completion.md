# Milestone 3.a — OCR Improvements (Completion Report)

**Status:** Complete — implemented, verified, documented.
**Date:** 2026-07-27 (retrospective doc; the work shipped in an earlier session)

M3.a improved the server-side OCR tool (`ocr-pdf`, backed by `ocrmypdf` +
Tesseract) with sensible always-on defaults, opt-in image-processing flags, and
validated language selection. The processor rides the same M2 queue + storage
pipeline as every other server tool (see [[server-tool-pipeline]]).

## What landed

- **Always-on Tesseract flags** (`lib/server/toolProcessing.ts` `ocr`):
  `--tesseract-oem 3` (LSTM neural net — Tesseract 4+ default, made explicit) +
  `--psm 3` (automatic page segmentation, robust default) + `--skip-text` (skip
  pages that already have text). These need no extra deps beyond Tesseract/
  ocrmypdf and improve accuracy out of the box.
- **Opt-in image-processing options** (off by default — they require Pillow,
  which may not be installed): `--deskew` (straighten crooked scans) and
  `--oversample N` (upscale low-DPI scans; clamped to 72–600, offered as
  0/300/400 in the UI).
- **Validated language selection**: `sanitizeOcrLang` drops any pack not in the
  installed whitelist and falls back to `eng`, preventing an ocrmypdf failure on
  an uninstalled language. Accepts a single pack or a `+`-joined multilingual
  combo (defensive for raw API callers).
- **Config-driven UI**: the `ocr-pdf` language/deskew/oversample selects are
  driven by `data/serverToolConfig.ts` `options` and rendered generically by
  `ServerToolRunner` — no OCR-specific client component.
- **5-minute timeout** on `ocrmypdf` (matches `pdfToImages`).

## Consolidation pass (this review)

- **Single-source language packs**: `OCR_LANG_PACKS` (code + label) now lives in
  `data/serverToolConfig.ts` and drives BOTH the `ocr-pdf` UI options AND
  `sanitizeOcrLang` (via `OCR_LANG_CODES`). Previously the list was hardcoded in
  two code places (the config + the sanitizer); now they can't drift. The
  Dockerfile/SERVER_SETUP/README apt lists remain prose (can't import a TS
  constant) but are documented as needing to stay in sync.
- **`ensureBinary("tesseract")`** added to the `ocr` processor (alongside
  `ocrmypdf`) so a missing Tesseract surfaces as a clear 503
  (`MissingDependencyError`) instead of a generic mid-run `CommandError` —
  consistent with the per-binary ensure pattern every other processor follows.
- **Unit tests** added for `sanitizeOcrLang` (single pack, unknown→eng, empty,
  `+`-combos, whitespace, sync with `OCR_LANG_CODES`).

## Files

- `lib/server/toolProcessing.ts` — `ocr` processor, `sanitizeOcrLang` (now
  exported), `OCR_LANG_CODES` import, `ensureBinary("tesseract")`.
- `data/serverToolConfig.ts` — `OCR_LANG_PACKS` / `OCR_LANG_CODES` single
  source; `ocr-pdf` language options derived from it.
- `lib/server/toolProcessing.test.ts` — `sanitizeOcrLang` tests (new).
- `lib/server/dependencyCheck.ts` — `tesseract` / `ocrmypdf` in the whitelist.

## Known follow-ups (not in scope for a consolidation pass)

- An admin who adds a language via the admin UI that isn't in `OCR_LANG_PACKS`
  gets a silent `eng` fallback (the processor validates against the static
  whitelist, not the runtime-merged config options). Coupling the sanitizer to
  the runtime config is a contract change left for a future milestone.
- `--oversample` is clamped server-side (72–600); the UI offers only 0/300/400.
  A raw out-of-range value is silently dropped (no oversample) rather than
  errored — defense-in-depth, acceptable.
- The Dockerfile/SERVER_SETUP/README apt pack lists are prose duplicates of
  `OCR_LANG_PACKS` (can't be consolidated with code); a comment in
  `serverToolConfig.ts` flags the sync requirement.

Related: [[server-tool-pipeline]], [[platform-architecture]].
