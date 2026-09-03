# Gate B — visual acceptance

**Verdict: `VISUAL ACCEPTANCE PENDING`.** A machine proved the pixels did not
move. No human has approved how they look, and nothing in this directory may be
read as approval.

Command, both legs:

```
node scripts/visual-acceptance-probe.mjs --url https://172.20.10.2:3001 --auth --baseline   # record
node scripts/visual-acceptance-probe.mjs --url https://172.20.10.2:3001 --auth             # compare
```

`--auth` mutates data: one throwaway account per run, two Workspaces, one
ingested document. No real credentials exist anywhere in these scripts.

## What was captured

18 surfaces × 9 viewports = **156 captures**, plus a full-page companion at
390×844 and 1440×900, plus surface 19 in its own run (below). Five contact
sheets under `docs/evidence/final-prelaunch/visual/contact-*.png`.

| Surface | Title | Group | Captures |
|---|---|---|---|
| `01-homepage` | Homepage | marketing | 9 |
| `02-tools-directory` | Tools directory | marketing | 9 |
| `03-merge-initial` | Merge — initial state | workflow | 9 |
| `04-merge-result` | Merge — result | workflow | 9 |
| `05-compress-progress` | Compress — progress | workflow | 3 |
| `06-compress-outcome` | Compress — outcome | workflow | 9 |
| `07-destination-choice` | Multi-Workspace destination selection | workflow | 9 |
| `08-workspace-populated` | Populated Workspace | workspace | 9 |
| `09-workspace-empty` | Empty Workspace | workspace | 9 |
| `10-activity-recent` | Activity / Recent | workspace | 9 |
| `11-editor-standalone` | Standalone Editor | editor | 9 |
| `12-editor-workspace` | Workspace Editor | editor | 9 |
| `13-publish-state` | Publish state | editor | 9 |
| `14-conflict-dialog` | Save conflict | editor | 9 |
| `15-pricing` | Pricing | marketing | 9 |
| `16-login` | Authentication — sign in | marketing | 9 |
| `17-register` | Authentication — register | marketing | 9 |
| `18-not-found` | 404 | states | 9 |
| `19-app-error` | Application error state | states | 9 (separate run) |

`05-compress-progress` is 3 viewports on purpose: it is a transient state that
only exists while a server job runs, and re-reaching it nine times would cost
nine compress jobs and nine chances of catching a different frame.

Every capture is a viewport shot, and every state is **driven** — real uploads
through the real file inputs, real job submissions, real saves. Nothing is
staged by injecting markup.

## The compare, twice, across a rebuild

| Run | Build | Result | Log |
|---|---|---|---|
| Baseline record | `223399b` artifact | 156 recorded | `visual-baseline-full.log` |
| Compare, same build | same | **PASS 156/156** | `visual-compare-full.log` |
| Compare, **after a rebuild** (`b29f79f`: new 404 + 27 metadata files) | new | **147/156** — all 9 failures on `18-not-found`, the one surface the commit changes | `visual-compare-3.log` |
| Compare, after re-recording `18-not-found` only | same | **PASS 156/156** | `visual-compare-4.log` |
| Compare, with **mutation N** applied (`--only 01-homepage`) | mutated | **PASS 0/9** — 23–36% of pixels, every viewport | `mutN-red.log` |
| Compare, after reverting mutation N through Git | rebuilt | **PASS 156/156** | `visual-compare-5.log` |

The third row is the useful one, and rows five and six are mutation N (below). A rebuild that touched 28 files moved exactly
the surface it was supposed to move, at 99.985–100% of pixels, and left the other
147 rows bit-identical. Two facts fall out of it: the harness detects a
whole-surface change unambiguously, and the other surfaces are stable across
builds rather than only across runs of one build.

The tightest genuine noise in the whole set is `12-editor-workspace 1280x800`:
**5 of 1,017,850 unmasked pixels** (0.0005%), against a 0.1% threshold. 146 of
the 147 unchanged rows differ by exactly **0 pixels**. The threshold is not
doing any work to hide anything.

Tolerance is 8/255 per channel and the ratio threshold is 0.1% of unmasked
pixels — small enough that a 12px padding change or a shifted brand hue lands
orders of magnitude above it. Mutation N below is the proof rather than the
claim.

## Masks: what each one actually bound

Masks are measured at **diff time, on the current page**, so adding one does not
invalidate an existing baseline. Rectangles are in viewport coordinates and
carry 2px of slack on each edge.

| Selector | Scope | Rects across the 156 captures | Surfaces bound |
|---|---|---|---|
| `[data-relative-time]` | global | 99 | `08`, `09` |
| `[role="status"]` | surfaces 13, 14 | 90 | `13`, `14` |
| `[data-user-identity]` | global | 25 | `08`, `09`, `10`, `12`, `14` |
| `time` | global | **0 — bound nothing** | none |

`time` is retained deliberately and recorded as binding nothing: this codebase
renders no `<time>` element today, and a mask that silently starts covering
pixels the day someone adds one is worth writing down now rather than
discovering later. Masked area is bounded and visible per row in the manifest —
the largest is 7 regions on `08-workspace-populated`, ~1.3% of a 1920×1080
frame.

**No global threshold was raised, and no surface was excluded, to make this
gate pass.** The only mask selectors are the four above.

## What the gate found — product defects

**P2, fixed — `18-not-found` was a photograph of the framework's 404.** There was
no root `app/not-found.tsx`, so every unknown public URL got Next's built-in
page: "404 | This page could not be found", no brand, no navigation, no way
back, and — because that page carries its own `prefers-color-scheme: dark`
styles — a near-black screen at every desktop and tablet width. The reference was
recorded, the anti-vacuity floor passed it (its text is ~60 characters, floor 40),
and the pixel compare passed it nine times. Only reading the contact sheet
caught it. Fixed in `b29f79f`; re-baselined; the runtime proof is a 404 status,
`noindex, nofollow`, and the branded copy.

**P3, fixed — three rows were green by luck.** `relativeTime()` output on the
Workspace dashboard ("Updated 2 hours ago") was NOT masked, and rows `08`, `10`
and `12` passed anyway, because baseline and compare both ran inside the same
minute of the document they had just created. Those three rows documented
nothing. `data-relative-time` now marks every render of that helper and the rule
is written at the helper itself.

**P3, fixed — the doubled brand.** Found while verifying the new 404 at runtime:
its title came out `Page not found — PDFDadi — PDFDadi`. 27 pages branded their
own titles under the root layout's admin-editable `title.template`. Not a pixel
defect — the visual gate cannot see a `<title>` — but it was found by this leg
and it is fixed in the same commit.

## What the gate found — probe defects

Each of these was a harness row that described its own blind spot as a property
of the product. All four are fixed; the classification matters because the
alternative is a launch report naming product failures that do not exist.

| Surface | What it did | Why it could never have passed |
|---|---|---|
| `13-publish-state` | fed the PDF fixture to "the first file input on the page" | the editor mounts three; two are image pickers. The PDF loaded nothing, the stage stayed at `onboarding`, and `Save to Workspace` is correctly absent there. Reported NOT EXERCISED against a product that was behaving. Now targets `input[accept="application/pdf"]` |
| `14-conflict-dialog` | `PATCH` to the document metadata route, then looked for a `[role="dialog"]` | that route has only GET and PUT (the PATCH answered 405), a metadata revision is a different domain from the document revision the CAS uses, and the conflict is a `role="alert"` banner. It blamed "an unwinnable race". Now it really loses the race: the editor's own version upload is cloned in flight, the clone commits first, and the server's CAS refuses the original |
| `16-login` | captured `/login` under `--auth` | a signed-in visitor is redirected to `/workspaces`. Two of the references documented the Workspace list under the names "sign in" and "register", passed the floor on the substitute page's text, and diffed only on the throwaway email. Now `anonymous: true` clears and restores the session, and `reach` refuses if the redirect still happens |
| `17-register` | as above, for `/register` | as above |

**One scope defect is recorded but NOT fixed, deliberately.** A surface is
reached once and then resized across the nine viewports — on purpose, because a
resize re-evaluates `@media` for real without a reload, so a driven state (a
result panel, an open dialog) survives the sweep. The consequence is that the
mobile editor captures are of a session that was first painted at desktop width:
`preserveInspectorVisibility` demotes the docked Inspector into an open drawer on
the way down, so `11-editor-standalone` at 320–412px shows the Inspector covering
the canvas. A reviewer would read that as "the editor opens on a phone with the
document hidden". It does not. Loading `/editor` at 390×844 as the FIRST paint
was measured directly:

```
{ "innerWidth": 390, "drawerHeading": false, "dialogs": 0,
  "heads": ["Untitled PDF· nothing opened yet", "Pages1", "Start editing"] }
```

No drawer, no dialog: on a phone the editor opens on the document. The captures
are valid references for the resize path, which is a real path, and they are
mislabelled as "the editor at 390px". Fixing it means either a reload per
viewport (nine job runs per surface, and nine chances of a different frame) or a
second surface for the phone-first load. Recorded rather than silently accepted.

## Surface 19 — the error boundary, in its own run

`19-app-error` cannot be reached on a healthy server, which is the point of it.
Against the ordinary origin the probe reports, correctly:

```
19-app-error: this server answered /workspaces normally; the boundary needs a
genuinely failing dependency (run with a broken DATABASE_URL)
```

That row is **NOT EXERCISED** in the 156-capture run and is never counted as a
pass. It was then exercised separately, against a second origin started on port
3003 with a `DATABASE_URL` pointing at a file that is not a database, and
recorded as its own baseline:

```
node scripts/visual-acceptance-probe.mjs --url https://172.20.10.2:3003 --only 19-app-error --baseline
```

`docs/evidence/final-prelaunch/visual/baseline-manifest-19-app-error.json` holds
that leg: 9 captures, `authenticated: false`, 151 characters of text at every
viewport, and `allowedConsoleError: /An error occurred in the Server Components
render/` — the server-render failure the boundary exists to catch, allowed for
this surface only so the run does not abort on the very error it is documenting.
The boundary renders its own branded copy at all nine widths.

The same is true of `18-not-found` after the fix: its 9 captures are preserved as
`baseline-manifest-18-not-found.json` because a `--baseline` run overwrites the
full manifest with only its own rows, and the record of what the re-baseline
actually contained should survive that.

## Reproducibility, honestly stated

The 41 MB of reference PNGs live in `docs/screenshots/final-prelaunch/`, which is
gitignored (`.gitignore:34`). They are **not** committed, so:

- the compare is reproducible **on this host only**, until a baseline is recorded
  elsewhere;
- what IS committed is everything needed to record a new baseline and to read this
  one — the probe, the diff library, the five contact sheets, the two side-run
  manifests, and this document;
- a CI-side visual gate would need the baselines in an artifact store. That is a
  launch decision, not a finding, and it is recorded as one in Group Q.

The five contact sheets in this directory are the reviewable artifact. They are
regenerated by every full run, and the run that produced the ones committed here
is `visual-compare-5.log` (PASS 156/156, the post-revert run).

## What a human still has to do

Nothing in this gate is an opinion about design. The machine proved: the 156
references exist, each one carries real text above its per-surface floor, the
pixels do not move across runs or across a rebuild, and a deliberate visible
regression is caught (mutation N below). Whether the product **looks right** is
unproven and unprovable here.

**`VISUAL ACCEPTANCE PENDING`.**

## Mutation N — the gate catches a visible spacing regression

The requirement is that this gate would notice a real visual defect, not merely
that it passes. So one was introduced, singly, and it went through the whole
pipeline — source, production build, standalone artifact, browser, diff — because
a mutation that only proves the differ works proves very little.

**The mutation.** [Hero.tsx:116](../../../../components/home/Hero.tsx#L116),
the homepage `<h1>`: `mt-4` → `mt-16`. One token, one file. A 48px push on the
headline, the sort of thing a careless Tailwind edit produces.

**Red, at all nine viewports** (`PASS 0/9`, exit 1):

| Viewport | Pixels differing | Share | Worst box |
|---|---|---|---|
| 320×800 | 71164 / 256000 | 27.80% | 280×614 at 20,186 |
| 360×800 | 76749 / 288000 | 26.65% | 320×614 at 20,186 |
| 390×844 | 97778 / 329160 | 29.71% | 370×692 at 0,152 |
| 412×915 | 127021 / 376980 | 33.69% | 412×763 at 0,152 |
| 768×1024 | 274207 / 786432 | 34.87% | 768×864 at 0,160 |
| 1024×768 | 282237 / 786432 | 35.89% | 992×754 at 32,14 |
| 1280×800 | 372047 / 1024000 | 36.33% | 1248×786 at 32,14 |
| 1440×900 | 405885 / 1296000 | 31.32% | 1364×835 at 72,14 |
| 1920×1080 | 478596 / 2073600 | 23.08% | 1920×1066 at 0,14 |

The smallest of those is 23.08% against a 0.1% threshold — **230× the gate**.
Set against the tightest genuine noise in the set (0.0005%), the margin between
"a real regression" and "run-to-run noise" is five orders of magnitude. The
threshold is not close to hiding anything a reviewer would care about.

**Reverted through Git.** `git checkout -- components/home/Hero.tsx`; line 116
reads `mt-4` again and `git status` is clean for that file. Rebuilt, origin
restarted, full compare rerun: **`PASS 156/156`** (`visual-compare-5.log`), which
is the run whose five contact sheets are the ones committed here.

Command sequence, for the record:

```
sed -i '' '116s/mt-4 text-\[clamp/mt-16 text-[clamp/' components/home/Hero.tsx
npm run build && sh scripts/restart-origin.sh                        # mutated artifact
node scripts/visual-acceptance-probe.mjs --url … --only 01-homepage   # PASS 0/9, exit 1
git checkout -- components/home/Hero.tsx
npm run build && sh scripts/restart-origin.sh                        # reverted artifact
node scripts/visual-acceptance-probe.mjs --url … --auth               # PASS 156/156
```

### One harness hazard this exposed, twice

A `--only` or `--baseline` run **overwrites `visual-manifest.json` with just its
own rows and regenerates the contact sheets from just its own captures.** After
the mutation the reviewable artifact was three sheets of homepage screenshots;
after the `18-not-found` re-baseline it was nine 404s. Neither loses a reference
PNG, but both destroy the reviewable summary, and a run that ended there would
have shipped a directory that looks like the gate covered one surface.

Both times the recovery was the same and it is the rule going forward: **a
partial run is always followed by a full `--auth` compare before the evidence is
read.** Recorded here rather than fixed in the probe: the fix is a merge into the
existing manifest, which is real work for a hazard that a written rule handles,
and the partial runs are useful precisely because they are cheap.
