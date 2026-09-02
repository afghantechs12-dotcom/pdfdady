# Milestone 7.11 checkpoint — document statistics and version comparison

Status: **complete**. Date: 2026-08-04.

## What was repaired and replaced

The phase was left partially written by the previous session. Three defects were
found and fixed, all of them real:

1. **`StatisticsService.ts` did not compile.** Four SHA-256 domain separators
   referenced an identifier `SEPARATOR` that was never defined — the residue of a
   previous session replacing raw NUL bytes without declaring their replacement.
   This produced all 12 remaining repository-wide TypeScript errors. Fixed by
   defining `HASH_SEPARATOR = String.fromCharCode(0)`, which keeps the source
   plain UTF-8 text and never writes a raw NUL byte into the file. Verified: raw
   NUL byte count in the file is **0**.

2. **`StatisticsService.test.ts` was fabricated.** It asserted against
   `generateDocumentStatistics`, `getDocumentStatistics`, `getComparisonResults`,
   `updateComparisonProgress`, `validateStatistics` and `validateComparison` —
   none of which exist on the service — and constructed it with 2 of its 7
   arguments. It has been replaced entirely.

3. **The DI registration was fabricated.** `StatisticsService` was registered
   with 2 of 7 dependencies, and the three M7.11 repository tokens did not exist.

## Security defect found and fixed during implementation

The HTTP recalculation route initially accepted the measured content
(`segments`, `imageCount`, `bookmarkCount`, …) from the request body, mirroring
the service's `calculateStatistics(source)` signature.

That is a real vulnerability, not a style problem. Statistics are stored as fact
in a durable row that **every member of the Workspace reads**, and a fabricated
count is indistinguishable from a measured one afterwards. Any member with write
access could have recorded arbitrary numbers — "this contract has 2 pages" — as
server-blessed measurement.

The fix follows the precedent M7.8 already set for reindexing: no route accepts
extracted content. `recalculateFromServerContent` now assembles the source
server-side from data the server already derived — M7.8 search chunks for text
and page numbers, M7.9 bookmark and attachment counts, and the version manifest
for page count and byte size. **A client may ask for a recalculation; it cannot
answer it.** `calculateStatistics` remains for trusted callers and is documented
as such.

Image and annotation counts stay `null` from this path: no server-side extractor
records them yet, and reporting `0` would claim a document has none when nothing
ever looked.

## Domain

`src/domain/entities/DocumentStatistics.ts` (+ 60 tests, unchanged this session
and re-verified).

Three properties the module holds:

1. **Every count is measured, and `null` ≠ `0`.** A field that was not measured
   is `null`; `0` means measured and none found. Collapsing the two would let a
   document nobody scanned for images report confidently that it has none. This
   distinction is preserved through the repository, the serializer and the UI —
   each layer has a test pinning it.
2. **Comparison state is a bounded one-way machine.** `pending → running →
   completed | failed | cancelled`, terminal states unwritable. `cancelled` has
   no outgoing edges, so a cancelled operation can never report completion.
3. **Unsupported is a real answer.** `COMPARISON_SUPPORT` marks `visual` as
   unavailable — there is no rasteriser in this build — and it is refused with an
   explanation rather than completing with an empty diff that would read as
   "these pages are identical".

## Persistence

Migration (additive, applied, **unmodified**):
`20260803233259_add_statistics_and_comparisons`

Migration count remains **17**. No corrective migration was required.

Adapters, each with a row-backed fake-Prisma test suite whose matcher applies
*only* the predicates the adapter actually supplies — so a dropped `workspaceId`
predicate makes the cross-tenant tests fail rather than pass on the fake's
goodwill:

| Adapter | Tests |
| --- | --- |
| `PrismaDocumentStatisticsRepository` | 15 |
| `PrismaComparisonOperationRepository` | 16 |
| `PrismaComparisonResultRepository` | 13 |

Key invariants under test: one statistics row per version (upsert converges,
revision increments, `createdAt` preserved); compare-and-swap on *status* rather
than on a revision counter, so a duplicate worker delivery finds the state
already moved; one result per operation, so a redelivered completion converges
instead of writing a second artifact; tolerant degradation of unknown statuses,
unknown types and malformed JSON.

## Service

`src/application/services/StatisticsService.ts` (+ 64 tests).

27 statistics tests and 30 comparison tests as specified, plus 7 for the trusted
`recalculateFromServerContent` path added when the security defect above was
fixed. Notable behaviours pinned:

- An unchanged recalculation does not move `calculatedAt` or bump the revision.
- A failed extraction persists `status: "failed"` with a bounded reason, rather
  than zeroes — a broken extractor stays distinguishable from an empty document.
- Cancellation is observed *before* a result is written, so "cancel" does not
  mean "cancel, unless it happened to finish first".
- Retry creates a **new** operation; the original terminal state is never
  rewritten, which keeps a failure an honest historical fact.
- A worker submitting versions that do not match the operation fails safely
  rather than filing a result against the wrong pair.

## DI

Tokens added: `DocumentStatisticsRepository`, `ComparisonOperationRepository`,
`ComparisonResultRepository` (`StatisticsService` already existed).

`container.test.ts`: 53 → **62** tests. Because the service takes three
same-shaped repositories in a row, a mis-ordered registration would still resolve
and still type-check — so the suite drives real calculations and comparisons
through the resolved service and reads back from the container's own
repositories, and one test asserts directly that the wrong order **fails**.

## HTTP and API

`src/application/services/statisticsHttp.ts` (+ 20 tests).

Serializers omit `organizationId` and the internal `checksum`, bound every error
message and excerpt on the way out, and report `hasResult` rather than handing
out the internal result id. Differences are re-bounded at the serializer even
though the repository bounds them on write, and `truncated` stays honest when the
list is capped.

Routes (all `getWorkspaceActor` + DI; every mutation calls `requireSameOrigin`
first; all errors mapped through `mapWorkspaceError`, never a stack trace):

- `GET|POST /api/workspaces/[workspaceId]/documents/[documentId]/statistics`
- `GET|POST …/documents/[documentId]/comparisons`
- `GET …/comparisons/[comparisonId]`
- `POST …/comparisons/[comparisonId]/cancel`
- `POST …/comparisons/[comparisonId]/retry`
- `GET …/comparisons/[comparisonId]/result`

**Deviation from the suggested route table, deliberate.** The plan suggested
`/versions/[versionId]/statistics`. Next.js permits only one slug name per path
segment and that segment is already `[versionNumber]`, so the nested form is not
buildable. Statistics are therefore addressed at document level with `versionId`
as a parameter, which also matches how the listing reads.

## UI

- `components/workspaces/statisticsLogic.ts` (+ 27 tests)
- `components/workspaces/StatisticsPanel.tsx`
- Mounted in `app/workspaces/[workspaceId]/page.tsx`, gated on a selected
  document (`?documentId=`), with the version list loaded server-side through the
  authorized `VersionService`.

Panel behaviour worth recording:

- An unmeasured count renders as "Not measured" in italic grey, never as `0`.
- A completed comparison shows its result **only when a result actually exists**
  (`canShowResult` requires both). A completed status with no result row — a
  state an interrupted worker can produce — displays an explicit "finished, but
  no result is available" note rather than an empty diff.
- Visual comparison appears in the type list, disabled, labelled
  "(unavailable)", with the domain's reason shown as soon as it is selected.
- Cancellation shows "Cancelling…" while work continues, never "Cancelled"
  before the worker has observed it.
- No `alert()` anywhere; errors render in place with `role="alert"` and a polite
  live region. Progress bars carry `role="progressbar"` with
  `aria-valuenow/min/max` and an accessible label built by the same function that
  produces the visible status, so the two cannot disagree.
- Excerpts render as React text nodes; no `dangerouslySetInnerHTML`.

## Gate results

M7.11 focused gate — **277 passed across 8 files**:

| File | Tests |
| --- | --- |
| `DocumentStatistics.test.ts` | 60 |
| `StatisticsService.test.ts` | 64 |
| `PrismaDocumentStatisticsRepository.test.ts` | 15 |
| `PrismaComparisonOperationRepository.test.ts` | 16 |
| `PrismaComparisonResultRepository.test.ts` | 13 |
| `container.test.ts` | 62 |
| `statisticsHttp.test.ts` | 20 |
| `statisticsLogic.test.ts` | 27 |

Repository-wide:

- `npx prisma format` — clean
- `npx prisma validate` — schema valid
- `npx prisma migrate status` — 17 migrations, database schema up to date
- `npm run typecheck` — **exit 0, 0 errors** (was 12 at session start)
- `npm run lint` — **exit 0, 0 errors, 0 warnings** (was 0 errors / 6 warnings;
  the 4 remaining M7.9 unused-import warnings were repaired here)
- `npm run test` — **137 files, 2506 tests, exit 0** (was 131 / 2291)

## Known limitations

- Image and annotation counts are `null` from the server-content path until an
  extractor records them. Honest by construction rather than zero-filled.
- Visual comparison remains unsupported; `COMPARISON_SUPPORT` flips when a
  rasteriser lands and no other code encodes the assumption.
- The comparison worker surface (`startComparison` / `reportComparisonProgress` /
  `completeComparison`) is implemented and tested but is not yet driven by the
  M2 queue; operations are created and observed through the API. Wiring it to the
  queue is M7.15/M7.16 integration work, not a defect in this phase.
