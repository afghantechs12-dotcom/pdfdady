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
| boot (shipped default) | `env … node .next/standalone/server.js` — the shipped default **at the time of this run**; since §40 it is `node ingress/server.mjs`, and the generated entry exits 1 in production | `/api/health` **200**, `/api/health/ready` **503 degraded — toolchain false** |
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

> **Two harness corrections were made on `upload-abuse-closeout`, in harness code only.**
> Both were found by the closeout, and neither changes a product line.
> **F3** ("every mutating Workspace route enforces same-origin") scanned each route file for
> `requireSameOrigin` by name. The three upload routes stopped containing that call when the
> gate absorbed it, so a *correct* refactor would have turned F3 red. It now accepts
> `workspaceUploadGate` transitively — but **only while** `lib/server/workspaceUploadGate.ts`
> itself still contains `requireSameOrigin`, so the check cannot be satisfied by a file that
> merely has the right import name.
> **I3** did `metadata.vulnerabilities ?? 0`, which silently reported *zero advisories* when
> `npm audit --json` produced no vulnerability block at all — a missing measurement rendered
> as a clean one. It now returns ENVIRONMENTAL: an absent count is an absent measurement, not
> a pass.

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

**Six P1 defects were found during the audit. All six are fixed.** A seventh was opened
*after* the audit closed, by reclassifying P2-7 upward — see §38.

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

**No P1 from the audit is open.** The one opened afterwards, P1-7 (the reclassified
P2-7), is closed too — with its own evidence, tests and live measurements in §38.

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

> **P2-7 IS RECLASSIFIED P2 → P1-7 AND CLOSED.** The row above is the original
> classification and stays exactly as it was written; this is the correction, not a
> replacement. **Why the severity was wrong:** the row weighed the finding as *bounded
> per-request parse work* and treated the missing rate limit as a capacity decision. It is
> more than that. An **unauthenticated** caller could make the server buffer and parse a
> multipart body — up to 25 MiB on the attachments route — before any authentication ran,
> and nothing bounded how many times. Unauthenticated resource consumption ahead of
> authentication, with no throttle, is a launch-hardening defect rather than a scheduled
> item, however cheap one request is. **What was still right:** no access control was
> bypassed, nothing was disclosed, and the per-request ceiling did hold — that part of the
> original analysis survived every re-measurement. Closed on branch
> `upload-abuse-closeout`; §38 has the fix, the tests, the mutations and the live numbers.

**One open P3, from the same pass as P2-7.** The identical unparseable body answers `422
"A multipart upload is required."` from the attachments route and `400 "Malformed multipart
body."` from its two siblings. 422 is the wrong status for a body that cannot be parsed, and
the message misdescribes the cause — a multipart upload *was* supplied, it just could not be
read. Left unchanged for the same reason as P2-7: shipped code cannot move without
invalidating the artifact all thirteen gates in §30 were measured against. Evidence for both:
`docs/evidence/final-prelaunch/anonymous-parse-workspace-uploads.log`.

> **THAT P3 IS CLOSED.** All three routes now answer one unparseable body identically:
> `400 {"code":"MALFORMED_MULTIPART","message":"Malformed multipart body."}`, from one
> taxonomy in `lib/server/multipart.ts`. Measured live on all three (L7, L7b in
> `upload-abuse-live.json`). The 422 is retained for its correct use — a **well-formed**
> body whose fields are invalid.

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
| X-6 | ~~keyboard row M5b — the OS file dialog~~ **NOW EXERCISED, and the reason above was wrong** | M5b drives the *destination `<select>`* in `ResultWorkflowActions`, not a file dialog. What blocked it is a macOS platform fact, measured in isolation rather than assumed: a **closed** native `<select>` routes `ArrowDown` to a browser-process popup that CDP cannot reach — neither `keyDown` nor `rawKeyDown` moves the selection — while **type-ahead of an option's first character does** change the value and fire `change`. The harness gesture now tries `ArrowDown` and falls back to type-ahead (`scripts/premium-ui-ux-probe.mjs`), and the gate detail reports which gesture actually moved it. Result at the frozen artifact: **125 pass, 0 product failures, 0 environmental, 0 not exercised** — product code untouched |
| X-12 | the `PROCESSING_PIPELINE=on` `compress-pdf` row of the tool-runtime matrix | the probe can only observe a **blob** download; the pipeline runner deliberately *navigates* to a signed URL (`scripts/tool-runtime-matrix-probe.mjs:178-208`, `hooks/useProcessingJob.ts:263`, `components/tools/runners/PipelineToolRunner.tsx:25-27`), so there is no blob to see. P3 and **harness-side**: the same delivery was then measured at the HTTP layer instead — 202 → `completed` 8219 → 302 with `content-disposition` + `no-store` → 200, 8219 bytes, `%PDF-1.5`. The default-config row passes on its own (8218 bytes via `gs`). Nothing was edited to make a row go green: `docs/evidence/final-prelaunch/pipeline-flag-compress-download.log` |
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
| 14 (resolved in code) | *superseded* — the app-layer limit now exists and is on by default: `UPLOAD_RATE_LIMIT_PER_MIN` 120 / `UPLOAD_ANON_RATE_LIMIT_PER_MIN` 20 / `UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN` 240, 60 s window (§38). What remains a decision is only the **numbers** and whether a second limit belongs in front of the app for multi-instance deployments — not whether any limit exists |

Items 1–8 are carried from `LAUNCH-PROFILE.md`; 9–13 were opened by later sections, and 14
by the last check this audit ran (§35, P2-7) — and 14 is now a *tuning* decision rather
than a *whether* decision, because §38 shipped the limiter. Twelve further rows need a human
eye rather than a decision, and are listed in §36.

### Verdict

The product is complete, internally consistent, tenancy-safe on every path probed, and
reproducible from a clean checkout. What is missing is not code: it is human visual
acceptance, a container build, a real production environment and fourteen decisions.

**PDFDADI CODE READY — PRODUCTION ACCEPTANCE NOT EXERCISED**

---

## §38 — Upload-abuse closeout (postdates the audit)

Branch `upload-abuse-closeout`, cut from the audit HEAD `1640b12`. Everything above this
line is the audit as it stood; nothing above was rewritten. §37's verdict was the audit's
verdict and is left as written.

**The correction, stated once.** P2-7 was reclassified **P2 → P1** and then closed. The
original row weighed it as bounded per-request parse work whose missing rate limit was a
capacity decision. That undersold it: an **unauthenticated** caller could make the server
buffer and parse up to 25 MiB before authentication ran, and nothing bounded the number of
such requests. Unauthenticated resource consumption ahead of authentication, unthrottled, is
launch hardening, not maintenance. The part of the original analysis that was right — no
access-control bypass, no disclosure, a per-request ceiling that does hold — survived
re-measurement and is unchanged. The original evidence file is untouched.

### 1 — Route inventory

`grep -rn '\.formData()' app/ lib/ src/ components/ --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
now returns **one** shipped line: `lib/server/multipart.ts:113`, inside `readMultipart`. The
five upload entry points reach it through two shared functions, and S1 fails if a sixth
appears anywhere else:

| Entry point | Via | Ceiling |
|---|---|---|
| `POST /api/workspaces/[workspaceId]/documents/upload` | `workspaceUploadGate` | 100 MiB |
| `POST /api/workspaces/[workspaceId]/documents/[documentId]/versions/upload` | `workspaceUploadGate` | 100 MiB |
| `POST /api/workspaces/[workspaceId]/documents/[documentId]/attachments` | `workspaceUploadGate` | 25 MiB + 64 KiB |
| `POST /api/tools/[slug]` | `submitToolJob` | 110 MiB |
| `POST /api/jobs?slug=…` | `submitToolJob` / `submitProcessingJob` | 110 MiB |

### 2 — Request-gate ordering

Full nine-stage table for all five sites, with the measurement behind every row:
`docs/evidence/final-prelaunch/upload-gate-ordering.md`. The three private routes, in
executed order: **origin/CSRF → declared size → media type → session lookup → rate limit →
401 → bounded parse → field validation → tenant authorization → storage.** Nothing above the
parse touches `request.body`.

Two orderings are deliberate. The **session lookup precedes the limiter while the 401
follows it**, because keying an authenticated caller `user:<id>` requires knowing who they
are; an anonymous flood therefore costs one session lookup, never a parse. And **tenant
authorization stays after the parse**, because the organization id is a form field: hoisting
it would authorize against an unknown organization and would make a foreign Workspace
distinguishable from a missing one. S15 measures that it still is not.

The two public tool routes have no CSRF, authentication or tenant stage — they are the
anonymous public endpoints and always were. They do have the limiter and the declared-size
check ahead of everything heavy, which is what the private three lacked.

### 3 — Size-limit ownership

The app owns it, not a proxy. `declaredLengthExceeds` is a cheap pre-check on a *claim*; the
authority is the counting stream in `readMultipart`, which **errors instead of enqueueing**
the chunk that would cross the ceiling (peak = ceiling + one chunk) and rebuilds the Request
with `duplex: "half"`. Measured: absent `Content-Length` (chunked) 26 MiB → 413 after 25.5 MiB
with RSS 377.8 → 378.1 MiB; understated `Content-Length` buys a truncated body, not a bigger
parse; conflicting and unparseable values are refused or treated as no declaration.
**No reverse proxy is a dependency of this fix**, which is why no absent-proxy assumption is
being leaned on.

### 4 — Rate limits: defaults, overrides, failure

`lib/server/uploadRateLimit.ts`, on the same `RateLimiter` the six already-protected routes
use. No route-local counter.

| Bucket | Default | Override | Key |
|---|---|---|---|
| authenticated | 120 / 60 s | `UPLOAD_RATE_LIMIT_PER_MIN` | `user:<id>`, server-derived |
| per trusted client | 20 / 60 s | `UPLOAD_ANON_RATE_LIMIT_PER_MIN` | the forwarded address, **only** behind the configured proxy |
| global | 240 / 60 s | `UPLOAD_GLOBAL_RATE_LIMIT_PER_MIN` | the literal `global` — always charged for unauthenticated traffic |

Invalid configuration is **fatal**, not defaulted: each value is
`z.coerce.number().int().positive()`, and `TRUSTED_PROXY_SECRET` is `z.string().min(16)`. An
abuse control that quietly disables itself is worse than none, because nothing announces it
is gone. The limiter **fails closed**: if it throws, the answer is
`{limited: true, retryAfterSeconds: 60, bucket: "unavailable"}`. `Retry-After` is the time
left in the caller's own window, minimum 1 s, `+1 ms` so the boundary instant is not refused
again — live: `Retry-After: 58`, obeyed to the second, next attempt not 429.

### 5 — Trusted proxy, and why a spoof cannot be rotated

`trustedClientAddress` returns `null` unless the request presents
`x-pdfdadi-proxy-secret` matching `TRUSTED_PROXY_SECRET`, compared as sha256 digests through
`timingSafeEqual`. Only then is the first `x-forwarded-for` hop (else `x-real-ip`) read.
**Default is `null`: forwarding headers are not read at all.** Unauthenticated traffic is
therefore always charged to the unspoofable `global` bucket, and a trusted per-client bucket
refuses *earlier, never instead* — so rotating a forged header changes nothing it can escape
by. Mutation H found "never instead" unpinned; S14 pins it now, in both topologies.

### 6 — Multi-instance behaviour, stated as a limitation

Limiter state is a `Map` in this process, exactly like the six pre-existing limiters. Behind
N instances the effective request ceiling is N × the configured number. The **byte** ceiling
is unaffected — the bounded reader is per request. A shared limiter (Redis, or the load
balancer) is the multi-instance answer and is not in this repository; §37 decision 14 keeps
that as a tuning decision rather than a "whether" decision.

### 7 — Error taxonomy, one table, one implementation

| Condition | Status | Body |
|---|---|---|
| foreign / absent origin | 403 | the existing `CSRF_ORIGIN_REJECTED` security response |
| declared or streamed oversize | 413 | `PAYLOAD_TOO_LARGE` + the route's own message |
| not `multipart/form-data` | 415 | `INVALID_INPUT` — "Expected a multipart/form-data upload." |
| over the request limit | 429 | `RATE_LIMITED` + truthful `Retry-After` |
| no session | 401 | the existing non-disclosing `UNAUTHORIZED` |
| multipart, syntactically invalid | 400 | `MALFORMED_MULTIPART` — "Malformed multipart body." |
| well-formed, invalid fields | 422 | `INVALID_INPUT` with the field message |
| no membership / no such Workspace | unchanged | the existing indistinguishable answer |

Every refusal carries `Cache-Control: no-store`, including the 403 and the 401. The old
`422 "A multipart upload is required."` for an unparseable body is gone: a multipart upload
*was* supplied, it just could not be read — which closes the P3 in §35.

### 8 — Live measurements against a rebuilt artifact

BUILD_ID `VWgZdjW1LEZvaUo6nwJJi` built at `f6f0fa8`, `node .next/standalone/server.js` on
`127.0.0.1:3052` with the TLS front on `172.20.10.2:3051`.
`node scripts/upload-abuse-probe.mjs` → **32/32**, full detail in
`docs/evidence/final-prelaunch/upload-abuse-live.json`. The load-bearing rows:

| Row | Measurement |
|---|---|
| L0 control | a signed-in 8 MiB upload **is** parsed: 201 after 5307 ms, 8.00/8.00 MiB sent — so the probe can tell a consumed body from an unread one |
| L1 ×6 | anonymous 8 MiB → **401 in 1–10 ms, 0.06/8.00 MiB sent**, all three routes, direct **and** through the TLS front |
| L2 ×3 | declared 200 MiB → 413 in 1–2 ms, before the body |
| L5 ×3 | foreign origin → 403 in 1 ms, 0.06/8.00 MiB |
| L6 ×3 | `application/json` → 415 |
| L3 | authenticated chunked 26 MiB, no `Content-Length` → 413 after 25.50 MiB, RSS 377.8 → peak 378.1 MiB |
| L4 | declares 1 KiB, sends 26 MiB → never served |
| L8 / L8b / L8c / L9 | 429 at attempt 227 with `Retry-After: 58`; an 8 MiB body offered while limited is read 0.06 MiB; a signed-in caller is unaffected; obeying the header to the second is enough |
| L11 | 8 concurrent anonymous 8 MiB (64 MiB offered) → all 401, 0.5 MiB read, RSS 377.3 → 377.3 → 377.8 MiB |
| L12 | `Expect: 100-continue` over the ceiling: `100 Continue` comes from the **Node runtime, not route code**, then 413 in 4 ms — reported that way rather than claimed as a route behaviour |
| L13 | after every anonymous attempt, all eight side-effect counters unchanged |
| L10 ×3 | a signed-in 64 KiB upload still succeeds and the stored sha256 and byte count match what was sent |

### 9 — Tests

`uploadBoundary.test.ts`, 1417 lines, S1–S18. They **observe** rather than argue: the body is
sent through a stream that counts bytes written at the instant the response arrives, so
"refused before the parse" is a number, not a reading of the source. S16 plants strings in
filenames, field values and body bytes and asserts none reaches a log line, an audit record,
a rate-limit key or a refusal body. S15 re-measures the non-disclosure invariants that moving
authentication earlier could have broken.

### 10 — Mutations

Eleven, each applied alone, the intended test verified red, reverted, and the revert verified
by an empty `git status --porcelain`:
`docs/evidence/final-prelaunch/mutations-upload-boundary.log`. All eleven intended tests went
red; all eleven reverts left a clean tree; the full suite was re-run green after the tenth
(7374 tests) and after the eleventh.

Two of them changed the code rather than only the tests. **H** ("X-Forwarded-For trusted with
no proxy secret") and **J** ("a trusted bucket *replaces* the global ceiling") both stayed
green — the property was real but unpinned — which is what `9d46606` and `434adc1` fixed.

### 11 — The finding the live run made, and the matcher

The first live run showed the 401 arriving only after the client had sent every byte, on a
gate whose own refusal takes 1 ms. The cause was **Next's middleware matcher**: a matched path
waits for the last byte before the handler runs. Measured, not inferred — `/api/nope` (no
route, no application code, matcher **included**) waited 2616 ms for a 200 MiB body while
`/api/nope.txt` (matcher **excluded**) answered in 3 ms, and a single refused 200 MiB upload
grew RSS by ~30–85 MiB on a matched path versus ~1 MiB on an excluded one. `f6f0fa8` excludes
exactly the five upload paths, `$`-anchored so every descendant (`/api/jobs/<id>/download`,
`/api/workspaces/<ws>/documents/<doc>`, …) stays matched; all five are POST-only JSON handlers
that render no script, so no CSP nonce is consumed and their responses still carry the full
header set. Mutation K restores the old matcher and turns the exclusion test red.

### 12 — Deployment requirements

**Superseded by §39.5 — one variable is now required.** This paragraph read "Nothing
new is *required*" when it was written, and that was true of the upload work itself. It
stopped being true when the reconciliation closed the topology contradiction: production
now refuses to boot without **`DEPLOYMENT_TOPOLOGY=single-instance`**, which is also the
only accepted value. The reason is directly below it in item 6 — the limiter is
process-local, so the configured ceiling only describes the deployment when there is one
process. Optional, and only for behind-a-proxy deployments: `TRUSTED_PROXY_SECRET`
(≥16 chars, and the proxy must send it in `x-pdfdadi-proxy-secret`) plus the three
`UPLOAD_*_PER_MIN` overrides; `client_max_body_size` guidance is in `SERVER_SETUP.md`
("Security & privacy model"). Three operational
facts about the standalone artifact were confirmed the hard way this session and belong with
the deploy steps: `server.js` **chdirs into `.next/standalone`**, so `.next/static` must be
copied in before boot, `STORAGE_LOCAL_ROOT` resolves to `.next/standalone/.storage/local`,
and the admin store is `.next/standalone/data/admin/store.json`. Production config refuses to
boot with a relative SQLite `DATABASE_URL`.

### 13 — Remaining limitations

1. The limiter is **process-local** (item 6).
2. **CLOSED IN CODE IN §40** (this item is left as written because it is what §40 had to
   overturn; the reasoning below — "not fixed in-app", "the mitigation is a reverse-proxy body
   cap" — is exactly the conclusion that was wrong). Paths still matched by the middleware
   matcher still buffer their bodies before their
   handler runs. That is pre-existing behaviour for non-upload routes, unchanged here, and now
   recorded with measurements in `proxy.ts`. **Quantified during the reconciliation**
   (`docs/evidence/final-prelaunch/proxy-body-clone-cost.log`, §39.4): a matched path reads
   a 64 MiB anonymous body in full while an excluded upload path stops after ~1.25 MiB, and
   the retention scales with concurrency — 28 concurrent 100 MiB posts took one process from
   301 MB to 1795 MB RSS and it stayed there. It applies to every page URL and every
   unrouted path, none of which has a rate limiter in front. Still not caused by the
   exclusion and still not fixed in-app: the only in-app lever re-arms the truncation
   footgun that `next.config.mjs` documents, so the mitigation is a reverse-proxy body cap
   (§39.5) and the residual is an operator action, recorded in §39.10.
3. `Expect: 100-continue` is answered by the Node runtime, so route code cannot refuse *at*
   the expectation — only immediately after (L12).
4. An authenticated caller can still spend its own 100 MiB ceiling 120 times a minute. That
   is a capacity choice, and it is what the overrides are for.

---

## §39 — Final code-readiness reconciliation (postdates §38)

Branch `final-readiness-reconciliation`, cut from the upload-abuse tip `f324053`. Nothing
above this line was rewritten: §37 is still the audit's verdict, §38 is still the
upload-abuse closeout's, and the accepted upload work — one multipart reader,
authenticate-before-parse, pre-parse limiting, streamed size enforcement, consistent
`400 MALFORMED_MULTIPART`, proxy-secret-gated forwarding headers — was re-verified rather
than redesigned. Two statements above are corrected in place and say so where they stand
(§38 item 12, §38 item 13.2).

Four readiness contradictions were the subject. Each is closed below with the evidence
that closes it, or reported as a decision that is not Claude's to take.

### 39.1 — Contradiction 1: nine high dependency advisories (CLOSED)

`npm audit` at this tip, both graphs, exit 0:

| Scan | Vulnerabilities | Dependencies | Artifact |
|---|---|---|---|
| `--omit=dev` (production graph) | **0** at info/low/moderate/high/critical | 158 prod | `audit-RECONCILED-prod.json` |
| full graph | **0** at every severity | 158 prod, 279 dev, 486 total | `audit-RECONCILED-full.json` |

**They were fixed, not reclassified, and none of them was dev-only.** The baseline recorded
**9 distinct production advisories** across 9 flagged packages and 11 in the full graph; R2
re-derived reachability from the lockfile's own dev flags and real dependency edges, and
found **9 of 11 production-reachable** (the 2 that are not are both `browserslist`, dev-only
by the lockfile and absent from the production audit — classified from that evidence, not
from the word "transitive"). Remediation, all by supported upgrade except one narrow
override:

| Advisory | Package | Sev | Remediation |
|---|---|---|---|
| 1117015 / 1108096 / 1116417 / 1117016 | `postcss` (×4) | high / mod | **`next 16.2.12 → 16.3.4`** raises the *nested production* copy to 8.5.23, the first fixed version. The devDependency went 8.5.18 → 8.5.28 separately; the dev copy was already at the fixed floor, the production one was not |
| 1117077 | `sharp` | high | Same Next upgrade — 16.3.4 moves its optional `sharp` to ^0.35.4. **This is the ninth flagged package, absent from the earlier report's list of eight** |
| 1105909 | `brace-expansion` | high | `npm update brace-expansion`. The earlier audit called it eslint-only; it also reaches **production** through `archiver`, which is how ZIP export builds its file list |
| 1116962 | `pdfjs-dist` | high | **`pdfjs-dist 6.1.200 → 6.3.289`**. The most reachable advisory in the set — this product's core input is a user-supplied PDF, so no reachability argument was available and none was attempted |
| 1117061 | `nanoid` | high | `npm update nanoid` |
| 1117040 | `deepmerge-ts` | high | **No supported parent upgrade exists**: `@prisma/config@6.19.3` pins it at exactly 7.1.5, there is no prisma 6.20.x, and npm's own proposed fix was a semver-**major downgrade** to prisma@6.12.0. Used `overrides: { "deepmerge-ts": "^8.0.2" }` — the brief's "narrow dependency override compatible with the existing lockfile" — then *proved* compatibility rather than assuming it: `prisma validate`, `prisma generate` and `prisma migrate status` all exit 0 on the overridden tree |
| 1153171 / 1153172 | `browserslist` (×2) | high | `autoprefixer 10.4.20 → 10.5.5`. Dev-only, from the lockfile's dev flags |

Two of those are **production** dependencies (`next`, `pdfjs-dist`), which is exactly the
case the brief singles out — "for changes to Next, Prisma or PDF.js, run their relevant
functional and migration/build gates". Run, and all at the rebuilt artifact: cold
`next build`, `prisma validate` / `generate` / `migrate status` / `migrate deploy`
(23 migrations), the full suite, `export-fidelity` 35/35, `csp-probe` 118/118 (which
exercises the pdf.js worker under the enforced policy), the tool-runtime matrix, and the
four Next-upgrade probes. The 158 production packages being identical to baseline means
nothing was **added to or removed from** the production graph — two packages in it moved
version, which is the point.

No `audit fix --force` was run, no advisory was suppressed for predating the branch, no
advisory was marked resolved merely because a test passed, and the harness was not edited to
ignore a finding. Where a fix existed, reachability was never used as an argument at all —
`postcss` runs at build time on this project's own CSS and never on attacker input, and the
inventory says so, but the fix was taken anyway rather than relied upon. R1 derives the
inventory from the machine-readable audit JSON so it cannot drift from prose (and pins
`distinctProductionAdvisories: 9` against `flaggedProductionPackages: 9` — conflating those
two is how "nine high" was reported for eight packages), R2 walks real lockfile edges, and
R3 asserts each installed version now sits outside the window that was actually violated,
proving the window it checks is the violated one.
The static harness's I3 `PRODUCT FAILURE` is therefore gone, and the harness exits 0:
**PASS 67/67, PRODUCT FAILURE 0, ENVIRONMENTAL 2, NOT EXERCISED 4, MANUAL REVIEW REQUIRED
12, 85 assertions** (`audit-static-RECONCILED.log`).

### 39.2 — Contradiction 2: the unidentified suite failure (REPRODUCED, OWNED, FIXED)

It was reproduced, so this is not a "not reproduced" report. Across 14 retained
invocations at 8 seeds only one was ever red — `m3-shuffle-20260904` — and its retained
summary names the three failures, which is the whole point of the harness rewrite. The
owner was **test-harness and cross-test interference, not the product**: a shared
not-found spy left set by whichever test ran first, a wall-clock fallback racing an abort,
and a file that crossed vitest's inherited 5000 ms default. Fixes went to the owners, and
R5 pins them by running exactly those three files in exactly the shuffled order that
failed them; R4b pins the explicit `testTimeout` so the default cannot silently come back.

Three further runs at the reconciliation tip, all **GREEN**, 384 files / 7432 tests /
0 failed:

| Label | Configuration | Wall | Artifact |
|---|---|---|---|
| `reconciled-final` | default order, default workers | 10.0 s | `suite/reconciled-final.summary.json` |
| `reconciled-shuffle-20260904` | shuffled at **the seed that was red** | 10.4 s | `suite/reconciled-shuffle-20260904.summary.json` |
| `reconciled-single-worker` | `--maxWorkers=1 --minWorkers=1` | 64 s | `suite/reconciled-single-worker.summary.json` |

R4 is satisfied by construction rather than by assertion of intent: an intentionally red
fixture leaves its name, file, seed, worker count, timing and stack trace in the retained
summary and the runner still exits nonzero, `ENVIRONMENTAL` is reported when vitest never
ran at all (the `--repeats=2` case, a flag vitest 3.2 does not have), a real failure is
never attributed to the environment, and the red fixture is kept out of the suite that
must stay green.

### 39.3 — Contradiction 3: rate-limit topology (CLOSED via Path A)

Path A: the launch architecture genuinely supports one instance, so the constraint is made
explicit and verifiable rather than left in prose. `DEPLOYMENT_TOPOLOGY=single-instance` is
**required in production and is the only accepted value** (`productionProblems()` in
`src/infrastructure/config/env.ts`, invoked at boot by `instrumentation.ts` via
`startupGate.ts`); `docker-compose.yml` declares it and pins `container_name`, so
`docker compose up --scale pdfdadi=2` fails. 12 tests in `deploymentTopology.test.ts` cover
R6 and R8, including the absent value, any other value at parse time, the arithmetic that
names the operator's own configured limits, development and `next build` exemptions,
all-problems-at-once reporting, and the compose file agreeing with the gate.

What the gate does **not** do is stated in `SERVER_SETUP.md` rather than glossed: it is not
mutual exclusion, and two hand-started processes against one database would each declare
`single-instance` and each start. (§40 measured exactly that — both booted, both served
`200` — and closed it with a database lease. Saying so plainly here is what made it findable;
what it did not do was make it non-blocking.) R7 (cross-process limiting) is **N/A under Path A** — no
Redis or other service was added for it, which the brief forbids doing silently.

### 39.4 — Contradiction 4: proxy matcher exclusion parity (CLOSED)

The exclusion is load-bearing, and the A/B proves it while holding the route handler
constant at *none*: `/api/nope` (matcher **included**) reads a 64 MiB anonymous body in
full; `/api/nope.txt` (matcher **excluded**) reads ~1.25 MiB and answers 404. Same absent
handler, same body, one variable — matcher membership. The mechanism was read out of Next's
own `cloneBodyStream` (`node_modules/next/dist/server/body-streams.js`): past the limit it
pushes null into both PassThroughs and returns early, and it never unpipes `input`, so
`experimental.proxyClientMaxBodySize` bounds **retention, not socket reads**. Recorded with
the per-path-class table and the concurrency series in
`evidence/final-prelaunch/proxy-body-clone-cost.log`.

R9 tests the matcher **Next actually compiled** — `functions-config-manifest.json`
`functions["/_middleware"].matchers[0].regexp`, taken from the cold production build, not
the source string (`middleware-manifest.json` is present, parsable and *empty* under Next
16's rename, which is a trap a test that trusted it would fall into). It asserts the five
canonical upload paths are excluded, that **every other API route on disk is still
matched** including routes added after the test was written, and that the approximation
`proxy.test.ts` uses agrees with the compiled regexp so the two cannot drift.

R10 covers the boundary spellings the brief lists: trailing slash (matched, but redirected
before the proxy runs), query string (never reaches the matcher, so `?slug=` cannot
re-enter it), percent-encoding (matched raw, excluded decoded — which is why the matcher is
applied to both forms), nested document/version ids (an id segment cannot swallow a slash),
similarly prefixed paths (only the exact five are out), and the two dimensions the matcher
does not have: **method** (exclusion is path-only, and the proxy has nothing method-shaped
to lose) and **case** (a literal segment re-enters the matcher and resolves to a different
file — App Router resolution is an exact-key lookup in `app-paths-manifest.json`, not a
filesystem probe, so `/api/JOBS` 404s even though APFS would say the directory exists).

R11 disposes of every responsibility in the brief's inventory for all five excluded routes,
and pins the *list itself* so a new responsibility cannot be added without passing through
this file:

| Responsibility | Disposition for the five excluded routes |
|---|---|
| Security headers | Equivalent: the six headers come from `next.config.mjs` `headers()`, which covers all five |
| CSP / nonce | Inapplicable: all five are route handlers and a handler renders no script, so no nonce is consumed |
| Inbound CSP request-header stripping | Inapplicable: the unstripped headers are read by nothing |
| Host/origin checks (CSRF) | Route-level equivalent: `requireSameOrigin` inside the gate, stage 1 |
| Authentication / session | Route-level equivalent: stage 4, and it is *earlier* than the proxy could ever be |
| Request IDs / tracing | Route-level equivalent, asserted on refusal paths |
| Response caching (`no-store`) | Route-level equivalent: every `refuse()` sets it |
| Admin gate | Never applied: unauthenticated, the five are not redirected |
| Redirects / canonicalisation, locale, maintenance gates, cookie changes, rewrites | Never applied to API upload routes |

Nothing was lost, so nothing had to be moved to a shared API boundary. 19 tests in
`proxyMatcherParity.test.ts`, plus 28 in `proxy.test.ts` (which still pins the body-clone
block and the 120 MB fallback for any path that is ever matched again).

### 39.5 — Deployment requirements, corrected

§38 item 12's "Nothing new is *required*" is superseded. Required in production now:
**`DEPLOYMENT_TOPOLOGY=single-instance`**. Optional and behind-a-proxy only:
`TRUSTED_PROXY_SECRET` plus the three `UPLOAD_*_PER_MIN` overrides.

Two operator facts were added to `SERVER_SETUP.md` this session because measurement found
the docs silent on both:

1. **`report-to` on static assets is decided at build time.** `next.config.mjs` resolves
   `reportingEndpointFor(NEXT_PUBLIC_SITE_URL)` while `next build` runs, and the
   `Dockerfile` passes no build argument for it, so `docker build` with no extra flag ships
   `/_next/static/*` with `report-uri` only. That matters beyond reporting cosmetics: a Web
   Worker inherits the CSP of its own response, and the pdf.js worker *is* a static asset
   (`.next/static/media/pdf.worker.min.*.mjs`). Measured both ways on a cold artifact.
2. **Reverse-proxy body caps.** Not for the byte ceilings — the app owns those — but for
   the retention in 39.4. A small global `client_max_body_size`, raised with
   `proxy_request_buffering off` only on the five excluded paths, is the zero-cost
   mitigation; the config is in `SERVER_SETUP.md` under "Security & privacy model".

### 39.6 — §6 authentication lookup cost, measured (no change made)

`workspaceUploadGate` authenticates (stage 4) before it rate limits (stage 5), deliberately,
so an unauthenticated flood reaches session resolution at full request rate. The brief's
instruction was to measure rather than theorise. Measured against real SQLite through the
real providers — `AuthService.getMe`, exactly what stage 4 calls — with 5002 sessions
seeded so an unindexed lookup would show, median of 21 samples after a warm-up:

| Cookie state | Queries | Median |
|---|---|---|
| no cookie at all | **0** | 0 ms |
| malformed (`not-a-token; drop table sessions --`) | 1 | 0.168 ms |
| random invalid, valid shape | 1 | 0.090 ms |
| expired, validly shaped | 1 | 0.140 ms |
| valid session | 2 (session, then user) | 0.211 ms |

Query **counts** and the SQLite query **plan** are the assertions; wall-clock is reported
beside them and is deliberately not a gate, because a timing threshold on a shared machine
is a coin flip. R13 asserts the plan searches the unique token index and never scans
`sessions`, which is the property that keeps the cost flat as the table grows.

**Conclusion: no preliminary control was added, and that is a measured decision.** An
absent cookie costs zero queries; a rotated invalid cookie costs one indexed unique-key
lookup at ~0.1 ms with no user read. That is not "meaningful I/O", and the smallest
"safe preliminary control" available — keying a pre-auth limiter on a client address —
would either be spoofable (`X-Forwarded-For` without the proxy secret) or would collapse
every anonymous caller into one global bucket, i.e. an easy denial of service. Both are
what the brief told us not to build. 6 tests in `authLookupCost.test.ts` (R12, R13).

### 39.7 — Mutation exercise: 10 mutations, each red, each reverted

Full detail in `evidence/final-prelaunch/mutation-reconciliation.md`, with the exact red
test and assertion per mutation. Applied individually and reverted with `git checkout --`;
the affected gate reran green after each.

| # | Mutation | Owning gate | Red tests |
|---|---|---|---|
| 1 | failure output dropped from the runner | R4 | 1 |
| 2 | high advisory reclassified with no reachability evidence | R2 | 1 |
| 3 | vulnerable dependency version restored | R3 | 2 |
| 4 | process B gets a fresh bucket after A exhausts it | `uploadRateLimit` | 1 |
| 5 | unsupported multi-worker configuration allowed to boot | R6/R8 + harness B1 | 5 + 1 |
| 6 | upload paths restored to the body-buffering matcher | R9/R10 | 7 |
| 7 | CSRF removed from the gate | S3/S18 + R11 | 8 |
| 8a/8b/8c | trailing-slash and encoded-path matcher bypasses | R9/R10 | 1 / 1 / 2 |
| 9a/9b | scan lookup / extra read on invalid cookies | R13 / R12 | 1 / 2 |
| 10a/10b | `no-store` / request id removed from a refusal path | S-series / R11 | 25 / 2 |

Two edits the exercise exposed were kept deliberately, neither part of any mutation: a
legible assertion message in `lib/server/uploadRateLimit.test.ts` and an
`Error.prepareStackTrace` save/restore in `proxyMatcherParity.test.ts`.

### 39.8 — Live verification at one artifact

A cold production artifact was rebuilt because product-adjacent files changed, and **every**
live gate below was re-run against that one build — `BUILD_ID J9-02HdnjsxfHyAkc7Xg-` — so no
gate cites an older artifact:

| Live gate | Result |
|---|---|
| `upload-abuse-probe` | **32/32** (R14) |
| `proxy-parity-probe` | 37/37 |
| `csp-probe` (with `--server-log`) | **118/118**, exit 0 |
| `legacy-job-ownership-probe` | 25/25 |
| `tool-runtime-matrix` | 29/29 exercised, 2 ENVIRONMENTAL, 3 NOT EXERCISED |
| `phase1-reliability` | 29/29, 2 NOT EXERCISED |
| `workflow-completeness` | 155/156, 1 ENVIRONMENTAL (no `soffice` on this host) |
| `export-fidelity` | 35/35 |
| `tsc` / `eslint` / `prisma migrate` | 0 errors / 0 errors + 13 warnings / 0, 23 migrations up to date |

R14 in the suite: **78 S1–S18 assertions green, 0 failed**, across `uploadBoundary.test.ts`
(68) and `lib/server/multipart.test.ts` (10). Server log across all six live probe runs: 38
lines, 24 info, 8 warn, **0 error, 0 5xx, 0 stack traces, 0 Server Action errors**; the 8
warns are 4 missing-LibreOffice (already `ENVIRONMENTAL` above) and 4 deliberate
`workspace.access.denied` from the reliability probe.

### 39.9 — Defects found in the *evidence*, not the product

Recorded because a probe that cannot fail is the failure mode this branch exists to find:

- **A CSP check that could only ever 404.** It fetched `/api/jobs/<id>/result`, whose route
  404s unless the stored row is `type: "processing"` — a pipeline entered only for
  `compress-pdf` with `unified_processing_pipeline` on (default OFF). On a stock build the
  check could never pass. Retargeted to `/download`, which dispatches on stored type and
  serves both pipelines through the same ownership gates (`0719a63`).
- **A probe that "passed" by not running.** 110/110 instead of 118 — `--server-log` was
  omitted, so nine endpoint-log checks never ran. Diffed check names to prove it.
- **Two environmental CSP failures were my build, not the product**: `.env` had
  `NEXT_PUBLIC_SITE_URL=http://localhost:3000`, and `reportingEndpointFor` correctly
  returns null for a non-https origin. Rebuilt with the https origin; both cleared. This is
  what became the `SERVER_SETUP.md` note in 39.5.
- **`Failed to find Server Action` came from my own curls.** The app has zero Server
  Actions; a *multipart* POST to a path with no route handler produces the line. Reproduced
  as a table (`/api/nope` +1, `/` +1, `/api/jobs` +0, JSON POST +0). Zero on the final
  artifact.
- **Evidence broke a product gate.** Copying two measurement scripts into `docs/` as
  `.mjs` put them inside eslint's default file set: exit 1, 20 `no-undef` errors. Renamed
  to `.mjs.txt`. This is exactly the brief's "avoid placing generated evidence where it
  changes product behavior", learned the direct way.
- **A memory reading that would have been wrong.** Run 1 showed +261 MB; run 2 on the
  already-grown process showed +1 MB, which alone reads as "no leak". The 8× and 16×
  concurrency series is what showed the plateau scales and is retained: 984 → 1728 peak →
  1795 MB after.

### 39.10 — What remains open, and why it is not a code blocker

Three statements from earlier reports are corrected here in their accurate form:

1. ~~"Nothing new is *required*."~~ → **`DEPLOYMENT_TOPOLOGY=single-instance` is required in
   production**, and is the only accepted value (39.3, 39.5).
2. ~~"All required regression gates pass."~~ → **`PASS 67/67 exercised, PRODUCT FAILURE 0`**,
   with `ENVIRONMENTAL 2`, `NOT EXERCISED 4` and `MANUAL REVIEW REQUIRED 12` *not counted as
   passes*. A gate whose command exits nonzero is never reported as passing, and the four
   verdict classes stay separate.
3. ~~"PDFDADI CODE READY."~~ → the verdict is qualified, and its basis is now re-run
   evidence at one named artifact rather than an inherited claim (39.8).

**The one measured characteristic left unfixed in code — FIXED IN CODE IN §40.** What
follows is the §39 text, kept because the reclassification in §40 is a correction OF it and
not a replacement for it: the measurements were right, "pre-existing" was true, and neither
made it non-blocking. `ingress/server.mjs` now bounds every request body before Next is
reached; the same 28 × 100 MiB burst offers 15.75 MiB of 2800 and moves RSS by 0 MB. The
reverse-proxy cap remains recommended as defence in depth and is no longer the mitigation.

> Any path the matcher still claims
that ends at the App Router — every page URL, and any unrouted path — retains up to
`proxyClientMaxBodySize` (120 MB) of an anonymous body before dispatch, with no rate limiter
in front; 28 concurrent 100 MiB posts took one process 301 → 1795 MB RSS and it stayed
there. It is **pre-existing** (recorded qualitatively in §38 item 13.2 before this branch,
under §37's CODE READY verdict), **not caused by the exclusion** — which strictly reduces it
— and it is quantified here rather than discovered. It is not fixed in code because the only
in-app lever is lowering `proxyClientMaxBodySize`, which re-arms the silent body-truncation
footgun that `next.config.mjs:130-159` exists to prevent, measured at 10481664 bytes
through / 10485760 not. The mitigation is therefore an operator action with no product
change: a small `client_max_body_size` plus `proxy_request_buffering off`, raised only on
the five excluded paths, now specified in `SERVER_SETUP.md`.

**Still pending, and none of it is code:** human visual acceptance of the contact sheets
(Entry Gate B), production acceptance in a real environment, a container build, and the 12
`MANUAL REVIEW REQUIRED` items the static harness enumerates — among them whether
first-party self-hosted measurement needs a consent banner in the launch jurisdictions,
which is a question for qualified legal review and not one to answer by inventing a consent
system. These were open at §37's verdict, are open now, and are what
"PRODUCTION ACCEPTANCE NOT EXERCISED" names.

**PDFDADI CODE READY — PRODUCTION ACCEPTANCE NOT EXERCISED**

---

## §40 — Final ingress memory-safety and deployment-enforcement closeout (postdates §39)

Branch `ingress-memory-safety-closeout`, cut from `478e111`. `main` untouched, no remote
configured, nothing pushed, nothing deployed, no container built.

### 40.1 — The two findings, and their correct classification

Both were already in this report. Neither was blocking in it, and both should have been.

| | what §38/§39 said | what it actually was |
|---|---|---|
| **Body amplification** | "pre-existing", "not caused by the exclusion", "not fixed in code", mitigation = a reverse-proxy body cap (§39.10) | **an open P1.** An anonymous stranger, with no account and no rate limiter in front, could make one production process retain up to `proxyClientMaxBodySize` (120 MB) per request, on every page URL and every unrouted path. Calling it pre-existing does not make it non-blocking, and a safety property that requires an optional proxy is not a property of the product |
| **Single-instance topology** | "required in production and enforced at boot", "the boot gate refuses the configuration" (§39.3, ledger) | **config validation.** The gate proved an operator had TYPED `single-instance`. Two hand-started production processes against one database both booted and both served — measured, not argued |

Every measurement in the earlier sections stands. What was wrong was the conclusion drawn
from them, in one specific place: "the only in-app lever is lowering
`proxyClientMaxBodySize`". That is the only lever inside *Next's configuration*. There is
another one outside it — the `http.Server` Next is handed.

### 40.2 — Baseline reproduction on a cold artifact: the body

`.next/standalone/server.js` started with no guard, `NODE_ENV=production`,
`DATABASE_URL=file:/tmp/audit-final-db.db`, `127.0.0.1:3002`. Probe:
`node scripts/ingress-probe.mjs --label baseline-unguarded`, whose expectations are the
POST-FIX ones, so the same instrument is the reproduction and then the acceptance.
`docs/evidence/final-prelaunch/ingress/BASELINE.md`, `probe-baseline-unguarded.{log,json}`.

**6/18 passed.** Two identical 28 × 100 MiB bursts, one process:

| moment | RSS (MiB) |
|---|---|
| process start | 141.7 |
| burst 1 — before / peak / settled | 516.5 / 3316.7 / 3145.7 |
| burst 2 — before / peak / settled | 3340.4 / 4168.9 / 4169.8 |

`offered 2800 MiB of 2800` in both: all 28 anonymous 100 MiB bodies read in full. All 28
answered **200** — the root page rendered, with a per-request nonce CSP, *after* the body had
been retained. The first burst gave back 171 MiB; the second gave back nothing. Retention,
not a spike. The originally reported 301 → 1795 MiB is reproduced and exceeded.

Per-case, the same run: `POST /` 200 after 100/100 MiB · unrouted path **404 after
100/100 MiB** · `/admin/…` **307 after 100/100 MiB** · chunked with no length **200 after
100/100 MiB** · `/api/csp-report` **413 after the whole body** (the forbidden shape: right
status, memory already spent) · `Expect: 100-continue` **200**, Node auto-continued and
invited the payload · hostile client headers (`proxy-secret`, XFF, CSP) changed nothing.
Three amplifier facts follow: a page URL is one, an unrouted path is one, and a missing
`Content-Length` is not a way out — so protecting only known routes, or trusting the declared
length, would each have left it open.

### 40.3 — Baseline reproduction on a cold artifact: the topology

`scripts/singleton-probe.mjs --entry .next/standalone/server.js`, two processes on 3011/3012,
one `DATABASE_URL=file:/tmp/audit-singleton-db.db`, both with
`DEPLOYMENT_TOPOLOGY=single-instance`. **3/8 passed.**

`:3011` served 200; `:3012` **also served 200** (`{"ok":true,"status":"up"}`); `serving=2`;
the second process's `/` answered 200 and its readiness disclosed `dataDir`, `toolchain` and
`database`; no `instance` check existed. S6 and S7 passed **vacuously** — with no lease there
is no takeover to measure, which is why they are recorded rather than counted. S8 failed for
an unrelated reason (`NEXT_PUBLIC_SITE_URL`), and that is exactly why the row now asserts the
guard's own message and not just the exit code.

The unguarded entry printed `✓ Ready in 0ms` **before `instrumentation.ts` ran**: the port was
bound and the listener installed before any lease could be consulted. That window is the whole
reason the fix cannot live in instrumentation.

### 40.4 — §2 the canonical inventory, and the test that fails when a route appears without a policy

`ingress/bodyRoutes.mjs` lists **98** routes with the method set each one exports and the
class assigned to it; `docs/evidence/final-prelaunch/ingress/BODY-ROUTES.md` is the same table
as a page. Membership is "can receive a body", not "calls `.json()`" — `app/api/auth/register/route.ts`
is `export const POST = signupPost`, so a file-local search for a body read would have missed it.
Seven routes read no body at all and are listed anyway, because "reads nothing" is a policy a
later edit should not be able to change silently.

`ingress/bodyRoutes.test.ts` (7 tests) is what makes it an inventory rather than a snapshot.
It walks `app/api/**` on the filesystem and fails when a route exists that the inventory does
not list, when the inventory lists one that no longer exists, when a route's exported methods
change, when a class C entry has no ceiling of its own, when the evidence page drifts from the
module, and when the class B ceiling would pre-empt a per-route ceiling. **A new
body-consuming route with no assigned policy is a red test, not a silent gap** — which is the
brief's requirement, and it is the reason the table is generated from a module the guard
itself imports rather than maintained beside it.

### 40.5 — §3 the three classes, and where the policy lives

`classifyPath` in `ingress/policy.mjs`, one implementation, used by the guard that enforces it
and by the test that checks the table:

| class | ceiling | what it is | on over-ceiling |
|---|---|---|---|
| **A** | `CLASS_A_MAX_BYTES` = **0** | everything that takes no body: page URLs, GETs, unrouted paths, `/admin/*` | 413 on the request line, `connection: close` |
| **B** | `CLASS_B_MAX_BYTES` = **2 MiB** | small structured bodies — JSON, `application/csp-report`, `text/plain`, form-encoded | 413 on the request line |
| **C** | the route's own | the five matcher-excluded multipart paths, on the bounded shared reader with authorization first | unchanged — `readMultipart` counts what it reads and stops |

Three properties that are the class rules rather than decoration. **Unknown paths are class A**,
so an unrouted path is protected exactly like a known one and the refusal is byte-identical —
a body-bearing probe cannot tell a page from a protected route from a nonexistent one (E2b).
**Chunked on A or B is 411 before a byte is read**, because measuring a body means reading it;
class C accepts it and counts. **`Content-Length` is parsed digits-only**, so the guard agrees
with Node's own parser rather than having a second opinion about the same header.

The policy is **code**, versioned with the app: `ingress/policy.mjs` and
`ingress/bodyRoutes.mjs`, installed by `ingress/server.mjs`, with no environment variable that
disables it and no operator setting to remember. `assertIngressInstalled()` in
`instrumentation.ts` refuses a production boot that reached instrumentation without it.

### 40.6 — §4 the architecture, and the three that were rejected

**Chosen: a guard on the `http.Server` Next is handed.** `installIngress()` patches
`http.createServer` once, and swaps the single `'request'` listener Next installs for one that
classifies first and delegates second. `ingress/server.mjs` does that and then `require`s the
generated `.next/standalone/server.js`, so the guard is in place *before* the port is bound —
the `✓ Ready in 0ms` window from 40.3. A refusal writes a JSON body plus
`connection: close`, which is what actually stops an in-flight transfer.

Rejected, and why each is worse rather than merely different:

1. **Lower `proxyClientMaxBodySize`.** Re-arms the silent-truncation footgun
   `next.config.mjs:130-159` exists to prevent (measured at 10481664 bytes through /
   10485760 not), and the brief forbids it by name.
2. **A reverse-proxy body cap as the mechanism.** Makes the safety property conditional on an
   optional deployment component. Kept as defence in depth in `SERVER_SETUP.md`; it is no
   longer the mitigation.
3. **A `proxy.ts` (middleware) check.** Cannot work: Next buffers the body *before* middleware
   runs, which is the finding itself. Middleware is downstream of the problem.
4. **A Node HTTP server of my own in front.** A second HTTP implementation to keep in step
   with Next's — the brief's "do not build a fragile proxy from scratch if the platform
   already offers a supported boundary". `http.createServer` **is** the supported boundary; the
   guard is ~200 lines that reuse Next's own listener.

### 40.7 — §5 legitimate body behaviour, preserved and measured

Every row live on the final artifact, `probe-guarded-final.log`:

| what | result |
|---|---|
| one byte **below** the class B ceiling | reaches the application — 413 from the route, **with a CSP** (E13a) |
| **exactly** the ceiling | still the application's answer, with a CSP (E13b) |
| one byte **over** | the guard, 413, **no CSP**, 0.06 MiB read (E13c) |
| a slow legitimate body (64 KiB every 40 ms, 3.0 s) | 204, untouched (E14a) |
| an interrupted upload | client aborts; the next `GET /` answers 200 (E14b) |
| a malformed sub-ceiling body | the route's own documented answer, 204 with a CSP — not the guard's (E15) |
| absent `Content-Length` | 411 on A/B before a byte; accepted and counted on C |
| understated `Content-Length` | the extra bytes cannot enter the request at all (E6) |
| **five recorded controls vs the unguarded baseline** | 5/5 identical in status, CSP source and body (E16) |

E16 is the one that answers "byte-identical" rather than asserting it: it reads
`probe-baseline-unguarded.json` off disk and compares status, CSP provenance and body for
`GET /`, a valid csp-report, the analytics route's own 16 KiB refusal, and both class C
controls. **No over-ceiling body is ever handed to a handler** (E10, 5/5 refused before
dispatch), so there is no silent truncation anywhere in the design: a body is either whole or
refused with a status.

The CSP is the external witness throughout. Every Next response carries one — a per-request
nonce from `proxy.ts`, or the static policy from `next.config.mjs`. **A response with no CSP
was written by the guard before Next ran.** That is how ownership of each answer is
attributed without instrumenting the server.

### 40.8 — §6 the topology, closed by a lease rather than a declaration

`src/infrastructure/config/instanceLease.ts`, one row (`instance_leases`, id `app`, migration
`20260905090000_add_instance_lease`) and one statement per attempt. Each of the brief's nine
properties, and the line that carries it:

| property | how |
|---|---|
| atomic acquisition | `create` wins the first boot; afterwards `updateMany WHERE id='app' AND (holder=me OR expiresAt < now-grace)` — the read and the write are one statement, so two contenders cannot both see a free lease |
| unique identity | `holderId = <host>:<pid>:<uuid>` — per **process**, so a restart onto a recycled pid is a different holder |
| heartbeat | `HEARTBEAT_MS` 3 s, extending `expiresAt` to now + `LEASE_TTL_MS` 10 s |
| stale expiry | a contender may steal only `expiresAt < now − CLOCK_GRACE_MS` (2 s) |
| clean release | `deleteMany WHERE id='app' AND holder=me` on SIGTERM — scoped, so a process that already lost the lease cannot delete a healthy instance's row |
| crash recovery | S6: SIGKILL the holder, the standby served in **12 107 ms** unattended (TTL 10 s + grace 2 s + one beat) |
| clock-race protection | the grace margin; the supported topology is one host, one clock. `ponytail:` a multi-host Postgres deployment should move the comparison to `now()` in the database — one dialect branch, worth writing when a second host is real |
| refusal **before serving traffic** | the guard answers 503 to everything while the lease is not `held`, installed at `http.createServer` time — before the port binds, and long before `instrumentation.ts` |
| readiness unhealthy when the lease is lost | `/api/health/ready` carries a named `instance` check; a lost lease makes it 503 |

A refused process does not exit. It cannot serve, so the safety property does not need an
exit — and exiting would turn every stale-lease window into a restart loop under
`restart: unless-stopped`. The same interval that heartbeats a held lease retries acquisition
when it is not held, which makes the second process a **warm standby**: S7 measured a fresh
instance acquiring in **433 ms** after a clean release, against ≥12 000 ms for the expiry path.

Two operational consequences, both now in `SERVER_SETUP.md` because both were found by running
it: **apply migrations before starting** (a database with no `instance_leases` makes *every*
process refuse — `serving=0`, which is the correct direction but total outage), and **start
through `node ingress/server.mjs`** (the generated entry exits 1 in production).

### 40.9 — §7 the tests

**25 live rows** (`scripts/ingress-probe.mjs`, E2a–E16), each of which can only be answered by
running a production artifact: what the socket did, how many bytes crossed it, which component
wrote the response, and what RSS did before/at/after the burst. **68 unit tests** across seven
files, each of which can only be answered without one — the branch conditions the live probe
cannot arrange on demand:

| file | tests | what it owns |
|---|---|---|
| `ingress/policy.test.ts` | 16 | classification, ceilings, chunked, `Content-Length` parsing, non-disclosure |
| `ingress/guard.test.ts` | 11 | the seam: listener swap, method-agnostic enforcement, shutdown ordering |
| `ingress/bodyRoutes.test.ts` | 7 | the inventory against the filesystem (40.4) |
| `instanceLease.test.ts` | 14 | compare-and-swap, takeover, grace, scoped release |
| `ingressState.test.ts` | 4 | `assertIngressInstalled()` refusing an unguarded production boot |
| `instrumentation.test.ts` | 8 | lease started before the first request; failure directions |
| `readyRoute.test.ts` | 8 | the `instance` check, and 503 on a lost lease |

### 40.10 — §8 the mutations

**13 mutations, 13 caught.** Each applied alone, the red gate observed with its exit code and
failing-test count, then reverted with `git checkout --`; the full table with the exact
assertion that fired is `docs/evidence/final-prelaunch/ingress/MUTATIONS.md`. They cover the
ceiling being inclusive (M3), the header parser (M4), method-agnostic enforcement (M6), the
class C carve-out set (M5), non-disclosure (M7), shutdown ordering (M8/M9), the
compare-and-swap itself (M10), the unguarded-boot refusal (M11), the container `CMD` (M12), and
**M13 — a new body-consuming route added with no policy**, which is the §2 requirement as an
experiment rather than a claim.

M6 is recorded as a **near-miss** and left in the file: skipping GET/HEAD was caught by exactly
one assertion in `guard.test.ts`, and the live probe would not have caught it at all, because a
GET with a body is not a shape a browser produces. That is why commit `3b113c7` exists.

Mutations are source-level, so the artifact rebuild in 40.11 does not invalidate them.

### 40.11 — §9 live verification on the final artifact

`BUILD_ID 98appVCcbyMxzlhk26zya`, a cold `output: "standalone"` build started through
`node ingress/server.mjs` on `127.0.0.1:3002` behind the TLS front on
`https://172.20.10.2:3001`, `DATABASE_URL=file:/tmp/audit-final-db.db`. **The original 28 ×
100 MiB load was exercised, twice, on one process** — not a smaller substitute:

| moment | baseline RSS | peak | settled | offered of 2800 MiB |
|---|---|---|---|---|
| burst 1 | 238.4 | 238.4 | 238.4 | **15.75** |
| burst 2 (same process) | 241.3 | 241.3 | **238.0** | **17.5** |

The unguarded artifact read all 2800 MiB and grew +2800 then +828 MiB, monotonically
(40.2). The guarded artifact read **15.75 MiB of 2800 offered** and moved RSS by **0.0 MiB**,
and the second burst settled *below* its own baseline. The bytes that were not read are the
finding: the guard refuses on the request line and closes the connection, so the sender never
gets to send.

All §10 gates on this one artifact, every exit code 0: ingress-probe **25/25** twice,
singleton **8/8**, upload-abuse **32/32**, csp **118/118**, proxy-parity 37/37,
job-ownership 25/25, tool-matrix 29/29 exercised, phase1-reliability 29/29,
workflow-completeness 155/156, export-fidelity 35/35, `tsc` 0, `eslint` 0 errors,
`prisma validate` 0, **vitest 389 files / 7487 tests**. Server log across every run: no 5xx,
no Server Action errors.

### 40.12 — §10 regression gates, with the four verdict classes kept apart

Every row below ran on `BUILD_ID 98appVCcbyMxzlhk26zya` in this session. A gate that ran and
passed is not the same claim as a gate that could not run here, so the last three columns are
never folded into the first.

| gate | result | exit | product failures | environmental | not exercised |
|---|---|---|---|---|---|
| `scripts/ingress-probe.mjs` (E2a–E16) | **25/25** | 0 | 0 | — | — |
| the same probe, repeated on the same process | **25/25** | 0 | 0 | — | — |
| `scripts/singleton-probe.mjs` (S1–S8, guarded) | **8/8** | 0 | 0 | — | — |
| `scripts/upload-abuse-probe.mjs` (S1–S18 + front rows) | **32/32** | 0 | 0 | — | — |
| `scripts/csp-probe.mjs` | **118/118** | 0 | 0 | — | — |
| `scripts/proxy-parity-probe.mjs` | 37/37 | 0 | 0 | — | — |
| `scripts/legacy-job-ownership-probe.mjs` | 25/25 | 0 | 0 | — | — |
| `scripts/tool-matrix-probe.mjs` | 29/29 exercised, 34 rows / 32 tools | 0 | **0** | 2 | 3 |
| `scripts/phase1-reliability-probe.mjs` | 29/29 | 0 | 0 | — | 2 |
| `scripts/workflow-completeness-probe.mjs` | 155/156 | 0 | 0 | 1 | — |
| `scripts/export-fidelity-probe.mjs` | 35/35 fixtures | 0 | 0 | — | — |
| `npx tsc --noEmit` | clean | 0 | 0 | — | — |
| `npx eslint .` | 0 errors, 13 warnings | 0 | 0 | — | — |
| `npx prisma validate` | valid | 0 | 0 | — | — |
| `npx vitest run` | **389 files, 7487 tests** | 0 | 0 | — | — |

**PRODUCT FAILURE: 0** across every gate.

The non-passes, named rather than counted. *Environmental* (2 + 1): the tool matrix's two rows
and the workflow probe's journey I need `soffice`, which is not installed on this machine —
the route branch each one guards is covered by unit tests. *Not exercised* (3 + 2): three
tool-matrix rows need the same missing binary, and the two phase-1 observability rows read
server log lines that are only forwarded into the browser console under `next dev`. *Manual
review required*: nothing new in this closeout. **Container execution: NOT EXERCISED** — there
is no local `docker`, so the `Dockerfile` `CMD` change is validated statically and by
`deploymentArtifact.test.ts` (M12), which is not production acceptance and is not called that.

### 40.13 — §11 documentation corrections

Each correction below replaces a statement that was **wrong**, not merely incomplete, and each
keeps the superseded text visible — the brief's "do not rewrite prior evidence as though it
never existed".

| file | what was wrong | now |
|---|---|---|
| `docs/FINAL_PRELAUNCH_PROGRESS.md` | "Six commits:" above a table listing **seven** | "Seven commits, in the six rows below — the fifth row is two commits", with the discrepancy named |
| ″ | Session 6 row 3 read `CLOSED via Path A` for the topology | struck through → `CONFIG VALIDATION ONLY; reopened and closed for real in Session 7` |
| ″ | the Session 6 verdict: "the only in-app lever is `proxyClientMaxBodySize`" | corrected in place — that is the only lever *inside Next's configuration*; the `http.Server` is outside it |
| `docs/FINAL_PRELAUNCH_AUDIT.md` §38 13.2, §39.10 | "the one measured characteristic left unfixed in code" | prefixed **FIXED IN CODE IN §40**, original paragraph preserved as a blockquote |
| ″ | the `boot (shipped default)` row implied enforcement | annotated with what the boot gate actually checked |
| `SERVER_SETUP.md` | "What the gate does and does not do" implied the topology was enforced | split into **what the config gate does** and **what the gate did NOT do, and what now does it**, quoting the old text, with the measured 12.1 s takeover and 0.43 s release |
| ″ | a reverse proxy was required for body limits | "**The app bounds request bodies itself, at ingress**", citing 15.75 MiB of 2800 and 0 MB RSS; nginx `location` list kept as defence in depth |
| ″ | no start instruction distinguished the entries | new top section: `node ingress/server.mjs`, plus migrate-first |
| `docs/PDFDADI_FEATURE_LEDGER.md` | "enforced at boot" for the billing rate limit; "now enforced rather than described" for topology | corrected to what the boot gate checked; heading → "declared and gated — not yet excluded", then the Session 7 entry; csp-probe recipe corrected to the guarded entry and build-time origin |
| `docs/evidence/.../FINAL-VERIFICATION-COMMANDS.md` | `node .next/standalone/server.js` | annotated: that entry exits 1 in production |
| `docs/evidence/.../rollback-runbook.md` | quoted `CMD` from `Dockerfile:88` | corrected to `prisma migrate deploy … && exec node ingress/server.mjs` (`Dockerfile:102`) |

### 40.14 — the forbidden shortcuts, and what was done instead

| forbidden | what was done |
|---|---|
| lower `proxyClientMaxBodySize` and accept silent truncation | untouched at 120 MB; the guard refuses whole requests, so no truncated body reaches a handler (E10, 5/5) |
| global `overflow`-style masking | no catch-all; every path resolves to exactly one class, unknown paths included |
| rely solely on `Content-Length` | chunked and absent-length are 411 on A/B **before** a byte (E5a/E5b); understated length is bounded by the parser (E6) |
| 413 only after buffering the whole body | 413 on the request line — 0.06 MiB read where the baseline read 100 MiB |
| make the reverse proxy optional while relying on it | the mechanism is in the app; the proxy is defence in depth |
| protect only known routes | unknown paths are class A and refuse **byte-identically** to known ones (E2b) |
| change the probe to offer fewer bytes | the same 28 × 100 MiB, twice, on one process; `offered … of 2800` is printed in every run |

Two of the brief's specific requirements are also live rows rather than assertions: the
trusted-proxy secret and forwarded identity **cannot be supplied by a client** (E12 — hostile
`x-proxy-secret`, `x-forwarded-for` and CSP headers changed nothing), and **failure responses
disclose no protected-route existence** (E2b, S4, M7).

### 40.15 — defects found in the instruments, not the product

Recorded because an instrument that lies is worse than a red row, and both of these were found
by using them rather than reading them.

1. **The RSS rows could pass without measuring anything.** `scripts/ingress-probe.mjs` read
   `const peakOk = baseline === null || peak - baseline <= 150`. Run without `--pid`, nothing
   was sampled and E7/E8 printed `RSS null → peak 0 → settled null` **under a PASS** — a
   memory claim, in the finding that is entirely about memory, that no one had measured. Now
   `baseline !== null && …`, with `RSS NOT SAMPLED — rerun with --pid` in the detail. Confirmed
   red without a pid (23/25), then green with one.
2. **S7 passed for two different wrong reasons before it passed for the right one.** A bare
   `status === 200` is also what waiting out the expiry produces, so the row was green at
   baseline where nothing was ever released, and green again with a shutdown-hook bug that
   skipped the delete. It now asserts a **budget**: 8 000 ms, which the release path meets in
   433 ms and the expiry path (TTL 10 s + 2 s grace) cannot.
3. **The CSP probe's two red rows were a build input, not a product defect.**
   `next.config.mjs:41` resolves `REPORT_ENDPOINT` from `NEXT_PUBLIC_SITE_URL` **at build
   time**, and `.env` carries `http://localhost:3000`, so the static-asset report group was
   absent from the artifact. Rebuilt with the https origin exported: `routes-manifest.json`
   then carried `report-to csp-endpoint`, and the probe went 108/110 → **118/118**. The
   recipe in the ledger and `scripts/tls-front.mjs` now says so, because the next person to
   run it would have hit the same two rows and looked for the bug in the product.

### 40.16 — residual risk and known ceilings

Four, each with the condition that makes it matter and the upgrade that answers it.

1. **The lease is judged on the application clock.** One host, one clock, so it is exact in the
   supported topology; `CLOCK_GRACE_MS` 2 s absorbs small skew beyond it. A multi-host Postgres
   deployment should move the comparison onto the database clock (`now()` in a raw `UPDATE`).
   Marked `ponytail:` in the source with that upgrade path. Do it when a second host is real.
2. **A standby is a warm spare, not a load balancer.** Two instances behind one database give
   failover, not capacity. The upload rate limiter is still per-process memory — which is
   *safe* now, because only one process serves, but it is safe by exclusion rather than by
   being shared. A genuinely multi-instance deployment needs the limiter moved to the database
   or a shared store before the lease is relaxed.
3. **`CLASS_B_MAX_BYTES` is 2 MiB for every structured body.** A future route that legitimately
   needs a larger JSON body must be given its own ceiling in `ingress/bodyRoutes.mjs`, and
   `bodyRoutes.test.ts` fails until it is — the ceiling is a decision the inventory forces,
   not a limit that silently truncates.
4. **The guard depends on Next installing exactly one `'request'` listener.** `guard.test.ts`
   asserts the swap, and `assertIngressInstalled()` refuses a production boot that reached
   instrumentation without it, so a Next upgrade that changed this shape fails a test and
   refuses to start rather than serving unguarded. That is the fail-closed direction, but it is
   a coupling to review on a major Next upgrade.

### 40.17 — what is NOT exercised

Stated as gaps, not as passes.

- **Container execution.** No `docker` on this machine. The `Dockerfile` `CMD`
  (`prisma migrate deploy … && exec node ingress/server.mjs`, `Dockerfile:102`) is validated
  statically and by `deploymentArtifact.test.ts`, which mutation M12 shows is load-bearing.
  This is not production acceptance.
- **Human visual acceptance.** Not begun, per the brief's stop instruction.
- **Production acceptance.** Not begun: no push, no deploy, no merge to `main`, no remote
  configured.
- **Multi-host lease behaviour.** One host was tested. See 40.16.1.
- **`soffice`-dependent conversions** (3 tool-matrix rows, 2 environmental) and the **two
  phase-1 observability rows** that need `next dev` log forwarding.

### 40.18 — the branch

Seven commits on `ingress-memory-safety-closeout`, from `478e111`. `main` untouched, no remote
configured, nothing pushed.

| commit | what it closed |
|---|---|
| `1432f91` | the 120 MB a page URL would retain for an anonymous stranger — policy, guard, seam |
| `792abff` | `DEPLOYMENT_TOPOLOGY=single-instance` proved only that an operator had typed it — the lease |
| `84e7014` | a guard nothing starts is a note in a runbook — `ingress/server.mjs`, the `Dockerfile` `CMD`, the production refusal |
| `0c7654b` | two instruments that were wrong before the product was (40.15) |
| `ce026f6` | the gates, held against a broken boundary one property at a time — the mutation exercise |
| `3b113c7` | a GET may carry a body, and only the seam can be asked about that — the M6 near-miss |
| `30a15b5` | three suites that pinned a boot without a lease, and a migration called "the last one" |

### 40.19 — carried forward, unchanged by this closeout

Neither is new, neither is caused by §40, and neither is closed by it; both are recorded so the
verdict is not read as covering them.

- **`app/api/storage/multipart/**` is anonymous.** Both entries are in the inventory with
  `auth: "anonymous"` and no per-route ceiling, so they are bounded by class B's 2 MiB rather
  than by authorization. They are pre-existing routes outside the five accepted multipart
  paths; the finding stands where §38 left it.
- **Local readiness returns 503 on `toolchain: false`.** On this machine the toolchain check
  fails for the missing `soffice`, so `/api/health/ready` is 503 even when the instance holds
  the lease. The `instance` check itself reports correctly (S5), which is what §6 required.

### 40.20 — verdict

Both boundaries in the brief are closed **in code**, on one cold production artifact, with the
original load exercised rather than substituted:

- **Body memory amplification.** The unguarded artifact read all 2800 MiB offered and grew
  +2800 then +828 MiB monotonically across two bursts. The guarded artifact read **15.75 MiB**
  and moved RSS **0.0 MiB**, settling below its own baseline on the second burst. 25/25 live
  rows, 68 unit tests, five controls byte-identical to the baseline.
- **Single-instance topology.** Two processes against one database: the baseline served
  `200` from both (`serving=2`). Guarded, exactly one serves, the second is a silent 503
  standby, SIGKILL failover took 12 107 ms unattended and a clean release let a fresh instance
  in after 433 ms. 8/8.

No product failures on any gate. What remains unexercised is named in 40.17 and is
environmental or explicitly out of scope, not unknown.

**PDFDADI CODE READY — PRODUCTION ACCEPTANCE NOT EXERCISED**
