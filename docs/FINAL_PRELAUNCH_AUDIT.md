# PDFDadi — Final Pre-Launch Audit

Branch `final-prelaunch-audit`, cut from Phase 6 HEAD `651c8fa`. No remote is
configured and nothing was pushed or merged.

This document is the evidence record. Every number in it was produced by a command
in this repository, and each section names the command. Where a claim could not be
established on the audit host, the section says so instead of estimating.

---

## Entry Gate A — the Phase 5 probe discrepancy

**The claim under test.** Phase 5 reported `155/156`. The first reproduction of this
audit measured `149/156` on the same commit with no source change.

**The cause: configuration, not regression.** `scripts/workflow-completeness-probe.mjs`
was not modified between Phase 5 closeout and Phase 6 HEAD
(`git diff 651c8fa..HEAD -- scripts/workflow-completeness-probe.mjs` is empty at the
audit branch point). The difference is `PROCESSING_PIPELINE`:

| Run | Commit | `PROCESSING_PIPELINE` | Result | Log |
|---|---|---|---|---|
| 1 | `5a4adca` (Phase 5 closeout), clean worktree, fresh `npm ci` | `on` | **155/156** | `phase5-probe-at-5a4adca-clean-worktree-pipeline-on.log` |
| 2 | `651c8fa` (Phase 6 HEAD) | `on` | **155/156** | `phase5-probe-at-HEAD-pipeline-on.log` |
| 3 | `651c8fa` (Phase 6 HEAD) | unset — **the shipped default** | **149/156** | `phase5-probe-at-HEAD-pipeline-off.log` |
| 4 | audit HEAD, after the P1 fix below | unset — the shipped default | **152/156** | `phase5-probe-at-audit-HEAD-pipeline-off-postfix.log` |

`isProcessingPipelineEnabled` returns false for every slug but `compress-pdf`, and
false for that one too unless `PROCESSING_PIPELINE=on` or a
`unified_processing_pipeline` flag row says otherwise. No deployment file in the
repository sets either. So run 2 is the reproduction of the reported number and run 3
is the reproduction of **the product a user would actually get** — and the reported
figure was measured in a configuration that does not ship.

### The seven non-passes, each classified

| # | Probe row | Run 2 (`on`) | Run 3 (default) | Class | Run 4 (after fix) |
|---|---|---|---|---|---|
| 1 | `C: the cloud result reports the same success copy as a local one` | PASS | FAIL | **PRODUCT** | PASS |
| 2 | `C: the save answered with a canonical document id` | PASS | FAIL | **PRODUCT** | PASS |
| 3 | `N3: the new document downloads, and holds the same bytes that were saved` | PASS | FAIL | **PRODUCT** | PASS |
| 4 | `I': the completed job really did arrive reporting a non-PDF output` | PASS | FAIL | **PROBE DEFECT** | FAIL (still) |
| 5 | `I': Open in Editor is offered NOWHERE on the page` | PASS | FAIL | **PROBE DEFECT** | FAIL (still) |
| 6 | `I': neither Save to Workspace nor the destination selector is offered for it` | PASS | FAIL | **PROBE DEFECT** | FAIL (still) |
| 7 | `I: the SERVER's own 415 UNSUPPORTED_OUTPUT branch is unreachable on this machine` | FAIL | FAIL | **ENVIRONMENTAL** | FAIL (still) |

156 − 149 = 7 and 156 − 152 = 4 (rows 4–7), so the table accounts for every non-pass
in both runs.

**Rows 1–3 — one product defect, P1, fixed.** `POST /api/jobs/:id/save-to-workspace`
answered `404 "Job not found."` to every job whose row was not a `processing` job,
while `ServerToolRunner` — the result surface for all 14 server tools in the default
configuration — rendered `Save to Workspace` and posted to exactly that route. The
button was therefore offered on eleven tools and could not succeed on any of them
unless the pipeline flag was on. Fixed in `7facfae` by
`resolveSavableOutput`, which dispatches on the job shape using the same two gates
the legacy download already used (`legacyJobAccessDenied`, then
`PdfToolJobService.getStatus`) and converges on the shared destination
authorization; `app/api/jobs/saveToWorkspaceRoute.test.ts` gained 149 lines covering
both shapes. Run 4 shows all three rows passing in the default configuration with no
probe change.

**Rows 4–6 — one probe defect, with the two downstream rows mislabelled.** Journey I′
manufactures the non-PDF result this host cannot produce by retyping a completed
job's `outputMimeType` in the browser. Its hook patches `window.fetch` for
`/api/jobs/:id`, which only the pipeline reader calls
([useProcessingJob.ts:129](../hooks/useProcessingJob.ts#L129)). In the default
configuration a server tool runs through `ServerToolRunner`, whose terminal event
arrives over `EventSource("/api/jobs/:id/progress")`
([ServerToolRunner.tsx:249](../components/tools/runners/ServerToolRunner.tsx#L249))
and whose MIME is read from that frame — which no `fetch` hook can observe. The log
records `rewrites=0`, so the retype never happened, and rows 5 and 6 then asserted
the ABSENCE of `Open in Editor` and `Save to Workspace` on a page showing an ordinary
PDF result. Their own evidence strings list both controls, which is the correct
behaviour for a PDF. Phase 5's probe reported those two as `FAIL[PRODUCT]`: two
product failures that do not exist. This audit corrects the classification only — the
rows still fail, the count is unchanged at 152/156, and the class is now derived from
whether the interception actually landed. The behaviour they guard is proven by the
same three rows passing in runs 1 and 2, by `saveToWorkspaceRoute.test.ts`, and by
the capability record tests.

**Row 7 — environmental, and it stays that way.** Every tool whose output is not a
PDF is server-run, and on this host `soffice` is absent, so no genuinely non-PDF
result can be *produced* here for the route's 415 branch to refuse. This is a
property of the audit host, not of the product: the `Dockerfile` installs
libreoffice, ghostscript, qpdf, poppler-utils, tesseract-ocr and ocrmypdf, and
§3's runtime matrix proves each dependency separately rather than grouping them.
The branch itself is covered by `saveToWorkspaceRoute.test.ts`.

**Verdict on Gate A.** The discrepancy is explained and reproduced in both
directions. It was not a flake: the shipped default configuration contained a P1
defect that the reported measurement's non-default flag hid, plus a probe defect that
mislabelled two of its own rows as product failures.

---

## §4 — Visual acceptance

**Verdict: `VISUAL ACCEPTANCE PENDING`.** Full record:
`docs/evidence/final-prelaunch/visual/GATE-B-VISUAL-ACCEPTANCE.md`.

`node scripts/visual-acceptance-probe.mjs --url … --auth` drives 18 surfaces through
9 viewports — **156 captures**, every state reached by real uploads, real jobs and
real saves rather than injected markup — plus surface 19 (the error boundary) in its
own run against a deliberately broken `DATABASE_URL`. Result: **`PASS 156/156`**
(`visual-compare-5.log`), with `19-app-error` reported **NOT EXERCISED** against a
healthy server and never counted as a pass.

What the machine established, and the limit of it: the references exist, each
carries real text above a per-surface floor, the pixels do not move across runs or
across a rebuild that touched 28 files (147 of 156 rows bit-identical, 146 of them at
exactly 0 differing pixels), and a deliberate visible regression is caught by 230×.
Whether the product *looks right* is not established here and cannot be — no human
approval exists, and nothing in the evidence directory may be read as approval.

Three product defects came out of this gate, two of them invisible to the gate's own
pass/fail: **P2** — there was no root `app/not-found.tsx`, so every unknown public URL
got Next's framework 404 (no brand, no navigation, no way back, near-black under
`prefers-color-scheme: dark`), and both the 0.1% pixel compare and the 40-character
anti-vacuity floor passed that page nine times; only the contact sheet caught it
(fixed, `b29f79f`). **P3** — 27 pages branded their own titles under the root layout's
admin-editable `title.template`, rendering `"Page not found — PDFDadi — PDFDadi"`
(same commit). **P3** — three rows were green by luck, because `relativeTime()` output
was unmasked and baseline and compare both ran inside the same minute (fixed,
`223399b`).

Four harness rows described their own blind spot as a property of the product and are
classified **PROBE DEFECT**, all four fixed: surface 13 fed a PDF to an image picker
and reported NOT EXERCISED against a behaving product; surface 14 PATCHed a GET/PUT
route for a 405, compared the wrong revision domain, looked for a `[role="dialog"]`
the product renders as `role="alert"`, and blamed "an unwinnable race"; surfaces 16
and 17 captured the Workspace list under the names "sign in" and "register", because
`/login` and `/register` redirect a signed-in visitor. One scope defect is recorded
and deliberately NOT fixed: surfaces are reached once and then resized, so the
phone-width editor captures are of a demoted docked Inspector, not of a phone-first
paint — measured directly at 390×844, a first paint shows no drawer and no dialog.

**Mutation N.** [Hero.tsx:116](../components/home/Hero.tsx#L116), `mt-4` → `mt-16`
on the homepage `<h1>`, singly, through a real production build and the standalone
artifact: `PASS 0/9`, 23.08–36.33% of pixels differing at every viewport against a
0.1% threshold. Reverted with `git checkout -- components/home/Hero.tsx`, rebuilt,
rerun: `PASS 156/156`.

## §6 — Available-tool runtime matrix

`node scripts/tool-runtime-matrix-probe.mjs` drives every tool the product offers
through the real browser against the real deployment artifact, attaching a real
fixture and reading the bytes that come back out of the download the product itself
produces. Log: `docs/evidence/final-prelaunch/tool-matrix.log`; JSON:
`docs/evidence/final-prelaunch/tool-matrix.json`.

**Result: `PASS 29/29 exercised · PRODUCT FAILURE 0 · ENVIRONMENTAL 2 · NOT EXERCISED 3`**
(34 rows for 32 tools).

| Class | Rows | Why |
|---|---|---|
| PASS | 29 | The tool produced a file whose first bytes are the signature its output type requires, under the name the naming policy assigns |
| ENVIRONMENTAL | 2 | `pdf-to-word` and `html-to-pdf` need `soffice`, which is absent on the audit host (`which soffice` → nothing) |
| NOT EXERCISED | 3 | `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` — no committed `.docx`/`.pptx`/`.xlsx` fixture exists, so no input could be offered |

Dependencies were proven one at a time rather than grouped: `gs`, `qpdf`, `pdftoppm`,
`pdfinfo`, `tesseract` and `ocrmypdf` each resolve on this host (`which` reported a
path for each), and only `soffice` does not. The two ENVIRONMENTAL rows are
accompanied by a second row each that DOES run here: the refusal message a missing
binary produces is asserted to blame the server rather than the user's file and to
leak no path, stack, or command line. Both pass.

**The one product defect this matrix found is a P1, and it is fixed** — see §34.
`ocr-pdf` passed `--psm 3` to `ocrmypdf`, which rejects it
(`unrecognized arguments: --psm`), so every OCR request in every environment answered
"Processing failed. The file may be unsupported or damaged. Please try a different
file." about a perfectly valid PDF. Fixed in `46baf5e`; the row now reads
`[PASS] ocr-pdf 56235 bytes, starts "%PDF", named multipage-fixture-ocr.pdf`.

## §10 — File and processing security: the upload ceilings

`docs/evidence/final-prelaunch/upload-ceiling.log` records both directions of this
one at runtime, against the real artifact behind the real TLS front.

**P1, fixed.** Every advertised upload ceiling in this product was unreachable by a
factor of ten, and the refusal blamed the user's file. `proxy.ts` is Next 16's
renamed middleware, and its matcher covers `/api/*`; that makes Next clone the body
of every API request, and the clone is capped by `DEFAULT_BODY_CLONE_SIZE_LIMIT`
(10 MiB) in `next/dist/server/body-streams.js`. Past that the body is truncated
silently — the only trace is a `console.warn` on the server — so
`request.formData()` threw and the route answered
`400 "Malformed multipart body."` about a perfectly valid PDF.

| Body | Phase 6 HEAD (limit unset) | Audit HEAD (`120mb`) |
|---|---|---|
| 10.000 MiB | `401` — parsed, reached auth | `401` |
| 10.004 MiB | **`400 Malformed multipart body.`** | `401` |
| 22 MiB (the perf fixture) | **`400`** | **`401` — parsed** |
| 60 MiB | **`400`** | **`401` — parsed** |
| 101 MiB | `400` | **`413 PAYLOAD_TOO_LARGE "Upload too large."`** |

The 10 MiB boundary was bisected to 4 KiB (`401` at `10485760`, `400` at
`10489856`), and a JSON body on a route that parses before it authorizes fails the
same way at the same size, so this was the proxy's clone rather than anything in the
upload route. The advertised ceilings it blocked are
`DOCUMENT_INGESTION_LIMITS.maxUploadBytes` = 100 MiB and the jobs route's own
110 MiB.

Fixed in `a14e7c1` by `experimental.proxyClientMaxBodySize: "120mb"` in
`next.config.mjs` — above both ceilings, so the ceiling a user is told about is the
one that refuses them, and the refusal is the product's honest 413. The 101 MiB row
is refused on `content-length` before the body is buffered.

**Pinned by test, not by memory.** `proxy.test.ts` gained
`describe("proxy — the body-clone limit clears every advertised upload ceiling")`:
it parses the configured size the way `bytes` does, reads
`DOCUMENT_INGESTION_LIMITS` and the jobs route's own literal from source, and
asserts the clone limit exceeds both — so raising a ceiling later without raising
the clone limit is red. It also asserts the matcher still covers the upload routes,
because the day `/api/*` leaves the matcher is the day this knob stops mattering and
the test should be re-read rather than silently still passing. R16.

**Mutation R16.** `experimental.proxyClientMaxBodySize` deleted from
`next.config.mjs`, singly: `AssertionError: next.config.mjs must set
experimental.proxyClientMaxBodySize: expected undefined to be defined`,
`Tests 1 failed | 25 passed (26)`. Reverted with `git checkout -- next.config.mjs`
(the fix was committed first, precisely so the revert could not destroy it), and the
26 pass again.

## §14 — Database and migrations

`node scripts/migration-restore-drill.mjs` — **`PASS 13/13`**. Log:
`docs/evidence/final-prelaunch/migration-restore-drill.log`.

The drill never touches the live database: every path is inside a fresh `mkdtemp`
directory that is removed on the way out. It rehearses the upgrade a launch actually
performs, on a database that already holds documents:

1. The first 22 migrations build the **pre-Phase-5** schema (40 tables;
   `workspace_save_intents` absent), and `prisma migrate resolve --applied` records
   them the way Prisma's own baselining does, so the migration under test runs
   against bookkeeping the script did not invent.
2. The database is **populated** — organization, membership, Workspace, document
   record at revision 5, two versions, an ingestion.
3. `prisma migrate status` names `20260902100000_add_workspace_save_intents` as
   pending rather than reporting a clean database.
4. `prisma migrate deploy` applies it (exit 0).
5. A content checksum over every populated table — ordered by primary key, read
   column by column — is **identical before and after** (`923f4caa3637ec24…`), so no
   row was rewritten or dropped. The document still reports
   `{"name":"Quarterly report.pdf","revision":5}`.
6. `migrate status` afterwards reports no drift and nothing pending.

An empty-database `migrate deploy` proves only that the SQL parses. This is the
distinction the drill exists for.

## §15 — Backup and restore

The same drill continues into the restore rehearsal, and it is the online backup API
rather than `cp`: copying a live SQLite file can capture a torn page.

7. `node:sqlite`'s `backup()` writes **950272 bytes (232 pages)** while the database
   is open.
8. Data is then destroyed the way a bad afternoon does it — `DELETE FROM
   document_versions; document_ingestions; document_records` — and the drill proves
   the destruction landed (`0 document record(s) left`, and the content checksum no
   longer matches).
9. The backup's content checksum **matches the pre-destruction checksum exactly**
   (`923f4caa3637ec24…`), so the restore returns the Workspace as it was rather than
   merely returning a file that opens.
10. `prisma migrate status` against the restored file reports migration head — the
    restore lands at the current schema, not at the schema it was baselined from.

The recovery path is therefore: keep the `backup()` output, and restoring it is the
whole procedure. No step of it was inferred.

## §25 — Deployment artifact

`next build` with `output: "standalone"` produces `.next/standalone/server.js` plus a
pruned `node_modules`. **It does not copy `.next/static` into that directory**, so a
standalone server started from a bare `.next/standalone` answers 404 to every
`/_next/static/chunks/*.js` and the application never hydrates: the page renders,
and nothing on it works.

This audit hit that failure and mistook it for a product defect for one probe run —
every tool reported "was still disabled after a valid upload", because
`Object.keys(fileInput)` was `[]`, because React had never adopted the DOM. The
diagnosis is recorded here because it is the most likely way a first deployment of
this repository fails, and it is silent.

**The container artifact is correct.** [Dockerfile:55](../Dockerfile#L55) copies
`.next/static` explicitly, and [Dockerfile:48-54](../Dockerfile#L48) records that
this repository has no `public/` directory, so nothing else is missing. A
`docker build` of this repo therefore produces a working image; the gap bites only a
hand-rolled host deployment that copies `.next/standalone` alone.

One operational detail worth writing into the runbook: **a Next.js standalone server
resolves its static directory at startup**. Copying `.next/static` in after the
process is running does not take effect — the server must be restarted. That is why
`scripts/restart-origin` style restarts in this audit always re-copy and then start,
in that order.
