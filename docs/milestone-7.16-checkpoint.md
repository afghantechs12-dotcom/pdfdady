# Milestone 7.16 Checkpoint — Final integration, gates and closure

**Status:** Complete. **Date:** 2026-08-04.

## Queue integration — the M7.11 item deferred to this phase

M7.11 left the trusted comparison worker surface tested but not connected to the
durable queue. That connection is now real.

`src/application/services/ComparisonJobHandler.ts` enqueues a durable job when a
comparison is created and drains it through the same trusted `StatisticsService`
methods the M7.11 suite already covers. The design point: **idempotency comes
from the service, not the handler.** `startComparison` transitions
`pending → running` and returns null when the operation has already moved, so a
duplicate delivery finds the work claimed and stops. A second delivery is
therefore *not* an error — at-least-once is the queue's normal behaviour, and
treating a duplicate as a failure would fail work that actually succeeded.

The handler never reports a comparison completed on its own authority. It hands
computed content to `completeComparison`, which re-checks the cancellation
request and the version pair before recording anything.

## Integration suite — `src/application/services/m7Integration.test.ts` (22 tests)

Real services and real in-memory adapters composed into whole flows. State
written by one subsystem is read back by another through its own authorized path.

**Durable versions (2).** Immutable versions a later save does not rewrite; an
older version preserved when newer ones are added.

**Statistics (3).** Version-scoped calculation from trusted server content; two
versions measured independently rather than sharing a row; an unmeasured count
staying null rather than collapsing to zero.

**Comparison through the queue (9).**

- End to end: create → enqueue → pull → handle → completed with a real result.
- Duplicate delivery converging to `already-claimed` with one result, not two.
- A late `completeComparison` refused by the state machine after a terminal state.
- A failure recorded on the comparison row, rethrown so the worker retries, then
  retried into a new pending operation with the original failure preserved.
- Content naming the wrong version pair rejected — a result filed against
  versions the operation did not name would be a diff attributed to the wrong pair.
- Work finishing after a cancellation delivered as `cancelled` with no result:
  "cancel" must not mean "cancel, unless it happened to finish first".
- Visual comparison refused honestly rather than pretending to run.
- A malformed payload rejected without retry.
- The job row committed durably, so a commit followed by a lost dispatch is
  recoverable.

**Tags and collections (2).** A smart collection answering differently once a
document changed — dynamic query, not a stored list.

**Command palette (2).** Search then execute against the *active pane's*
document; execution re-authorizing a viewer into refusal despite the palette
having displayed the command as enabled.

**Operation center (3).** Start → running → progress → complete → retrievable
result; cancel then retry with the cancellation preserved on the original;
Workspace scoping.

**Cross-tenant sweep (1).** Nine representative real ids — statistics,
comparison, comparison result, document tags, collection, operation, operation
result, command execution, version listing — every one producing `NotFoundError`
from the other tenant. Real ids, so this is an existence-oracle test, not a
null-input test.

## Fabrication scan

Every pattern from the closure list was searched across `src/`, `app/`,
`components/`, `lib/`, excluding tests.

| Pattern | Result |
| --- | --- |
| `as any` | **1 found, fixed.** `app/api/workspaces/[workspaceId]/documents/route.ts` cast an unvalidated `sortBy` query param straight into the query builder. Replaced with a real allowlist falling back to the default; `sortOrder` tightened the same way. |
| `alert(` | **0 in production.** The two in `EditorWorkspace.tsx` were replaced in M7.15. |
| `@ts-ignore`, `@ts-expect-error`, `eslint-disable` | 0 |
| `TODO`, `FIXME`, `in a real implementation`, `placeholder` implementations | 0 |
| `mock-`, `mock-checksum`, `workspace-456`, `hard-coded document-` | 0 |
| `organizationRole: string`, `documentId.split` | 0 |
| `dangerouslySetInnerHTML` | 1, **legitimate** — `components/seo/JsonLd.tsx` emits server-authored JSON-LD with `<` escaped, the standard safe pattern for inline structured data. No user input reaches it. |
| `Math.random` | 3, **legitimate** — client-side DOM/editor object ids in `ids.ts`, `BlogManager`, `PagesManager`. No security token uses it; the 12 security-relevant id sites use `randomUUID`. |

## Prisma and migration gate

| Command | Result |
| --- | --- |
| `npx prisma format` | Formatted, no changes required |
| `npx prisma validate` | **Schema is valid** |
| `npx prisma generate` | Client v6.19.3 generated |
| `npx prisma migrate status` | **17 migrations found, database schema is up to date** |

No migration was added in M7.14, M7.15 or M7.16 — no real schema need arose. No
historical migration was edited. No drift.

The Prisma config deprecation warning (`package.json#prisma`) persists and is
tracked as M7-R17.

## Final repository gate — run sequentially

| Gate | Result |
| --- | --- |
| `npm run typecheck` | **exit 0**, 0 errors |
| `npm run lint` | **exit 0**, 0 errors, 0 warnings |
| `npm run test` | **exit 0** — 148 files, 2846 tests, 0 failures |
| `npm run build` | **exit 0** |

### Build detail

Next.js 16.2.12 (Turbopack), `output: "standalone"`.

- Compiled successfully in ~11 s
- TypeScript checking passed
- Page data collected using 11 workers
- **106/106 static pages generated**
- Route table includes `/editor`, `/workspaces`, `/workspaces/[workspaceId]`,
  `/workspaces/[workspaceId]/settings`, all 18 `/tools/*` pages plus 27 SSG tool
  slugs, and the M7 API routes.
- M7.14 routes present and dynamic: `/api/workspaces/[workspaceId]/commands`,
  `/api/workspaces/[workspaceId]/operations`,
  `.../operations/[operationId]/cancel`, `.../operations/[operationId]/retry`.

**Build note, recorded honestly.** The first build attempt compiled successfully
but its TypeScript worker exited with `3221226505` (0xC0000409, stack overflow)
under memory pressure — ~2 GB of 15.8 GB free, with 10 Node processes belonging
to an **unrelated repository** (`modelgate`) resident. Those were left untouched.
Removing the stale `.next` directory and rebuilding succeeded, and the build was
then reproduced a second time to confirm it was not a one-off.
`tsc --noEmit` passes independently over the whole project, so the crash was
environmental, not a type error. `--stack-size` cannot be raised for Next's
workers (`NODE_OPTIONS` rejects it), so the mitigation is a clean `.next` and
adequate free memory.

## npm audit — classification

`npm audit` and `npm audit --omit=dev` both report **4 high**, no critical.

| Advisory | Severity | Path | Classification |
| --- | --- | --- | --- |
| `postcss` ≤ 8.5.22 — sourceMappingURL path traversal / arbitrary `.map` read, `</style>` XSS | high | dev dependency of the root project via `tailwindcss`, `autoprefixer`, `vite`; `next` bundles its own copy | **build-only.** Absent from `.next/standalone/node_modules`. No runtime user-CSS compiler exists. |
| `brace-expansion` 4.0.0–5.0.8 — DoS via unbounded intermediate arrays | high | `eslint@10.8.0` → `minimatch@10.2.6` | **development-only.** Lint tooling; never shipped. |
| `sharp` < 0.35.0 — inherited libvips CVE-2026-33327/33328/35590/35591 | high | optional dependency of `next@16.2.12` | **production dependency, path unreachable.** See below. |
| `next` 9.3.4-canary.0 – 16.3.0-preview.10 | high | root | **metavulnerability.** Inherits only the two above; no independent finding. |

### Why `sharp` is unreachable

`sharp` *is* traced into `.next/standalone/node_modules/sharp`, so the naive
answer would be "production reachable". It is not, and the reasoning is checked
rather than assumed:

- **No `next/image` import exists anywhere** in `app/` or `components/` — the
  grep for `from "next/image"` returns nothing. The one textual match is a code
  comment explaining why the component is deliberately not used.
- **No `images` block** is configured in `next.config.mjs`, so no image optimizer
  endpoint is generated.
- **No code passes uploaded or remote bytes to an image library** — the grep for
  `sharp` across `app/`, `components/`, `lib/`, `src/` returns nothing.
- The four `next/og` `ImageResponse` surfaces (`/opengraph-image`, `/icon`,
  `/blog/[slug]/opengraph-image`, `/brand-logo`) render **server-authored JSX**
  with no attacker-controlled image source, and three of the four are
  **statically prerendered at build time** — only `/brand-logo` is dynamic, and
  it takes no input at all.

The libvips CVEs require decoding an attacker-supplied image. Nothing in this
application decodes one. **No production-reachable critical or high
vulnerability remains**, so closure is not blocked.

`npm audit fix --force` was **not** run: it proposes Next 16.3.0, outside the
stated dependency range. No blind downgrade was performed.

## Component mounting

| Component | Mounted at |
| --- | --- |
| `CommandPalette` | `app/workspaces/[workspaceId]/page.tsx` header |
| `OperationCenter` | `app/workspaces/[workspaceId]/page.tsx`, above the file manager |
| `SplitWorkspaceView` | `components/workspaces/` — exported and covered by 31 + 26 tests; workbench mounting is carried as debt (see below) |
| `StatisticsPanel` | Workspace page, when a document is selected |
| `SearchPanel`, `DocumentFileManager` | Workspace page |
| `CommentsPanel`, `DocumentSharingPanel`, `TagCatalog`, `SmartCollections` | Feature surfaces |

## Carried debt

Recorded in `docs/milestone-7-risk-register.md` rather than hidden:

1. SQLite WAL, busy timeout and the ADR-M7-009 contention benchmark remain
   unconfigured and unmeasured. No numeric performance claim is made.
2. No DOM test environment; accessibility verified at the logic layer only.
3. Screen-reader and physical-device verification not performed, not claimed.
4. Operation-center state is per-process by design.
5. `ComparisonJobHandler`'s content resolver is injected and tested end-to-end
   through the real queue, but is not yet bound to production object storage in
   the container.
6. `SplitWorkspaceView` is tested and exported but not yet mounted in a workbench
   route.
