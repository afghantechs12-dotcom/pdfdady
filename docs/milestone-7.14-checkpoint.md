# Milestone 7.14 Checkpoint — Command palette and operation center

**Status:** Complete. **Date:** 2026-08-04.

## Scope delivered

A canonical command palette and an operation center, both mounted on the
workspace page.

### Recovery note

The previous session ended with an HTTP 502 immediately after writing
`CommandPaletteService.test.ts`. All five files written before the failure were
inspected on disk and found complete and syntactically intact — no truncation,
no malformed spreads, no placeholder markers. `npm run typecheck` returned 0
errors and the two existing suites passed (42 + 20). No file was rewritten
blindly; work resumed from the verified disk state.

### Domain (`src/domain/entities/CommandPalette.ts`, pre-existing, 42 tests)

Bounded command descriptors, categories, keywords, shortcuts, contextual
requirements, enabled state and disabled reasons; deterministic local ranking
(exact → label prefix → word prefix → keyword prefix → substring → keyword
substring → subsequence); bounded query length and result count; wrapping
keyboard selection; operation statuses with a terminal-final transition table;
progress and error bounds; operation ordering; bounded history.

### Canonical registry (`src/domain/entities/canonicalCommands.ts`, new)

21 commands, each mapping to an implemented M7 feature: document save/save-as/
properties/statistics/versions/compare, comments and sharing, split and single
view, pane focus, back/forward/go-to-page, search, upload, file manager, tags,
operation center, and the palette itself. No placeholder commands. Registered
once at container creation rather than per page, so the palette holds the same
set on every screen.

### Services

- `CommandPaletteService` (pre-existing, 20 tests) — registry, deterministic
  search, per-context evaluation, and an `execute` that re-authorizes against
  the Workspace with the command's declared write flag and resolves the target
  document within the Workspace. An unregistered id is `NotFoundError`, not
  `Forbidden`, so the palette does not confirm which commands exist.
- `OperationCenterService` (34 tests, new suite) — start/running/progress/
  complete/fail/cancel/retry, Workspace-scoped reads, bounded history that never
  evicts active work, and result access gated on both a completed status and a
  real reference.

### Defect found and fixed

`OperationCenterService` returned shallow copies (`{ ...operation }`). `Date` is
mutable, so a caller calling `setFullYear` on a returned `createdAt` wrote into
stored state through what looked like a read-only copy. A `snapshot()` helper
now rebuilds both dates at every exit point (start, transition, progress, list,
get). Pinned by "hands out copies a caller cannot use to reach stored state".

### Architecture decision — in-memory, deliberately

The M7 plan (§M7.14) specifies "persisted operation record **only where existing
Job/activity is insufficient**". Durable work already has durable rows: M7.4
ingestion, M7.11 comparisons, M2 queue jobs. The center therefore presents and
coordinates rather than duplicating that state. No migration was added; the
count remains 17.

The honest limitation: **operation-center state is per-process and does not
survive a restart.** It is not presented as durable anywhere in the UI or the
API. Work that must survive a restart is owned by its durable repository and
read through that feature's own API.

### DI

`Tokens.CommandPaletteService` and `Tokens.OperationCenterService`, registered
with the existing singleton policy. Container tests grew 66 → 75 (+9), covering
resolution, token distinctness, singleton lifecycle, canonical commands
registered exactly once with no duplicate ids, a real search, execution
re-authorization (viewer refused, editor allowed), a real operation start/list,
Workspace scoping, and constructor argument order.

### API

- `GET  /api/workspaces/[workspaceId]/commands` — catalogue for a context.
  `canWrite` is derived from the server-resolved role, never the client's claim.
- `POST /api/workspaces/[workspaceId]/commands` — resolves an allowlisted id to
  an authorized target. Not a general execution endpoint: an unregistered id is
  refused, and the response is the resolved target the client then acts on
  through the feature's own API.
- `GET  /api/workspaces/[workspaceId]/operations`
- `POST /api/workspaces/[workspaceId]/operations/[operationId]/cancel`
- `POST /api/workspaces/[workspaceId]/operations/[operationId]/retry`

All three mutations enforce `requireSameOrigin`. `resultRef` is never serialized.

### UI

- `components/workspaces/commandLogic.ts` + 42 tests — query normalization and
  capping, context construction, fixed-order category grouping, keyboard
  resolution (ArrowUp/Down wrapping, Home/End, Enter, Escape), Enter refused on
  a disabled row, selection reset on a new query, `aria-activedescendant`,
  operation ordering and bounding, control eligibility, announcements, stale
  response suppression, and a merge that never moves a terminal operation
  backwards.
- `components/workspaces/CommandPalette.tsx` — visible trigger and Ctrl/Cmd+K,
  autofocused search, dialog semantics with focus containment and focus return
  (via the existing `Modal`), combobox/listbox roles, grouped results, shortcut
  chips, disabled rows shown with their reason and refusing Enter, errors in a
  live region, no `alert()`, no `dangerouslySetInnerHTML`.
- `components/workspaces/OperationCenter.tsx` — all five states, accessible
  status text, a determinate progressbar only while running, cancel only while
  active, retry only for failed/cancelled, result link only when the server
  reports one, bounded history, active-first ordering, polling only while work
  is active, duplicate-safe merge, motion-safe transitions, responsive layout.

Both are mounted on `app/workspaces/[workspaceId]/page.tsx`.

## Gate results

**Focused (6 files, 227 tests, all passing):**

| Suite | Tests |
| --- | --- |
| `CommandPalette.test.ts` | 42 |
| `CommandPaletteService.test.ts` | 20 |
| `OperationCenterService.test.ts` | 34 |
| `commandHttp.test.ts` | 14 |
| `container.test.ts` | 75 |
| `commandLogic.test.ts` | 42 |

**Repository-wide:**

| Gate | Before (M7.13) | After (M7.14) |
| --- | --- | --- |
| Test files | 140 | **145** |
| Tests | 2602 | **2763** |
| Failures | 0 | **0** |
| `npm run typecheck` | 0 errors | **0 errors** |
| `npm run lint` | 0 errors, 0 warnings | **0 errors, 0 warnings** |
| Migrations | 17 | **17** (unchanged) |

## Known limitations

- Operation-center state is per-process and does not survive a restart, by
  design. See the architecture note above.
- Durable operations (ingestion, comparisons, tool jobs) are not yet aggregated
  into the center's list; the wiring to the durable queue boundary is M7.16.
- Browser and keyboard verification of the two new components is M7.15/M7.16.
