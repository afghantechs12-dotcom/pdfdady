# Mutation exercise — final code-readiness reconciliation

Ten mutations, named by the brief, applied ONE AT A TIME to a clean tree, each reverted
with Git before the next. For every one: the exact edit, the exact red test and
assertion, and the gate rerunning green after `git checkout --`.

Three of the ten have more than one plausible spelling (8: trailing slash / config /
nested id; 9: schema index / extra read; 10: `no-store` / request id). Each spelling was
applied and reverted separately rather than picking one, so the sub-cases are listed as
8a-8c, 9a-9b, 10a-10b.

Baseline: branch `final-readiness-reconciliation`, tip `77d45b1`, tree clean, static
harness `node scripts/final-prelaunch-audit.mjs` exit 0 with `PRODUCT FAILURE 0`.

---

## 1 — Remove retained failure output from the test runner

**Edit** `scripts/suite-evidence.mjs`: `const failures = report ? failuresFrom(report) : [];`
→ `const failures = [];`

**RED** `finalReconciliation.test.ts > R4 — a failing run leaves evidence that names what
failed > retains the test name, file, seed, worker count, timing and stack trace, and
still exits nonzero`

```
AssertionError: expected [] to have a length of 1 but got +0
 ❯ finalReconciliation.test.ts:248:32
   248|       expect(summary.failures).toHaveLength(1);
```

**Note.** The sibling test `attributes a real failure to the product, and never to the
environment` stayed GREEN, because it reads a committed artifact from before the
mutation. Retained evidence cannot detect a change to the harness that produced it; the
live pin is the spawning test above. Recorded because a reader could otherwise assume
the artifact check covers this.

**Reverted** → `Tests 6 passed | 12 skipped (18)`.

## 2 — Reclassify a high advisory without reachability evidence

**Edit** `docs/evidence/final-prelaunch/dependency-advisories.json`, advisory 1124066
(`sharp`, **high**): `"productionReachable": true` → `false`.

**RED** `finalReconciliation.test.ts > R2 — dev-only and production-reachable are told
apart by the real production graph > re-derives each production-reachable claim from the
audit graph and the lockfile's dev flags`

```
AssertionError: 1124066 sharp: expected false to be true // Object.is equality
 ❯ finalReconciliation.test.ts:144:81
```

The claim is re-derived from `audit-baseline-prod.json` and the lockfile's `dev` flags,
so writing a different answer beside the data contradicts the data.

**Reverted** → `Tests 2 passed | 16 skipped (18)`.

## 3 — Restore a vulnerable dependency version

**Edit** `package-lock.json`, `node_modules/next/node_modules/postcss`: `8.5.23` → `8.4.31`
(inside advisory 1117015's `<8.5.10` window and 1124252's `<=8.5.11`).

**RED, two assertions in two tests** — `finalReconciliation.test.ts > R3 — every
remediated advisory has an installed version outside its vulnerable range`:

```
AssertionError: 1117015: node_modules/next/node_modules/postcss is 8.4.31, inside <8.5.10:
  expected true to be false
 ❯ finalReconciliation.test.ts:186:11        (> leaves no copy of any flagged package inside the advisory's window)

AssertionError: postcss 8.4.31 is installed but unrecorded:
  expected '8.5.28 (dev) / 8.5.23 (production, ne…' to contain '8.4.31'
 ❯ finalReconciliation.test.ts:209:102       (> records the versions the lockfile actually installs today)
```

**Reverted** → `Tests 3 passed | 15 skipped (18)`.

## 4 — Let process B receive a fresh bucket after process A exhausts it

**Edit** `lib/server/uploadRateLimit.ts`: both global-bucket calls rekeyed from the
literal `"global"` to `` `global:${process.pid}` ``.

**RED** `lib/server/uploadRateLimit.test.ts > checkUploadLimit — whose budget is spent >
keys the ceiling on a constant, so no second process could mint a fresh one`

```
AssertionError: both global-bucket calls must pass the literal "global":
  expected [] to have a length of 2 but got +0
 ❯ lib/server/uploadRateLimit.test.ts:192:87
```

The other nine tests in that file stayed green, which is the point: one process cannot
observe its own pid changing, so no behavioural assertion in a single-process test can
see this. The pin is the key, and the second process is refused separately by mutation 5.

**Harness improvement kept.** The assertion first failed as `AssertionError: Target
cannot be null or undefined` — a null `String.match` result, naming neither the file nor
the key. `?? []` plus two assertion messages replaced it. Kept, not reverted: it is a
fix to legibility, not part of the mutation.

**Reverted** → `Tests 10 passed (10)`.

## 5 — Allow an unsupported multi-worker configuration to boot

**Edit** `src/infrastructure/config/env.ts`: `if (e.DEPLOYMENT_TOPOLOGY !==
"single-instance") {` → `if (false) {`.

**RED in two independent gates.** `deploymentTopology.test.ts`, five tests:

```
expected '' to contain 'DEPLOYMENT_TOPOLOGY'                          deploymentTopology.test.ts:90:17
expected '' to match /UPLOAD_RATE_LIMIT_PER_MIN=60/                   deploymentTopology.test.ts:104:17
expected 'Refusing to start: 3 production confi…' to contain 'DEPLOYMENT_TOPOLOGY'
                                                                      deploymentTopology.test.ts:137:17
expected [] to have a length of 1 but got +0                          deploymentTopology.test.ts:161:22
expected '' to contain 'docs/adr/ADR-M7-009-sqlite-operations…'       deploymentTopology.test.ts:202:25
```

and the static harness, which went to exit 1:

```
✗ B1 a production start with none of the four required values is refused, and names all four
     — named only DATABASE_URL, ADMIN_SECRET, NEXT_PUBLIC_SITE_URL
```

`instrumentation.test.ts` stayed green: its misconfiguration test names three variables
and does not count them, so it does not own this. Recorded rather than left implied.

**Reverted** → `Tests 19 passed (19)` across both files.

## 6 — Restore upload paths to the body-buffering matcher

**Edit** `proxy.ts`: the matcher's exclusion group deleted, leaving
`"/((?!_next/static|_next/image|.*\\.[^/]*$).*)"` — the shape at `f6f0fa8`'s parent.

**RED** `proxyMatcherParity.test.ts`, seven tests across R9 and R10:

```
expected '^(?:\/(_next\/data\/[^/]{1,}))?(?:\/(…' to contain 'workspaces\/[^/]+\/documents\/'
/api/jobs should be excluded: expected true to be false
expected [ '/api/jobs', …(4) ] to deeply equal []
/api/jobs with a query stays excluded: expected true to be false
/api/jobs excluded: expected true to be false
/api/workspaces/cku1abc/documents/cku2def/versions/upload matched=false: expected true to be false
case: expected true to be false
```

**Reverted** → `Tests 18 passed (18)`.

## 7 — Remove one security responsibility from an excluded upload route

**Edit** `lib/server/workspaceUploadGate.ts`: the first two lines of the gate deleted —
`const csrf = requireSameOrigin(request); if (csrf) return { response: refuse(csrf) };`

**RED in both directions — behaviour and structure.** `uploadBoundary.test.ts`, seven
tests: a foreign-origin upload is **accepted**.

```
AssertionError: expected 201 to be 403          uploadBoundary.test.ts:457:29   (S3 attachments)
AssertionError: expected 201 to be 403          uploadBoundary.test.ts:473:29   (S3 documents/upload)
AssertionError: expected 201 to be 403                                          (S3 versions/upload)
AssertionError: expected 201 to be 403                                          (S3 no origin at all)
AssertionError: expected 201 to be 403          uploadBoundary.test.ts:1384:37  (S18 foreign origin)
AssertionError: expected 201 to be 403                                          (S18 no origin evidence)
AssertionError: foreign origin: expected 2 to be +0
                                                uploadBoundary.test.ts:1413:56  (S18 read the body)
```

and `proxyMatcherParity.test.ts > R11 > CSRF, authentication, rate limiting and tracing
each live in the handler`:

```
AssertionError: expected '/**\n * THE upload boundary for the p…' to contain 'requireSameOrigin(request)'
 ❯ proxyMatcherParity.test.ts:389:44
```

The last row is the sharpest: with CSRF gone the foreign-origin request reaches
`readMultipart` and buffers 2 chunks, so the matcher exclusion would have turned a
pre-parse refusal into a parsed upload. That is the exact hazard §5 asks about.

**Reverted** → `Tests 86 passed (86)`.

## 8 — Add a trailing-slash or encoded-path matcher bypass

Three spellings, applied and reverted individually.

### 8a — trailing slash tolerated inside the exclusion

**Edit** `proxy.ts`: `attachments)))$|` → `attachments)))/?$|`, so `/api/jobs/` and the
other four trailing-slash forms leave the matcher too.

**RED** `proxyMatcherParity.test.ts > R10 — boundary spellings of the five excluded paths
> trailing slash: matched, but redirected before middleware ever runs`

```
AssertionError: /api/jobs/ is matched: expected false to be true
 ❯ proxyMatcherParity.test.ts:243:65
   243|       expect(runtimeMatches(`${path}/`), `${path}/ is matched`).toBe(true);
```

### 8b — the config that turns the safe disposition into a live one

**Edit** `next.config.mjs`: `skipTrailingSlashRedirect: true` added.

R10's disposition for the trailing-slash spelling is "matched, but Next's internal 308
runs before middleware". That holds only while this key is unset, so the key is what a
bypass would actually need.

**RED** same test:

```
AssertionError: expected undefined to match object { destination: '/:path+', …(3) }
 ❯ proxyMatcherParity.test.ts:252:19
```

### 8c — an id segment allowed to swallow slashes (nested-identifier bypass)

**Edit** `proxy.ts`: `workspaces/[^/]+/documents/(?:upload|[^/]+/` →
`workspaces/.+/documents/(?:upload|.+/`.

**RED** two tests:

```
expected '^(?:\/(_next\/data\/[^/]{1,}))?(?:\/(…' to contain 'workspaces\/[^/]+\/documents\/'
 ❯ proxyMatcherParity.test.ts:157:22    (R9 > is not the source string …)
/api/workspaces/cku1abc/extra/documents/upload matched=true: expected false to be true
 ❯ proxyMatcherParity.test.ts:315:66    (R10 > nested ids: an id segment cannot swallow a slash)
```

**Reverted** after each → `Tests 46 passed (46)` over `proxyMatcherParity.test.ts` +
`proxy.test.ts`.

### Defect found by 8a, fixed, not a mutation

8a's first red named `proxyMatcherParity.test.ts:141`, a **comment line**. Diagnosed by
inserting a probe assertion at a known line: source 128 was reported as 77, and the drift
grew with position — the position in the transformed module, i.e. no source map applied.
Bisected across the file's six `next/dist/**` imports: exactly one,
`next/dist/build/analysis/get-page-static-info.js`, **replaces
`Error.prepareStackTrace`** when it loads, and that hook is where vitest's remapper
lives. `uploadBoundary.test.ts` and `finalReconciliation.test.ts` probed correct; only
this file imports that module.

The module is not replaceable — `getMiddlewareMatchers` is Next's real build-time
compiler and using it is the point of R9 — so it is now loaded with `await import()`
between a save and a restore of the hook. Frames verified correct afterwards (243, 252,
157, 315 above all land on their assertions). R4's promise that "a stack frame is what
makes it reproducible" was false for this one file until now.

## 9 — Let random invalid cookies trigger unlimited session-store lookups

### 9a — the index removed

**Edit** `prisma/schema.prisma`: `token String @unique` → `token String`, which makes the
per-request session lookup a full table scan: work that grows with the sessions table on
every random cookie.

**RED** `authLookupCost.test.ts > R13 — the lookup is indexed, so the cost does not grow
with the table > SQLite searches the unique token index and never scans sessions`

```
AssertionError: expected '// PDFDadi data model — provider-agno…' to match /token\s+String\s+@unique/
 ❯ authLookupCost.test.ts:156:58
```

**The SCAN assertion is not vacuous, proven without touching the database.** Same table,
same `EXPLAIN QUERY PLAN`, one indexed column and one not:

```
SELECT id FROM sessions WHERE token = ?      -> SEARCH sessions USING INDEX sessions_token_key (token=?)
SELECT id FROM sessions WHERE expiresAt = ?  -> SCAN sessions
```

So `not.toMatch(/SCAN/)` discriminates. The schema assertion is what fails first for a
mutation, because `EXPLAIN` reads the database file rather than the schema.

### 9b — a second lookup before the limiter

**Edit** `src/application/services/AuthService.ts`, `getMe`: `if (!session) return null;`
→ `if (!session) return this.users.getByEmail(token);` — an unbounded `users` read keyed
by the attacker-supplied cookie, ahead of `checkUploadLimit`.

**RED** `authLookupCost.test.ts`, two tests:

```
AssertionError: expected [ …(2) ] to have a length of 1 but got 2
 ❯ authLookupCost.test.ts:115:59   (R12 > a cookie that cannot be a session still costs one lookup)
AssertionError: expected [ …(2) ] to have a length of 1 but got 2
 ❯ authLookupCost.test.ts:130:57   (R12 > an expired session costs the same one lookup and no user read)
```

**Reverted** after each → `Tests 6 passed (6)`.

## 10 — Remove `no-store` or request identification from one refusal path

### 10a — `no-store`

**Edit** `lib/server/workspaceUploadGate.ts`, in `refuse()`:
`response.headers.set("Cache-Control", "no-store");` deleted.

**RED** `uploadBoundary.test.ts`, **25 tests** — S3, S4, S5, S6, S8, S10 and every S18
matrix row:

```
AssertionError: expected null to be 'no-store'
 ❯ uploadBoundary.test.ts:462:51, :497:51, :538:58, :615:53, :680:59, … (25 in total)
```

One shared `refuse()` is why one deletion is 25 reds: the rule has no per-status
exception to slip through.

### 10b — request identification

**Edit** `src/application/services/workspaceHttp.ts`, `requestId()`:
`request.headers.get("x-request-id")?.slice(0, 128) || randomUUID()` → `randomUUID()`,
severing the inbound correlation id so a refusal cannot be tied to the caller's trace.

**RED** `proxyMatcherParity.test.ts`, two tests:

```
AssertionError: expected 'import { randomUUID } from "node:cryp…' to contain 'request.headers.get("x-request-id")'
 ❯ proxyMatcherParity.test.ts:613:79   (R11 > CSRF, authentication, rate limiting and tracing …)

AssertionError: expected [ Array(1) ] to include 'src/application/services/workspaceHtt…'
 ❯ proxyMatcherParity.test.ts:578:42   (R11 > the unstripped inbound CSP request headers are read by nothing)
```

The second is the anti-vacuity control of a different test firing as designed: that test
proves nothing reads the inbound CSP headers, and its control is that the same helper
DOES find the one header this tree reads. Remove the read and the control fails, which is
what stops "nobody reads it" from meaning "the search was broken".

**Reverted** after each → `Tests 86 passed (86)`.

---

## Summary

| # | Mutation | Owning gate | Red tests |
|---|---|---|---|
| 1 | failure output dropped | R4 | 1 |
| 2 | high advisory reclassified | R2 | 1 |
| 3 | vulnerable version restored | R3 | 2 |
| 4 | per-pid global bucket | uploadRateLimit | 1 |
| 5 | topology gate disabled | R6/R8 + harness B1 | 5 + 1 |
| 6 | matcher exclusion removed | R9/R10 | 7 |
| 7 | CSRF removed from the gate | S3/S18 + R11 | 8 |
| 8a/8b/8c | matcher bypasses | R9/R10 | 1 / 1 / 2 |
| 9a/9b | scan lookup / extra read | R13 / R12 | 1 / 2 |
| 10a/10b | `no-store` / request id | S-series / R11 | 25 / 2 |

Every mutation was reverted with `git checkout --` and its gate reran green. Two edits
were kept deliberately, both improvements the exercise exposed and neither part of any
mutation: the legible assertion message in `lib/server/uploadRateLimit.test.ts` (from 4)
and the `Error.prepareStackTrace` save/restore in `proxyMatcherParity.test.ts` (from 8a).
