# Milestone 7.15 Checkpoint — Security, accessibility, mobile and performance hardening

**Status:** Complete. **Date:** 2026-08-04.

M7.15 was implementation and testing, not documentation. Three real defects were
found and fixed, and two routes gained a missing control.

## Defects found and repaired

### 1. Resource exhaustion in the statistics text bound (medium, fixed)

`src/domain/entities/DocumentStatistics.ts` enforced the 50 M code-point text
limit *after* materializing each segment into an array
(`characters += [...segment.text].length`). An oversized segment therefore
allocated an array proportional to its entire length on the way to being
rejected — the bound could be made to consume the memory it existed to protect.

Surfaced as a real symptom: `StatisticsService.test.ts > rejects text beyond the
measurable limit` timed out at 5 s under memory pressure, and the full suite
died with `JavaScript heap out of memory`.

Fixed by checking the cheap UTF-16 `length` first (it never under-counts code
points, so anything within the limit by that measure is certainly within it
exactly) and falling back to `countCodePointsUpTo`, which stops counting the
moment the cap is passed. Rejection now precedes `countWords`, so no work is done
on a string that will be refused. All 124 M7.11 statistics tests still pass and
the timeout is gone.

### 2. Empty disabled reason produced no announceable text (low, fixed)

`disabledReasonText` used `??`, which catches only `null`. A command carrying
`disabledReason: ""` produced an empty string — a greyed-out row with nothing for
a screen reader to announce, which reads as broken. Now trimmed and falls back to
the generic reason.

### 3. Mutable dates escaped the operation center (medium, fixed in M7.14)

Recorded here for completeness; see the M7.14 checkpoint. Shallow copies shared
`Date` instances, so a caller could write into stored state through a returned
"read-only" copy.

### 4. Two POST-shaped reads lacked origin evidence (low, fixed)

`POST /api/workspaces/[workspaceId]/search` and
`.../smart-collections/preview` carry their query in the body because it is too
large for a URL. Neither writes, so neither was a CSRF target in the strict
sense — but both disclose which documents exist, and that is worth protecting
from a hostile origin. Both now call `requireSameOrigin`. Every M7 mutation route
was audited: **all 50 state-changing handlers now enforce it.**

### 5. Two blocking `alert()` calls remained in the editor (low, fixed)

The M7.14 plan lists "migration from blocking M7 alerts" as in scope.
`components/editor/EditorWorkspace.tsx` still used `alert()` for export and
PDF-open failures. A blocking dialog steals focus from the canvas, cannot be read
back in context, and must be dismissed before the user can look at what failed.
Replaced with a dismissible in-place `role="alert"` banner. **No production
`alert()` call remains** in `components/` or `app/`.

## Security suite — `src/application/services/m7Hardening.test.ts` (44 tests)

Real services (`CommentService`, `TagService`, `OperationCenterService`,
`CommandPaletteService`) against real in-memory adapters. The Workspace double
applies the M7 access decision algorithm including lifecycle-before-membership
precedence; a double that simply allowed would prove nothing.

**Cross-tenant isolation and IDOR (10 tests).** Foreign Workspace, foreign
document within the same organization, foreign document across organizations,
foreign comment thread, foreign comment message (edit and delete), foreign
operation (read, cancel, retry, result), foreign tag assignment, foreign smart
collection, and command execution against a foreign document. Each reads as
missing, never as forbidden.

One test is the load-bearing one: **a real-but-inaccessible id and a fabricated
id produce byte-identical error messages.** A difference there is an existence
oracle regardless of what else is correct.

**Permission lifecycle (10 tests).** Viewer writes refused across every surface;
viewer permitted a read-only command; workspace lifecycle denial beating an
owner's role; grant expiry reached by advancing an injected clock (not by
asserting a rejected past date); revocation ending conferral; repeated revocation
converging; a grantee unable to re-share; self-grant refused; foreign grant id
unrevokable through an owned document; and a tampered client's displayed
`enabled: true` failing at execution anyway.

**Input bounds and content safety (10 tests).** Comment markup stored verbatim
as text (the defence is that it is never treated as markup, not that characters
are stripped); six malformed anchor shapes; oversized and empty bodies; oversized
operation label; bounded operation error; oversized command query returning
nothing; malformed command ids; five malformed smart-collection queries including
a private-field probe; tag name bounds.

**Idempotency (5 tests).** Repeated tag assignment converging to one row;
repeated removal; duplicate operation transition refused rather than replayed;
duplicate terminal event unable to resurrect a completed operation; thread
resolve where the second delivery carries a stale revision and is refused.

**Leakage (5 tests).** Foreign operations absent from a listing rather than
filtered client-side; foreign tags and threads not disclosed; internal
`resultRef` reachable only through a re-authorized call; unregistered command
indistinguishable from an unauthorized one.

**Bounded resources (3 tests).** Operation history ≤ 100 per process; command
results ≤ 50; comment listing capped at 100 despite a requested 1000.

## Accessibility and responsive suite — `components/workspaces/m7Accessibility.test.ts` (17 tests)

Five operation states producing five distinct spoken strings; the operation named
in its own status text; terminal-only announcements rather than per-tick;
"Not measured" kept distinct from zero and pending kept distinct from failed;
every disabled command guaranteed a reason; determinate progress only when there
is real progress; progress within its declared range; every row including
disabled ones reachable by keyboard; Escape closing from any index;
`aria-activedescendant` always pointing at a row that exists; controls offered
only when they apply so focus never lands on a dead button; single-pane fallback
below 768 px showing the *active* pane rather than always the left one.

### Verification labelling

| Area | Evidence level |
| --- | --- |
| Command/operation logic, keyboard resolution, status text, bounds | **automated** (Vitest) |
| Authorization, IDOR, CSRF, idempotency, leakage | **automated** (Vitest) |
| Dialog focus containment / focus return | **automated** — `lib/a11y/focusTrap.test.ts` (7 tests) covers the shared primitive both new dialogs use |
| Responsive breakpoint rules | **automated** (logic-level) |
| Rendered DOM, live-region timing, visible focus rings | **unverified** — no DOM test environment is configured; the suite is `environment: "node"` |
| Screen reader | **unverified** — not performed |
| Physical device | **unverified** — not performed |

Nothing above is recorded as screen-reader or physical-device verified, because
neither was performed.

## Performance and SQLite — verified from code and configuration

| Item | Finding | Evidence |
| --- | --- | --- |
| No object streaming or PDF processing inside a DB transaction | **Confirmed.** All four `$transaction` call sites (`WorkspaceService`, `PrismaDocumentVersionRepository`, `PrismaOutlineItemRepository`, `PrismaSearchChunkRepository`) contain only row operations. | grep of each transaction body for storage/stream/pdf calls — no matches |
| Bounded pagination | **Confirmed.** Every list surface clamps through a domain helper: `COLLABORATION_LIMITS.maxListLimit` 100, `METADATA_LIMITS.maxListLimit` 200, `COMMAND_LIMITS.maxResults` 50, `maxOperationHistory` 100, autosave drafts per document. | `Math.min(Math.trunc(limit), …)` in each entity |
| Bounded operation history | **Confirmed**, 100 per Workspace, active work never evicted | `OperationCenterService.test.ts`, hardening suite |
| Indexes support actual predicates | 91 `@@index` declarations across 35 models, including the M7.10 `(documentId, pageNumber)` thread anchor index added specifically for the page filter | `prisma/schema.prisma` |
| WAL / busy timeout | **Not configured in code.** ADR-M7-009 states WAL is enabled "only where runtime/storage support is verified" and that the numeric busy timeout "must be measured, not guessed" — it remains unmeasured and unclaimed. Carried as debt, not represented as done. | grep for `journal_mode`/`busy_timeout`/`PRAGMA` — no matches |
| One writable deployment per local DB | Architectural constraint from ADR-M7-009, unchanged | ADR-M7-009 |
| Measured latency/throughput numbers | **Not claimed.** The ADR benchmark remains unmeasured; no numeric performance figure is asserted anywhere in M7 documentation. | — |

### Environment note

The full suite exhausted the default heap during this phase. Root cause was
defect 1 above, now fixed. Contributing factor: ~2.0 GB of 15.8 GB physical
memory was free, with 10 Node processes belonging to an **unrelated repository**
(`modelgate`) resident. Those were left untouched. The suite completes cleanly
with `--pool=forks --poolOptions.forks.maxForks=4`, which is the bounded-writer
posture ADR-M7-009 asks for anyway.

## Gate results

| Gate | Result |
| --- | --- |
| Test files | **147** (140 at M7.13, 145 at M7.14) |
| Tests | **2824** (2602 at M7.13, 2763 at M7.14) |
| Failures | **0** |
| `npm run typecheck` | **0 errors** |
| `npm run lint` | **0 errors, 0 warnings** |
| Migrations | **17** (unchanged — no schema need arose) |

New in M7.15: `m7Hardening.test.ts` (44), `m7Accessibility.test.ts` (17).

## Carried debt

- SQLite WAL, busy timeout, and the ADR-M7-009 contention benchmark remain
  unmeasured and explicitly unclaimed.
- No DOM test environment, so rendered-output accessibility is asserted at the
  logic layer only.
- Screen-reader and physical-device verification not performed.
