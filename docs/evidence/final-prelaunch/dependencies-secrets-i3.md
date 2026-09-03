# I3 — the nine production advisories, each one resolved to reachability

HEAD `eb8f7fa` · audit host, 2026-09-03. This file exists because the final harness
run reported exactly one PRODUCT FAILURE and it was a **count**:

```
I3  PRODUCT FAILURE  no critical or high advisory in the production dependency tree
    -> 9 high/critical advisories: @prisma/config (high), brace-expansion (high),
       deepmerge-ts (high), nanoid (high), next (high), pdfjs-dist (high),
       postcss (high), prisma (high)
```

A count is not a finding. Every advisory below was traced to whether the vulnerable
code can be reached **in this product, as configured, in the artifact that ships**.
Nothing was upgraded — the brief forbids mass dependency upgrades — so each row ends
with the remediation named rather than performed.

## The commands

```
$ npm audit --omit=dev --json
counts:      {"info":0,"low":0,"moderate":0,"high":9,"critical":0,"total":9}
audited:     158 prod dependencies (485 total incl. dev and optional)
```

The decisive one, because it distinguishes "installed" from "shipped" — what the
standalone artifact's dependency trace actually contains, checked in **both** the
primary-tree build and the independently produced fresh-worktree build at final HEAD:

```
$ ls .next/standalone/node_modules/<pkg>          (BUILD_ID Y8FTkWwDAOHlzSbHMICnZ)
$ ls /tmp/audit-wt-final2/.next/standalone/...    (BUILD_ID ru-Ap-qQ5xfFzGqKIfgYn)

  IN ARTIFACT   sharp@0.34.5
  IN ARTIFACT   readdir-glob        (dist/ only — no package.json, no minimatch)
  not traced    pdfjs-dist  nanoid  postcss  brace-expansion  minimatch
  not traced    archiver  deepmerge-ts  @prisma/config  prisma
```

Both builds agree exactly. `pdfjs-dist` is absent from the *server* trace because it
is a **browser** dependency — it ships in the client bundle instead, which was
confirmed rather than assumed:

```
$ grep -l pdfjs .next/static/chunks/*.js      -> .next/static/chunks/3yqk4dqheskwk.js
$ find .next/static -name '*pdf.worker*'      -> .next/static/media/pdf.worker.min.43wid0v0nfx-f.mjs
```

## The nine, one row each

| # | Package | Advisory | Where it actually is | Reachable here? |
|---|---|---|---|---|
| 1 | `pdfjs-dist` 6.1.200 (direct) | GHSA-hq66-cqwq-w95j — arbitrary JS on opening a malicious PDF | **shipped, client bundle** | **No** — both advisory preconditions absent; see below |
| 2 | `sharp` 0.34.5 | GHSA-f88m-g3jw-g9cj — inherited libvips CVEs | **shipped, server artifact** | **No** — transitive under `next` only; no product import (`grep "from 'sharp'"` → none); images are embedded by pdf-lib, and no `images.remotePatterns` is configured, so no attacker-supplied image reaches Next's optimizer |
| 3 | `postcss` ≤8.5.22 | 2 high + 2 moderate — `sourceMappingURL` arbitrary `.map` read | build-time only, nested at `node_modules/next/node_modules/postcss`; **not traced** into the artifact | **No** — a build-time CSS compiler over in-repo CSS. Reaching it requires the attacker to already control the source tree |
| 4 | `nanoid` <3.3.18 | GHSA-2v37-7h3g-55p8 — a *custom* generator loops forever at size 0 | **not traced** into the artifact | **No** — no product call site at all, and the bug needs a custom generator called with size 0 |
| 5 | `brace-expansion` 5.0.8 | GHSA-rgw5-rvv9-x895 — DoS via unbounded intermediate arrays | **not traced**; chain is `archiver → readdir-glob → minimatch → brace-expansion` | **No, twice over** — `lib/server/zip.ts` never calls `.glob()`/`.directory()` (grep across `app`, `components`, `src`, `lib` → none), and in the artifact `readdir-glob` is a partial trace with no `minimatch` beneath it, so the glob path cannot even resolve |
| 6 | `deepmerge-ts` <8.0.0 | GHSA-ggr8-5vv4-36mx — stack exhaustion on recursive object graphs | **not traced**; `prisma → @prisma/config → deepmerge-ts` | **No** — CLI config loading, not a request path. No product import of `@prisma/config`; no `prisma.config.*` file exists; the string inside `@prisma/client/runtime/client.js` is an embedded build manifest, not a `require` |
| 7 | `@prisma/config` | inherits #6 | as #6 | **No** — same chain |
| 8 | `prisma` (peer of `@prisma/client`, present for `migrate deploy`) | inherits #6 | **not traced** into the artifact | **No** — deploy-time CLI |
| 9 | `next` 16.2.12 (direct) | flagged **via** `postcss` and `sharp`, i.e. #2 and #3 | shipped | **No** — the advisory is not in Next's own code; it is the two rows above |

## Why pdfjs-dist — the only one that ships to a browser — is not exploitable here

The advisory has two preconditions. Both were checked against this product rather
than assumed away.

**1. `enableScripting` must be true.** It defaults to false, and the flag is read
only inside pdf.js's annotation layer (`node_modules/pdfjs-dist/build/pdf.mjs`:
every gate sits in `AnnotationElement`/`AnnotationLayer`, and `AnnotationLayer`
reads `params.enableScripting === true` at line 20626). This product never
constructs that layer:

```
$ grep -rn 'AnnotationLayer|PDFScriptingManager|enableScripting' app components src lib hooks
none
```

The whole pdfjs import surface is the core API — one runtime `import("pdfjs-dist")`
in [lib/pdf/render.ts](lib/pdf/render.ts), plus `import type` in five files. No
`web/pdf_viewer`. The shipped client chunk confirms the consequence:

```
enableScripting        13 occurrences   (dead flag reads inside the annotation code)
AnnotationLayer         9 occurrences
PDFScriptingManager     0 occurrences   ← the sandbox driver is not even bundled
```

**2. There must be no `script-src` CSP.** Measured on the running artifact
(`web-security-headers.log`):

```
script-src 'nonce-<per-request>' 'strict-dynamic'
```

No `unsafe-eval`, no `unsafe-inline`, no wildcard. A nonce the page did not mint
cannot be guessed by a PDF.

**Classification: real advisory, not exploitable in this product as configured.**
Recorded as a **P2**, not a launch blocker, and it keeps its own row in §35.

## Remediations, named and not performed

| Package | Fix npm offers | Note |
|---|---|---|
| `pdfjs-dist` | ≥ 6.2.108; **6.3.289** available, **not** semver-major | the one worth doing first — it is the only advisory that reaches a browser |
| `next` (→ fixes `postcss` + `sharp`) | **16.3.4**, not semver-major | one bump clears three of the nine rows |
| `brace-expansion`, `nanoid` | fix available in place | transitive; a lockfile-only bump |
| `prisma`/`@prisma/config`/`deepmerge-ts` | npm proposes **prisma 6.12.0 — a semver-major *downgrade*** | do not take npm's suggestion; wait for a forward fix |

No upgrade was applied in this audit. `npm audit fix --force` on this tree would
downgrade Prisma by a major version to "fix" a CLI-only stack-exhaustion bug.

## Secrets, at the same HEAD

```
$ git ls-files | grep -E '\.env|\.pem$|\.key$|id_rsa|\.p12$'      -> .env.example only
$ git ls-files | grep -E '\.(db|sqlite|sqlite3)$'                  -> none tracked
$ grep -n 'env|\.db|data/' .gitignore   -> .env* (with !.env.example), /.storage,
                                            *.db, *.db-journal, *.sqlite, *.sqlite3
```

A pattern sweep for live-credential shapes (`sk_live_…`, `AKIA…`, `ghp_…`,
`-----BEGIN … PRIVATE KEY-----`) across **every tracked file** matches six files,
and all six are negative tests — the canaries assert that a secret does *not* leak:

```
scripts/csp-probe.mjs:175        CANARY_SECRET = "sk_live_…_MUST_NOT_APPEAR"
lib/security/cspReport.test.ts   asserts a report URL is sanitized
app/api/cspReportRoute.test.ts   expect(logged[0]).not.toContain("sk_live_…")
instrumentation.test.ts          "whsec_leakme" must not appear in the boot summary
stripeProbeSecretHygiene.test.ts the redaction fixture A3 pins by sha256
src/infrastructure/config/env.test.ts  the gate's own refusal cases
```

That is what harness rows **A3/A4** mean by `MANUAL REVIEW REQUIRED`: 1613
historical blobs were scanned, two matches, both confined to the one
path-acknowledged redaction fixture whose current bytes A3 pins by hash. Reviewed
by hand here, and confirmed: **no live secret is committed, in the tree or in
history.** Values are not reproduced in this file.

The boot gate (`src/infrastructure/config/env.ts:274-300`) refuses production
start on: `ADMIN_SECRET` unset; `ADMIN_SECRET` equal to the public dev fallback
that ships in this repository; `ADMIN_SECRET` shorter than 16 characters;
`PDFDADI_ALLOW_INSECURE_DEV_SECRET=1`; a short `STORAGE_SIGNING_SECRET`. Its error
text names the variable and never its value — deliberately, per the comment at
`:245`, because that text reaches logs. Harness rows B1–B7 all PASS.
