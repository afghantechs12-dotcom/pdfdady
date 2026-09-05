# Stage 12 — human visual-acceptance package

**Date:** 2026-09-05 · **Branch:** `production-acceptance` · **Base:** `3e4ac8b`
**Artifact:** `BUILD_ID MniplDUweIbeIPYT_CM5N` · **Front:** `https://192.168.0.175:3001` (TLS, self-signed) → origin `http://127.0.0.1:3002`
**Measurements:** `15-visual-acceptance.log`, `docs/evidence/production-acceptance/visual/` (five contact sheets)
**Baseline:** `docs/screenshots/final-prelaunch/baseline` — the accepted Gate B set

> **VISUAL ACCEPTANCE PENDING.** Everything below is a machine measurement that the
> pixels did not move. No line of it is an approval of how the product looks, and
> nothing in this branch records one. Only the owner can accept the contact sheets.

## What Stage 12 has to answer

1. Did any pixel move between the accepted prelaunch artifact and this one?
2. Is there a package a human can actually review, rather than 156 loose files?
3. Does the product hold together at real viewport widths without a horizontal scrollbar?
4. Do the interaction gates still pass on the artifact behind the TLS front?
5. What is still unreviewed after all of that?

## 1. The compare: PASS 156/156

```
node scripts/visual-acceptance-probe.mjs --url https://192.168.0.175:3001 --auth \
  --out docs/screenshots/production-acceptance \
  --baseline-dir docs/screenshots/final-prelaunch/baseline \
  --sheets docs/evidence/production-acceptance/visual
```

156 captures over 18 surfaces at 320/360/390/412/768/1024/1280/1440/1920, compared
against the prelaunch baseline. `05-compress-progress` is deliberately 3 captures
rather than 9: a genuine in-flight state cannot be held at nine widths.

| | |
|---|---|
| Compared captures | 156 — **PASS 156/156** |
| Byte-identical | **154** |
| Nonzero, both under threshold | 2 |
| Aggregate difference | **14 px of 124,482,826 = 0.000011%** (threshold 0.1%) |
| Groups | marketing 45 · workflow 39 · editor 36 · workspace 27 · states 9 |
| NOT EXERCISED | 1 — `19-app-error`, see §5 |

The comparison is meaningful because of what changed underneath it. Between the
baseline and this run: a full rebuild, 12 commits, a different LAN origin
(`172.20.10.2` → `192.168.0.175`), and a different throwaway account. Only 8 files
under `app/` changed on this branch, all API routes and tests — no page, no
component. So a moved pixel here would have been a real regression, not expected
drift, which is the property that makes 156/156 worth having.

### The two nonzero captures

| Capture | Differing | Ratio | Worst box |
|---|---|---|---|
| `12-editor-workspace` 1280x800 | 5 px | 0.0005% | 62x3 at 276,170 |
| `14-conflict-dialog` 1280x800 | 9 px | 0.0009% | 345x3 at 276,207 |

The probe only prints worst-box geometry on failure, so `scripts/lib/png-diff.mjs`
was re-run on the two pairs to get it, and both captures were then cropped at that
box and looked at. Both boxes are **3 pixels tall** and land on the editor's tool
rail — select, pan, text, image, shape, draw, duplicate. Every icon is present, the
same size, at the same x; the residual is anti-aliasing along SVG strokes.

The geometry is what rules out the alternative reading: a moved or resized element
produces a diff box the height of that element, not a 3-pixel band. Neither box is
adjacent to a masked rect, so it is not mask-edge bleed either.

## 2. Masks — 214 rects, and one that binds nothing

| Selector | Rects | Where |
|---|---|---|
| `[data-relative-time]` | 99 | `08-workspace-populated` 54, `09-workspace-empty` 45 |
| `[role="status"]` | 90 | `13-publish-state` 45, `14-conflict-dialog` 45 (per-surface only) |
| `[data-user-identity]` | 25 | 08 · 09 · `10-activity-recent` 9 · 12 · 14 |
| `time` | **0** | no `<time>` element renders on any captured surface |

**107 of 156 captures are compared with no mask at all.** What is masked is exactly
what legitimately differs between two runs: the throwaway account's identity,
relative timestamps, and a live region whose text depends on when the shot lands.

`time` binding zero rects is recorded rather than assumed. A mask that matches
nothing hides nothing — and stating it now stops someone later "fixing" its absence
by widening the selector until it does hide something.

## 3. The package a human reviews

[docs/evidence/production-acceptance/visual/](visual/) — PNG plus an HTML index per sheet:

| Sheet | Captures | Covers |
|---|---|---|
| `contact-mobile` | 69 | 320 / 360 / 390 / 412 |
| `contact-tablet` | 35 | 768x1024 |
| `contact-desktop` | 52 | 1024 / 1280 / 1440 / 1920 |
| `contact-workflow-states` | 39 | upload → progress → result → download |
| `contact-editor-states` | 36 | empty · loaded · publish · conflict · error |

The **PNG** of each sheet is self-contained and is what the owner reviews. The `.html`
index beside it references the individual captures by absolute `file://` path into the
gitignored `docs/screenshots/` tree, so it only resolves on the machine that produced
it — a pre-existing property of the probe, true of the prelaunch sheets as well, and
not worth changing for a one-machine audit.

## 4. Responsive sweep — anonymous, 63 measurements, zero overflow

```
node scripts/responsive-qa.mjs --url https://192.168.0.175:3001
```

| Page | Measurements | Overflow | `hscroll` | `wide` (max) | Page height | Console errors |
|---|---|---|---|---|---|---|
| `/` | 9 | 0 | 0 | 8 | 5922–11492 | 9 |
| `/tools` | 9 | 0 | 0 | 0 | 5535–11688 | 9 |
| `/pricing` | 9 | 0 | 0 | 0 | 1916–3595 | 9 |
| `/blog` | 9 | 0 | 0 | 0 | 2608–5572 | 9 |
| `/editor` | 9 | 0 | 0 | 8 | 720–1080 | 0 |
| `/login` | 9 | 0 | 0 | 2 | 800–1080 | 0 |
| `/signup` | 9 | 0 | 0 | 2 | 925–1141 | 0 |

`scrollW <= viewport width` in **63 of 63** measurements, no exceptions. This is the
first evidence package in the repository to include an anonymous sweep, which is how
it found the one new defect (§6).

Two heuristic outputs are **not** findings, and the report's own numbers say so:

- **`wide` is not overflow.** All 101 flagged elements are decorative aura layers —
  `pointer-events-none absolute -inset-10 -z-10`, `animate-glow-pulse absolute …
  blur-[70px]`. At 360x800 on `/`, one rect runs left=-44 to right=256 and another
  left=175 to right=645 while `scrollW=360`. Boxes extend past the viewport by
  design; the document does not scroll.
- **`tiny` (144 rows) contains no accessibility defect on these pages.** The rule is
  `height < 24 || width < 24` over `a,button,[role=button],input,select`, and it
  reads neither `aria-hidden`, `sr-only`, nor a wrapping label:

  | Row | What it is |
  |---|---|
  | 1x1 `<a>`, all 7 pages | the skip link, `sr-only focus:not-sr-only …` ([app/layout.tsx:85](../../../app/layout.tsx#L85)). Focused it is 138x40 — measured by the premium probe's A5/B5 gates |
  | 1x1 `<input>` on `/` | the dropzone's file input: `className="sr-only" tabIndex={-1} aria-hidden` ([components/upload/UploadDropzone.tsx:86-95](../../../components/upload/UploadDropzone.tsx#L86-L95)). Not a target at all; the 300x256 dropzone is, and premium gate C1 asserts exactly that |
  | 16x16 `<input>`, login/signup | checkboxes wrapped in a `<label>` that is itself the target (`min-h-[44px]` on login, `py-2` on signup) |
  | 17px-tall `<a>` x6 | inline text links inside sentences, which WCAG 2.2 SC 2.5.8 excepts |

  Stated at this length on purpose: the lazy alternative is to file six a11y bugs
  that do not exist, and someone would then "fix" a working skip link.

## 5. Premium UI/UX probe — 125 pass, 0 product failures

```
node scripts/premium-ui-ux-probe.mjs --url https://192.168.0.175:3001 --auth
```

All 13 scenarios PASS: A 12/12 · B 13/13 · C 8/8 · E 5/5 · D 7/7 · F 13/13 ·
G 11/11 · H 10/10 · I 12/12 · J 5/5 · K 11/11 · M 14/14 · L 4/4 —
**125 pass · 0 product failures · 0 environmental · 0 not exercised.**

Each scenario carries an anti-vacuity floor, so none of them can pass against a
blank page: `/` 7105 chars · `/tools` 5512 · `/tools/merge-pdf` 1437 ·
`/tools/compress-pdf` 1575 · `/workspaces` 388 · workspace document 777 ·
`/editor` 728 · `/pricing` 2513.

Reconciliation with the harness: the earlier phases recorded this probe at **111
pass**; the final prelaunch audit took it to **125** by exercising row M5b for the
first time (the closed native `<select>`, driven by type-ahead after CDP proved
unable to reach the browser-process popup with `ArrowDown`). This stage reproduces
125 on the production-acceptance artifact behind the TLS front. Product code
untouched in both.

## 6. The defect this stage found: every anonymous page load prints a console error

Two designed "nothing here" answers are 4xx, so Chrome files a red console line for
each. Both are functionally correct, and neither is suppressible from JavaScript —
the browser logs the response before `fetch` resolves.

| | |
|---|---|
| `GET /api/auth/me` → **401** for an anonymous visitor | [app/api/auth/me/route.ts](../../../app/api/auth/me/route.ts): `if (!token) return authError("UNAUTHORIZED", …, 401)`. Fetched after hydration by [hooks/usePublicSession.ts:51](../../../hooks/usePublicSession.ts#L51), whose own comment says "401 is the normal signed-out case, not an error worth reporting" |
| `GET …/editor-state` → **404 `EDITOR_STATE_UNAVAILABLE`** for a version with no saved scene | [route.ts:110-126](../../../app/api/workspaces/[workspaceId]/documents/[documentId]/editor-state/route.ts#L110-L126), "Deliberately undifferentiated" |

Measured: **36 occurrences** of the 401 = 4 pages x 9 widths (`/`, `/tools`,
`/pricing`, `/blog`). `/login`, `/signup` and `/editor` do not render that header,
which is why their rows show `errs=0`. The 404 appears once, in premium gate G5,
as the single network entry that gate ignored.

The 401 is not gratuitous: reading the session cookie on the server would opt roughly
30 static routes out of prerendering, so the header ships signed-out markup and
upgrades after hydration. That is a deliberate trade, and the console line is its
cost.

**Why no earlier probe could see it — three independent reasons, all measurable:**

1. `premium-ui-ux-probe.mjs`'s `main()` calls `signUp(ctx)` before the scenario loop
   under `--auth`, so `/api/auth/me` answers **200** in scenarios A/B/I. Ten of its
   eleven console gates ignored exactly **0** network entries.
2. `responsive-qa.mjs` is always anonymous — and had never been included in an
   evidence package before this stage.
3. `probe-browser.mjs` splits `jsErrors` from `netErrors` (Chrome files "Failed to
   load resource: 401" under `Log.entryAdded` with source `network`). That is why
   Stage 11's "0 JS errors" and these 36 lines are both true statements about the
   same build.

**Severity P3. Not fixed here.** Changing an auth endpoint's status code, or moving
the session read to the server, is not a clearly low-risk edit to make during
acceptance — the first would touch a trust boundary's response contract, the second
would change the prerendering of ~30 routes. It becomes an owner row in Stage 13
with three options: leave it (cosmetic, visible only in devtools), answer 200 with
`{user:null}` for the anonymous case, or have the client skip the fetch when no
session cookie is present.

## 7. `19-app-error` is NOT EXERCISED, and the probe's own hint for it is stale

The probe suggests reaching the error boundary by starting with a broken
`DATABASE_URL`. That technique is obsolete, measured on a throwaway origin
(`PORT=3004`, started by hand rather than through `scripts/restart-origin.sh` so the
live origin's `.next/static` was never touched):

```
$ curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:3004/ /workspaces \
    /api/health /api/health/ready
503 503 503 503        body: {"error":"Server is not accepting requests."}
```

[src/infrastructure/config/instanceLease.ts:95-170](../../../src/infrastructure/config/instanceLease.ts#L95-L170) —
`tryAcquire()` throws on a genuine database failure and `beat()`'s catch keeps the
status `pending` — while [ingress/guard.mjs:107-129](../../../ingress/guard.mjs#L107-L129)
serves only `SERVING = new Set(["held","disabled"])`. An unusable database therefore
returns 503 on **every** path and the Next application is never invoked: no error
boundary renders, so there is nothing to screenshot. The lease landed 72 commits
after the Gate B run whose hint this is.

Two consequences are recorded for Stage 13 rather than decided here:

- The guard's own comment says an operator reads the difference in
  `/api/health/ready`'s `instance` field. In exactly the states that matter, that
  endpoint is one of the 503s — the field is unreachable when it would be useful.
- [Dockerfile:105-106](../../../Dockerfile#L105-L106) healthchecks `/api/health`,
  which a lease-unheld process refuses. A container waiting correctly for a lease is
  therefore marked unhealthy. `docker-compose.yml` defines no healthcheck of its own.

Both live listeners were re-verified 200 afterwards and `/tmp/pa-stage12-broken` was
removed.

## 8. Reproducibility, honestly stated

**The first run of this stage proved nothing, and is recorded because of it.** Run
with `--out` pointed at a fresh stage directory and no `--baseline-dir`, the probe
reported **PASS 0/0 with 157 NOT EXERCISED** and still exited 0 with its banner
printed. `BASELINE_DIR` defaults to `join(OUT, "baseline")`, so naming a new output
directory does not "capture into a new place and compare" — it silently removes the
comparison. A `PASS 0/0` is the shape a vacuous green run takes here.

That run also exposed a real defect in the probe: `contactSheets()` wrote to a
hardcoded `docs/evidence/final-prelaunch/visual`, so this phase's run overwrote the
previous phase's **committed** sheets — 10 modified files. Restored with
`git checkout -- docs/evidence/final-prelaunch/visual/` and verified 0 modified
afterwards. The probe now takes `--sheets`, which is the fix committed with this
stage; `responsive-qa.mjs` gained `--ignore-certificate-errors` for an `https` URL
only, because without it the sweep would have measured Chrome's TLS interstitial
against the self-signed front rather than the product.

Neither patch touches product code. Both are in the measurement tools.

## 9. What Stage 12 does **not** establish

- **That the product looks right.** 156/156 says today's pixels equal the accepted
  baseline's pixels. If the baseline itself is wrong, this stage reproduces the
  mistake exactly. Only §11 closes that.
- **The error boundary's appearance** (`19-app-error`) — §7. Reaching it now needs a
  dependency that fails *after* the lease is held, which no current probe stages.
- **Anything at a real device.** Every capture is Chrome with an emulated viewport on
  one machine. No iOS Safari, no Android Chrome, no Firefox, no real DPR-3 phone, no
  screen reader, no reduced-motion or forced-colors pass.
- **Print, or non-default zoom.** No `@media print` capture; no 200% browser zoom
  pass, which is a distinct WCAG requirement from the widths swept here.
- **Colour contrast.** No probe in this package measures contrast ratios; the
  premium probe checks accessible *names* and target *sizes*, not colour.
- **The blog's rendered content beyond layout.** `/blog` appears in the responsive
  sweep only, never in the visual set, so its posts have no pixel baseline.

## 10. Harness rows

| Row | Before | After this stage |
|---|---|---|
| **R2** — 111 rendered-layout assertions across 9 viewports | NOT EXERCISED (delegated: "run it separately and report its own count") | **PASS** — run separately as the harness instructed, reporting its own count: premium probe **125 pass / 0 product failures** (111 → 125 via M5b), plus **63/63** responsive measurements with zero overflow |
| **R3** — visual acceptance of the rendered screenshots by a human | MANUAL REVIEW REQUIRED | **still MANUAL REVIEW REQUIRED** — carried to Stage 13. The package exists; the approval does not, and a self-generated screenshot is not approval |

## 11. What a human still has to do

Open the five sheets in [visual/](visual/) and decide whether the product looks
right. Specifically, because a pixel compare cannot:

1. **Mobile at 320.** The narrowest supported width, 69 captures. Cramped-but-correct
   and cramped-but-wrong are byte-identical to a diff.
2. **The workflow strip.** upload → progress → result → download, 39 captures: does
   it read as one flow, and is the result state obviously finished?
3. **The editor states.** 36 captures including the real 409 conflict dialog — is the
   conflict comprehensible to someone who did not cause it deliberately?
4. **Marketing copy and hierarchy** at desktop widths: is the primary action the most
   prominent thing on each page?
5. **The two nonzero captures**, if the anti-aliasing account in §1 is to be
   confirmed by eye rather than taken from geometry.

## Files changed by this stage

| File | Change |
|---|---|
| `scripts/visual-acceptance-probe.mjs` | `--sheets` for the contact-sheet directory; it no longer writes into a hardcoded previous-phase path |
| `scripts/responsive-qa.mjs` | `--ignore-certificate-errors` for an `https` base only, so the sweep measures the page and not Chrome's interstitial |
| `docs/evidence/production-acceptance/visual/` | five contact sheets, PNG + HTML index |
| `docs/evidence/production-acceptance/15-visual-acceptance.{md,log}` | this write-up and its measurements |

**VISUAL ACCEPTANCE PENDING**
