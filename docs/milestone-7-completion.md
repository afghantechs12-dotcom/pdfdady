# Milestone 7 — Completion Report

**Status:** COMPLETE. **Date:** 2026-08-04.
**Scope:** Workspaces, document management, collaboration and the professional
workbench (M7.0 – M7.16).
**M8 has not been started and remains unauthorized.**

---

## 1. Phases

| Phase | Title | Status |
| --- | --- | --- |
| M7.0 | Architecture, planning, ADRs, threat model | Complete |
| M7.1 | Workspaces and memberships | Complete |
| M7.2 | Projects and folders | Complete |
| M7.3 | Document records and file manager | Complete |
| M7.4 | Upload and ingestion | Complete |
| M7.5 | Autosave | Complete |
| M7.6 | Durable versions | Complete |
| M7.7 | Tags and smart collections | Complete |
| M7.8 | Search and indexing | Complete |
| M7.9 | Metadata, bookmarks, outlines, attachments | Complete |
| M7.10 | Comments, sharing, async collaboration | Complete |
| M7.11 | Statistics and version comparison | Complete |
| M7.12 | Tabs and session restoration | Complete |
| M7.13 | Split view and navigation | Complete |
| M7.14 | Command palette and operation center | Complete |
| M7.15 | Security, accessibility, mobile, performance hardening | Complete |
| M7.16 | Final integration, gates, closure | Complete |

Checkpoints: `docs/milestone-7.{0,1,2,3,10,11,13,14,15,16}-checkpoint.md`.

---

## 2. Migrations

**17 migrations. All applied. Schema up to date. No drift. No historical
migration edited.**

```
20260727091322_init
20260727165301_add_user_password
20260801150000_add_workspaces
20260801170000_add_organization_membership_lookup_index
20260801185338_add_projects_and_folders
20260801191609_add_document_records
20260802145047_add_workspace_sessions
20260802153439_add_document_ingestions
20260802170336_add_autosave_drafts
20260802175053_autosave_snapshot_metadata
20260802190000_add_document_versions
20260802234143_add_tags_and_smart_collections
20260803010908_add_search_index
20260803111811_add_document_metadata_bookmarks_outlines_attachments
20260803144104_add_comments_and_document_permissions
20260803144651_add_comment_thread_page_anchor_index
20260803233259_add_statistics_and_comparisons
```

No migration was added in M7.14, M7.15 or M7.16 — no real schema need arose. The
operation center is deliberately in-memory (plan §M7.14: "persisted operation
record only where existing Job/activity is insufficient"), so adding a table
would have created a second, weaker source of truth beside the durable rows that
already exist.

| Prisma command | Result |
| --- | --- |
| `npx prisma format` | Formatted, no changes needed |
| `npx prisma validate` | **Schema is valid** |
| `npx prisma generate` | Client v6.19.3 generated |
| `npx prisma migrate status` | **17 found, up to date** |

35 models, 91 `@@index` declarations.

---

## 3. Final repository gate — run sequentially

| Gate | Command | Result |
| --- | --- | --- |
| Types | `npm run typecheck` | **exit 0** — 0 errors |
| Lint | `npm run lint` | **exit 0** — 0 errors, 0 warnings |
| Tests | `npm run test` | **exit 0** — **148 files, 2846 tests, 0 failures** |
| Build | `npm run build` | **exit 0** |

### Test growth across the closing phases

| Checkpoint | Files | Tests |
| --- | --- | --- |
| After M7.11 | 137 | 2506 |
| After M7.13 | 140 | 2602 |
| After M7.14 | 145 | 2763 |
| After M7.15 | 147 | 2824 |
| **After M7.16** | **148** | **2846** |

### Focused suites added or grown in M7.14 – M7.16

| Suite | Tests |
| --- | --- |
| `CommandPalette.test.ts` (domain) | 42 |
| `CommandPaletteService.test.ts` | 20 |
| `OperationCenterService.test.ts` | 34 |
| `commandHttp.test.ts` | 14 |
| `commandLogic.test.ts` | 42 |
| `container.test.ts` (66 → 75) | 75 |
| `m7Hardening.test.ts` (security) | 44 |
| `m7Accessibility.test.ts` | 17 |
| `m7Integration.test.ts` | 22 |

---

## 4. Production build

Next.js **16.2.12** (Turbopack), `output: "standalone"`.

- Compiled successfully (~11 s)
- TypeScript checking passed
- Page data collected using 11 workers
- **106/106 static pages generated**
- Build reproduced twice to confirm stability

### Route table (abridged)

Static/SSG: `/`, `/about`, `/blog`, `/blog/[slug]` + OG images, `/contact`,
`/editor`, `/pricing`, `/privacy-policy`, `/terms`, `/tools`, `/tools/[slug]`
(27 slugs), 18 individual `/tools/*` pages, `/icon`, `/opengraph-image`,
`/robots.txt`, `/sitemap.xml`.

Dynamic: `/workspaces`, `/workspaces/[workspaceId]`,
`/workspaces/[workspaceId]/settings`, `/brand-logo`, `/server-status`, and the
M7 API surface — 50+ `/api/workspaces/**` routes including the four added in
M7.14:

```
/api/workspaces/[workspaceId]/commands
/api/workspaces/[workspaceId]/operations
/api/workspaces/[workspaceId]/operations/[operationId]/cancel
/api/workspaces/[workspaceId]/operations/[operationId]/retry
```

**Build environment note.** The first attempt compiled successfully but its
TypeScript worker exited `3221226505` (0xC0000409, stack overflow) with ~2 GB of
15.8 GB free and 10 Node processes from an **unrelated repository** resident;
those were not touched. Clearing the stale `.next` and rebuilding succeeded.
`tsc --noEmit` passes independently over the whole project, so this was
environmental, not a type error.

---

## 5. Security

### Hardening suite — 44 tests, real services against real adapters

Cross-tenant isolation and IDOR (10), permission lifecycle (10), input bounds and
content safety (10), idempotency (5), leakage (5), bounded resources (3).

The load-bearing assertion: **a real-but-inaccessible id and a fabricated id
produce byte-identical errors.** A difference there is an existence oracle
regardless of what else is correct.

### CSRF

**All 50 state-changing `/api/workspaces/**` handlers enforce
`requireSameOrigin`**, including the four added in M7.14. Two POST-shaped *reads*
(`/search`, `/smart-collections/preview`) gained it in M7.15 as defence in depth —
neither writes, but both disclose which documents exist.

### Defects found and repaired during M7.14 – M7.16

| # | Defect | Severity | Where |
| --- | --- | --- | --- |
| 1 | Text bound counted code points *before* enforcing the cap, so an oversized segment allocated a 50 M-element array on its way to being rejected — the bound could exhaust the memory it existed to protect. Surfaced as a suite-wide OOM. | Medium | `DocumentStatistics.ts` |
| 2 | Shallow copies shared mutable `Date` instances, letting a caller write into stored state through a "read-only" copy. | Medium | `OperationCenterService.ts` |
| 3 | `as any` cast an unvalidated `sortBy` query param into the query builder. Replaced with a real allowlist. | Low | `documents/route.ts` |
| 4 | Two blocking `alert()` calls remained in the editor. Replaced with a dismissible `role="alert"` region. | Low | `EditorWorkspace.tsx` |
| 5 | `??` let an empty-string disabled reason through, leaving a greyed row with nothing to announce. | Low | `commandLogic.ts` |
| 6 | Two POST-shaped reads lacked origin evidence. | Low | 2 routes |

### Fabrication scan

`as any` 0 (1 fixed) · `@ts-ignore` 0 · `eslint-disable` 0 · `TODO`/`FIXME` 0 ·
`alert(` 0 in production · `mock-`/`workspace-456`/`mock-checksum` 0 ·
`Math.random` 3 (all legitimate client-side ids; the 12 security-relevant id
sites use `randomUUID`) · `dangerouslySetInnerHTML` 1 (server-authored JSON-LD
with `<` escaped — the standard safe pattern, no user input).

---

## 6. npm audit

`npm audit` and `npm audit --omit=dev`: **4 high, 0 critical.**

| Advisory | Classification |
| --- | --- |
| `postcss` ≤ 8.5.22 | **build-only** — absent from `.next/standalone`; no runtime user-CSS compiler |
| `brace-expansion` 4.0.0–5.0.8 | **development-only** — via `eslint` → `minimatch` |
| `sharp` < 0.35.0 (libvips CVEs) | **production dependency, path unreachable** |
| `next` | **metavulnerability** — inherits the two above only |

**Why `sharp` is unreachable**, checked rather than assumed: no `next/image`
import exists anywhere in `app/` or `components/`; no `images` block is
configured, so no optimizer endpoint is generated; no code passes uploaded or
remote bytes to an image library; and the four `next/og` `ImageResponse` surfaces
render server-authored JSX with no attacker-controlled source, three of them
prerendered at build time. The libvips CVEs require decoding an attacker-supplied
image, and nothing here decodes one.

**No production-reachable critical or high vulnerability remains.**
`npm audit fix --force` was **not** run — it proposes Next 16.3.0, outside the
stated range. No blind downgrade was performed.

---

## 7. Integration evidence

22 end-to-end tests over real services and in-memory adapters. Notably:

**The M7.11 deferral is closed.** `ComparisonJobHandler` connects the trusted
comparison worker to the M2 durable queue. Idempotency comes from the service —
`startComparison` returns null when work is already claimed, so a duplicate
delivery converges rather than failing work that succeeded. Covered: end-to-end
completion, duplicate delivery, late completion refused, failure recorded and
retriable, wrong version pair rejected, cancellation beating a late finish,
malformed payload rejected without retry, and the job row committed durably so a
lost dispatch is recoverable.

Also covered: version immutability, version-scoped statistics, dynamic smart
collections, active-pane command routing with execution-time re-authorization,
operation lifecycle with cancel/retry preserving history, and a cross-tenant
sweep over nine real ids from every subsystem.

---

## 8. Accessibility and responsive — evidence levels

| Area | Level |
| --- | --- |
| Command/operation logic, keyboard resolution, status text, bounds | **automated** (Vitest) |
| Authorization, IDOR, CSRF, idempotency, leakage | **automated** (Vitest) |
| Dialog focus containment / focus return | **automated** — `focusTrap.test.ts`, the shared primitive both new dialogs use |
| Responsive breakpoint rules | **automated** (logic level) |
| Rendered DOM, live-region timing, visible focus rings | **unverified** — suite is `environment: "node"`; no DOM environment configured |
| Screen reader | **unverified — not performed** |
| Physical device | **unverified — not performed** |
| Browser interaction | **unverified — not performed** |

No screen-reader, physical-device or browser verification is claimed, because
none was performed.

---

## 9. Performance — verified from code, not asserted numerically

| Item | Finding |
| --- | --- |
| No object streaming or PDF processing inside a DB transaction | **Confirmed** — all four `$transaction` sites contain only row operations |
| Bounded pagination | **Confirmed** — comments 100, metadata 200, commands 50, operations 100, autosave drafts capped |
| Bounded operation history, active work never evicted | **Confirmed** by test |
| Indexes support actual predicates | 91 `@@index` across 35 models |
| SQLite WAL / busy timeout | **Not configured, not claimed** — ADR-M7-009 requires measurement first |
| Latency/throughput figures | **Not claimed anywhere in M7** |

---

## 10. Fresh-install and upgrade evidence

- `npx prisma migrate status` — 17 applied, up to date, no drift
- `npx prisma validate` — valid
- `npx prisma generate` — client regenerated cleanly
- `npm run build` — succeeds from a cleared `.next`, reproduced twice
- Migration history is additive and unedited, so the upgrade path from any prior
  applied migration is retained

---

## 11. Known limitations and carried debt

Recorded in `docs/milestone-7-risk-register.md`, not hidden:

1. **SQLite WAL, busy timeout and the ADR-M7-009 contention benchmark remain
   unconfigured and unmeasured.** No numeric performance claim is made anywhere.
2. **No DOM test environment** — accessibility verified at the logic layer only.
3. **No screen-reader or physical-device verification.**
4. **Operation-center state is per-process** and does not survive a restart, by
   design. Durable work is owned by its durable repository; the center presents
   and coordinates rather than duplicating that state.
5. **`ComparisonJobHandler`'s content resolver is injected and tested end-to-end
   through the real queue but not yet bound to production object storage** in the
   container.
6. **`SplitWorkspaceView` is tested (57 tests) and exported but not yet mounted**
   in a workbench route.
7. **Prisma config deprecation** (`package.json#prisma`) unresolved; remains on
   Prisma 6.
8. **Public sharing and project-level sharing remain out of scope**;
   `ProjectPermissionGrant` stays provisional.
9. **No Git history** — the repository is not a working tree, so attribution and
   rollback rely on checkpoints and backups.

---

## 12. Confirmation

- Every M7 phase from M7.0 through M7.16 is complete.
- All four final gates pass: typecheck 0, lint 0/0, 2846 tests, build exit 0.
- 17 migrations, applied, no drift, no edited history.
- No production-reachable critical or high vulnerability.
- No fabricated implementation, placeholder command, suppressed type error or
  disabled lint rule was used to reach this state.
- Limitations are recorded rather than claimed as done.

**MILESTONE 7 COMPLETE.**

**M8 was not started and remains unauthorized.**
