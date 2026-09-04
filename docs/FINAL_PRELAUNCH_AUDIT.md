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

**One row in that table fails twice in this report, for two unrelated reasons, and
§7 describes the second one.** Row 3 (`N3`) is classified **PRODUCT** here and went
green at run 4 on the P1 legacy-save fix — that classification stands. Later, in the
from-scratch worktree runs, `N3` failed *again* with `status 409`, and that second
failure was the probe's: the content route answers `409 CONTENT_UNAVAILABLE` with
`preparation: "processing"` while ingestion finishes, and the probe read the status
without the body. Fixed in the probe at `eb8f7fa`. Two consequences worth stating
rather than smoothing over: run 4's `N3 PASS` was recorded *before* that race was
understood, so it was a pass the racy probe happened to give; and the deterministic
evidence for `N3` is the post-`eb8f7fa` runs — `fresh-env-final.log` (155/156 on both
legs) and the final-HEAD rerun in `probes-at-388e8af.log`.

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

## §1 — Launch profile

What kind of product is being launched, read off the code rather than assumed. The
full table is `docs/evidence/final-prelaunch/LAUNCH-PROFILE.md`; the shape is:

| Dimension | What ships |
|---|---|
| Commercial | three plans, one purchasable (`free`). Paid requires all three of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`; any other count → `billing.enabled = false` and a 503 on checkout. `business` is unpurchasable by domain law (no price slot exists) |
| Accounts | open public registration, no invite or approval. **No email verification. No password recovery.** Session 30 days; signup 10/hour, login 10/minute |
| Data platform | SQLite, enforced at boot. Storage `local\|r2`, half-configured refused. Queue `memory\|redis` |
| Processing | 32 available tools; 14 server-run; the toolchain is six binaries plus LibreOffice |
| Observability | first-party only: JSON logs to stdout, no error-monitoring backend, no metrics sink (§17) |
| Retention | 1 h tool outputs, 15 min sweep, 30-day save intents, 30-day sessions (§13) |
| Support | one `mailto:` (§24) |

Eight items in the profile are **`LAUNCH DECISION REQUIRED`** — free-only vs paid;
whether free stays free; launching without password recovery; domain/DNS/TLS; markets
and currency; where stdout is collected and for how long; backup schedule and off-host
destination; and whether the one support inbox is monitored. §37 consolidates these
with the five the later sections add. None is a code defect, none blocks a build, and this audit does not
invent an answer for any of them.

## §2 — Baseline reproduced

The branch was cut from Phase 6 HEAD `651c8fa`. The baseline was reproduced in a
**detached worktree at Phase 5 closeout `5a4adca`** with nothing carried over —
`node_modules` absent before `npm ci`, `.next` absent before the build
(`clean-worktree-5a4adca-npm-ci-build-probe.log`):

```
npm ci        → added 371 packages, audited 372 in 18s, exit=0
                10 high severity vulnerabilities  (carried into §12)
prisma generate → Prisma Client v6.19.3, 72ms
```

That run is what made Gate A decidable: the same commit Phase 5 measured, installed
and built from the lockfile alone, reproduced Phase 5's `155/156` with
`PROCESSING_PIPELINE=on` and `149/156` without it. §5 repeats the whole procedure at
**final** HEAD, because a baseline reproduction is not a substitute for it.

## §3 — Phase 5 reconciliation

All seven non-passes are classified in **Entry Gate A** above, with the four-run
table that produced them. In summary: one **P1 product defect** (`Save to Workspace`
answered 404 for every non-`processing` job, so the button was offered on eleven
tools and could not succeed on any of them in the shipped configuration — fixed in
`7facfae`), one **probe defect** with two rows that Phase 5 had reported as product
failures and that were not, and one **environmental** row (`soffice`).

**Update at final HEAD `eb8f7fa`.** Rows 4–6 no longer fail. Entry Gate A's table
records them as "FAIL (still)" as of run 4, and the reason was named there: the
retype hook could only see the polled `/api/jobs/:id` response, while the shipped
default's terminal frame arrives over `EventSource`. That hook now handles both
frame shapes, and journey I′ arms on the shipped default for the first time —
`rewrites=1`, all four I′ rows passing against real product behaviour. The current
run on the configuration that ships is **155/156 with zero product failures and zero
probe failures**; the single remaining row is row 7, still environmental
(`workflow-probe-final-default.log`, §7).

So the reconciliation ends where it should: the reported figure was measured in a
configuration that does not ship, the shipped configuration was genuinely worse, and
it is now equal — 155/156 — with the difference between the two runs being one
missing system binary rather than one hidden defect.

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

## §5 — Fresh-environment reproducibility

**Verdict: `PASS`.** Evidence: `docs/evidence/final-prelaunch/fresh-env-final.log`
(run `/tmp/audit-fresh-final3.sh`, HEAD `eb8f7fa`, 2026-09-03T23:15Z–23:24Z).

The question this group answers is narrow and worth stating precisely: can a person
who has only this repository and its lockfile — no `node_modules`, no `.next`, no
`.env`, no database, no `DATA_DIR` — reach a running product using the documented
commands? Everything below was measured in a **detached worktree at final HEAD**
with all four of those confirmed absent first.

| Step | Command | Result |
|---|---|---|
| R4 install | `npm ci` | **exit 0**, 371 packages from the lockfile alone |
| R4 client | `prisma generate` | **exit 0**, Prisma Client v6.19.3 |
| R5 migrate | `prisma migrate deploy` onto an **empty database file** | **exit 0**, `All migrations have been successfully applied` — **23** migrations recorded, **42** tables created |
| R4 build | `npm run build` | **exit 0**, `BUILD_ID ru-Ap-qQ5xfFzGqKIfgYn`, standalone server present |
| boot (shipped default) | `env … node .next/standalone/server.js` | `/api/health` **200**, `/api/health/ready` **503 degraded — toolchain false** |
| workflow probe, default | `workflow-completeness-probe.mjs` | **155/156**, `PROBE_EXIT=0` |
| boot (`PROCESSING_PIPELINE=on`) | same, one variable added | `/api/health` **200**, ready **503 degraded — toolchain false** |
| workflow probe, pipeline-on | same probe | **155/156**, `PROBE_EXIT=0` |

Three things in that table are load-bearing.

**The exit codes are the commands' own.** An earlier version of this script wrote
`npm ci 2>&1 | tail -25; echo "exit=$?"`, which records `tail`'s status — it would
have printed `exit=0` for a failed install. Every exit code above is read with
`${PIPESTATUS[0]}`. This is stated because the alternative is evidence that cannot
fail.

**The migration chain applies to a blank file, not just to an already-migrated
one.** 23 migrations, 42 tables, from a database file that did not exist when the
run started. R6 — the same chain onto a *populated* database, preserving data — is
separate and is recorded in §14.

**Both configurations now agree.** The shipped default and
`PROCESSING_PIPELINE=on` reach the identical 155/156 with `PROBE_EXIT=0`. That
equality is the substantive outcome of this audit's entry gate: the two legs
differed by 6 rows when the audit opened (§3), and they do not differ now.

The single non-pass, in both legs, is the same row and it is not a defect:

```
FAIL[ENVIRONMENTAL]  I: the SERVER's own 415 UNSUPPORTED_OUTPUT branch is
unreachable on this machine — every non-PDF-output tool is server-run and its
binary is absent (soffice), so no genuinely non-PDF result can be PRODUCED here.
```

Readiness reporting **503 degraded** in a fresh environment is correct behaviour,
not a fresh-install failure: the toolchain binaries are host software, not npm
packages, so a machine that has never had LibreOffice installed cannot become
ready by installing this repository. §16 and §23 cover what that costs a deploy;
what matters here is that the fresh install says so out loud rather than reporting
ready and failing later.

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

**Re-run at final HEAD** (`tool-matrix-final.log` / `.json`, BUILD_ID
`Y8FTkWwDAOHlzSbHMICnZ`), because the `ocr-pdf` fix landed after the first matrix and
an old matrix cannot describe a new artifact. The result is identical row for row:
**29/29 exercised, 0 product failures, 2 environmental, 3 not exercised, 34 rows for
32 tools**, with `ocr-pdf` at the same 56235 bytes. Host binaries as measured by the
probe's own header: `gs=present qpdf=present pdftoppm=present pdfinfo=present
tesseract=present ocrmypdf=present soffice=absent`.

## §7 — Core workflow acceptance

**Verdict: `PASS`** — 155/156, zero product failures, zero probe failures, on the
configuration that actually ships. Evidence:
`docs/evidence/final-prelaunch/workflow-probe-final-default.log` (HEAD `371f4ef`
app code = final HEAD app code, BUILD_ID `Y8FTkWwDAOHlzSbHMICnZ`,
`PROCESSING_PIPELINE` unset) and the independent from-scratch reproduction in
`fresh-env-final.log` (§5), which reaches the same 155/156 in **both**
configurations.

The probe drives a real Chromium over CDP against the deployed standalone artifact
behind a TLS front, registers its own throwaway account, and walks sixteen journeys
end to end:

| | Journey |
|---|---|
| SETUP | a real account and a real Workspace |
| A | a browser result opens in the editor, and the bytes never leave |
| B | a browser result becomes ONE Workspace document, and stays one |
| C | a server job's output is copied server-to-server, never through the page |
| D | the Workspace editor can publish a version of the document it holds |
| E | publishing your own version does not become a conflict on the next edit |
| F | an intentional open is recorded, and nothing else pretends to be one |
| G | the activity feed names the document, the version and the tool |
| H | a signed-out result offers sign-in and still opens in the editor |
| H+ | nothing broke quietly while all of that happened |
| I | unsupported output, and the server-side half of the same rule |
| I′ | a non-PDF cloud result, with no test behaviour anywhere in the product |
| J | a member of several Workspaces chooses where the result goes |
| K | a lost response and a retry produce the SAME document, not a second |
| L | what the Workspace holds is what the tool made — parsed, not counted |
| M | a genuinely stale second session is refused, and told the truth |
| N | a save intention decides whether two saves are one, and content does not |

Three of those deserve to be called out, because they are the ones a green unit
suite is compatible with failing:

- **K — idempotency.** A lost response and a retry produce the *same* document. The
  suite cannot see this: it needs a real network round trip that is abandoned.
- **L — content, parsed not counted.** What the Workspace holds is compared by
  parsing the stored PDF, not by comparing a byte count. A byte count passes when
  the wrong document of the right size is stored.
- **I′ — a non-PDF cloud result.** This is the journey that had never once armed on
  the shipped configuration, and it is the reason §3 exists. See below.

**The one non-pass is environmental and is the same row in every run:**

```
FAIL[ENVIRONMENTAL]  I: the SERVER's own 415 UNSUPPORTED_OUTPUT branch is
unreachable on this machine — every non-PDF-output tool is server-run and its
binary is absent (soffice), so no genuinely non-PDF result can be PRODUCED here.
```

That is a missing system binary, not a defect, and it is not called a PASS. The
route branch it would exercise is covered by `saveToWorkspaceRoute.test.ts`, and the
browser behaviour that branch guards is covered by I′ — which does run here.

**Both probe defects found in this group were the probe's, and both were fixed in
the probe rather than in the product.** They are recorded because a probe that
misreports is worse than a probe that fails:

1. **N3 raced the ingestion.** The first save returns 409 with a body whose own
   `preparation: "processing"` says why; the probe discarded the body and read the
   status as a product failure.
2. **I′ armed nothing on the shipped default.** The product has **two job
   transports that name the output mime differently** — the polled
   `/api/jobs/:id` response carries `job.outputMimeType` alongside
   `resultAvailable`, while the SSE terminal frame from `/api/jobs/:id/progress`
   carries `result.mimeType` and **no `resultAvailable` at all**. The probe's retype
   hook only understood the polled shape, so outside `PROCESSING_PIPELINE=on` it
   rewrote nothing and the journey passed vacuously. It now handles both frame
   shapes, and on the shipped default it reports `rewrites=1` — the hook fired — and
   all four I′ rows pass against real behaviour: `Download` **is** offered,
   `Open in Editor` is offered **nowhere**, `selects=0 chooseCopy=false`, and
   `0 → 0` handoff entries were written.

That second one is the substantive result of this whole audit group. The gap it
closed was not a failing assertion; it was an assertion that could not fail, in the
only configuration that ships.

## §8 — Authentication and sessions

**Verdict: `PASS` on the mechanics, with one `LAUNCH DECISION REQUIRED`** —
account recovery does not exist. Nothing below is a source scan: every row was
measured against the running standalone artifact (BUILD_ID `Xh7-umLcPW6vE-EVOjOYB`)
over the TLS front, and no token value appears in this report or in any evidence
file.

The whole end-user auth surface is four routes — `login`, `logout`, `me`,
`signup` (with `register` as a delegating alias). There is no fifth.

| | Claim | Measured |
|---|---|---|
| E1 | the session cookie is httpOnly, sameSite and secure | `pdfdadi_session=<masked>; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=lax` |
| E2 | logout revokes server-side, not just in the browser | session row count 6 → 5 on logout, and **replaying the saved pre-logout cookie returns 401** `UNAUTHORIZED` |
| E3 | login rotates the token, closing session fixation | two consecutive logins issue two different cookies |
| E4 | a wrong password is indistinguishable from an unknown email | both: `401 INVALID_CREDENTIALS` · `"Email or password is incorrect."` — byte-identical |
| R9 | sessions expire and expired rows are actually removed | `Max-Age=43200` (12 h) and the retention sweep reported `sessionsPruned: 1`, then `0` expired rows remaining |

E2 is the row worth stating twice, because "logout" that only clears a cookie is
indistinguishable from real revocation in a browser: the pre-logout cookie was
saved to a separate jar, replayed after the logout returned 200, and answered
`401` with `"Your session has expired. Please sign in again."` The record is gone
from `sessions`, so a stolen cookie dies with the logout.

R9's expiry half is in `docs/evidence/final-prelaunch/retention-sessions-postfix.log`
— four self-rescheduled sweeps 15 minutes apart, `sessionsPruned: 1` on the one
that had something to prune, `sessions total: 27 · still expired and stored: 0`,
and `expiresAt` stored as a sqlite `integer` (the type the sweep's comparison
needs; a text column would have made the sweep silently no-op).

**Brute force.** `loginRateLimiter` is 10 attempts per 60 s, `signupRateLimiter`
10 per hour, both per client
([src/application/services/authHttp.ts:112-113](src/application/services/authHttp.ts#L112-L113)).

**Two items are recorded as they are, not as one would wish** (both
`MANUAL REVIEW REQUIRED`, both pre-existing):

- **E5 — the admin session is a stateless HMAC** with a 7-day maximum age, so an
  individual admin token cannot be revoked; rotating `ADMIN_SECRET` invalidates all
  of them at once. That is a deliberate design for a single-operator panel, and it
  is a different guarantee from the end-user session above. Accept or schedule.
- **E6 — no default admin password ships**, and an initialized deployment cannot be
  re-run through setup. Verified by hand that no password hash is seeded in the
  shipped store.

**`LAUNCH DECISION REQUIRED` — there is no account recovery and no email
verification.** Measured, not assumed: the `users` table has no verification
column (`id, email, provider, providerExternalId, createdAt, updatedAt,
passwordHash, name`), no route or page exists for verify / reset / forgot, and the
only password-change endpoint in the repository is
[app/api/admin/password/route.ts](app/api/admin/password/route.ts), which is behind
`requireAdmin` and belongs to the admin panel. So a user who forgets their password
loses the account and its Workspace documents, and an email address is never proven
to belong to the person who typed it. This is not a defect in the code that exists
— it is a product decision that has not been made, and this audit does not make it.

## §9 — Authorization and tenant isolation

**Verdict: `PASS`, and R11 is now exercised at runtime rather than reasoned about.**
Evidence: `docs/evidence/final-prelaunch/f5-cross-tenant-final.log`.

The static harness rows hold at final HEAD:

| | Claim |
|---|---|
| F1 | every Workspace API route resolves the actor server-side |
| F2 | no Workspace route trusts an organization id from the client without re-resolving it |
| F3 | every mutating Workspace route enforces same-origin |
| F4 | the job routes authorize per job, not per session — via `resolveJobActor` / `legacyJobAccessDenied` / `processingResultStream` / `processingResultRedirect` |

F5 was `NOT EXERCISED` there, and honestly so: a static harness cannot provision
two accounts. It is now exercised in a real browser —
`scripts/phase1-workspace-reliability-probe.mjs`, two real accounts registered
through the real form, **30/31 checks passed**:

- a Workspace is created, opens for its owner, and shows its own name (so the
  refusal below is a refusal of something that demonstrably existed);
- a second account requesting that Workspace's URL gets **`404`** and the
  controlled "This Workspace is not available" page — never the Workspace, never
  the generic server-error page;
- the outsider's own picker (`GET /api/workspaces`) does not list it either;
- a nonexistent id and a malformed id get the same controlled answer, leaking no
  identifier and no stack;
- no document response in the whole walk was a 5xx.

**The one failing row is a probe defect, and chasing it found a real gap.** The row
counts `workspace.access.denied` lines in the *browser* console, which only works
under `next dev` — that server replays its stderr into the page, a production
standalone build replays nothing, so the count is structurally 0 there whatever the
product does. The server's own log held the lines, ids only, no email or token.

But replaying each refusal shape one at a time against the artifact showed that
one of them logged nothing at all:

| request by a signed-in outsider | http | audit line |
|---|---|---|
| `/workspaces/<id>?organizationId=<the OTHER tenant's org>` | 404 | **0 — before the fix** |
| `/workspaces/<id>` (no `organizationId`) | 404 | 1 |
| `/api/workspaces/<id>` | 404 | 1 |
| `/workspaces/<id>` with no session at all | 307 → login | 0, deliberately |

Every answer was already correct — no 404 body contained the other tenant's
Workspace name — but the shape that *names another tenant's organization*, which is
what a deliberate cross-tenant probe looks like, was invisible in the log. The
organization guard in `workspacePageActor` runs before any Workspace lookup, so
`WorkspaceService.get` — the one place that logs a refusal — was never reached.

Fixed in
[src/application/services/workspacePageData.ts](src/application/services/workspacePageData.ts):
both page-level organization refusals now emit the same ids-only line
(`operation=workspacePageActor`, `category=ORGANIZATION_NOT_FOUND` or
`ORGANIZATION_ROLE_MISSING`, `actorId`, and the `organizationId` the URL named).
An anonymous visitor is still not logged — that path is a redirect to login, and a
line there would be written for every crawler that finds a Workspace URL.

Verified after rebuilding the artifact: the first row above now produces exactly
one line carrying the other tenant's org id, the other two still produce exactly
one each, the anonymous row still produces none, and the owner still opens their
own Workspace with `200`. Covered by five tests in
`src/application/services/workspacePageData.test.ts`, of which **three go red**
when the fix is reverted; `tsc` and `eslint` clean.

The probe's two console-reading rows now report `NOT EXERCISED` with the reason
instead of one false red and one vacuous green — the second of them passed with an
empty list, because `JSON.stringify({})` contains no email either.

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

## §11 — Web security and the content policy

**Verdict: `PASS`.** Static evidence: harness group **H**, 5/5. Runtime evidence:
`docs/evidence/final-prelaunch/web-security-headers.log`, measured on the running
final-HEAD artifact.

Every page and every API route answers with the same enforced policy — checked on
the homepage, on a tool page and on an API route, not on one URL:

```
content-security-policy: default-src 'self'; base-uri 'self'; object-src 'none';
  frame-ancestors 'none'; frame-src 'none'; form-action 'self';
  script-src 'nonce-<per-request>' 'strict-dynamic'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self';
  report-uri /api/csp-report; report-to csp-endpoint
X-Content-Type-Options: nosniff          X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

What is worth saying about that header rather than just quoting it:

- It is **`content-security-policy`, not `-report-only`** (H2). A report-only policy
  and an enforced one are indistinguishable in a screenshot and completely different
  in effect.
- `script-src` is a **per-request nonce with `strict-dynamic`** and carries no
  `unsafe-eval`, no `unsafe-inline`, no wildcard (H3). The dev-only relaxation for
  HMR exists and is confined to development. This is also the second half of why the
  pdf.js advisory is not exploitable here (§12).
- The legacy vectors are pinned to `none`: `object-src`, `frame-src`,
  `frame-ancestors` — plus `X-Frame-Options: DENY` for agents that predate CSP.
- `style-src` keeps `'unsafe-inline'`. That is a real, deliberate looseness: the
  framework emits inline style attributes. It is recorded here rather than omitted,
  and it does not permit script.
- Violations have somewhere to land (H5): `report-uri /api/csp-report`, whose
  handler is the same one `cspReport.test.ts` proves sanitizes a URL before logging
  — a violation report containing `?token=…` is logged with the token stripped.
- HSTS is served with a two-year max-age and `includeSubDomains`, observed through
  the TLS front rather than inferred from source.

The mutating API surface is same-origin gated (H4, F3), with 13 rejection cases in
`workspaceHttp.test.ts` and a live leg in `scripts/csp-probe.mjs`. R8 —
`next` on login cannot redirect to an external host — and R10 are covered there and
in `workspaceCsrfProxyOrigin.test.ts`; brief mutation **E** made that gate red and
was reverted through Git.

## §12 — Dependencies and secrets

**Verdict: `PASS` on secrets. `P2` on dependencies** — nine high advisories exist,
and none of them is reachable in this product as configured. Full working:
`docs/evidence/final-prelaunch/dependencies-secrets-i3.md`.

This is the audit's **only PRODUCT FAILURE row** at final HEAD, and it deserves to
be read carefully because the row is a count, not a defect:

```
I3  PRODUCT FAILURE  no critical or high advisory in the production dependency tree
    -> 9 high/critical advisories  (0 critical)
```

`npm audit --omit=dev` over 158 production dependencies: **9 high, 0 critical**. The
question that decides whether that is a launch blocker is not how many there are but
which of them a request can reach, so each was traced to the artifact. The
distinction that does most of the work is **installed vs shipped** — the standalone
dependency trace, checked identically in the primary-tree build and in the
independent fresh-worktree build at final HEAD:

| In the shipped artifact | Not traced into it |
|---|---|
| `sharp` 0.34.5 (server), `pdfjs-dist` (client bundle + worker asset) | `nanoid`, `postcss`, `brace-expansion`, `minimatch`, `archiver`, `deepmerge-ts`, `@prisma/config`, `prisma` |

Both builds agree exactly. Summarised:

| Package | Why it cannot be reached here |
|---|---|
| `pdfjs-dist` | the advisory needs `enableScripting: true` **and** no `script-src` CSP. Nothing in `app`, `components`, `src`, `lib`, `hooks` mentions `enableScripting`, `AnnotationLayer` or `PDFScriptingManager`; the import surface is the core API only; `PDFScriptingManager` has **0 occurrences** in the shipped client chunk; and the served policy is a per-request nonce (§11) |
| `sharp` | transitive under `next`, no product import, no `images.remotePatterns`; images are embedded by pdf-lib |
| `postcss` | build-time compiler over in-repo CSS, nested under `next`, not in the artifact |
| `nanoid` | no call site, and the bug needs a custom generator invoked with size 0 |
| `brace-expansion` | `archiver`'s glob path — `lib/server/zip.ts` never calls `.glob()`/`.directory()`, and `minimatch` is not even present beneath the artifact's partial `readdir-glob` trace |
| `deepmerge-ts`, `@prisma/config`, `prisma` | Prisma CLI config loading; no `prisma.config.*` exists; not a request path |
| `next` | flagged *via* `postcss` and `sharp`; not its own code |

Remediations are **named and not performed** — the brief forbids mass upgrades:
`pdfjs-dist` → 6.3.289 (non-major, and the one to do first, since it is the only
advisory that reaches a browser); `next` → 16.3.4 (non-major, clears three rows);
`brace-expansion` and `nanoid` fix in place. **Do not run `npm audit fix --force`
on this tree**: npm's proposed fix for the Prisma chain is a semver-major
*downgrade* to prisma 6.12.0, to fix a CLI-only stack-exhaustion bug.

**Secrets: `PASS`.** No `.env`, key, certificate, database file or upload is
tracked; `.gitignore` covers `.env*` (with `!.env.example`), `/.storage`, `*.db`,
`*.db-journal`, `*.sqlite*`. A live-credential pattern sweep over every tracked file
matches six files, and all six are **negative tests** whose whole purpose is to
assert a secret does not leak (`CANARY_SECRET = "sk_live_…_MUST_NOT_APPEAR"`,
`expect(logged[0]).not.toContain(…)`, `"whsec_leakme"`). Harness rows A3/A4 report
`MANUAL REVIEW REQUIRED` over 1613 historical blobs with two matches confined to the
one path-acknowledged redaction fixture, whose current bytes A3 pins by sha256; that
review was done by hand here and the conclusion is that **no live secret is
committed, in the tree or in history**. No secret value is reproduced in this report.

The production boot gate (`src/infrastructure/config/env.ts:274-300`, harness B1–B7
all PASS) refuses to start on: no `ADMIN_SECRET`; `ADMIN_SECRET` set to the public
dev fallback that ships in this repository; `ADMIN_SECRET` under 16 characters;
`PDFDADI_ALLOW_INSECURE_DEV_SECRET=1`; a short `STORAGE_SIGNING_SECRET`; a
`DATABASE_URL` the shipped provider cannot open; a relative SQLite path; and
half-configured object storage. Its refusal text names the variable and never its
value — a deliberate choice, commented at `env.ts:245`, because that text reaches
logs. `next build` is exempt (B5) so CI compiles without deployment secrets.

One open item, recorded not resolved: **I4 `MANUAL REVIEW REQUIRED` —
`package.json` declares no `engines.node`**, so nothing in the repository states
which Node major is supported. The Dockerfile pins one (C3: all stages run one
supported major), but a host deploy has no such constraint. A one-line `engines`
field would close it; adding it is a product change and is left to the owner.

## §13 — Privacy and retention

Three tables were examined for a retention policy, and the answer differed for each.
Two grew forever and are fixed; the third is deliberately left alone.

### The horizons the product actually has

Every value read from source, not from documentation:

| Constant | Value | What it bounds |
|---|---|---|
| `TOOL_OUTPUT_TTL_MS` | 1 h | a tool result's stored bytes |
| `PROCESSING_OUTPUT_TTL_MS` | 1 h | a pipeline job's output |
| `RETENTION_INTERVAL_MS` | 15 min | how often the sweep that enforces those runs |
| `EXPIRY_SWEEP_MS` | 5 min (`PROCESSING_EXPIRY_SWEEP_MS`) | the processing expiry pass |
| `SAVE_INTENT_RETENTION_MS` | **30 days** | `workspace_save_intents` — **added by this audit** |
| `GUEST_DRAFT_MAX_AGE_MS` | 14 days | an anonymous editor draft |
| `AutosaveDraft retentionMs` | 30 days | a signed-in editor draft |
| `maxGrantTtlMs` | 365 days | the ceiling on any signed URL |
| `sessions` | `expiresAt` per row | **nothing, before this audit** |
| `audit_logs` | none | nothing, **by design** — see below |

### R19 / R20 — two tables that only ever grew

Neither was an access-control bug, and that is why neither had ever surfaced. A row
that nothing reads and nothing deletes costs nothing today and passes every test.

**`workspace_save_intents`** gained a row per save-to-workspace operation — a userId,
a workspaceId and a payload checksum — and nothing deleted one: no cascade reaches
it, and the service that writes it only ever moves a status. The ledger's own claim
was *"rows are small and bounded by real saves; a retention job is not built"*, which
is not a bound at all: the count is monotonic in traffic for the life of the
deployment. Fixed at `1d36b30` with a 30-day horizon measured from `updatedAt`
(a row reclaimed for a fresh attempt is live again).

**`sessions`** gained a row on every login and lost one only on an explicit logout.
`ISessionProvider.get` already refuses an expired token, so a stale row was never
usable — the leak was the row, not the access, which is exactly why nothing surfaced
it. This one was found **at runtime**, not by reading code: the R19/R20 observation
below printed `sessions already expired and still stored: 1` on a live deployment.
Fixed at `371f4ef`.

Both prunes ride the **existing** 15-minute `file-retention` sweep rather than adding
a recurring job each. `ISessionProvider.pruneExpired` is a **required** port method:
nothing in the request path needs it, so an optional one would have compiled forever
and never been implemented — making it required cost five `tsc` errors across four
test doubles, which was the intended outcome. Clerk returns 0 and says why. A throw
from either prune is warned and swallowed, because a sweep that dies on its newest
duty stops expiring *files*, turning a growth problem into a retention failure.

**Observed at runtime, because no mutation reaches it.** Every unit test here runs in
`environment: "node"` and builds the handler itself, so all of them stay green in a
deployment where the lazy `ensureWorkerReady()` never fires and nothing expires at
all. In a deployed standalone artifact, one real `compress-pdf` job triggered the
bootstrap at 22:36:55Z and 900 s later, unprompted:
`{"msg":"Retention sweep complete","purged":325,"intentsPruned":0}` — with the row
aged past its expiry **gone** and **zero** rows left expired.
Evidence: `docs/evidence/final-prelaunch/retention-r19-r20.md`.
Seven mutations, each applied singly and reverted through Git:
`docs/evidence/final-prelaunch/mutation-P-retention.md` (P1–P3, P4–P7). P7 is the one
worth naming — the provider is resolved and then discarded, it **passes
`tsc --noEmit`**, and only the behavioural bootstrap assertion sees it.

### `audit_logs` — unpruned, and it should stay that way

`AuditLog` maps to `audit_logs` and no code anywhere deletes from it. Reported rather
than fixed, deliberately: it is the record of who did what, it is *read* (the activity
feed), and a retention policy for it is a compliance decision belonging to whoever
operates the deployment. Choosing a default here would be inventing a launch decision.
**Listed as an operator decision, not a defect.**

### R18 — logs exclude private content

`ConsoleLogger` emits one JSON line per call and drops anything below the configured
level (`LOG_LEVEL`, `env.ts:414`; ranks debug 10 → error 40). Request correlation is
`x-request-id` sliced to 128 chars or a fresh `randomUUID()`. The content route's
unavailable branch is the case worth checking, because it is the one that has a
document's storage facts in hand: it reports only the ingestion **state**, and its
comment says so — *"only its state is reported — never a key, size or checksum."*
Failure reasons are bounded and non-disclosing at the point they are stored
(`DocumentIngestionService`), not filtered on the way out.

### J3 — erasure and export: `LAUNCH DECISION REQUIRED`

Not a defect; a capability the product does not have. No delete-account route, no
export route, no admin route that removes a user — every `app/api/**/route.ts` was
enumerated. And it is not a small feature: `model User` has **no relations at all**,
while a user id appears in **23 columns across 22 models**, every one a plain
`String` with no foreign key and therefore no cascade. Deleting a `users` row today
succeeds and orphans all 23 references, because nothing exists to stop it.

The consequence is jurisdictional, so the audit does not choose: for EU/UK data
subjects Articles 15 and 17 make these obligations rather than features; for a closed
or single-tenant launch a documented manual procedure is defensible. That procedure
does not exist in writing today, and writing it is the smallest thing that closes the
gap without new code. Full statement, including the 23-column list:
`docs/evidence/final-prelaunch/erasure-export-j3.md`.

**§13 verdict: R18 PASS · R19 PASS · R20 PASS · erasure/export `LAUNCH DECISION
REQUIRED` · `audit_logs` retention `LAUNCH DECISION REQUIRED`.**

## §14 — Database and migrations

`node scripts/migration-restore-drill.mjs` — **`PASS 16/16`**. Log:
`docs/evidence/final-prelaunch/migration-restore-drill.log`.

The drill never touches the live database: every path is inside a fresh `mkdtemp`
directory that is removed on the way out.

**The blank chain first (R5), kept separate on purpose.** `migrate deploy` against an
empty file applies all **23** migrations (exit 0), `migrate status` then reports head
with nothing pending and no drift, and the schema it produced is the current one —
**42 tables, `workspace_save_intents` present**. That is what a *first* deployment
does, so it is recorded; it proves the chain is self-consistent from zero and nothing
more, which is why it is not allowed to stand in for the leg below.

**Then the upgrade a launch actually performs**, on a database that already holds
documents:

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

## §16 — Reliability and lifecycle

Two endpoints, and they answer different questions. `GET /api/health` reports
liveness — is this process alive — and returned **200 `{"ok":true,"status":"up"}`**.
`GET /api/health/ready` reports readiness — should traffic come here — and returned
**503**:

```
{"ok":false,"status":"degraded","dataDir":true,"toolchain":false,"database":true,
 "checks":[{"name":"database","healthy":true}]}
```

That 503 is the strongest available form of PASS for R23, not a failure: `soffice`
is genuinely absent from this macOS host (the other six binaries in `binaryInfo` —
`gs`, `qpdf`, `pdftoppm`, `pdfinfo`, `tesseract`, `ocrmypdf` — all resolve), so
readiness is red on a host that really cannot run every tool while liveness stays
green. Mutation O tried to make readiness green under exactly that condition and
was caught. Full command log: `docs/evidence/final-prelaunch/readiness-r23.log`.

Note the path. **`/api/ready` does not exist** — it 404s and serves the app shell,
which is how a monitor pointed at the wrong path would report a healthy site
forever. The path is `/api/health/ready`.

Three lifecycle facts an operator needs, all measured rather than assumed:

- The container `HEALTHCHECK` asks `/api/health`, which does not look at the
  toolchain. A container with a missing binary is therefore *healthy and not
  ready*. Deliberate — a restart does not install a binary — but it means the
  deploy signal to watch is readiness, not container health state.
- The dependency probe caches for **30 s** (`DEP_CACHE_MS`). A binary installed
  seconds ago still reads `false` until that expires; a rollback verification that
  does not wait it out will conclude the fix failed.
- Recurring work is registered lazily. `ensureWorkerReady()` is called from the
  tool, job and upload routes, so on a freshly booted process that has served no
  job, the retention sweep is not yet scheduled. §13 records the runtime
  observation that closes this: one real job at 22:36:55Z registered the handler,
  and 900 s later the sweep fired unprompted and purged 325 rows.

Restart safety and the crash path are covered where the evidence lives rather than
restated here: the deploy/rollback rehearsal in §26 boots the artifact, rolls back
to the previous one, runs a real job on each, and rolls forward; §14 covers
migration behaviour on both a blank and a populated database.

## §17 — Observability

Every log line is one JSON object — `{level, msg, ts, ...fields}` — from a single
`ConsoleLogger` adapter, debug/info to stdout and warn/error to stderr, so a
shipper can ingest it without parsing prose. `child()` carries base fields down,
and a `sanitize()` pass drops `undefined`, unwraps `Error` to `{name, message}`
and drops functions. R18 (§13) is the privacy half of this: no document content,
no filename bytes and no token material appears in what it writes.

What exists, and what that means at launch:

| Port | Adapter in production | Consequence |
|---|---|---|
| `ILogger` | `ConsoleLogger` (JSON to stdout/stderr) | usable; needs a shipper |
| `IErrorReporter` | `ConsoleErrorReporter` → `logger.error("error.reported")` | **no error monitoring service**; an exception is a stdout line nobody is paged for |
| `IMetrics` | `ConsoleMetrics` → `logger.debug(...)` | **silent in production** (below) |
| `IAnalytics` | `ConsoleAnalytics` (first-party only) | no third-party analytics; §23 |
| `ITracing` | `ConsoleTracing` | no distributed tracing backend |

The metrics gap is worth stating precisely, because the instrumentation is real
and the output is not. `ConsoleMetrics.increment/gauge/histogram` all emit at
**debug** level (`src/infrastructure/observability/ConsoleMetrics.ts:12-24`), and
`ConsoleLogger.emit` drops anything below the configured level
(`RANK.debug = 10 < RANK.info = 20`). `LOG_LEVEL` defaults to **`info`**
(`src/infrastructure/config/env.ts:98`). So a default production deployment emits
**zero** metric points: every counter, gauge and histogram the application records
is discarded at the logger boundary. Nothing is broken — the call sites are
correct and a Prometheus/Datadog adapter would receive them — but "we have
metrics" is not true of the shipped default, and `LOG_LEVEL=debug` is not a
sensible way to obtain them (it also turns on every other debug line, including
the retention sweep's).

Classified **P2**, twice: no error-reporting backend, and metrics that exist but
do not leave the process. Neither loses data, neither is a security matter, and
both are one adapter each. They are launch-relevant because together they mean a
production incident produces no alert and no time series — only stdout.

## §18 — Performance and load

One command produced every number below, in one uninterrupted run with nothing else
on the host:

```
node scripts/perf-load-probe.mjs --url https://172.20.10.2:3001 \
  --api-url http://127.0.0.1:3002 --csrf-origin https://172.20.10.2:3001 \
  --json /tmp/perf-all-final.json
```

Full output: [perf-load.log](evidence/final-prelaunch/perf-load.log) (333 lines),
machine-readable rows in [perf-load.json](evidence/final-prelaunch/perf-load.json).
Seven routes × 3 cold-cache runs, six input shapes × 2 end-to-end runs, and eleven
concurrency fan-outs against the API directly.

**Read the resolutions before the numbers.** Editor paint is polled at 100 ms; the
in-page merge and the job status are polled at 500 ms. So `local_merge = 517` and
`server_processing = 2998` mean "finished at or before that poll", not "spent that
long working" — the first is a ceiling, the second is bounded to a 500 ms window.
Every figure here carries that granularity and nothing else, which is why the
probe's own clock is discussed below rather than hidden.

### Pages

| Route | LCP (median, range) | CLS | Transferred | JS | Requests | JS errors |
|---|---|---|---|---|---|---|
| Homepage | 100 ms (80–104) | 0.005 | 399 KB | 162 KB | 39 | 0 |
| Tools directory | 60 ms (44–64) | 0.005 | 322 KB | 199 KB | 40 | 0 |
| Merge (tool page) | 52 ms (52–52) | 0.005 | 287 KB | 188 KB | 30 | 0 |
| Pricing | 48 ms (44–60) | 0.005 | 287 KB | 162 KB | 58 | 0 |
| Editor (standalone) | 72 ms (68–84) | 0.001 | 398 KB | 312 KB | 23 | 0 |
| Workspace | 104 ms (100–108) | 0.017 | 296 KB | 197 KB | 39 | 0 |
| **Workspace Editor** | **412 ms** (392–416) | **0.212** | **921 KB** | **459 KB** | 43 | 0 |

No route logged a single JavaScript error in any run. Six of the seven paint inside
110 ms and hold CLS an order of magnitude under the 0.1 "good" threshold.

**The Workspace Editor is the one route that fails a Core Web Vitals threshold:
CLS 0.212, twice the allowed 0.1.** It is not measurement noise — the same 0.212
appears in every run of this probe and in the earlier run it replaced, so the shift
is structural rather than incidental. Its FCP is 44 ms and its LCP 412 ms, which is
the shape of a header that paints immediately and a document surface that arrives
much later and pushes it: the layout is not reserving the space the page image will
take. The same route also ships the largest payload on the site by a factor of 2.3
(921 KB transferred, 459 KB of JavaScript). Classified **P2**: it is a visible
quality defect on the authenticated workbench, not a functional failure, and the fix
is a reserved-height container rather than anything architectural.

**These LCP and TTFB figures are floors, not predictions.** The browser and the
server share one machine, there is no CDN, no bandwidth shaping and no device
throttling, so latency-bound numbers can only get worse in production. The two
figures that do transfer are CLS and payload weight, because they are layout and
bytes rather than bandwidth — and those are exactly where the one failure sits.

### The end-to-end workflow, six input shapes

Milliseconds, median of two runs. `n/a` means an earlier stage refused, and the
refusal is quoted rather than summarised.

| Shape | In-page merge | Local download | Upload | Job submit | Server processing | Result download | Workspace save | Editor load | Publish | Reopen |
|---|---|---|---|---|---|---|---|---|---|---|
| tiny (2 KB) | ≤517 | 5 | 11 | 13 | 2998 | 16 | 10 | 242 | 6 | 239 |
| ordinary (5 KB) | ≤520 | 8 | 11 | 11 | 2242 (1488–2995) | 12 | 12 | 357 | 6 | 371 |
| large (22.8 MB) | ≤517 | 8 | 48 | 39 | 2973 | 12 | 12 | refused 238 ms | 43 | refused 249 ms |
| many-page (104 KB) | ≤518 | 8 | 15 | 18 | 1889 (776–3001) | 10 | 11 | refused 128 ms | 6 | refused 146 ms |
| encrypted (6 KB) | 17 (refused) | n/a | 11 | 11 | 2807 | 11 | 11 | refused 231 ms | 7 | refused 243 ms |
| malformed (3 KB) | ≤516 (refused) | n/a | 10 | 12 | 2997 | 10 | 11 | refused 132 ms | 6 | refused 131 ms |

Every stage a user waits on synchronously is fast, including the one that carries
22.8 MB: upload 48 ms, submit 39 ms, result download 12 ms, Workspace save 12 ms.
Publishing a revision costs 6 ms on small documents and 43 ms on the 22.8 MB one.

**Server processing is uncorrelated with input size.** A 2 KB document and a 22.8 MB
document both complete in the same 2.5–3.0 s window, across a 10,000× range of
bytes, while a 104 KB document completed once in 776 ms and once at the 3.0 s edge.
The dominant term is therefore a fixed per-job cost, not the compression work, and
the spread is scheduling variance in the in-process worker. It is not failed attempts
being retried: the origin log for this window contains zero retry or attempt lines.
Attributing the constant to a specific component would need a profile this audit did
not run, so it is recorded as an observation with a bound — **every server job on
this host costs about three seconds regardless of what it is given** — and not as a
diagnosis. For launch it is acceptable: the API returns 202 immediately and the
connection never waits on processing ([app/api/jobs/route.ts:43-46](../app/api/jobs/route.ts#L43)).

**The four editor refusals are the product being right, quickly.** The 340-page and
300-page documents are turned away by the editor's page cap with the count and the
limit both named ("It has 340 pages, and the Editor supports up to 200"), and the
encrypted and truncated files by the open failure. All four answers land in
128–238 ms — the editor decides before the page ever looks busy. The 300-page copy
is the P2 fixed earlier in this audit at `297c776`; it now says the document is too
long rather than possibly damaged.

### Concurrency and measured capacity

Fan-out against the API with an explicit `Origin`, every level fully accepted unless
the table says otherwise:

| Family | Fully accepted | Where it sheds | Median latency at the top level |
|---|---|---|---|
| Anonymous server jobs | 16 concurrent | not reached | 64 ms (34–87), 16×202 |
| One-IP burst | — | **25: 20×202, 5×429, `Retry-After: 10`** | 81 ms (47–129) |
| Workspace uploads | 8 concurrent | not reached | 36 ms (27–53), 8×201 |
| Document opens | 16 concurrent | not reached | 13 ms (11–13), 16×200 |
| Publishes (distinct documents) | 4 concurrent | not reached | 15 ms (8–50), 4×201 |
| Revision conflict (one document, one revision) | — | **4: 1×201, 3×409** | 9 ms |
| Anonymous browser workflows | 3 concurrent | not reached | 7156 ms wall 7241 ms |

Two of these rows are the interesting ones, and neither is a capacity limit.

The **one-IP burst** is the rate limiter working: 25 simultaneous submissions from
one address are answered 20 accepted, 5 refused with `429` and a `Retry-After: 10`
the client can obey. The shed is deliberate and it is polite.

The **revision conflict** row is the compare-and-set on a document version. Four
writers race the same revision of the same document; exactly one wins with `201` and
the other three get `409`. Losing three of four writes is the correct answer to that
question — the alternative is silent overwriting — and it is reported as a
correctness result rather than as a shed, which is a change this audit had to make to
the probe (below).

Concurrent browser workflows are the slow row at 7.2 s wall for three at once, and
that is three real Chrome tabs each doing an in-page merge on one contended laptop;
it bounds this host, not the product.

### Three probe defects, all fixed before this run

Every number above is post-fix, and they differ from the earlier truncated log on
purpose. The defects are recorded because each one produced a plausible, wrong,
publishable figure:

1. **The load probe's fourteen uploads were one document.** The fan-out re-sent one
   identical buffer, and `WorkspaceAwareUploadService` dedupes on
   `(workspaceId, sha256)` — so fourteen uploads returned the same file, "publishes
   ×4 (distinct documents)" was really a second CAS race on one row, and the capacity
   table printed a shed that did not exist. Each upload now carries a uuid comment.
   Uploads answer **201** at 15/20/39 ms instead of a **200** dedupe hit at 5 ms, and
   the row states `documents=4 distinct of 14 uploaded`. The origin log for this run
   independently confirms it: fourteen distinct `documentId`s in fourteen
   "Upload ingested into initial version" lines.
2. **The capacity generator grouped the CAS race under "publishes"**, turning a
   correctness result into an apparent throughput ceiling of one. It is now its own
   family.
3. **The refusal clock was the probe's own poll budget.** The error panel was read
   only after the 300 × 100 ms poll gave up, so every editor refusal was dated at the
   deadline: the 340-page document was reported as "refused after 30830 ms" when the
   product had answered in 238 ms. The panel read now happens inside the poll.

All three belong to the same family as the `editor_load = 9016 ms` and "no page was
painted" defects found earlier in this audit: a harness measuring its own constants
and presenting them as product latency.

### What was not measured

No CDN, no network shaping, no device throttling, single host, single instance. No
sustained soak — the fan-outs are bursts, not minutes of load, so nothing here speaks
to memory growth or file-descriptor drift over hours. The queue is the in-process
one; `REDIS_URL` is unset, so the multi-instance path is **NOT EXERCISED**. And every
figure comes from one host under one contention profile: these are the product's
proportions, not a capacity plan for production hardware.

## §19 — Browser compatibility

**One engine was exercised. The other two are recorded as unexercised, with the
reason measured rather than assumed** —
[cross-browser.log](evidence/final-prelaunch/cross-browser.log).

| Engine | Status | Evidence |
|---|---|---|
| Chromium | **EXERCISED** — every browser probe in this audit | `~/Library/Caches/ms-playwright` holds `chromium-1234` and `chromium_headless_shell-1234` and nothing else; all probes drive it over CDP via `scripts/lib/probe-browser.mjs` |
| Firefox / Gecko | **ENVIRONMENTAL** — absent three ways | no `/Applications/Firefox.app`, no `firefox`/`geckodriver` on `PATH`, no Playwright Firefox download |
| WebKit / Safari | **NOT EXERCISED** — present but not permitted | `Safari.app` **and** `safaridriver` both exist; a real session request returned `session not created … You must enable 'Allow remote automation'` |

The WebKit line is the one worth reading twice. This is not a missing dependency
the audit could install: `safaridriver` was started on port 4470 and asked for a
session, and the refusal above is its own answer. Enabling remote automation is a
human action inside Safari Settings plus `safaridriver --enable`, which prompts for
administrator authorisation. No WebDriver client (`playwright`, `puppeteer`,
`selenium`, `webdriver`, `cypress`) is a dependency of this repository either, so
there is no in-repo path to a Gecko or WebKit run. **R29 is satisfied in its
"explicitly unexercised" form, not its "exercised" form.**

What *can* be said across engines without running them is what the code asks the
engine for. That was swept rather than assumed:

| Feature used | Cross-engine status | How the code handles it |
|---|---|---|
| `EyeDropper` | Chromium-only | feature-detected at [ColorPopoverPanel.tsx:84-85](../components/editor/color/ColorPopoverPanel.tsx#L84-L85) and the button is not rendered at all when absent ([:165](../components/editor/color/ColorPopoverPanel.tsx#L165)) — every other route to a colour (brand swatches, in-document swatches, hex field, opacity slider) is untouched |
| `navigator.clipboard` | secure-context only | optional-chained at [PropertiesPanel.tsx:482](../components/editor/panels/PropertiesPanel.tsx#L482) (`navigator.clipboard?.writeText`), so a context without it is a no-op, not a throw |
| `ResizeObserver` (7 files), `IntersectionObserver` (4) | supported in all three engines | used unguarded, correctly |
| `::-webkit-scrollbar` | Chromium/WebKit only | paired with `scrollbar-width: none` for Gecko in the same rule ([globals.css:81-87](../app/globals.css#L81-L87)); the comment there also forbids using it where the scrollbar is the only affordance |
| CSS colour syntax | — | Tailwind 3.4.17 with `autoprefixer` 10.4.20; no `oklch()`, no `color-mix()`, no `:has()`, no `@container` anywhere in `app/`, `components/` or `styles/` |

So the product uses one engine-gated API and it degrades by construction. That is a
real reduction in cross-engine risk, and it is still **not a substitute for
opening the site in Firefox and Safari.** Layout and text-metric differences,
Gecko's PDF-render and download behaviour, WebKit's file-input and cookie handling,
and iOS Safari's viewport are all unmeasured here. Nothing in this audit claims
they work.

**Recommendation before launch:** one manual pass through the merge flow and the
Workspace Editor in Firefox and in Safari, on a machine where a human can grant the
automation permission. That is a person-hours item, not a code change.

## §20 — Accessibility

**A keyboard-only user completes a whole tool workflow, twice, with zero mouse
events dispatched** — scenario M of `scripts/premium-ui-ux-probe.mjs`, run signed
out and again with `--auth`:
[keyboard-r28.log](evidence/final-prelaunch/keyboard-r28.log).

```
$ node scripts/premium-ui-ux-probe.mjs --url https://172.20.10.2:3001 --only M [--auth]
signed out: 13 pass · 0 product failures · 0 environmental · 1 not exercised
--auth:     13 pass · 0 product failures · 0 environmental · 1 not exercised
```

The workflow it walks is the real one: Tab to the drop control (stop 13 of 24
signed out, 10 of 24 signed in), **Enter** to open the file picker, Tab to
`Merge PDFs` (stop 16 / 13 of 40), **Enter** to run the tool through to a result,
then Tab across every action the result offers and **Enter** on one. The activation
trail recorded at the capture phase is `["INPUT","Merge PDFs","Start over"]` — the
hidden file input clicked by the dropzone's own Enter handler, the tool's action,
and the result action, in that order. **Zero `Input.dispatchMouseEvent` calls occur
anywhere in scenario M**, which is what makes "keyboard-only" a measurement rather
than a description.

| Gate | Signed out | `--auth` |
|---|---|---|
| M1 file-open control reachable by Tab, named, focus-ringed | PASS — outline solid 2px | PASS |
| M2 Enter opens the file picker | PASS — hidden input received 1 programmatic `click()` | PASS |
| M3 tool action reachable by Tab from the staged state, ringed | PASS | PASS |
| M4 Enter on the action runs the tool to a result | PASS | PASS |
| M5 every enabled result action reachable and ringed | PASS — 4 offered, unreachable none, unringed none | PASS — 4 offered |
| M5b a disabled action can be enabled from the keyboard | **NOT EXERCISED** — the result offered no disabled action | **NOT EXERCISED** |
| M6 Enter on a result action does the thing it names | PASS — `Start over` cleared the result panel | PASS |
| M7 focus advances rather than cycling in place | PASS — 46 distinct stops in 60 Tabs | PASS — 41 in 60 |
| M8 no console errors across the whole flow | PASS (signed out ignores one expected `401` on `/api/auth/me`) | PASS — 0 ignored |
| M9 one `<main>` landmark · bypass block resolves · every control named · every `<img>` decides `alt` | PASS — 1 `<main>`, `#main` focused 138×40, **45** named controls, 0 `<img>` without `alt` | PASS — **42** named controls, 0 without `alt` |

Two honest limits, both recorded in the log itself rather than smoothed over:

- **M5b is NOT EXERCISED in both runs** because the result panel genuinely offered
  no disabled action to enable — signed in, `Save to Workspace` is live immediately
  since a default destination is already selected. Nothing was faked to reach a
  green gate, and the scenario therefore reports **13/14**, not 14/14.
- **The OS file dialog is the one seam.** `DOM.setFileInputFiles` supplies the two
  files, because no probe can drive the native dialog. What M2 proves is the last
  thing the page controls: Enter on the drop control fires the hidden input's own
  `click()`. Choosing a file *inside* that dialog is not exercised and is not
  claimed.

M5 reads the offered action set off the page instead of hard-coding it, which is
why the two runs differ legitimately — signed out offers
`[Download | Start over | Open in Editor | Sign in to save to Workspace]`, signed in
the fourth becomes `Save to Workspace` — and neither run can pass by knowing less
than the product offers.

**No screen reader was driven, and no synthetic tree is offered as a substitute.**
VoiceOver needs the same machine-level automation permission WebKit needs (§19).
What the probes do establish is the tree a screen reader would read: one `<main>`
per page, a bypass block that actually moves focus into it, an accessible name on
every control, an `alt` decision on every image, and `role="alert"` on error
surfaces. A person listening to it is still an open item. Also unmeasured: reduced
motion preferences, 200% zoom reflow, and Windows high-contrast mode.

**R28 verdict: PASS** (13/14, one gate NOT EXERCISED for want of a disabled
control). **Screen-reader acceptance: NOT EXERCISED.**

**The first run of scenario M reported four product failures, and all four were the
probe's.** `tabThrough(n)` returned focus on the *nth* stop rather than the one the
caller asked for, so the Enter meant for the dropzone (stop 13) went to stop 24, a
footer link, which Enter followed to `/tools` — a page with no `Merge PDFs` button,
which then failed M3 and left M4–M7 unreached. A standalone diagnostic on the same
commit, with focus placed on the control, showed the product was correct on all
four rows: 1 picker after Enter, 2 after Space (both keys bound), and `Merge PDFs`
reachable at tab 16 all along. Fixed in the probe (`tabThrough(dropStop + 1)` plus
an assertion naming which control the key reached), never in the product.
Classified **PROBE DEFECT** — the third of four such harness bugs in this audit.

## §21 — SEO and route truth

Both crawler-facing surfaces are generated, and both were tested by calling them
rather than by reading their source. That required fixing the reason nothing ever
had: `lib/seo/adminRuntime.ts` opens with `import "server-only"`, a package the
Next compiler supplies and npm does not, so under plain vitest every module
reachable from it failed to load — which is why the previous harness read
`app/sitemap.ts` and `app/robots.ts` as text. `test/stubs/server-only.ts` (empty,
aliased in `vitest.config.ts`) makes them callable; a real client bundle still
resolves the real package and still fails the build.

**R24 — no private route is indexable. PASS, with a finding fixed.**
`app/workspaces/[workspaceId]/page.tsx` — the file manager a signed-in user spends
their time on — exported **no `metadata` at all**, while its three siblings each
declared `robots: { index: false, follow: false }`. There is no
`app/workspaces/layout.tsx` to supply one by inheritance, so it inherited the root
layout's indexable defaults. Fixed in `450657d`.

The test contains **no list of private routes**, deliberately: a hardcoded list
would have stayed green through exactly this defect, because the page nobody
remembered to add to the list is the page nobody remembered to noindex. The rule is
derived from the product's own two surfaces — walk every `app/**/page.tsx`, call
`sitemap()`, and require every route the sitemap does not advertise to declare or
inherit noindex. One exemption, proved by invoking rather than by asserting:
`app/signup/page.tsx` has no metadata because it never renders — it
`permanentRedirect`s to `/register`, and the test accepts it only if the throw
carries a `NEXT_REDIRECT` digest.

`/workspaces` is deliberately **not** in `app/robots.ts`'s disallow list. A path
blocked in robots.txt is never fetched, so its noindex is never read — blocking is
how a URL gets indexed without its page ever being seen. noindex is the mechanism.

**R25 — the sitemap is registry-derived. PASS.** `getToolsList()` returns **45**
tools; **13** of them (`pdf-to-powerpoint`, `pdf-to-excel`, `pdf-forms`,
`redact-pdf`, `compare-pdf` and the eight `coming-soon-ai` slugs) have capability
rows whose `available` is false. The availability gate is load-bearing, not
belt-and-braces: weakening it to an existence check submits all 13 thin placeholder
stubs to crawlers.

Three mutations, each applied singly and reverted through Git, gate green again at
`450657d` (`app/seoIndexingTruth.test.ts`, 5 tests):

| # | Mutation | Result |
|---|---|---|
| S1 | keep `metadata`, drop only its `robots` key on the Workspace page | **RED** 1/5 — a "has metadata" check would have stayed green |
| S2 | `if (!capability)` instead of `if (!capability?.available)` in `app/sitemap.ts` | **RED** 2/5 |
| S3 | add `/tools` to robots.txt's disallow list | **RED** 1/5 — names all 33 contradicted paths |

S3 earns its place because the assertion passes on an empty result: `contradictions
=== []` means both "coherent" and "the filter never ran". S3 proves it runs.

## §22 — Pricing and commercial truth

Three plans in `data/pricing.ts`: `free` (`available: true`), `pro`
(`available: false`), `business` (`available: false`). **R26 PASS** — the property
under test is that a plan which cannot be bought shows no price and no checkout,
and it holds in both directions.

Money can be taken **only** if a deployment sets all three of
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_PRO`. Any other
count leaves `billing.enabled = false`, `/api/billing/checkout` and the portal
answer **503 `BILLING_NOT_CONFIGURED`**, and `configWarnings` says so at boot
(`env.ts:161`, `buildBillingConfig`). With billing unconfigured, Pro reads
"Not yet available" and its CTA points at contact — not at a disabled Subscribe
button — resolved per request through `/api/billing/summary`.

Business is non-purchasable **by domain law rather than by configuration**:
`BillingPriceMap` has no `business` slot and there is deliberately no
`STRIPE_PRICE_BUSINESS` variable, so no environment can turn it on by accident.

Mutation `O2` covers the inverse claim (advertising a price the deployment cannot
charge) and `O3` covers a capability record inventing a tool — 7 failed / 63
passed. Both reverted through Git.

Two items here are **`LAUNCH DECISION REQUIRED`**, not defects: whether the free
tier stays free once paid plans exist, and whether the three Stripe variables are
set at launch. The code fully supports either launch; the difference is three
environment variables. What it refuses to do is show a price it cannot charge.

## §23 — Analytics and cookies

**No third-party analytics exists in this product.** `IAnalytics` resolves to
`ConsoleAnalytics` (`container.ts:371`); usage lands in the application's own
tables through `UsageRepository`. There is no Google Analytics or Tag Manager tag,
no PostHog, Plausible, Segment or Hotjar snippet, and no Sentry browser SDK — a
grep across `app`, `components`, `src` and `lib` returns nothing but unrelated
substring matches (`segments` in route parameters).

Cookies, observed against the running artifact rather than read from source:

```
$ curl -skD - https://172.20.10.2:3051/  →  (no Set-Cookie at all)
$ POST /api/auth/signup → 201
set-cookie: pdfdadi_session=<redacted>; Path=/;
            Max-Age=2592000; Secure; HttpOnly; SameSite=lax
```

One cookie, and only after the user authenticates. `httpOnly` (script cannot read
the token, so XSS cannot exfiltrate a session), `sameSite=lax` (withheld from
cross-site POSTs — the CSRF half of §11 — while surviving a top-level navigation
back into the app), `secure` in production, `path=/`, 30-day `maxAge` matching the
session lifetime. `clearedSessionCookieOptions()` mirrors the set attributes
exactly, which is what makes logout actually clear rather than orphan the cookie.

That is a **strictly necessary** cookie by any reading, and it is the only one. So
the product as built creates **no consent-banner obligation of its own** and none
exists in the UI. Two things are worth naming so nobody rediscovers them later:

- The browser also holds first-party client state that is not a cookie:
  IndexedDB-backed editor persistence
  (`src/infrastructure/persistence/browser/IndexedDbKeyValueStore.ts`), plus
  `sessionStorage` for the tool→editor handoff (`lib/workflow/handoff.ts`) and the
  save intent (`lib/workflow/saveIntent.ts`), and small `localStorage` UI
  preferences (panel layout, recent colours). All of it is the user's own data on
  the user's own machine, serving a function they asked for; none of it is
  tracking, and none of it leaves the origin. Retention horizons for the parts that
  matter (guest drafts 14 days, autosave drafts 30 days) are in §13.
- If a third-party tag is ever added — including an error-monitoring browser SDK
  (§17) — the consent question arrives with it. It does not exist today.

**PASS.** Nothing about analytics or cookies is a launch blocker; the honest note
is that "we have analytics" means first-party usage counters, not a funnel.

## §24 — Email and support

Support is **one channel**: a `mailto:hello@pdfdadi.com` link on `/contact`
(`components/contact/ContactForm.tsx:50`). Recorded as P3 earlier in this audit and
fixed in `f55ffca`, because the form previously accepted a message and discarded
it — it now no longer claims to deliver anything it does not.

There is **no transactional email at all**, and the two consequences are the ones
§8 already names: no email verification (an account is usable the moment it is
created; there is no `emailVerified` column, no token, no send) and **no password
recovery** (no reset token, no forgot-password route, no page). A forgotten
password today means a lost account, and the only recovery is an operator editing
the database.

Neither absence is a half-built feature — nothing incomplete is being shipped — so
neither is a code defect. Both are scope, and they land on the single mailto:

- **`LAUNCH DECISION REQUIRED`** — launch without password recovery and absorb the
  support load in the shape it will actually arrive (locked-out users, mailed to a
  human), or hold launch until recovery exists.
- **`LAUNCH DECISION REQUIRED`** — whether `hello@pdfdadi.com` is monitored, and by
  whom. Nothing in the repository says. It is the only channel, which makes that
  answer the entire support plan.

**PASS on truthfulness** — no surface promises an email the product cannot send —
with the two decisions above recorded as decisions rather than as findings.

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

## §26 — Deployment and rollback rehearsal

The container rollback could not be exercised on this host — there is no Docker
daemon — so [rollback-runbook.md](evidence/final-prelaunch/rollback-runbook.md) is
procedure written from the shipped entrypoint, not evidence. What *is* evidence is
the artifact the image carries. `sh scripts/r30-rollback-smoke.sh` swaps
`.next/standalone` + `.next/static`, which is the standalone analogue of rolling an
image digest back: the same claim that the bytes which served before serve again,
minus the daemon. Full output:
[r30-deploy-rollback.log](evidence/final-prelaunch/r30-deploy-rollback.log).

| # | Gate | Result |
|---|---|---|
| 0 | the artifact now serving is kept aside as the rollback target | PASS — `6teqv2zm5azzpKU0nakv3` |
| 1 | `npm run build` produces an artifact at HEAD | PASS — `Q0Vyn2Fqoa0Yn_j5UK-H-`, 234 lines |
| 2 | the artifact built at HEAD boots and answers liveness | PASS — `/api/health` → 200 |
| 3 | readiness answers on the new artifact | PASS — 503 degraded, **naming** `toolchain false` |
| 4 | a real job completes on the new artifact and returns a PDF | PASS — 149102 bytes of `%PDF-` |
| 5 | the PREVIOUS artifact boots again after a rollback | PASS — `6teqv2zm5azzpKU0nakv3` back, 200 |
| 6 | a real job completes on the rolled-back artifact | PASS — 149106 bytes of `%PDF-` |
| 7 | rolling forward again leaves HEAD serving | PASS — `Q0Vyn2Fqoa0Yn_j5UK-H-`, 200 |

The rollback was not a configuration toggle: the HEAD build was removed from the
tree and the kept directory copied back in its place before the boot. Both
artifacts completed a real `compress-pdf` job on a 300-page fixture and returned
bytes the client could read. The two outputs differ by four bytes because
Ghostscript writes a fresh creation timestamp and document id into each one — not a
corrupted result.

The 503 at gate 3 was accepted **only because the body names which subsystem is
false**. `soffice` genuinely is absent from this host (§16), so 503 is the truthful
answer; a 503 that said nothing would have failed the gate.

The database leg is deliberately not repeated here — the online `backup()` snapshot,
its byte-exact restore and `prisma migrate status` against the restored file are
already proven in §15. Repeating them would add a second copy of one fact.

**The first run of this script failed, and the failure was its own.** It reported
`FAIL — a real job completes on the new artifact: download was not a PDF` while the
database showed that job `completed` in the same second. The script had submitted
the job and then polled with no cookie jar, so submitter and poller were two
different anonymous callers, and `/api/jobs/<id>` answered `{"error":"Job not
found."}` — which is the R12 ownership rule working exactly as designed: a stranger
gets 404 rather than 403, and never a stranger's bytes. Filed as a product failure
it would have been a launch blocker that does not exist. Classified **PROBE DEFECT**,
fixed in the script at `bfed32f`, and recorded because it is the fourth harness bug
in this audit that produced a plausible, publishable, wrong failure.

**Not exercised:** no Docker build, no `docker compose up`, no image digest pinned,
no `prisma migrate deploy` inside a container, no load balancer observed draining on
the 503. Zero downtime was not attempted — this rehearsal stops the server, swaps the
artifact and starts it again, an outage window of a few seconds, which is what the
runbook describes.

## §27 — Tests added, and the brief's R1–R30 mapped to them

**A naming collision to clear first.** `finalPrelaunchRegression.test.ts` numbers its
own 32 tests R1–R30 (R19b is the 32nd, added late — see §35). Those are **not** the brief's R1–R30. The file was written
against a different list and its numbers stayed; renumbering it now would invalidate
every mutation row that quotes an assertion by name. Where a row below cites that
file, the brief's item is on the left and the file's own label is quoted in the cell.

Eleven test files are new on this branch, fourteen were extended:

| New file | Tests | Written because |
|---|---|---|
| `finalPrelaunchRegression.test.ts` | 32 | the regression spine — name/path composition, ceilings, cookie, disclosure, capability |
| `app/seoIndexingTruth.test.ts` | 9 | R24/R25 — derives the private set from the route tree and from `sitemap()`'s own output |
| `deploymentArtifact.test.ts` | 8 | R30 — ties the image's installed packages to the binaries readiness requires |
| `lib/server/tempFileLifecycle.test.ts` | 11 | R17 — `cleanup.ts` and both guards around `rm` had nothing |
| `lib/server/runCommandInjection.test.ts` | 3 | R14 — the argv seam had no gate at all |
| `lib/server/jobErrorDisclosure.test.ts` | 6 | R12 — the 404-not-403 rule had only a source scan; then R18 — an unclassified 500 left no trace |
| `data/admin/shippedStoreSecrets.test.ts` | 2 | the P0 password hash, globbed by filename so a `.bak` sibling cannot hide |
| `components/seo/jsonLdEscape.test.ts` | 3 | the product's only `dangerouslySetInnerHTML` |
| `src/infrastructure/auth/LocalSessionProvider.test.ts` | 4 | R9/R19 — session pruning, against real SQLite rather than the in-memory twin |
| `src/infrastructure/jobs/workerBootstrap.test.ts` | 3 | R19/R20 — nothing asserted the retention sweep is *registered* |
| `src/application/services/workspacePageData.test.ts` | 5 | R11/R18 — the cross-tenant page refusal logged nothing |

Extended: `readyRoute.test.ts`, `saveToWorkspaceRoute.test.ts`,
`documentLoadState.test.ts`, `data/pricing.test.ts`, `instrumentation.test.ts`,
`loadWorkspaceDocument.test.ts`, `toolProcessing.test.ts`, `proxy.test.ts`,
`AuthService.test.ts`, `saveIntentIdentity.test.ts`,
`usageObservationRetention.test.ts`, `workspaceCsrfProxyOrigin.test.ts`,
`env.test.ts`, `PdfToolWorkerHandler.test.ts`.

### The map

| Brief | Claim | Covered by | Kind |
|---|---|---|---|
| R1 | every Phase 5 non-pass is classified | Gate A table, §3 — all seven | evidence + probe |
| R2 | the canonical tool list is what the build can run | `seoIndexingTruth` *lists only tools this build can actually run*; `capability.test.ts`; §6 matrix | test + probe |
| R3 | a missing runtime dependency cannot look available | `PdfToolWorkerHandler.test.ts` *categorizes a MissingDependencyError*; `deploymentArtifact` *installs a package for every binary readiness requires*; `readyRoute.test.ts` | test |
| R4 | clean install and build from the lockfile | `fresh-env-final.log` (at `eb8f7fa`, 155/156 on both legs) and the first attempt
`fresh-env-first-run-2840bea.log` — `npm ci` 0, build 0, both legs booted | evidence |
| R5 | migrations apply to a blank database | `migration-restore-drill.log` rows 1–7 (23 migrations, 42 tables); repeated in the fresh worktree | evidence |
| R6 | migrating a populated database preserves data | `migration-restore-drill.log` rows 8–12 — row counts before/after | evidence |
| R7 | production config refuses insecure combinations | `env.test.ts` (25); `deploymentArtifact` *supplies every variable the production gate refuses to start without* | test |
| R8 | the login `next` parameter cannot redirect off-site | `components/auth/returnTo.test.ts` + `authValidation.test.ts` — mutation D, 5 red | test |
| R9 | sessions rotate and expire | `AuthService.test.ts` (16); `LocalSessionProvider.test.ts`; §8 measured live — rotation, server-side revocation, `Max-Age=43200` | test + live |
| R10 | CSRF and origin gates hold | `workspaceCsrfProxyOrigin.test.ts` (18) — mutation E, 9 red | test |
| R11 | a cross-tenant read fails | `workspaceAuthorization.test.ts` (25), `workspacePageData.test.ts` (5); **runtime** in `f5-cross-tenant-final.log` — all four refusal shapes in a real browser | test + live |
| R12 | a foreign job or result answers without disclosing | `jobErrorDisclosure.test.ts` (6) — byte-identical to a job that does not exist, **and** the vague 500 now logs name and message while an authorization refusal still logs nothing; `legacy-job-ownership-probe.mjs` | test + probe |
| R13 | hostile filenames stay inert | `finalPrelaunchRegression` *R9/R11/R29/R30/R19b*; `tempFileLifecycle` (7 of 11); **runtime** `hostile-filename-r13.log` — five hostile names POSTed for real on both pipeline configurations | test + live |
| R14 | processing arguments cannot become shell syntax | `runCommandInjection.test.ts` — mutation I *created a file* when the shell was let in | test |
| R15 | a MIME/content mismatch is rejected | `finalPrelaunchRegression` *R19 a claimed extension is checked against the actual leading bytes* | test |
| R16 | request and file ceilings are enforced | `proxy.test.ts` (26) + `finalPrelaunchRegression` *R20*; **runtime** `upload-ceiling.log` — 22 and 60 MiB parse, 101 MiB → 413; and `anonymous-parse-workspace-uploads.log` — the Workspace attachment ceiling refuses 26 MiB with `413` in **0.03 s**, i.e. on the declared content-length, before the body is read | test + live |
| R17 | temp files are cleaned | `tempFileLifecycle.test.ts` (11) — mutations T1–T3 | test |
| R18 | logs exclude private content | `workspacePageData.test.ts`; measured — 6 access-denied lines from a browser walk, 0 with an email, password, cookie or token | test + live |
| R19 | save-intent retention is decided | **resolved, not deferred** — 30-day sweep (`1d36b30`), `saveIntentIdentity.test.ts`, `workerBootstrap.test.ts`, and the sweep observed firing 15 min after boot | test + live |
| R20 | expired results are cleaned up | `retention-sweep-selfscheduled.log` — a forced-expired row purged by the sweep on its own schedule, 325 rows, then 0 still expired | live |
| R21 | shared content survives deleting one reference | `VersionService.test.ts` (62) — mutation K went red on *keeps bytes a stored-file row outside this Workspace still points at* | test |
| R22 | backup and restore | `migration-restore-drill.log` rows 13–16 — online `backup()`, byte-exact restore, `migrate status` on the restored file | evidence |
| R23 | health and readiness tell the truth | `readyRoute.test.ts` (7) — mutation O; live `/api/health` 200 while `/api/health/ready` 503 `toolchain:false` | test + live |
| R24 | private routes are not indexed | `seoIndexingTruth.test.ts` — found the one indexable private page, mutation S1 | test |
| R25 | the sitemap is registry-derived | `seoIndexingTruth.test.ts` — mutations S2/S3; the availability gate keeps 13 unavailable slugs out | test |
| R26 | Pricing matches what can actually be bought | `data/pricing.test.ts` (15) — mutation O2/brief M, 2 red | test |
| R27 | screenshot baselines exist and compare | `GATE-B-VISUAL-ACCEPTANCE.md` — 156 captures over 18 surfaces, mutation N caught at 23–36% of pixels | evidence |
| R28 | a keyboard-only workflow completes | `keyboard-r28.log` — 13 gates signed out, 13 signed in, one row NOT EXERCISED (the OS file dialog) | live |
| R29 | Firefox and WebKit exercised, or explicitly not | `cross-browser.log` — Chromium exercised; Firefox ENVIRONMENTAL; WebKit and screen reader NOT EXERCISED | live |
| R30 | deployment and rollback smoke | `r30-deploy-rollback.log` — 8/8, both artifacts booted, both completed a real job | live |

**Nothing here was satisfied by a source scan alone.** The two claims that once were
— R12's 404-not-403 rule and R24's indexing gate — are the two the mutation program
caught (G and O1/S1), and both got behavioural tests before the mutation was applied.

R13 is the row that shows why the rule earns its place. Its unit coverage was real and
green, and the sanitizer it tests is correct: every hostile name this audit threw at the
running server came back inert. But the *live* POST reached a layer no filename test can
see — the multipart parser itself — and one of the five names never got as far as the
sanitizer at all. It produced an unlogged HTTP 500 (§35, fixed at `388e8af`). A source
scan of `sanitizeBaseName` would have passed R13 with a defect sitting in front of it.

## §28 — The final audit probe, groups A–R

Two different instruments run at final HEAD `388e8af`, and the report keeps them
apart because they answer different questions. Every number below was re-measured at
that HEAD on a clean tree after the R13 fix landed; all of them came back identical to
the run at `9389da3`, which is itself the useful result — a fix to the submit paths
moved nothing else.

**`scripts/final-prelaunch-audit.mjs` is a STATIC harness.** It reads source, config,
schema, the Dockerfile and Git history. It boots nothing. An earlier version of it
advertised "live checks" behind `--url` while its own `live()` helper was called zero
times — fixed in `71f9bf5`, and recorded here so no line below can be mistaken for a
runtime result. Runtime behaviour comes from the four driving probes underneath.

`node scripts/final-prelaunch-audit.mjs --json …` → `HARNESS_EXIT=1`,
**85 rows over 18 groups**, evidence `audit-static-at-388e8af.{log,json}` (and
`audit-static-FINALHEAD.{log,json}` from the earlier HEAD):

| Group | Pass | Not a pass |
|---|---|---|
| A Repository and build integrity | 5 | 2 MANUAL REVIEW (A3 secrets in the tree, A4 secrets in history — both need a human to confirm no *value* is a real one) |
| B Production configuration gate | 7 | — |
| C Deployment artifact | 6 | 2 ENVIRONMENTAL (C7 the image builds, C8 it migrates a fresh volume — no Docker daemon) |
| D Tool inventory and capability truth | 4 | — |
| E Authentication and session | 4 | 2 MANUAL REVIEW (E5 admin session semantics, E6 the setup route) |
| F Tenant isolation | 4 | **1 NOT EXERCISED — F5, and by design: a static reader cannot perform a cross-tenant read.** Done at runtime instead, below |
| G File and processing security | 5 | 1 MANUAL REVIEW (G6 hostile document fixtures — zip bomb, encrypted, malformed xref, embedded JS) |
| H Web security and CSP | 5 | — |
| I Dependencies | 2 | **1 PRODUCT FAILURE (I3)** + 1 MANUAL REVIEW (I4 the image's Node major) |
| J Privacy and retention | 3 | 1 MANUAL REVIEW (J3 no account deletion, no export) |
| K Schema and migrations | 3 | 1 MANUAL REVIEW (K3 destructive migration intent) |
| L Reliability and lifecycle | 4 | 1 MANUAL REVIEW (L3 readiness omits storage writability) |
| M Observability | 2 | 1 NOT EXERCISED (M3 aggregation, alerting, on-call) |
| N Performance budget | 1 | 1 MANUAL REVIEW (N2 static-render opt-outs) + 1 NOT EXERCISED (N3 sustained load — measured by the perf probe instead, §18) |
| O SEO and route truth | 3 | — |
| P Commercial truth | 4 | — |
| Q Analytics and consent | 3 | 1 MANUAL REVIEW (Q4 consent banner — a legal question, not a code one) |
| R Accessibility and responsive layout | 1 | 1 NOT EXERCISED (R2 111 rendered-layout assertions) + 1 MANUAL REVIEW (R3 human visual acceptance) |

**Separate totals — static harness:** PASS **66/67 exercised** · PRODUCT FAILURE **1** ·
ENVIRONMENTAL **2** · NOT EXERCISED **4** · MANUAL REVIEW REQUIRED **12**.

`HARNESS_EXIT=1` is entirely **I3**: nine high advisories in the *development*
dependency tree. §12 traces every one to reachability, and the decisive measurement is
the standalone trace — only `sharp` (server) and `pdfjs-dist` (client bundle) are in
the shipped artifact at all, and the pdf.js advisory needs `enableScripting` plus an
absent `script-src`. Recorded **P2**, not a blocker, and not silently downgraded: the
harness still reports it as a failure and still exits non-zero.

**The same harness gives two different totals, and the difference is worth naming.**
Run with `--offline` it reports **66/66 exercised, 0 product failures,
`HARNESS_EXIT=0`** (`audit-static-at-388e8af-offline.log`), because `npm audit` cannot
run without a network and I3 downgrades itself to ENVIRONMENTAL rather than passing.
The networked run is the one this report quotes. An offline harness cannot see the
only failure the harness has, so `--offline` is a convenience for iterating, never the
number to publish.

**Separate totals — the four runtime probes, same HEAD, same artifact
(BUILD_ID `1nfPtJYCTsqaZBbSstXKc`), evidence `probes-at-388e8af.log`:**

| Probe | Result | Not a pass |
|---|---|---|
| `workflow-completeness-probe` — 18 core journeys | exit 0, **155/156** | 1 ENVIRONMENTAL (journey I: the 415 UNSUPPORTED_OUTPUT branch needs a non-PDF result, and every tool that makes one is `soffice`-backed) |
| `phase1-workspace-reliability-probe` — F5/R11 | exit 0, **29/29** | 2 NOT EXERCISED (the two rows that can only read a dev server's replayed console) |
| `tool-runtime-matrix-probe` — 34 rows for 32 tools | exit 0, **29/29 exercised**, 0 product failures | 2 ENVIRONMENTAL (`pdf-to-word`, `html-to-pdf`), 3 NOT EXERCISED (no `.docx`/`.pptx`/`.xlsx` fixture) |
| `legacy-job-ownership-probe` — R12 | exit 0, **25/25**, 0 failed | — |

**Zero product failures across all four runtime probes at final HEAD.** F5, the row the
static harness cannot reach, is the one this audit spent the most effort on: it now
passes end to end in a real browser, and the refusal it exercises is auditable in every
shape (§9).

## §29 — Mutation testing: the brief's A–O

Fifteen mutations, each applied singly to product source, each observed red at the
gate the brief names, each reverted through Git with the tree confirmed clean by
`git status --porcelain` before the next. Ten were executed in this audit's later
sessions at HEAD `b05108a`; five already had red-and-reverted evidence from earlier
groups and were not rerun, because the code they attack did not change afterwards —
the brief's own rule. Records: `mutation-A-and-E-to-O.md` (with the brief-letter map),
`mutation-B-legacy-save.md`, `mutation-C-deployment.md`, `mutation-D-config-truth.md`,
`mutation-P-retention.md`, `mutation-S-indexing.md`, `mutation-U-malformed-body.log`,
`mutation-results.json` (38 machine-readable rows in the repository's own lettering),
and Gate B's own file.

| Brief | Mutation | Brief expects | Applied to | Observed |
|---|---|---|---|---|
| **A** | a Phase 5 product failure reads as environmental — reintroduce `--psm`, which `ocrmypdf` rejects | R1 | `lib/server/toolProcessing.ts` | **RED** 2 failed / 10 passed |
| **B** | advertise a tool whose binary is absent — a `MissingDependencyError` becomes an ordinary processing failure | R2/R3 | `PdfToolWorkerHandler.ts` | **RED** 1 failed / 12 passed |
| **C** | accept an unsafe production default — delete the gate's wrong-provider and relative-path refusals | R7 | `src/infrastructure/config/env.ts`, `prisma/schema.prisma` | **RED** ×4 rows (D1–D4), 1 failed each |
| **D** | allow an external login redirect — `safeRedirectPath` hands back absolute and scheme-relative candidates | R8 | `authValidation.ts` | **RED** 5 failed / 39 passed |
| **E** | remove one CSRF/origin check — `requireSameOrigin` never objects | R10 | `workspaceCsrf.ts` | **RED** 9 failed / 4 passed |
| **F** | remove a Workspace membership check — `get` grants `editor` to anyone naming an existing Workspace | R11 | `WorkspaceService.ts` | **RED** 8 failed / 35 passed |
| **G** | expose whether a foreign job exists — 403 "Not your job." instead of 404 | R12 | `processingJobApi.ts` | **RED** 4 failed / 24 passed |
| **H** | render an HTML-like filename unsafely — drop the `<` escape from the only raw-HTML sink | R13 | `components/seo/JsonLd.tsx` (+ row `H1`, the staged name) | **RED** 2 failed / 1 passed |
| **I** | pass a filename through shell syntax — `runCommand` with `shell: true` | R14 | `lib/server/runCommand.ts` | **RED** 3 failed / 0 passed, and the run **created** `/tmp/pdfdadi-should-not-exist` |
| **J** | trust the extension without content validation — accept any extension, drop the leading-byte sniff | R15 | `lib/server/validateUpload.ts` | **RED** ×4 rows (`H2`, `J1`, `K1`, `K2`) |
| **K** | delete shared bytes while another document still references them | R21 | `VersionService.ts` | **RED** 1 failed / 61 passed |
| **L** | a CMS-only tool reaches the sitemap | R25 | `app/sitemap.ts` (row `S2`) | **RED** — and it found that the gate is not belt-and-braces: 13 unavailable slugs enter without it |
| **M** | a price and checkout for a plan that cannot be bought | R26 | `data/pricing.ts` (row `O2`) | **RED** 2 failed / 41 passed |
| **N** | a visible spacing regression — homepage `<h1> mt-4 → mt-16`, built and served | R27 / visual | `app/page.tsx` | **RED** `PASS 0/9`, 23–36% of pixels differing against a 0.1% threshold |
| **O** | readiness green while a required dependency is absent — `some` instead of `every` | R23 | `app/api/health/ready/route.ts` (+ `Q1`/`Q2`) | **RED** 1 failed / 6 passed |

After the ten reverts, the combined gate rerun at `f75aac1` was **15 files, 288 tests,
all passing** (`/tmp/mut-gate-rerun.log`), and the full suite at final HEAD is green
(§30). **No mutation is left applied**: the tree is clean, and `store.json.bak` —
mutation A2's gitignored subject, the one row `git status` could never verify — is
absent.

### What the program actually found

Two of the fifteen were not confirmations. **Brief L / S1–S2** found the Workspace
file manager indexable and the sitemap's availability gate load-bearing. **Row O1**
(the analytics allowlist) came back **green** on the first attempt: deleting
`if (!allowed.has(key)) continue;` left 50 passed / 0 failed, because every property
either test fed it was already caught by one of the two other filters. The allowlist —
the thing that stops an undeclared dimension reaching an analytics vendor — was pinned
by nothing. R24 now sends `pageCount`, `orgSeats` and `stackFrame`, which only the
taxonomy can drop; O1 is red at R24 alone, and `events.test.ts` still passes with the
allowlist deleted, which is worth knowing about that file.

Three of the ten executed rows had **no behavioural gate at all** and would have
stayed green: the argv seam (**I**), the raw-HTML sink (**H**) and the 404-not-403 rule
(**G**, which had only a source scan). Their tests were written first, run green and
committed (`2940696`, `b05108a`) *before* the mutation was applied, so the red is a
real gate rather than a test shaped to fit a known failure.

### One mutation the brief did not ask for: U, on the fix this audit shipped last

The malformed-body guard (§35, `388e8af`) is product code this audit wrote, so it was
held to the same standard as the code it audits — three mutations, each red, each
reverted through Git (`mutation-U-malformed-body.log`):

| Row | Mutation | Observed |
|---|---|---|
| **U1** | remove the guard from `toolJobSubmit.ts`, back to a bare `await request.formData()` | **RED** 1 failed / 31 passed |
| **U2** | keep the guard on `processingJobSubmit.ts` but throw the wrong error type, so the generic catch answers 500 again | **RED** 1 failed / 31 passed |
| **U3** | remove the log line from the unclassified-500 site | **RED** 2 failed / 4 passed |

These three are a **rerun**. Their first pass was genuinely red, but each revert restored
the *pre-fix* code, because the fix had not been committed yet and `git checkout --` can
only restore what Git holds. That is worth recording rather than hiding: a mutation
program whose subject is uncommitted silently tests the wrong baseline. The rerun above
ran against the committed `388e8af`, and the suite is green again afterwards
(38 passed / 38).

### What no mutation here reaches, stated rather than implied

Source mutation cannot move the Gate A rows that are probe or host facts; it cannot
prove *wiring* (a route calling the right service, a worker reading the right flag) —
that is what the probe runs at HEAD do; and `P7` is the shape that matters most for
this repository: it type-checks clean (`tsc --noEmit` exit 0) and only the behavioural
wiring test sees it, which is the same failure mode the memory notes record from
earlier phases.

## §30 — Final verification

Every gate below ran **after** the last change to shipped code, on one artifact built
from it. The artifact is `BUILD_ID 1nfPtJYCTsqaZBbSstXKc`, built at commit `388e8af` — the
commit that carries the last change to shipped code, the R13 malformed-body fix (§35).
Every commit after it touches `docs/**` only: `git diff --name-only 388e8af..HEAD`
lists **0 non-docs paths**, re-checked at each later HEAD including the last. The
commands are recorded verbatim in
`docs/evidence/final-prelaunch/FINAL-VERIFICATION-COMMANDS.md`, and the runs
themselves in `probes-at-388e8af.log`, `gates-at-388e8af.log` and
`audit-static-at-388e8af.log`.

An earlier full pass of this same table ran at `9389da3` /
`BUILD_ID _DzYjfCuvno7KJhZM8SWY` and is kept in the evidence directory. It is
superseded, not contradicted: **every gate returned the same result at both**, and the
only figures that moved are the four unit tests the fix added.

| Gate | Command | Exit | Result |
|---|---|---|---|
| Build | `npm run build` | **0** | `BUILD_ID 1nfPtJYCTsqaZBbSstXKc`; standalone server emitted; `.next/static` and `public` copied into it before boot; both new guard strings confirmed present in `.next/standalone/.next/server/chunks` |
| Types | `npx tsc --noEmit` | **0** | 0 lines of output |
| Lint | `npx eslint .` | **0** | 13 problems — **0 errors**, 13 warnings (unused vars not prefixed `_`) |
| Schema | `npx prisma validate` | **0** | *The schema at prisma/schema.prisma is valid* |
| Migrations | `npx prisma migrate status` | **0** | *Database schema is up to date!* |
| Unit/integration suite | `npx vitest run` | **0** | **377 files, 7287 tests, 7287 passed, 0 failed** |
| Static harness A–R | `node scripts/final-prelaunch-audit.mjs --json …` | **1** | 66/67 exercised, 85 rows; the non-zero exit is I3 alone (§28) |
| Core journeys | `node scripts/workflow-completeness-probe.mjs --url …` | **0** | **155/156**; 1 ENVIRONMENTAL |
| Workspace / F5 / R11 | `node scripts/phase1-workspace-reliability-probe.mjs …` | **0** | **29/29**; 2 NOT EXERCISED |
| Tool matrix | `node scripts/tool-runtime-matrix-probe.mjs --url … --json …` | **0** | **29/29 exercised**, 0 product failures; 2 ENVIRONMENTAL, 3 NOT EXERCISED |
| Job ownership / R12 | `node scripts/legacy-job-ownership-probe.mjs --url …` | **0** | **25/25**, 0 failed |
| Export fidelity | `npm run test:export-fidelity` | **0** | **35/35 fixtures within threshold** — worst `image-low-resolution` 10.716% against a 12.0% limit |
| Visual compare (Gate B) | `node scripts/visual-acceptance-probe.mjs --url … --auth` | **0** | **156/156 exercised**, 1 NOT EXERCISED (`19-app-error` needs a genuinely failing dependency); verdict stays **`VISUAL ACCEPTANCE PENDING`** |
| Liveness | `GET /api/health` | — | **200** |
| Readiness | `GET /api/health/ready` | — | **503** `{"ok":false,"status":"degraded","dataDir":true,"toolchain":false,"database":true}` — truthful: `soffice` is absent from this host |

**The 503 is the correct answer here and is not counted as a pass.** It is the
liveness/readiness split working: the process is alive, the toolchain is not complete,
and the body names which subsystem is false without naming the binary.

Two notes on how these numbers were produced, because both changed a result earlier in
this audit:

- Every browser probe uses `https://172.20.10.2:3051` — the TLS front — and that value
  is also `NEXT_PUBLIC_SITE_URL`. Point a probe at `127.0.0.1` instead and the
  CSRF/origin gate refuses every mutation, which reads as a wall of product failures.
- Node's `fetch` rejects the front's self-signed certificate and CDP-driven Chrome
  needs `--ignore-certificate-errors`. Two separate fixes for one certificate; missing
  either one produced "no server answering" while `curl` worked.

One harness note, recorded because it appears in the older boot logs: the boot script
used to ask `/api/ready`, which is a **404** — the route is `/api/health/ready`. That
was the script's path typo, not a missing route; no readiness evidence in this report
was ever taken from it, and the script asks the real path now, which is where the
`503 degraded` row above comes from.

**One live re-measurement belongs in this table but does not fit a row.** The defect
fixed at `388e8af` was checked against this artifact rather than only in unit tests: a
hand-built multipart POST whose filename carries a raw `"` now answers
**`400 {"error":"Malformed multipart body."}`** on the shipped default *and* on a
`PROCESSING_PIPELINE=on` leg — it answered an unlogged `500` on both before. Evidence:
`hostile-filename-r13.log`.

## §31 — Files changed

Against the baseline this branch was cut from (`651c8fa`, `phase-6-premium-ui`):
**189 files, +21884 / −727** at the artifact commit `388e8af`, of which product source under `app/`,
`components/`, `lib/`, `src/`, `prisma/`, `next.config.mjs`, `Dockerfile` and `docker-compose.yml`
is the part that ships. At the branch tip that carries this report the figure is **199 files,
+23608 / −727**; the whole difference is this document, the progress file and evidence files
written after the artifact was frozen — `git diff --name-only 388e8af..HEAD` still lists
0 non-docs paths.

**Behaviour changed (the fixes):**

| File | What changed |
|---|---|
| `data/admin/store.json` | the shipped admin password hash removed (P0) |
| `src/infrastructure/config/env.ts`, `startupGate.ts` | the production gate stops demanding a database the shipped Prisma provider cannot open (P0) |
| `Dockerfile`, `docker-compose.yml` | the container path can build, boot and keep its data across a restart (P0) |
| `app/api/jobs/[id]/save-to-workspace/route.ts` | `Save to Workspace` works on a legacy server-tool result (P1) |
| `lib/server/toolProcessing.ts` | `ocr-pdf` passes `--tesseract-pagesegmode`, the flag `ocrmypdf` actually has (P1) |
| `next.config.mjs` | `experimental.proxyClientMaxBodySize: "120mb"` — the advertised 100/110 MiB ceilings were unreachable past 10.004 MiB (P1) |
| `src/infrastructure/jobs/PdfToolWorkerHandler.ts`, `workerBootstrap.ts` | the recurring sweep now prunes `workspace_save_intents` past 30 days and expired `sessions` |
| `src/application/ports/auth/SessionProvider.ts`, `LocalSessionProvider.ts` | `pruneExpired` added and made **required** on the port |
| `app/api/health/ready/route.ts` | readiness aggregates the toolchain with `every`, and never names the missing binary |
| `app/workspaces/[workspaceId]/page.tsx` | `robots: {index:false, follow:false}` — it was the one private page a crawler could index |
| `app/sitemap.ts`, `app/robots.ts` | the availability gate, now with its comment corrected to say it is load-bearing |
| `src/application/services/workspacePageData.ts` | one structured, ids-only line per refused Workspace page |
| `lib/server/toolJobSubmit.ts` | `sanitizeBaseName` no longer turns `..pdf` into `...pdf` (P3); and a body no multipart parser can read now throws `UploadValidationError` → **400**, not an unlogged 500 (P2) |
| `lib/server/processingJobSubmit.ts` | the same guard on the unified-pipeline submit path, so both configurations answer alike |
| `lib/server/processingJobApi.ts`, `app/api/jobs/route.ts` | the two unclassified-500 sites now log error name and message — never the filename, per R18 |
| `app/not-found.tsx` (new), `app/workspaces/not-found.tsx` | every unknown URL gets the product's 404 rather than Next's framework page |
| 19 `app/admin/*/page.tsx`, `app/login`, `app/register`, `app/editor` | `title.absolute` — 27 titles were branded twice |
| `components/contact/ContactForm.tsx` | stops thanking a visitor for a message it discards (P3) |
| `components/editor/documentLoadState.ts`, `lib/editor/loadPdf.ts`, `loadWorkspaceDocument.ts`, `EditorWorkspace.tsx` | a valid large document is no longer called "possibly damaged"; the page ceiling says what it is |
| `components/workspaces/*`, `components/app/*` | the premium-UI surfaces the visual gate captures |

**Tests and infrastructure:** 11 new `.test.ts` files, 14 extended (§27),
`test/stubs/server-only.ts` (a Next-supplied package absent from `node_modules`, which
is why nothing had ever called `sitemap()` or `robots()`), and `vitest.config.ts`.

**Audit-only, not shipped:** `scripts/final-prelaunch-audit.mjs` and eight probe
scripts; `docs/FINAL_PRELAUNCH_AUDIT.md`, `docs/FINAL_PRELAUNCH_PROGRESS.md` and
`docs/evidence/final-prelaunch/**`. Screenshot baselines stay under gitignored
`docs/screenshots/final-prelaunch/` (41 MB), so Gate B's compare is reproducible on
this host only.

**Deliberately not changed:** no dependency was upgraded; `audit_logs` remains
unpruned by design; `Dockerfile`'s CRLF line endings are recorded as P2 hygiene rather
than edited blind in an artifact no build on this host can verify.

## §32 — Commits and working tree

Branch `final-prelaunch-audit`, **77 commits** ahead of `651c8fa` at the artifact commit
`388e8af`, and **80** at the branch tip that carries this report — the extra three are
documentation and evidence only, which is why the artifact is still final HEAD for every
gate. (`651c8fa` is the audit's own baseline, not the branch point: this branch already
carried 18 Phase 6 commits before the audit opened.) **No remote is
configured, nothing was pushed, and `main` is untouched.** Working tree at the end of
the audit: clean — `git status --porcelain` empty, no merge, rebase or cherry-pick in
progress, one worktree.

Classified by the highest-priority path each one touches — product source, then
tests, then `scripts/`, then `docs/` — the 77 are: **17** that change product
behaviour, **8** that only add or strengthen tests, **13** that only fix the audit's
own probes and harness, and **38** docs-only (20 evidence, 10 progress checkpoints, 8
report and ledger). One commit touches none of those paths. At the branch tip the only
figure that moves is docs-only, 38 → **41**: 17 / 8 / 13 / 41 / 1 = 80. Counting by priority is
why the test figure is small: most test work landed in the same commit as the fix it
guards, which is deliberate — §29 depends on a fix being *committed* before its
mutation runs. The audit's own defects are committed under their own names rather than
folded into the fixes, because five of them produced a plausible, publishable, wrong
failure:

| Commit | The probe's own defect |
|---|---|
| `79e292e` | journey I′ called its own blind spot a product failure |
| `71f9bf5` | the harness's `--url` advertised live checks the code never made |
| `13dd074` | 14 uploads of one buffer were **one** document, so a capacity threshold was invented |
| `6b2a201` | every editor refusal was dated at the poll deadline — "refused after 30830ms" for a two-second answer |
| `bfed32f` | the deployment smoke polled a job as a different caller than submitted it, and read R12's correct 404 as a deploy blocker |
| `7c3c2a2` | the keyboard probe's four failures were all `tabThrough`'s off-by-one |
| `223399b` | three of the visual harness's green rows were green by luck |
| `9389da3` | two probe rows read the browser console for server logs, which only `next dev` replays |

The interrupted first session's work was recovered and committed intact (`438e800`),
not rewritten: its harness, probes, fixtures and evidence are in history as they were
found.

## §33 — P0

**Three P0 defects were found. All three are fixed on this branch, and each one
independently prevented a launch.**

| # | Defect | Why it was P0 | Fixed |
|---|---|---|---|
| P0-1 | `data/admin/store.json` shipped a real scrypt password hash for the admin account | the admin credential of every deployment was a committed artifact: a self-hoster could not set their own, and the hash was in the repository and in Git history | `97b8110` |
| P0-2 | the container deployment path could not build, boot, or keep its data | `COPY` of a path the build does not produce; the entrypoint served without migrating; the database and stored documents lived inside the container layer, so a restart discarded every uploaded document | `28e377b` |
| P0-3 | the production startup gate refused to start unless `DATABASE_URL` named a database the shipped Prisma provider cannot open | the documented production configuration could not boot at all | `b6e3961` |

Each is pinned by a test that fails without the fix: `shippedStoreSecrets.test.ts`
globs *filenames* under `data/admin` so a `.bak` sibling cannot hide (mutation A2 —
and the tree's `.bak` is gitignored, so `git status` could never have been the check),
`deploymentArtifact.test.ts` (8 tests, mutations C1–C5), and `env.test.ts` (25 tests,
mutations D1–D4).

**No P0 is open.** Nothing in the final verification, in any of the four runtime probes,
or in the static harness's 85 rows is a P0.

## §34 — P1

**Six P1 defects were found. All six are fixed.**

| # | Defect | Effect on a real user | Fixed |
|---|---|---|---|
| P1-1 | `Save to Workspace` answered 404 for every job that was not `processing`-typed | the button was offered on eleven tools and could not succeed on any of them in the shipped configuration | `7facfae` |
| P1-2 | `ocr-pdf` passed `--psm`, a flag `ocrmypdf` does not accept | OCR never ran; the user was told their file may be damaged | `46baf5e` |
| P1-3 | every advertised upload ceiling was unreachable past **10.004 MiB** | a valid 22 MiB PDF was refused with *"Malformed multipart body."* — the product blamed the user's file for its own body-clone limit. 100 MiB and 110 MiB were advertised | `a14e7c1` |
| P1-4 | `workspace_save_intents` grew forever | one row per save — `userId`, `workspaceId`, payload checksum — with no delete anywhere, no cascade reaching it, and no policy. Unbounded personal data in a production table | `1d36b30` |
| P1-5 | expired `sessions` were never deleted | a row per login, removed only by explicit logout, **in an authentication table**. `get` already refuses an expired token, which is exactly why the growth went unnoticed | `371f4ef` |
| P1-6 | `SERVER_SETUP.md` described a build that had not shipped for a year | an operator following the documented steps does not get a working deployment | `0d13da2` |

P1-4 and P1-5 are the brief's K item, **resolved rather than classified**: both now ride
the retention sweep that already recurs every 15 minutes, with a 30-day horizon, the
Prisma adapter proved against real SQLite rather than only its in-memory twin, and
`pruneExpired` made **required** on `ISessionProvider` — which surfaced five `tsc` errors
across four doubles, and that was the point. The sweep was then watched doing it in a
deployed artifact: 15 minutes after boot, unprompted, it purged a forced-expired row
along with 324 others and rescheduled itself (`retention-sweep-selfscheduled.log`).

**No P1 is open.**

## §35 — P2 and below

**Fixed during the audit:**

| Defect | Class | Fixed |
|---|---|---|
| no root `app/not-found.tsx` — every unknown public URL got Next's framework 404: no brand, no navigation, near-black under `prefers-color-scheme: dark`. The visual gate had recorded that page as the *reference* for surface `18-not-found` and passed it nine times | P2 | `b29f79f` |
| the Workspace file manager was the one private page a crawler could index — it exported no `metadata` and has no layout above it to supply one, while all three siblings declared `robots:{index:false}` | P2 | `450657d` |
| a valid 300-page document was refused with *"may be damaged"* instead of the page ceiling it actually hit | P2 | `297c776` |
| the cross-tenant page refusal produced **no audit line at all** — the organization guard runs before the only place that logs. Correct answer, invisible | P2 | `9389da3` |
| an upload whose filename carries a raw `"` made the multipart body unparseable, and the `TypeError` reached the route's generic catch: HTTP **500**, no log line, on both submit paths. Found by POSTing R13's hostile filenames for real rather than reading the sanitizer | P2 | `388e8af` |
| 27 pages branded their own titles under the root layout's `title.template` → *"Page not found — PDFDadi — PDFDadi"* | P3 | `b29f79f` |
| `sanitizeBaseName` turned an upload named `..pdf` into a download named `...pdf` | P3 | `d84ed4a` |
| `/contact` showed a green tick and *"we've noted your message"* with no transport behind it — no fetch, no server action, no mail provider | P3 (copy-only fix; a mail transport is feature work this audit may not add) | `f55ffca` |

**Open P2 — none of these blocks a launch, and none is inflated into one:**

| # | Open finding | Why it is P2 and not higher |
|---|---|---|
| P2-1 | nine high npm advisories (`next`, `prisma`, `pdfjs-dist`, `postcss`, `nanoid`, `brace-expansion`, `deepmerge-ts`, `@prisma/config`) | traced individually in §12. The standalone artifact contains only `sharp` and the client `pdfjs-dist`; the pdf.js advisory needs `enableScripting` **and** no `script-src`, and both are absent. Not fixed here because the brief forbids mass dependency upgrades — this is a scheduled-maintenance item |
| P2-2 | Workspace Editor **CLS 0.212**, twice the 0.1 threshold, on the largest payload (921 KB / 459 KB JS) | a visible quality defect on the authenticated workbench, not a functional failure; the fix is a reserved-height container |
| P2-3 | no error-monitoring backend (`ConsoleErrorReporter`) | a production incident produces no alert. One adapter; loses no data |
| P2-4 | metrics exist but never leave the process | no time series for an incident. One adapter |
| P2-5 | `Dockerfile` has CRLF line endings — the only deploy-critical file that does | BuildKit tolerates them, and the container path is NOT EXERCISED on this host; changing it blind in an artifact no build here can verify would be worse than recording it |
| P2-6 | server processing takes ≈3 s largely independent of input size | an observation from §18, not a diagnosis. No retries appear in the log; it is recorded so it is not mistaken for a per-megabyte cost |
| P2-7 | the three Workspace upload routes `await request.formData()` with only `requireSameOrigin` ahead of it, so an **anonymous** caller's multipart body is buffered and parsed before any authentication. Measured live, no session cookie: a 13-byte and an **8 MiB** well-formed body both reached *field* validation (`422 "Invalid attachment fields."`), which is downstream of the parse | bounded per request and unbounded only in request count. The ceiling holds and holds cheaply — 26 MiB declared and sent returned `413 PAYLOAD_TOO_LARGE` in **0.03 s**, i.e. refused on content-length before the body was read, at `maxAttachmentBytes` = 25 MiB. Nothing is bypassed: authorization still precedes every read and every write, and `versions/upload/route.ts:81`'s documented *AUTHORIZATION BEFORE STORAGE* invariant is intact. Nothing is disclosed: an invalid-fields answer is what a non-existent workspace returns too. The missing piece is a **rate limit** — six shipped routes construct one, including the *public* tool route, and none of these *private* ones does — and its values are a policy decision, so it is §37's fourteenth open decision rather than a change made here |

**None of the open P2 items predates or postdates its way out of this list.** Three of them
(P2-1, P2-5, P2-7) were already true at the baseline; per the brief they are not downgraded
for that reason, and equally they are not promoted to blockers because this audit noticed them.

**One open P3, from the same pass as P2-7.** The identical unparseable body answers `422
"A multipart upload is required."` from the attachments route and `400 "Malformed multipart
body."` from its two siblings. 422 is the wrong status for a body that cannot be parsed, and
the message misdescribes the cause — a multipart upload *was* supplied, it just could not be
read. Left unchanged for the same reason as P2-7: shipped code cannot move without
invalidating the artifact all thirteen gates in §30 were measured against. Evidence for both:
`docs/evidence/final-prelaunch/anonymous-parse-workspace-uploads.log`.

**How both were found.** Not by reading. The R13 fix at `388e8af` guarded two `formData()`
call sites, so the root-cause question — *does this fix have an unguarded sibling?* —
required listing all five in shipped code. All five are guarded. But the same listing showed
what runs *before* the parse on three of them, and that ordering was then exercised against
the running artifact with no cookie attached rather than asserted from the source.

## §36 — Environmental and not exercised

Nothing in this section is a pass. Every row is something this host could not do, or
something a machine cannot decide, stated so it cannot be mistaken for a green check.

### The host could not do it (ENVIRONMENTAL)

| # | Blocker | What it cost |
|---|---|---|
| E-1 | **`soffice` is absent** (`which soffice` → nothing) | `pdf-to-word` and `html-to-pdf` cannot run here at all; journey I's `415 UNSUPPORTED_OUTPUT` branch is unreachable because every tool that produces a non-PDF output is `soffice`-backed; and `/api/health/ready` answers **503 `toolchain:false`** — which is the truthful answer, and is what mutation O attacked. The *refusal* path was exercised: both tools report a server-side unavailability that blames no file and leaks no path or command |
| E-2 | **no Docker daemon** | harness C7 (the image builds) and C8 (the image migrates a fresh volume and serves) could not run; the container deploy and rollback path is unexercised. The standalone equivalent ran instead — `r30-deploy-rollback.log`, 8/8, both artifacts booted and both completed a real job |
| E-3 | **Playwright's Firefox build is absent** from `~/Library/Caches/ms-playwright` (chromium only) | R29's Firefox leg |
| E-4 | **no production credentials, no production environment** | nothing in this audit ran against production, and no report line claims otherwise |

### A machine cannot decide it, or nothing drove it (NOT EXERCISED)

| # | Not exercised | Why |
|---|---|---|
| X-1 | **human visual acceptance** (harness R3) | 156 captures compare clean at final HEAD and mutation N proves the gate can see a real regression, but **no human has approved how any of it looks**. Verdict `VISUAL ACCEPTANCE PENDING` |
| X-2 | `19-app-error` — the error boundary surface | needs a genuinely failing dependency; this server answered `/workspaces` normally. Captured once against a broken `DATABASE_URL` in its own run, which is recorded and not counted |
| X-3 | 111 rendered-layout assertions across 9 viewports (harness R2) | the static harness cannot render; the visual and responsive probes cover the same surfaces by pixel instead |
| X-4 | `word-to-pdf`, `powerpoint-to-pdf`, `excel-to-pdf` | no `.docx`, `.pptx` or `.xlsx` fixture exists in the repository. Their dependency was still checked (`soffice` = absent) |
| X-5 | two workspace-probe observability rows | server logs are not replayed into the browser console outside `next dev`. The same property was measured directly from the server's log instead: 6 access-denied lines, 0 containing an email, password, cookie or token |
| X-6 | keyboard row M5b — the OS file dialog | no CDP client can drive it. The other 26 keyboard gates pass, signed out and signed in |
| X-7 | **WebKit and a screen reader** | `safaridriver` refuses without `safaridriver --enable`; no screen reader was driven. Chromium is the one engine measured |
| X-8 | log aggregation, alerting, an on-call route (harness M3) | none exists to exercise — see P2-3 and P2-4 |
| X-9 | sustained load, cold-start latency, memory ceiling under concurrency (harness N3) | the perf probe measures page and workflow latency and a fan-out capacity table; a sustained soak was not run |
| X-10 | zero-downtime deployment | the rehearsal stops the server, swaps the artifact and starts it again — an outage window of seconds, which is what the runbook describes. No load balancer was observed draining on the 503 |
| X-11 | image digest pinning, `migrate deploy` inside a container | follows from E-2 |

### A human must confirm it (MANUAL REVIEW REQUIRED — 12 harness rows)

`A3` and `A4` — no secret **value** is committed in the tree or reachable in local Git
history: the scan finds the shapes, only a human can confirm none is a live credential.
`E5` admin session semantics · `E6` the setup route on an initialized deployment ·
`G6` hostile document fixtures (zip bomb, encrypted, malformed xref, embedded JS —
these are absent from the repository and were not synthesized) · `I4` the Node major the
image ships · `J3` no account deletion and no export exist anywhere in the tree ·
`K3` destructive-migration intent · `L3` readiness omits storage writability ·
`N2` static-render opt-outs · `Q4` whether first-party measurement needs a consent
banner in the launch jurisdictions (a legal question) · `R3` the visual acceptance above.

## §37 — Release decision

### What the code earned

At final HEAD `388e8af` (`BUILD_ID 1nfPtJYCTsqaZBbSstXKc`, and
`git diff --name-only 388e8af..HEAD` lists 0 non-docs paths, so the artifact measured
below *is* the artifact this branch ships): build 0 · `tsc --noEmit` 0 · `eslint .` 0
errors · `prisma validate` 0 and `migrate status` up to date · **7287/7287** unit tests ·
workflow completeness 155/156 · workspace and tenancy 29/29 · tool matrix 29/29
exercised with 0 product failures · job ownership 25/25 · export fidelity 35/35 ·
Gate B 156/156 captures compared clean. **Zero product failures in all four runtime
probes.** A clean-machine reproduction (`npm ci` from the lockfile into a fresh worktree,
blank database, migrations, build, boot, probe) reached the same result. Deploy and
rollback were rehearsed for real on the standalone path: both artifacts booted and both
completed a real job. The brief's fifteen mutations (A-O) were applied one at a time, each turned a gate
red, each was reverted through Git, and the gate came back green. The audit ran
more than the brief asked: **38** machine-readable rows in its own lettering
(`mutation-results.json`) plus Gate B's screenshot mutation. The last three of those
attack a fix this audit wrote itself (§29, row U).

Three P0 findings and six P1 findings were opened by this audit and **all nine are
fixed**, each with the commit recorded in §33 and §34. No P0 and no P1 is open. Seven P2
items and one P3 remain open and are listed in §35; none of them is a launch blocker, and
none is inflated into one here. The seventh was opened by the audit's own last check —
asking whether the `388e8af` fix had an unguarded sibling, and then posting to the routes
it named instead of reading them.

### Why that is not the same as launch-ready

Four things cannot be settled by this repository on this host, and §36 records them as
what they are rather than as passes:

1. **No human has approved how it looks.** The gate can see a real spacing regression —
   mutation N proved that — but 156 self-generated captures are not visual acceptance.
   **`VISUAL ACCEPTANCE PENDING`**.
2. **No container image was ever built.** There is no Docker daemon here, so C7, C8, the
   image digest, an in-container `migrate deploy` and the container rollback are all
   unexercised. What is proven is the standalone path.
3. **Two tools cannot run at all here** (`soffice` absent), which is also why readiness
   correctly answers 503 `toolchain:false`. On a host with LibreOffice installed that
   turns green; nothing here demonstrates it.
4. **Nothing ran against production** — no production credentials, no production
   environment, no real domain or certificate, one browser engine, no soak.

### Fourteen decisions this audit will not make for you

Each is a business or operations choice, not a defect. The code supports either answer;
none is invented here.

| # | Decision | Both answers are supported — the difference |
|---|---|---|
| 1 | Does the free tier stay free? | copy deliberately says "$0 today" |
| 2 | Are Stripe keys set at launch? | three environment variables separate free-only from paid |
| 3 | Launch without password recovery? | there is no reset flow; an operator can reset a hash |
| 4 | Domain, DNS, TLS provisioning | `https://pdfdadi.com` is configured intent only |
| 5 | Markets, languages, currency | one language, `$` implied, no stated market |
| 6 | Where stdout is collected and for how long | decides whether "was there an error last Tuesday" is answerable |
| 7 | Backup schedule and an off-host copy | the *procedure* is proven (R22), the *policy* does not exist |
| 8 | Is the single support inbox monitored? | it is the entire support plan |
| 9 | Account erasure and data export (J3) | neither exists in the tree; whether that is required is jurisdictional |
| 10 | `audit_logs` retention | the only table with no expiry and deliberate append-only growth |
| 11 | Image and artifact retention for rollback | how far back a rollback must be able to reach |
| 12 | Who authorizes a restore that loses data | R22 restores to a point in time; the loss window needs an owner |
| 13 | SQLite now, or PostgreSQL before launch | SQLite is correct for one host and is the ceiling on the next one |
| 14 | Rate limits on the Workspace upload routes — and whether a limiter in one process is the right layer at all | the *public* tool route is limited; the three *private* upload routes are not, and each will parse an anonymous 25 MiB body (P2-7). The values (requests per IP per window, and whether the limit belongs in the app or in front of it) are a capacity and cost choice, not a defect |

Items 1–8 are carried from `LAUNCH-PROFILE.md`; 9–13 were opened by later sections, and 14
by the last check this audit ran (§35, P2-7). Twelve further rows need a human eye rather
than a decision, and are listed in §36.

### Verdict

The product is complete, internally consistent, tenancy-safe on every path probed, and
reproducible from a clean checkout. What is missing is not code: it is human visual
acceptance, a container build, a real production environment and fourteen decisions.

**PDFDADI CODE READY — PRODUCTION ACCEPTANCE NOT EXERCISED**
