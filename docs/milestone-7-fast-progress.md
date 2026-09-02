# Milestone 7 Fast Implementation Progress

> **Status: Milestone 7 implementation is in progress. Automated verification is
> not yet green. M8 remains excluded.**
>
> A prior session recorded M7.4–M7.12 as "Complete". That was false: those
> phases were service stubs returning fabricated values, with no durable
> persistence and tests asserting the fabricated results. The entries below are
> corrected. A phase is only marked real when it has a domain model, a
> repository port, both repository adapters, a migration, a service backed by
> real persistence, behaviour tests, DI wiring, and passing typecheck + lint.

## Baseline at recovery (repo-wide, before M7.12 repair)

- Typecheck: 132 errors
- Lint: 30 warnings
- Full tests: 1 failure
- Prisma schema: stopped at `DocumentRecord`; no durable models for versions,
  tags, search, metadata, comments, comparisons or workspace sessions

## Phase status

| Phase | Scope | Real? | Notes |
|---|---|---|---|
| M7.3 | Document records / file manager | Yes | Predates this recovery; 20/20 in `fileManagerLogic.test.ts` |
| M7.4 | Upload and ingestion | **Yes** | Rebuilt on real persistence — see below |
| M7.5 | Autosave | **Yes** | Rebuilt on real persistence — see below |
| M7.6 | Versions | **Yes** | Rebuilt on real persistence — see below |
| M7.7 | Tags / smart collections | **Yes** | Rebuilt on real persistence — see below |
| M7.8 | Search | **Yes** | Rebuilt on real persistence — see below |
| M7.9 | Metadata / bookmarks / attachments | **No** | No persistence; fake embedded-PDF mutation |
| M7.10 | Comments / collaboration | **No** | No `CommentThread` / `CommentMessage`; fabricated comments and grants |
| M7.11 | Statistics / comparison | **No** | No `DocumentStatistics` / `ComparisonOperation`; fixed counts, fabricated completed results |
| M7.12 | Multi-document tabs / session restore | **Yes** | Rebuilt on real persistence — see below |
| M7.13–M7.16 | Split view, command palette, security suite, integration | Not started | Blocked behind M7.4–M7.11 |

## M7.4 — Upload and ingestion

- **Implementation status:** Real and complete
- **Migration filename:** `20260802153439_add_document_ingestions`
- **Focused test result:** 31/31 passed in `WorkspaceAwareUploadService.test.ts`
- **Typecheck (M7.4 files):** 0 errors
- **Lint (M7.4 files):** 0 errors, 0 warnings
- **Actual blocker:** None

### What was built

- `DocumentIngestion` Prisma model — `@@unique([workspaceId, checksum])` and
  `@@unique([workspaceId, documentId])`, `@@index([workspaceId, status])`,
  `@@index([organizationId, workspaceId])`. Status is `String`, not an enum
  (SQLite portability); no `Json` fields.
- `DOCUMENT_INGESTION_LIMITS` in the domain entity shared by the service
  (rejects on write) and both adapters (clamp on read).
- `DocumentIngestionRepository` port. `findByChecksum` is Workspace-scoped by
  signature, so dedup cannot reach another tenant's rows.
- In-memory and Prisma adapters. Prisma keeps `workspaceId` inside every WHERE
  predicate (`findFirst`/`updateMany`/`deleteMany`), so cross-Workspace reads and
  writes are unreachable rather than merely unlikely. An unrecognized status
  string maps to `failed`, never blindly cast to the union.
- `WorkspaceAwareUploadService.uploadToWorkspace` — Workspace authorization with
  write access required, a defense-in-depth cross-organization check,
  folder/project validation inside the same Workspace (archived folders rejected),
  filename validation (bounds, control characters, path separators, traversal,
  `data:`/`blob:`), document-name bounds and normalization, empty-file and
  100 MB size limits, MIME allow-list plus a `%PDF-` magic-number check over the
  real bytes, content-addressed storage key, Workspace-scoped dedup, and
  StoredFile + DocumentRecord + `pending` ingestion creation.
- Rollback on partial failure: ingestion, document, and StoredFile are unwound in
  reverse order, and the stored object is deleted **only** when this call is what
  wrote it — a content-addressed key shared with another tenant's file is left
  intact.
- Dedup non-disclosure: `deduplicated` is set only from a match inside the same
  Workspace. Two Workspaces uploading identical bytes each get their own
  document, ingestion, and StoredFile rows, and neither result reveals the other.
- Real CSRF-protected `multipart/form-data` route replacing the fabricated
  `mock-file-id` / `mock-document-id` / `mock-file-key` response. Enforces
  same-origin, content-type, and a pre-buffer body bound; returns 201 on a new
  upload and 200 on a workspace-local duplicate.
- DI: `Tokens.DocumentIngestionRepository` added, `PrismaDocumentIngestionRepository`
  registered, and the upload service registration corrected from 3 to its real 8
  dependencies.

### Test quality note

Seven mutations were applied and all seven were killed: removing the PDF
signature check, making rollback always delete the shared object, downgrading
authorization to read-only, deleting the cross-organization guard, skipping the
empty-file check, letting dedup return trashed documents, and skipping the size
limit. Three initially survived — the cross-organization guard and empty-file
check were unreachable through the honest doubles, and the empty-file assertion
was satisfied by the signature error instead. A test driving the guard through a
deliberately permissive authorizer and a reason-specific assertion closed both.

## M7.12 — Multi-document tabs and session restoration

- **Implementation status:** Real and complete
- **Migration filename:** `20260802145047_add_workspace_sessions`
- **Focused test result:** 66/66 passed
  - `TabService.test.ts` — 40 passed
  - `PrismaWorkspaceSessionRepository.test.ts` — 18 passed
  - `container.test.ts` — 8 passed (includes 4 new M7.12 DI tests)
- **Typecheck (M7.12 files):** 0 errors
- **Lint (M7.12 files):** 0 errors, 0 warnings
- **Actual blocker:** None

### What was built

- `WorkspaceSession` Prisma model — `@@unique([workspaceId, userId])`,
  `@@index([userId])`, `@@index([organizationId, workspaceId])`, nullable
  `activeTabId`, tabs as `String` JSON (SQLite portability: no `Json`, no `enum`),
  `version` optimistic counter.
- `WORKSPACE_SESSION_LIMITS` in the domain entity as the single source of truth
  for bounds, shared by the service (rejects on write) and the Prisma adapter
  (drops out-of-bounds values on read, so an old or tampered row cannot return
  unbounded data).
- `WorkspaceSessionRepository` port addressed by `(workspaceId, userId)` or
  `(id, userId)` — never by id alone, so cross-user access is unreachable at the
  adapter boundary.
- In-memory and Prisma adapters with verified parity: idempotent create,
  atomic version check via `updateMany` WHERE predicate, `createdAt` preserved,
  `updatedAt` strictly advancing, deep clones in memory to prevent mutation leaks.
- `TabService` — workspace authorization on every operation, document
  authorization before open/restore, presence-aware partial updates
  (`hasOwnProperty`, not `|| []`), deterministic neighbour selection on close,
  `randomUUID` tab ids, `data:`/`blob:` rejection, bounded page/scale/offset/
  selection/title/tool/payload, dirty+conflict preservation, unauthorized tabs
  dropped on restore without leaking document details.
- DI: `Tokens.WorkspaceSessionRepository` added; `TabService` registration
  repaired to resolve all four dependencies. Also fixed six pre-existing
  container registrations (`WorkspaceAwareUploadService`, `AutosaveService`,
  `VersionService`, `TagService`, `CommentService`, `StatisticsService`) that
  referenced classes never imported — 14 typecheck errors cleared.

### Test quality note

The focused tests were mutation-checked rather than assumed: removing the
in-memory clone, replacing presence-aware update with `updates.tabs || []`, and
deleting the cross-workspace document guard each produce failures. The third
initially survived (both adapters already scope by workspace), so a test driving
that guard through a deliberately unscoped repository was added.

## M7.5 — Autosave

- **Implementation status:** Real and complete
- **Migration filenames:** `20260802170336_add_autosave_drafts`, corrected by the
  additive `20260802175053_autosave_snapshot_metadata` (the applied migration was
  not edited)
- **Focused test result:** 82/82 passed
  - `AutosaveService.test.ts` — 42 passed
  - `PrismaAutosaveDraftRepository.test.ts` — 27 passed
  - `container.test.ts` — 13 passed (includes 5 new M7.5 DI tests)
- **Typecheck (M7.5 files):** 0 errors
- **Lint (M7.5 files):** 0 errors, 0 warnings
- **Actual blocker:** None

### Architecture reconciliation

The first migration stored the serialized editor state inline in a `payload` TEXT
column, contradicting `docs/milestone-7-plan.md` §4.3 ("Large repeated
editor-state JSON is not stored in SQLite"). The corrective migration adds
`snapshotKey` / `snapshotGeneration`, drops `payload`, and indexes `snapshotKey`
(reference check before delete) and `updatedAt` (retention sweeps). A draft is now
a metadata row plus a bounded object-storage snapshot.

### What was built

- `AUTOSAVE_DRAFT_LIMITS` in the domain as the single source of truth for bounds,
  plus `autosaveDraftListLimit` shared by both adapters so listing caps cannot
  drift, and `autosaveSnapshotKey` partitioned workspace → document → user →
  hashed device → generation, so one identity's snapshots are unaddressable under
  another's prefix.
- Expiry is derived from `updatedAt`, not stored — a persisted copy would need
  rewriting on every save and could drift from the policy it was written under.
- `AutosaveDraftRepository` port addressed by `(workspaceId, documentId, userId,
  deviceId)`, never by id alone, with `isSnapshotReferenced` guarding deletes.
- In-memory and Prisma adapters in verified parity: version-checked `updateMany`,
  bounded listings, deep copies (including `Date` copies) so a returned draft
  cannot reach persisted state.
- `AutosaveService` on `IObjectStorage` with stage-new-generation-then-repoint:
  each save writes a fresh key before the row moves, the superseded object is
  released only after the row no longer references it, and a failed write is
  reconciled rather than orphaned. Lease-based write ownership on an injectable
  clock; a revision-mismatch conflict keeps the lease (that device is still the
  only editor) while a save blocked by another device's live lease takes nothing.
- No `DocumentVersion` is created or incremented by autosave — a draft is not a
  version.
- DI: `Tokens.AutosaveDraftRepository` added; the `AutosaveService` registration
  was fabricated (Logger + ObjectStorage + FileMetadataRepository) and now
  resolves its five real dependencies. A container test saves through the wired
  service, so an arity or ordering mistake fails rather than type-checking.
- Routes under `app/api/workspaces/[workspaceId]/documents/[documentId]/autosave/`
  — `GET`/`POST`/`DELETE`, plus `recover/` and `mark-saved/`. Same-origin CSRF
  check on every mutation, `content-length` refused before the body is parsed,
  zod bounds from the domain limits, errors through `mapWorkspaceError` (no stack
  traces). `snapshotKey` is withheld from responses: echoing it would tell a
  client where another tenant's bytes would live.

### Test quality note

The adapter tests found two real defects rather than confirming the code: the
listing bound treated `Number.POSITIVE_INFINITY` as garbage (clamping to 1 row
instead of the cap), and `toDomain` aliased the row's `Date` objects, so a caller
mutating `leaseExpiresAt` reached persisted state. Both were fixed in production
code. A third finding was cross-adapter drift — in-memory listings defaulted to
100 rows while Prisma capped at 20 — now closed by the shared domain helper and a
parity test.

Two optimistic-concurrency tests initially passed for the wrong reason: the
service re-reads the row immediately before updating, so bumping the version
beforehand never conflicts. They now use a repository wrapper that lands a
competing write between the service's read and its write, which is the only way
the version check can actually fire.

## M7.6 — Document versions

- **Implementation status:** Real and complete
- **Migration filename:** `20260802190000_add_document_versions`
- **Focused test result:** 123/123 passed
  - `VersionService.test.ts`: 61
  - `PrismaDocumentVersionRepository.test.ts`: 42
  - `container.test.ts`: 20
- **Typecheck (M7.6 files):** 0 errors
- **Lint (M7.6 files):** 0 errors, 0 warnings
- **Prisma:** validate passed, generate passed, migration applied
- **Actual blocker:** None

### What was built

- `DocumentVersion` domain entity with a bounded artifact manifest. The
  `mock-checksum` literal and the documentId string-splitting that previously
  stood in for workspace identity are both gone: workspace scope is a real
  column, and checksums are computed over actual bytes.
- `DocumentVersionRepository` port with both adapters in parity. Every Prisma
  predicate carries `workspaceId`, so a cross-Workspace read or write is
  unreachable rather than merely unlikely.
- `VersionService` — snapshot, list, get, restore — with Workspace membership
  and write-access checks on every operation, optimistic revision on mutations,
  and non-disclosing failures for inaccessible resources.
- DI: `Tokens.DocumentVersionRepository` registered to the Prisma adapter, and
  `VersionService` resolving its real dependencies. Container tests exercise a
  real operation through the wired graph, so an arity or ordering mistake fails
  rather than type-checking.
- Routes under `app/api/workspaces/[workspaceId]/documents/[documentId]/versions/`
  — collection `GET`/`POST`, `[versionNumber]` `GET`, and
  `[versionNumber]/restore` `POST`. `requireSameOrigin` on every mutation; the
  read-only `[versionNumber]` route has no mutation to guard.
- Artifact storage keys are withheld from every response. `toVersionResponse`
  returns checksums, sizes and counts — enough to verify a download and render
  history — but never a key, since a key's shape discloses where another
  tenant's bytes would live.

## M7.7 — Tags and smart collections

- **Implementation status:** Real and complete
- **Migration filename:** `20260802234143_add_tags_and_smart_collections`
- **Focused test result:** 153/153 passed
  - `TagService.test.ts`: 58
  - `PrismaTagRepository.test.ts`: 15
  - `PrismaDocumentTagRepository.test.ts`: 12
  - `PrismaSmartCollectionRepository.test.ts`: 14
  - `container.test.ts`: 27
  - `tagLogic.test.ts` (UI): 27
- **Typecheck (M7.7 files):** 0 errors
- **Lint (M7.7 files):** 0 errors, 0 warnings
- **Prisma:** validate passed, generate passed, migration applied
- **Actual blocker:** None

### What was built

- `Tag` and `SmartCollection` domain entities. The fabricated surface is gone:
  no `Math.random`/`Date.now` identifiers, no `organizationRole: string` actor
  beside the real `ActorContext`, no `validateQuery` that returned `true`, and no
  `documentId.split('-')[0]` standing in for workspace identity.
- Tag-name normalization is deterministic and locale-independent (NFKC,
  whitespace collapse, `toLowerCase`) rather than delegated to database
  collation, so both adapters agree on what counts as a duplicate. Forbidden
  code points are written as numeric ranges, not a regex literal, so the intent
  survives tooling that rewrites escape sequences.
- A strict versioned query grammar for collections: allowlisted fields and a
  field/operator matrix, with caps on depth, condition count, term length, id
  length, tags per condition, and serialized size. No eval, no `Function`, no raw
  SQL, no arbitrary Prisma `where`, no user-supplied property path. Unknown
  versions, fields and operators are rejected rather than ignored, and parsing
  returns a canonical object so a caller's extra properties cannot ride into
  storage.
- Collection membership is never persisted. It is re-evaluated from live
  `DocumentRecord` and `DocumentTag` data on every read, so tagging a document
  changes what a collection contains without any write to the collection.
- Degradation fails closed: a stored definition that cannot be parsed within
  bounds evaluates to *no* documents and is flagged `queryDegraded`, rather than
  being read as "no filters" and matching everything.
- Three ports — `TagRepository`, `DocumentTagRepository`,
  `SmartCollectionRepository` — each with an in-memory and a Prisma adapter in
  behavioural parity. Every predicate carries `workspaceId`; duplicates are
  rejected by the unique index rather than by a racing check-then-insert; updates
  are compare-and-swap on `revision`, and a stale revision is reported
  identically to a missing row so neither discloses the other.
- `TagService` rewritten on real dependencies (`ILogger`, `WorkspaceService`,
  `DocumentRecordRepository`, and the three repositories), with membership
  re-authorized on every operation, write access required for mutations,
  document authorization before assignment, idempotent assign/remove, and bounded
  bulk operations that report per-document outcomes honestly instead of failing
  the whole batch.
- DI: `Tokens.TagRepository`, `Tokens.DocumentTagRepository` and
  `Tokens.SmartCollectionRepository` registered to the Prisma adapters, and the
  stale three-argument `TagService` registration repaired to its real six-
  dependency form. Container tests drive real operations through the wired graph,
  so an arity or ordering mistake fails rather than type-checking.
- Routes under `app/api/workspaces/[workspaceId]/` — `tags` (`GET`/`POST`),
  `tags/[tagId]` (`PATCH`/`DELETE`), `tags/bulk` (`POST`),
  `documents/[documentId]/tags` (`GET`/`POST`/`DELETE`), `smart-collections`
  (`GET`/`POST`), `smart-collections/[collectionId]` (`GET`/`PATCH`/`DELETE`) and
  `smart-collections/preview` (`POST`, a read). `requireSameOrigin` guards every
  mutation. The collection query is validated by the domain grammar rather than
  by a zod mirror of it, so there is no second validator to drift from the
  allowlist the evaluator enforces.
- UI: `tagLogic.ts` (pure, tested) plus `TagChips.tsx`, `TagCatalog.tsx` and
  `SmartCollections.tsx` — tag chips, add/remove picker, tag catalog, bulk
  tagging, and collection list/builder/preview/results. Loading, empty,
  validation and error states are all present; controls are keyboard-operable
  with visible focus. The UI validates through the same domain rules the API
  enforces, so it cannot present a draft as saveable that the server will reject.
  Manual a11y verification remains deferred.

## M7.8 — Workspace search

- **Implementation status:** Real and complete
- **Migration filename:** `20260803010908_add_search_index`
- **Focused test result:** 229/229 passed across 7 files
  - `SearchIndex.test.ts` (domain): 10
  - `SearchService.test.ts`: 47
  - `SQLiteSearchIndexAdapter.test.ts`: 20
  - `PrismaSearchDocumentRepository.test.ts`: 34
  - `PrismaSearchChunkRepository.test.ts`: 32
  - `container.test.ts`: 35 (8 new M7.8 DI tests)
  - `searchLogic.test.ts` (UI): 51
- **Typecheck (M7.8 files):** 0 errors
- **Lint (M7.8 files):** 0 errors, 0 warnings
- **Prisma:** validate passed, generate passed, migration applied, no drift
- **Actual blocker:** None

### What was built

- `SearchDocument` (one index entry per document, per version) and `SearchChunk`
  (bounded, page-aware content units). Chunking rather than one blob per document
  is what lets a snippet say *where* a match is and lets a reindex replace
  content incrementally.
- Queries are tokenized into bounded literal terms and never compiled into a
  regular expression, so no input can describe catastrophic backtracking.
  `.*contract.*` stays a literal and does not decay into `contract`;
  punctuation-only and single-character queries are rejected rather than matching
  everything. Normalization is NFKD-then-NFKC with diacritics stripped and
  locale-independent case folding, so `résumé` and `resume` agree on both sides.
- Authorization ordering is the security property: `SearchService` resolves the
  eligible `DocumentRecord` set *before* any chunk is consulted, and every count,
  snippet, page and cursor is derived from that set. `SearchIndexPort` is a
  backend query boundary only — it owns no tenant-role decision, and its adapter
  test pins that division. FTS5 is not required.
- Highlights are returned as offset ranges over plain text, never as markup, so
  index content cannot become document structure. The client segmenter validates
  every range against the string it indexes and *drops* an unusable range rather
  than clamping it; a range that does not fit is a signal that offsets and text
  disagree, not a near-miss to repair. No path reaches `dangerouslySetInnerHTML`.
- Both Prisma adapters carry `workspaceId` in every predicate — pinned
  structurally by a recording-delegate test per adapter, so a future method that
  authorizes on `documentId`, `searchDocumentId`, `checksum` or `versionId` alone
  fails the suite. Entries read as *missing* across a Workspace boundary, and a
  stale revision is reported identically to an absent row so neither discloses
  the other. Unknown persisted states degrade to `stale` (fails closed) and
  unknown chunk source types degrade to `text` (content valid, label unusable).
- Reindex is honest: the route is `requireSameOrigin`-guarded, answers 202, and
  moves the entry to `pending`. Nothing claims indexing completed, and no public
  endpoint accepts arbitrary extracted text or raw chunks as authoritative.
- UI: `searchLogic.ts` (pure, tested) plus `SearchPanel.tsx`, mounted on the
  workspace page. Debounced input, `AbortController` cancellation, and a
  monotonic request id so a slow earlier query cannot overwrite a later one.
  Initial, loading, empty, error, stale-index and truncated-query states are all
  present; results are a semantic list activated by real buttons with visible
  focus; filters collapse on narrow widths. Manual a11y verification remains
  deferred.

## Repo-wide gates

- Typecheck: **42 errors** (was 57). All remaining errors sit in the still
  fabricated M7.9–M7.11 files (`MetadataService`, `CommentService`,
  `StatisticsService` and their tests); 0 in M7.4–M7.8 and M7.12 files. Dominant
  causes unchanged: incomplete `ILogger` test doubles missing
  `info`/`warn`/`child`, `organizationRole: string` instead of `Role`, and fields
  that no durable model defines yet.
- Lint: **0 errors**, 8 warnings (was 13) — all unused vars/args in the
  fabricated M7.9–M7.11 service stubs, which those phases will consume or remove.
- Full tests: **1738 passed across 119 files**, 0 failures.
- Final production build: still deferred while repository-wide typecheck is red.

## Next

M7.9 — document metadata, bookmarks, outlines and attachments, to be built on
real persistence.

---

# FINAL STATE — Milestone 7 complete (2026-08-04)

The "Repo-wide gates" and "Next" sections immediately above are a **historical
snapshot taken during M7.8** and are now obsolete. They are left in place as the
record of that moment rather than rewritten. The authoritative final state is
below; the full report is `docs/milestone-7-completion.md`.

## Phases

M7.0 through M7.16 are all complete. M8 has not been started.

The three phases completed after the M7.13 checkpoint:

- **M7.14 — Command palette and operation center.** 21 canonical commands
  registered once at container creation, a `CommandPaletteService` that
  re-authorizes at execution regardless of what the palette displayed, an
  in-memory `OperationCenterService` that presents durable work without
  duplicating its state, four API routes, and two mounted UI components.
- **M7.15 — Hardening.** 44 security tests and 17 accessibility/responsive tests
  over real services; five real defects repaired.
- **M7.16 — Integration and closure.** The M7.11 comparison worker connected to
  the durable queue, 22 end-to-end integration tests, fabrication scan, full
  Prisma and repository gates, production build, and audit classification.

## Repo-wide gates — final

| Gate | Result |
| --- | --- |
| `npm run typecheck` | **exit 0 — 0 errors** (was 42 at the M7.8 snapshot above) |
| `npm run lint` | **exit 0 — 0 errors, 0 warnings** (was 8 warnings) |
| `npm run test` | **exit 0 — 148 files, 2846 tests, 0 failures** (was 119/1738) |
| `npm run build` | **exit 0** — Next 16.2.12, 106/106 static pages, reproduced twice |
| Migrations | **17, applied, no drift** |
| `npm audit` | 4 high, **0 production-reachable** |

The M7.8-era note that "final production build: still deferred while
repository-wide typecheck is red" no longer applies. Typecheck is clean and the
build passes.

## Defects repaired in the closing phases

1. Statistics text bound counted code points before enforcing the cap, so an
   oversized segment could exhaust the memory the bound existed to protect
   (surfaced as a suite-wide OOM).
2. Operation center handed out shallow copies sharing mutable `Date` instances.
3. An `as any` let an unvalidated `sortBy` param reach the query builder.
4. Two blocking `alert()` calls remained in the editor.
5. An empty-string disabled reason left a greyed row with nothing to announce.
6. Two POST-shaped reads lacked same-origin evidence.

## Carried debt

SQLite WAL/busy-timeout unconfigured and unbenchmarked; no DOM test environment;
no screen-reader, device or browser verification; operation-center state is
per-process by design; the comparison content resolver is not yet bound to
production storage; `SplitWorkspaceView` is tested but not yet mounted in a
workbench route. All recorded in `docs/milestone-7-risk-register.md`.

## Next

**Nothing in M7.** Milestone 7 is closed. M8 remains unauthorized.
