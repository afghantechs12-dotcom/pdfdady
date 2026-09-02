# PDFDadi / PDFMaster — Milestone 7 Plan
## Document Workspace & Professional Productivity

## 1. Authority, scope, and approval boundary

This plan implements the user-defined official scope for **M7 — Document Workspace & Professional Productivity**. It replaces the rejected Advanced Typography proposal. No unfinished M5 typography slice is included in M7 unless later repository evidence proves that a narrowly identified typography defect blocks an M7 user flow; such a prerequisite must be documented separately and approved before work.

M7 turns PDFDadi/PDFMaster into a tenant-safe professional document workspace while preserving all stable M1–M6 behavior. M8 features—embeddings, semantic AI search, RAG, summaries, translation, and AI document assistance—are explicitly excluded.

This internal plan is only the execution blueprint. The authorized M7.0 run must write the corrected content into the actual repository file `D:\AndroidStudioProjects\Backup\PDFMaster\docs\milestone-7-plan.md`; updating this internal file or a chat response is not the deliverable. M7.0 also creates `docs/milestone-7-current-architecture.md`, the required ADR files, and the amendment mapping table with concrete paths and every row marked incorporated. No Prisma schema edit or migration is permitted. M7.1 remains blocked pending a separate approval.

## 2. Current architecture report

### 2.1 Verified repository foundations

- **Application:** Next.js 16.2.12 App Router, React 19, TypeScript, Tailwind.
- **Architecture:** clean-layer structure under `src/domain/`, `src/application/`, and `src/infrastructure/`; App Router presentation under `app/`; React UI under `components/`.
- **Composition:** custom token-based DI in `src/application/di/container.ts` and `tokens.ts`.
- **Database:** Prisma 6.19.3 with SQLite in `prisma/schema.prisma`. Current portability conventions avoid Prisma enums and JSON columns; structured data is serialized as strings.
- **Existing identity/tenant models:** `User`, `Organization`, `OrganizationMembership`, and `Session`. Organization roles are `owner | admin | member | viewer` and remain organization-scoped.
- **Storage:** `IObjectStorage` with local filesystem and Cloudflare R2 adapters; streaming read/write methods; `StoredFile` contains byte-object metadata and is not a document identity model.
- **Uploads:** checksum/deduplication support exists; storage and metadata writes are not one atomic transaction, so M7 requires staged commit and compensating cleanup.
- **Jobs:** in-memory and Redis queue/worker implementations with progress, cancellation, scheduling, and retries. Redis processing recovery and M7 job idempotency require hardening.
- **Editor:** editor format v6 with v1–v6 migrations. `EditorDocumentService` and `CommandHistory` are created per editor surface, providing a sound isolation seam for multi-document tabs.
- **Current editor shell:** `components/editor/EditorWorkspace.tsx` owns one editor instance, source bytes, backgrounds, active page, viewport, tool, and file name. M7 must lift these into per-tab resources without rewriting the editor domain. `/editor` must remain independently functional.
- **PDF processing:** PDF.js/pdf-lib and existing server tool workers provide a base for extraction, thumbnail, metadata, comparison, and feasibility jobs.
- **Testing:** Vitest exists. No project Playwright configuration has been found; browser E2E is added only where IndexedDB, reload, multi-tab, or real focus behavior cannot be validated reliably in Vitest.
- **Repository caveat:** the current project directory is not a Git working tree. Disk state, migrations, package-lock consistency, reports, and exact command output replace Git status/history evidence.

### 2.2 Missing M7 capabilities

No existing first-class models/services were found for Workspace, Project, Folder, DocumentRecord, durable versions, autosave drafts, tags, smart collections, comments/shares, search indexes, workspace sessions, multi-document tabs, split view, or recovery. No application IndexedDB persistence or `BroadcastChannel` coordination exists.

### 2.3 Required bounded architecture

Add cohesive workspace slices without coupling them to the editor domain:

- `src/domain/workspace/` — entities, roles/capabilities, invariants, value objects, state machines.
- `src/application/workspace/` — use cases, DTOs, and repository/storage/search/job ports.
- `src/infrastructure/workspace/` — Prisma repositories, IndexedDB adapter, storage adapter, search adapters, job handlers.
- `app/workspaces/` — workspace shell and product routes.
- `app/api/workspaces/` — thin authenticated/authorized API controllers.
- `components/workspace/`, `hooks/workspace/`, `lib/workspace/` — workspace UI and browser orchestration.
- Additive registrations in `src/application/di/tokens.ts` and `container.ts`, preferably grouped through a workspace composition helper.

Dependency direction remains presentation → application → domain, with Prisma, storage, queue, search, and IndexedDB as adapters.

## 3. Approved architecture decisions and ADRs

M7.0 creates explicit ADRs under `docs/adr/` (or the repository’s established ADR location) for:

1. **Organization → Workspace:** Organization remains tenant/billing/policy/security boundary; Workspace is a child and document-productivity boundary. `Organization.defaultWorkspaceId` is the authoritative default pointer and is introduced through additive nullable-field/backfill/validation migration.
2. **Project contains Folders:** Project is a business/workflow entity; Folder is a hierarchical navigation entity. Folder may optionally belong to Project. Project is not a Folder subtype. `ProjectPermissionGrant` remains provisional and is not implied by this hierarchy.
3. **SQLite-first/PostgreSQL-ready operations:** Prisma + SQLite remains initial baseline. Define WAL, busy timeout, writer/worker concurrency, supported topology, backup/recovery, query-plan testing, and measurable PostgreSQL migration triggers before schema implementation.
4. **Autosave draft versus durable version:** rolling local/server drafts are mutable and coalesced; durable versions are immutable checkpoints. Every explicit Save creates a durable version.
5. **Search adapter strategy:** `SearchIndexPort` isolates portable chunked indexed search from optional SQLite FTS5 and future PostgreSQL FTS adapters.
6. **Collaboration boundary and FK-backed grants:** M7 supports asynchronous sharing, comments, activity, optimistic concurrency, and conflict-safe saves; no CRDT/OT. `DocumentPermissionGrant` is confirmed and FK-backed. `PublicShareLink` is conditional. `ProjectPermissionGrant` remains provisional and receives no table until explicitly approved.
7. **Workspace versus embedded PDF metadata:** workspace metadata/bookmarks/attachments are distinct from embedded PDF metadata/outlines/attachments; native mutation requires feasibility proof.
8. **Document/version artifact manifest:** define source blob, editor snapshot, optional materialized PDF, checksums, manifest version, provenance, and derived-artifact relations. Autosave does not materialize permanent PDFs.
9. **Immutable blob ownership and deduplication:** preserve existing global physical byte deduplication in early M7 while enforcing tenant-scoped logical references and non-disclosure. Define immutable references, quarantine, logical quota accounting, retention, orphan cleanup, cross-tenant zero-reference deletion, and future organization-scoped migration triggers; a referenced blob cannot be deleted.
10. **Transactional outbox:** authoritative mutations and OutboxEvent commit atomically; consumers are idempotent and safely retryable.
11. **Trash, retention, restore, and purge:** define subtree behavior, version/blob retention, authorization, audit, restore conflicts, and asynchronous reference-safe cleanup.
12. **Provider-independent naming:** define Unicode normalization, case policy, reserved/invalid names, normalized columns, and scoped uniqueness for slugs, tags, folders, projects, and documents.
13. **Multi-tab editor lifecycle:** each active tab owns an isolated editor/resource bundle; suspension and restoration use `WorkspaceSession`/`WorkspaceSessionTab`, not authentication Session or shared editor services.
14. **Early notification/operation contract:** ingestion and autosave use a minimal accessible operation-state/toast/banner contract; later notification phases expand it. Blocking alerts are not an M7 dependency.

## 4. M7 data-model proposal

Names are finalized against existing conventions during M7.0; the semantic distinctions are mandatory.

### 4.1 Tenant and workspace

- `Organization` — unchanged top-level tenant, billing, security, organization membership, quota, audit/compliance boundary.
- `Organization.defaultWorkspaceId` — additive nullable FK to Workspace and the authoritative default-workspace pointer. Migration order is add nullable field → create/backfill one Workspace per existing Organization → validate same-Organization ownership and uniqueness expectations → set pointers → only later tighten constraints where SQLite rebuild safety is proven. No Workspace-local default flag participates in authority. Omit such a field unless a later proven cache requirement defines it solely as a transactionally validated projection of `Organization.defaultWorkspaceId`.
- `Workspace` — `organizationId`, name, normalized slug, description, workspace settings, lifecycle timestamps/state.
- `WorkspaceMembership` — explicit workspace grants only: `workspaceId`, `userId`, role (`owner | editor | commenter | viewer`), revocation/deny state where needed, timestamps; unique `(workspaceId,userId)`. Default-workspace inheritance is derived from Organization membership instead of persisted as duplicate WorkspaceMembership rows.

### 4.2 Organization hierarchy

- `Project` — exactly one Workspace; business context, status/lifecycle, description, owner/team, deadline, ordering, archive/trash state.
- `Folder` — exactly one Workspace; optional Project; optional parent Folder; name, ordering, color/icon, archive/trash state.
- `DocumentRecord` — authoritative logical document identity; exactly one Workspace; optional Project and Folder; normalized/display name, owner/creator, MIME, size/page count, favorite/status/archive/trash, current durable version, optimistic revision, timestamps.

Invariants:

- Project, Folder, parent Folder, and DocumentRecord references always share a Workspace.
- Folder cycles are prevented before every move and protected transactionally.
- A Project move/archive/trash operation preserves its hierarchy as one metadata operation.
- Documents may live directly in a Project, in a Folder, or in a Workspace Folder; ambiguous invalid combinations are rejected by service policy.

### 4.3 Persistence and recovery

- `DocumentVersion` — immutable snapshot with safely allocated monotonic document version number and a versioned artifact manifest. The manifest identifies source PDF/blob, editor-state snapshot, optional materialized output PDF, per-artifact checksums, provenance, and relationships to thumbnails/search/statistics. `Document.currentVersionId` and denormalized size/page/thumbnail fields update in the same transaction as version creation. Rolling autosave never forces permanent PDF materialization.
- `AutosaveDraft` — one initial server policy: metadata row plus bounded object-storage editor-state snapshot, scoped per document/user, with base version, expected document/draft revision, blob/checksum, status, timestamps, and expiry. Large repeated editor-state JSON is not stored in SQLite.
- `WorkspaceSession` — user/workspace restorable session envelope, versioned bounded validated payload metadata, active tab/pane identity, timestamps.
- `WorkspaceSessionTab` — ordered tab descriptor with document/version IDs, active page, viewport, tool/UI state, dirty/suspended flags. Session payloads never contain source PDF bytes or page backgrounds.

### 4.4 Discovery, collaboration, and metadata

- `Tag`, `DocumentTag` — workspace-scoped tag catalog and document associations.
- `SmartCollection` — workspace/owner, name, versioned and validated query definition; membership is dynamic, not duplicated rows.
- `CommentThread` — `id`, `workspaceId`, `documentId`, optional `versionId`, `anchorType`, versioned validated anchor payload, status, `resolvedById`, `resolvedAt`, and timestamps. Resolution and anchor ownership belong to the thread. Anchors degrade to an explicit orphaned/approximate state when a referenced page, editor object, or version is unavailable; they never silently retarget.
- `CommentMessage` — `id`, `threadId`, `authorId`, bounded body, created/updated/edited/deleted timestamps. Replies are ordered messages in a thread, not nested thread records.
- `DocumentPermissionGrant` — confirmed FK-backed document grant with principal, capability/role, expiry/revocation. `ProjectPermissionGrant` is provisional and must not become a Prisma table until project-level sharing is explicitly confirmed before M7.2 or M7.10. Avoid unchecked polymorphic resource pointers without referential integrity. Workspace access uses WorkspaceMembership. A separate FK-backed `PublicShareLink`, if public links are approved, stores only a hashed, revocable opaque token and explicit expiry/scope.
- `ActivityEvent` — actor, action, target, bounded metadata, timestamp; security-sensitive events also use existing organization audit infrastructure.
- `OutboxEvent` — committed atomically with authoritative DB mutation; versioned payload, aggregate identity/revision, idempotency/dedup key, status/attempt/lease timestamps. Indexing, thumbnails, metadata, statistics, comparison, notifications, activity/audit propagation, and cleanup consume outbox events idempotently.
- `SearchDocument`, `SearchChunk` — SearchDocument identifies workspace/document/version/index schema/checksum/state; bounded SearchChunks preserve page/source/kind/order and normalized content for PDF text, OCR, annotations, comments, bookmarks, outlines, and metadata. No single unbounded text body.
- `AttachmentRecord` — workspace/document/version, `StoredFile`, workspace/native classification, metadata.
- `DocumentMetadata` — version-aware normalized metadata/properties, explicitly identifying workspace-derived versus embedded-PDF origin.
- Version-specific statistics record or cache — page/text/image/annotation/editor-object counts and derived values with schema/checksum validity.

### 4.5 Identity distinctions

- **Document identity:** stable `DocumentRecord.id` across versions.
- **Current version:** pointer on DocumentRecord to latest accepted durable snapshot.
- **Durable version:** immutable DocumentVersion.
- **Rolling draft:** replaceable recovery state, never a version-number increment.
- **Open tab:** in-memory editor/resource owner for one document/version context.
- **Restorable session:** bounded persistence recipe for rebuilding tabs/panes; not a live editor instance.

## 5. Authorization matrix

Organization and workspace roles are separate. Exact server-side workspace-access precedence is mandatory:

1. Missing, deleted, suspended, disabled, or otherwise unauthorized Organization → deny.
2. Archived/trashed Workspace → apply an explicit lifecycle policy: default deny writes; allow only specifically authorized read/restore/admin operations.
3. Explicit workspace deny or revoked grant → deny.
4. Active explicit WorkspaceMembership → use its explicit workspace role.
5. If this is `Organization.defaultWorkspaceId`, derive inherited workspace access from OrganizationMembership.
6. An active FK-backed DocumentPermissionGrant may grant only that document scope after same-Organization/same-Workspace validation and cannot bypass organization/workspace lifecycle denial or an explicit workspace deny. ProjectPermissionGrant follows the same placement only if project-level sharing is explicitly approved before M7.2 or M7.10; until then it is not implemented.
7. Otherwise → deny.

Inherited access is derived, not materialized as duplicate membership rows. ADR-M7-002 test-locks the initial mapping: Organization owner → inherited Workspace owner; Organization admin → inherited Workspace editor plus explicit organization-admin management capabilities; Organization member → inherited Workspace editor; Organization viewer → inherited Workspace viewer. Organization admin does not receive workspace ownership transfer, workspace deletion, permanent purge, or destructive retention override unless separately approved. Explicit deny always wins.

| Capability | Workspace owner | Editor | Commenter | Viewer |
| --- | --- | --- | --- | --- |
| View/search/open permitted documents | Yes | Yes | Yes | Yes |
| Download permitted documents | Yes | Yes | Yes | Yes, unless policy disables |
| Create/upload documents, folders, projects | Yes | Yes | No | No |
| Edit document content/metadata | Yes | Yes | No | No |
| Explicit Save/create durable version | Yes | Yes | No | No |
| Move, archive, trash, restore | Yes | Yes | No | No |
| Create/edit own comments/replies | Yes | Yes | Yes | No |
| Resolve/reopen threads | Yes | Yes | Policy-limited | No |
| Tags/bookmarks/session state | Yes | Yes | Own state where applicable | Own bookmark/session state |
| Share documents/projects | Yes | Configurable; default No | No | No |
| Manage members/settings | Yes | No | No | No |
| Transfer/delete/purge workspace | Yes with explicit policy/confirmation | No | No | No |
| Inspect metadata/security/signature presence | Yes | Yes | Yes | Yes when document-visible |

Mandatory enforcement:

- Every server use case receives actor + organization/workspace context and scopes all repository predicates by tenant/workspace.
- Resource IDs alone never authorize access.
- Search applies authorization before results, counts, facets, snippets, or existence signals are produced.
- Signed URLs are generated only after authorization and have short TTLs.
- Cookie-authenticated mutations enforce the project’s CSRF/origin policy.
- Share tokens are opaque, hashed at rest, scoped, expiring/revocable, and audited.
- Job payloads are created from trusted authorized records and include organization/workspace/document/version identity.
- Cross-workspace references, including folder/project/document moves, are rejected server-side and transactionally.

## 6. Storage and version model

### 6.1 Logical versus physical identity

`StoredFile` remains physical object metadata. `DocumentRecord` is the stable logical identity. `DocumentVersion` references immutable stored source bytes and, when needed, immutable serialized editor state. Thumbnails, comparison output, search extraction, and statistics are derived artifacts keyed by document version/checksum.

### 6.2 Commit protocol

Never hold a database transaction while streaming an object:

1. Validate authorization, filename, MIME/signature, size/quota, and expected revision.
2. Stream into a staged/content-addressed object and compute checksum.
3. Create/reuse StoredFile metadata according to dedup/reference policy.
4. In a short DB transaction, re-check revision, allocate the next version number, insert the immutable version/manifest links, update `Document.currentVersionId`, revision, size/page/thumbnail projections, and atomically append versioned OutboxEvents. Version-number unique conflicts are retried by re-reading the authoritative counter/current state within a bounded retry policy; no `max+1` allocation occurs outside the transaction.
5. Dispatch idempotent derived work from committed OutboxEvents after commit. Idempotency keys are scoped by actor, Organization, Workspace, operation, and canonical request hash.
6. On failure, execute compensating cleanup or leave a marked staged object for a retention sweeper; never leave an untracked permanent object.

Early M7 preserves existing global physical content-addressed byte deduplication. Authorization remains tenant-scoped and reference-based: possession of a checksum/key or a physical match grants no access and reveals no other tenant existence, ownership, name, or metadata. APIs never disclose cross-tenant deduplication. `StoredFile` remains immutable physical metadata; DocumentRecord, DocumentVersion, AutosaveDraft, AttachmentRecord, and derived artifacts own tenant-scoped logical references. User-visible quota should initially use logical referenced bytes per Organization, with physical bytes tracked separately for infrastructure cost, unless a documented hybrid is approved. Purge removes logical references transactionally and emits outbox cleanup; bytes are deleted only after authoritative zero-reference checks across every tenant plus retention/legal-hold validation. Organization-scoped physical dedup remains a future compliance migration option. See ADR-M7-006.

### 6.3 Restore

Restoring an old version creates a new immutable version with `restoredFromVersionId`, updates DocumentRecord’s current-version pointer/revision and denormalized fields transactionally, and writes reconciliation OutboxEvents. Consumers invalidate/rebuild or safely reconcile all open-tab bases, local/remote drafts, search chunks, statistics, thumbnails, and comparison artifacts. Existing history is never overwritten; open clients receive a revision conflict/recovery state rather than silent reload.

## 7. Autosave state machine

### 7.1 Local IndexedDB draft

States:

`clean → dirty → local-saving → locally-saved`

Error/lifecycle branches:

- `local-saving → local-failed → retry-wait → local-saving`
- schema/identity mismatch → `recovery-review`
- accepted durable save → `clean` after checksum/revision confirmation

Stored fields include device ID plus workspace/user/document identity, base durable version, base document revision, editor serialization schema, checksum, dirty timestamp, and bounded serialized state. IndexedDB keys are partitioned by user/workspace/document/device. Writes are debounced/coalesced and lifecycle-flushed where safely possible. Drafts are cleared or quarantined on logout, account switch, access revocation, document deletion, or incompatible schema.

### 7.2 Remote rolling draft

States:

`idle → pending → saving → saved`

Additional states:

`offline`, `retry-wait`, `conflict`, `failed`, `stale`.

Each request carries idempotency key, base durable version, expected document revision, expected draft revision, and checksum. Duplicate delivery is safe. Autosave does not create a durable version.

### 7.3 Explicit Save

Every explicit Save:

1. Flushes and validates editor state.
2. Stages required immutable objects.
3. Performs compare-and-swap against expected document revision/base version.
4. Creates exactly one immutable durable version and advances document revision.
5. Marks matching drafts clean/superseded.
6. Emits activity/audit and idempotent derived jobs.

If compare-and-swap fails, both local and remote states are preserved. The local submission becomes a recoverable conflict draft/version candidate; the user receives explicit options. Silent last-write-wins is forbidden.

Meaningful non-explicit checkpoints—named version, restore, conflict resolution, close checkpoint, and policy-controlled idle checkpoint—have explicit policy and provenance. Frequent autosave remains rolling.

### 7.4 Recovery precedence

On reopen/session restore, compare local draft, remote draft, and durable current version by identity, base revision, checksum, and timestamp. Show a recovery dialog with explicit choices (recover local, use server draft, use durable version, duplicate where necessary). Do not overwrite a conflicting state before resolution.

Same-document browser tabs coordinate autosave ownership through `navigator.locks` where available. An expiring local lease with owner ID, fencing generation, heartbeat, and expiry is the fallback; takeover requires observed expiry plus a new fencing generation, and server compare-and-swap rejects stale owners. Lease duration uses monotonic elapsed time where available; wall-clock skew never overrides server revision authority. A crashed tab is recovered after lock release or lease expiry. `BroadcastChannel` carries dirty/saved/conflict/revocation notifications but is not authoritative. Server revisions and actor/organization/workspace/operation/canonical-request-hash-scoped idempotency keys remain authoritative. Page-lifecycle remote save is best-effort; local IndexedDB persistence is the primary crash-safety mechanism.

## 8. Search/index architecture

### 8.1 Ports and services

- `SearchIndexPort`
- `SearchQueryService`
- `SearchIndexer`
- `SearchDocumentRepository`
- `SearchJobPort`

Application/domain code does not contain `MATCH`, `tsvector`, or database-specific search syntax.

### 8.2 Phases

A. **Portable metadata index:** normalized filename/title, tags, folder, project, owner, status, favorite, dates, size, page count, metadata.

B. **Portable content index:** extracted PDF text, existing OCR text, annotations, comments, bookmarks, outline titles, with version/checksum/index-schema tracking.

C. **Optional SQLite FTS5 adapter:** only after runtime/build/deployment feasibility is verified.

D. **Future PostgreSQL FTS adapter:** documented readiness target; not an initial M7 prerequisite.

### 8.3 Safety and consistency

- Authorization is part of the query contract.
- Indexing jobs are idempotent, retryable, duplicate-delivery safe, bounded, and version-aware.
- Restore/new version invalidates and rebuilds affected index records.
- Trash/archive/share changes update visibility without leaking stale results.
- Authorization filters eligible DocumentRecords before returning results, counts, snippets, facets, or existence signals.
- SearchChunk rows are bounded and preserve `sourceType`, page number, ordinal, bounded original text, normalized text, and optional validated anchor metadata for page-aware/source-aware snippets and incremental deletion/reindexing.
- Stale/failed index state is visible and recoverable.
- Snippets are escaped; highlighting is returned as structured ranges, never unsafe HTML.
- Unicode, special characters, oversized text, malformed extraction, and 10,000-document datasets are tested.

## 9. Session and tab lifecycle

Each active tab owns:

- independent `EditorDocumentService` and CommandHistory,
- document/version/base revision identity,
- source bytes and rendered backgrounds,
- active page, viewport, selection/tool/UI state,
- autosave/dirty/conflict state,
- resource handles and cancellation controllers.

Lifecycle:

`descriptor → loading → active ↔ background → suspended → restoring → active → closing → disposed`

Failure branches include `load-failed`, `recovery-required`, and `conflict`. Suspension serializes bounded session/editor state and releases source/background/object-URL/PDF.js resources. Closing a dirty tab requires successful checkpoint/recovery preservation or explicit informed discard. No editor history/state/resource is shared between tabs.

`WorkspaceSession` and `WorkspaceSessionTab` store a schema-versioned, bounded, fully validated restoration recipe, active tab/pane, and bounded navigation/UI state. They never store source PDF bytes or page backgrounds and never pretend a session is a durable document version. `/editor` continues to mount the existing standalone single-document path.

Split view composes two pane references over the tab/session model. Synchronized scroll/zoom uses source-tagged updates or sequence IDs to prevent feedback loops and is opt-in when documents differ.

### 9.1 Workspace navigation history

`WorkspaceNavigationEntry` stores bounded, versioned navigation targets for page/bookmark/comment/search jumps. It contains only validated resource IDs and lightweight navigation metadata, never source bytes, images, page backgrounds, or unbounded editor resources.

## 10. Database migration strategy

1. Keep existing Organization IDs and semantics unchanged.
2. Add Workspace, explicit WorkspaceMembership, and nullable `Organization.defaultWorkspaceId` in an additive migration with required indexes. The Organization pointer is the sole default-workspace authority.
3. Add an idempotent provisioning/backfill command that creates exactly one default Workspace per existing Organization, validates same-Organization ownership, sets `Organization.defaultWorkspaceId`, and records progress in short transactions. Tightening occurs only after validation.
4. Provision personal Organization + default personal Workspace idempotently for users requiring personal tenancy.
5. Add Project, Folder, and DocumentRecord with nullable/staged relationships where required.
6. Do not migrate StoredFile rows blindly into documents; only records with verified document semantics are associated. Anonymous/tool temporary files retain existing behavior unless explicitly ingested.
7. Add versions/drafts, then tags/search/comments/sessions/attachments/metadata in phase-owned additive migrations rather than one oversized migration.
8. Backfill and validate before tightening nullable fields or adding constraints that require SQLite table rebuilds.
9. Test fresh install; upgrade from each checked-in migration state; repeat/idempotent backfill; interrupted backfill; seed; Prisma generate; application rollback; backup/restore.
10. Add provider-independent normalized columns and scoped unique/index contracts. Define Unicode normalization form, case-folding policy, whitespace/reserved-name rules, display-name preservation, and collision behavior for workspace slugs, tags, folders, projects, and documents before migration.
11. Add access-pattern indexes, including workspace/update, workspace/folder, workspace/project, workspace/owner, favorite/archive/trash, document/version number, document tags, comments, drafts, sessions, outbox status/lease, and search document/chunk version/checksum.
12. SQLite supports one writable application deployment per local database, no multi-instance writers, and no network/shared-filesystem database. ADR-M7-009 defines verified WAL use, explicit busy timeout, short transactions, bounded outbox/index writers, backup/recovery, migration locking, query-plan tests, and PostgreSQL triggers. Numeric latency/concurrency capacity remains explicitly unmeasured until the M7 workload benchmark is authorized; do not claim it before measurement.
13. Produce a PostgreSQL-readiness report before M7 completion covering schema compatibility, migration, full-text adapter, isolation, uniqueness, timestamps/case behavior, connection pooling, workers, and rollback.

### 10.1 Portable name normalization contract

A shared domain/application normalization service is the only source for normalized uniqueness values. Initial policy to record in ADR and test vectors:

- Unicode normalization: NFKC for matching/uniqueness while preserving the original display value.
- Whitespace: trim ends, collapse Unicode whitespace runs to one ASCII space for normalized names; slugs use a single hyphen separator.
- Case: locale-independent Unicode case folding; never rely on SQLite/PostgreSQL default collation.
- Reject NUL, C0/C1 controls, bidi override/isolate controls unless explicitly justified, path separators for storage-facing names, dot-only/empty results, and platform-reserved names where exported filenames are affected.
- Define per-entity UTF-8/code-point length limits in the ADR and enforce before DB/storage use.
- Slugs are generated deterministically from normalized input, use a bounded ASCII-safe representation, and resolve collisions with deterministic suffixes under scoped uniqueness.
- Scoped normalized uniqueness: workspace slug within Organization; project/folder/tag/smart-collection/document name according to their parent/workspace business rule. Collision errors are stable and provider-independent.

### 10.2 Trash, retention, restore, and purge contract

Trash is reversible metadata state with `trashedAt`, `trashedById`, original folder/project location, `purgeAfter`, and retention-policy override. Trashing a Project/Folder applies explicit subtree visibility semantics without deleting versions, comments, activities, attachments, or blobs. Restore prefers the recorded location, falls back to an authorized workspace recovery location if the parent no longer exists, and resolves normalized-name collisions explicitly. Permanent purge is a separate owner/policy-authorized, confirmed, audited asynchronous operation; it preserves required audit/legal records, removes logical references transactionally, emits OutboxEvents, and deletes blobs only after retention and zero-reference validation.

### 10.3 Required implementation invariants

- `Document.currentVersionId`, document revision, current size, page count, checksum, and derived-artifact revision pointers update transactionally with version creation where applicable.
- Monotonic version allocation uses a transaction-safe counter/allocation rule and bounded unique-conflict retry.
- Idempotency keys are scoped by actor, Organization, Workspace, operation, and canonical request hash.
- IndexedDB drafts are partitioned by user/Workspace/Document/device and cleared or quarantined on logout, account switch, revocation, deletion, or incompatible schema.
- Page-lifecycle remote saving is best-effort; IndexedDB recovery is primary crash safety.
- Restoring a version invalidates or reconciles tabs, drafts, search, statistics, thumbnails, comparison artifacts, and open WorkspaceSessions.
- WorkspaceSession payloads are schema-versioned, bounded, validated, and never contain source PDF bytes, image data URLs, page backgrounds, or unbounded editor resources.
- Explicit Save always creates an immutable durable version; autosave never increments durable version numbers.
- Every storage/database split operation has compensating cleanup or durable outbox-based reconciliation.

## 11. Phased implementation plan

Every phase must document the required categories: objective, user flows, domain model, API contract, database changes, storage impact, authorization, jobs, search, autosave/version impact, security, accessibility, mobile, performance, tests, migration/rollback, expected files, acceptance criteria, and gates. “No impact” must be explicit rather than omitted.

### M7.0 — Baseline, repository discovery, ADRs, and threat model

- **Objective/user flows:** establish a trustworthy M6 disk baseline and approved M7 architecture before feature edits.
- **Domain/API/DB/storage:** no feature schema change. Map existing auth, data, storage, worker, editor, API, UI, and test contracts.
- **Authorization/security:** create threat model for tenant isolation, IDOR, CSRF, share tokens, signed URLs, unsafe upload/path names, indexing leakage, job trust, resource exhaustion, retention/purge, and recovery confidentiality.
- **Required artifacts:** `docs/milestone-7-current-architecture.md`, corrected `docs/milestone-7-plan.md`, `docs/milestone-7-threat-model.md`, `docs/milestone-7-risk-register.md`, ADRs listed in section 3 (including transactional outbox, durable artifact manifest, immutable blob lifecycle, SQLite operations, trash/retention/purge, normalization, and early operation state), data-model/migration proposal, exact access-precedence matrix, and autosave/version diagrams.
- **Tests/gates:** sequential `npx prisma validate`, `npx prisma generate`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`; exact exit status/counts/durations/warnings/stderr/routes/Prisma/worker evidence; repository hygiene; `npm audit` without `--force`; stop on any red gate. M7.0 current evidence stopped at a red test gate, so build was not run.
- **Manual evidence:** label browser-emulated, physical-device, screen-reader, automated, inferred, and unverified checks honestly.
- **Expected files:** docs/ADRs only unless a baseline defect requires a separately explained repair.
- **Acceptance:** M6 must be green on current disk before M7.1. Latest M7.0 rerun passed Prisma, typecheck, lint, and all tests but is still red because `next build` detected another running build process. Architecture contradictions are reported explicitly and all mandatory amendments are incorporated; stop for review before another baseline attempt, Prisma migration, or M7.1 schema implementation.

### M7.1 — Workspace foundation

- **Objective/flows:** list/select/create/update/archive workspaces; enter `/workspaces/[workspaceId]`; manage members/settings according to role.
- **Domain/DB:** Workspace, explicit WorkspaceMembership, Organization.defaultWorkspaceId, roles/capabilities, default-workspace provisioning/backfill. No inherited membership duplication.
- **API:** authenticated workspace CRUD/list/current, member list/update/remove, settings, cursor pagination, authoritative revision/error envelopes.
- **Storage/jobs/search/autosave:** no document bytes yet; optionally provision asynchronous backfill only if required and idempotent; no search data.
- **Security:** implement the exact seven-step precedence in section 5, including archived/trashed Workspace policy and resource-grant placement; cross-tenant IDOR tests, CSRF/origin, audit membership/settings changes.
- **A11y/mobile/performance:** semantic workspace switcher, keyboard/focus behavior, responsive shell, bounded/cursor lists.
- **Migration/rollback:** additive tables + idempotent one-default-per-Organization backfill; preserve Organizations.
- **Expected files:** `prisma/schema.prisma`, new migration(s), `src/{domain,application,infrastructure}/workspace/`, DI tokens/container, `app/workspaces/`, `app/api/workspaces/`, `components/workspace/`, tests.
- **Acceptance/gates:** every existing Organization has one default Workspace; role override/inheritance is deterministic; no tenant leakage; focused tests + typecheck/lint + full checkpoint.

### M7.2 — Projects and folder hierarchy

- **Objective/flows:** create/edit projects; nested folders; breadcrumbs; keyboard/drag-drop move, copy, duplicate; archive/trash/restore hierarchy.
- **Domain/DB:** Project and Folder, normalized-name columns, parent/project/workspace invariants, order/lifecycle/trash fields.
- **API:** transactional create/rename/move/copy/duplicate/archive/trash/restore and cursor tree/list queries; idempotency for bulk moves. Trash is soft deletion with subtree visibility semantics; restore validates destination/name collisions; permanent purge is separately authorized/audited and emits asynchronous reference-safe cleanup.
- **Storage/jobs/search/autosave:** metadata-only initially; no binary move; hierarchy changes later invalidate path facets.
- **Security:** same-workspace validation, cycle prevention, destination authorization, project-level permission hooks.
- **A11y/mobile/performance:** tree semantics, breadcrumbs, keyboard alternative to drag/drop, touch target/announcement support, lazy subtree loading.
- **Migration/rollback:** additive tables; no destructive existing-data move.
- **Expected files:** workspace domain/use cases/repositories/APIs, hierarchy UI, drag-drop/keyboard logic, tests.
- **Acceptance/gates:** cycles/cross-workspace references impossible; hierarchy operations are transactional and recoverable; property/concurrency/a11y tests green.

### M7.3 — Document records and professional file manager

- **Objective/flows:** list/grid/compact modes, columns, sort/filter, selection, bulk actions, favorite/recent/shared/archive/trash views, restore and retention-aware purge.
- **Domain/DB:** DocumentRecord, lifecycle/status/current-version placeholders, favorite/recent/share projections where appropriate.
- **API:** cursor document lists with deterministic tie-breaker; metadata mutations; bulk operation contract with per-item results and operation IDs.
- **Storage:** DocumentRecord remains separate from StoredFile; trash retains versions/blobs through policy; restore preserves references; permanent purge removes logical references transactionally and delegates zero-reference deletion through outbox cleanup. No unsafe implicit byte deletion.
- **Authorization:** every view/filter/count and bulk item is scoped; shared view reflects active grants only.
- **Search/autosave:** metadata query seam prepared; no content indexing or drafts yet.
- **A11y/mobile/performance:** accessible table/grid semantics, column controls, list virtualization threshold, bulk-action focus/announcements, compact mobile controls.
- **Migration/rollback:** additive DocumentRecord schema; no blind StoredFile conversion.
- **Expected files:** document domain/repositories/APIs, file-manager views/components/hooks, cursor/virtualization helpers, tests.
- **Acceptance/gates:** professional views are correct and tenant-safe at scale; bulk partial failures are explicit; focused + full checkpoint green.

### M7.4 — Workspace-aware upload and ingestion

- **Objective/flows:** upload to Workspace/Project/Folder, retry/cancel, progress, dedup, metadata/page count/thumbnail processing, failed-ingestion cleanup.
- **Domain/DB:** ingestion status, source StoredFile association, derived-artifact records/status as needed.
- **API:** multipart/stream initiation, completion, cancel/retry/status; validated destination/revision/idempotency.
- **Storage/jobs:** staged/quarantined commit protocol; authoritative mutation plus OutboxEvent in one DB transaction; idempotent metadata extraction, page-count, thumbnail, checksum, cleanup, notification, activity, and audit consumers; bounded leases/concurrency and reference-safe cleanup sweeper.
- **Authorization/security:** quota and destination access, MIME/signature validation, filename/path safety, decompression/resource bounds, signed URL policy.
- **Search/autosave/version:** creates initial durable upload version according to explicit import policy; enqueue initial index later through a stable event contract.
- **A11y/mobile/performance:** introduce the minimal non-blocking notification/operation-state contract here for accessible progress/cancel/retry/failure; no blocking alerts. Support mobile file picker, streamed bytes, and no DB transaction during upload.
- **Migration/rollback:** additive ingestion/artifact fields; staged objects are reclaimable after rollback.
- **Expected files:** semantic storage ports, UploadService integration, workspace job handlers, API routes, operation UI, tests.
- **Acceptance/gates:** interruption/duplicate/retry/cancel/cleanup are safe; large and malformed inputs bounded; source and metadata cannot split silently.

### M7.5 — Autosave and crash recovery

- **Objective/flows:** dirty indicator, local IndexedDB draft, optional remote rolling draft, offline retry, reload/crash recovery dialog, conflict preservation.
- **Domain/DB:** AutosaveDraft metadata row plus bounded object-storage snapshot and revision/checksum state machine; partitioned versioned client local-draft schema.
- **API:** conditional draft read/write/delete/recover with idempotency and expected revisions.
- **Storage/jobs/search:** bounded serialized state may use object storage; no derived jobs for each autosave; no search indexing on transient drafts by default.
- **Authorization/security:** drafts are user/document/workspace scoped; encrypted transport; no cross-account recovery; malicious serialized state revalidated.
- **Version impact:** autosave never increments durable version; accepted explicit/close policy checkpoints clean/supersede drafts.
- **A11y/mobile/performance:** reuse the early non-blocking operation/status contract; accessible recovery/conflict dialogs; `navigator.locks` ownership with expiring-lease fallback and BroadcastChannel notifications; mobile lifecycle/offline behavior; page-lifecycle remote save is best-effort; local durable recovery is primary; debounce/coalesce/bounded storage.
- **Migration/rollback:** additive draft table; IndexedDB schema migrations preserve or quarantine incompatible drafts.
- **Expected files:** domain state machine, draft repositories/services/APIs, IndexedDB adapter, workspace editor host/hooks/dialogs, tests.
- **Acceptance/gates:** crash/reload/offline/concurrent-tab states preserve work; conflicts never overwrite either side; drafts are cleared/quarantined on logout, account switch, revocation, and incompatible schema; browser E2E added if justified.

### M7.6 — Durable version history

- **Objective/flows:** explicit Save, named/labeled/note checkpoint, version timeline, restore, duplicate, close/idle policy checkpoint, comparison entry point.
- **Domain/DB:** immutable DocumentVersion with versioned artifact manifest, bounded monotonic allocator with unique-conflict retry, provenance, current-version pointer, optimistic DocumentRecord revision, and same-transaction denormalized size/page/thumbnail updates.
- **API:** create/list/read/label/restore/duplicate versions with compare-and-swap and idempotency.
- **Storage/jobs/search:** immutable source/editor-state references, dedup/reference accounting; restore/new version invalidates/rebuilds derived artifacts.
- **Authorization/security:** editor/owner creates/restores; version visibility follows document access; immutable bytes/history; audit sensitive restores/purges.
- **Autosave:** explicit Save always creates one version; conflict submission becomes recoverable state; restore creates a new version.
- **A11y/mobile/performance:** accessible timeline and restore confirmation; cursor history; lazy details/thumbnails.
- **Migration/rollback:** additive version schema; backfill initial version only for verified ingested documents; rollback preserves bytes/history.
- **Expected files:** version domain/services/repos/APIs/timeline UI/storage orchestration/outbox consumers/tests plus durable-artifact-manifest ADR.
- **Acceptance/gates:** immutability, monotonicity, restore provenance, dedup safety, concurrent save conflicts, and editor v1–v6 compatibility proven.

### M7.7 — Tags and smart collections

- **Objective/flows:** create/manage tags, bulk tag documents, build/save/edit collections, dynamic membership.
- **Domain/DB:** Tag, DocumentTag, SmartCollection with versioned validated query AST/string.
- **API:** scoped tag CRUD/assignment and smart collection validation/preview/list.
- **Storage/jobs/autosave/version:** metadata-only; no byte/draft/version change.
- **Search:** tag and collection filters use search/query ports; changes update index facets idempotently.
- **Security/A11y/mobile/performance:** no unsafe query execution; scope all tags/collections; accessible chips/builder; compact mobile controls; indexed joins and cursor results.
- **Migration/rollback:** additive models; query-definition version supports future migration.
- **Expected files:** domain/query validation, repositories/APIs, tag and builder UI, tests.
- **Acceptance/gates:** invalid/expensive queries rejected, membership remains dynamic and authorized, bulk tagging is transactional/idempotent.

### M7.8 — Search and indexing

- **Objective/flows:** global workspace search across approved metadata/content; filters, snippets, structured highlights, stale/reindex status.
- **Domain/DB:** SearchDocument plus bounded SearchChunk records with version/checksum/schema/status/page/source/order; SearchIndexPort and query/index services.
- **API:** authorized query with cursor, facets/filters, structured snippets/highlights, status/reindex endpoints.
- **Storage/jobs:** bounded extraction/index jobs; idempotent retry/duplicate handling; cancellation where extraction is long.
- **Authorization/security:** authorization before counts/snippets/facets; escaped snippets; bounded terms/text; no cross-workspace leakage.
- **Autosave/version:** index durable current versions and approved collaboration metadata; restore/new version reindexes; transient draft indexing excluded unless separately approved.
- **A11y/mobile/performance:** semantic results/highlights/filter controls; responsive search; debounce/cancel; benchmark 10,000 documents; optional FTS only behind adapter.
- **Migration/rollback:** additive portable index; adapter-specific setup isolated and optional.
- **Expected files:** search ports/services/adapters/jobs/APIs/UI/tests/readiness docs.
- **Acceptance/gates:** complete approved fields, authorization-safe results, Unicode/malformed/stale-index recovery, deterministic pagination, scale target green.

### M7.9 — Metadata, properties, bookmarks, outlines, and attachments

- **Objective/flows:** inspect/edit workspace metadata, workspace bookmarks/attachments; inspect and only safely mutate supported embedded PDF metadata/outlines/attachments.
- **Domain/DB:** DocumentMetadata, workspace bookmark, AttachmentRecord, origin/native-capability fields.
- **API:** workspace metadata/bookmark/attachment CRUD; native inspection/mutation endpoints only after feasibility approval.
- **Storage/jobs:** feasibility jobs for PDF-native structures; attachment streaming/checksum/quota/cleanup; version creation for any native mutation.
- **Authorization/security:** distinguish workspace versus embedded data; sanitize metadata; prevent attachment abuse; precise permission/signature wording.
- **Search/version:** index approved metadata/bookmarks/outlines/attachment names; native mutation creates durable version and reindexes.
- **A11y/mobile/performance:** accessible outline/tree/bookmark navigation, attachment controls, lazy parsing/streaming.
- **Migration/rollback:** additive records; unsupported native mutation omitted rather than faked.
- **Expected files:** feasibility reports/spikes, domain/repos/jobs/APIs/panels/tests.
- **Acceptance/gates:** capabilities are evidence-backed; signature presence never called validation; malformed/encrypted/signed corpus and round-trip tests pass.

### M7.10 — Comments, sharing, and asynchronous collaboration

- **Objective/flows:** share Workspace/Project/Document within approved scope; comment threads/replies; resolve/reopen; activity; optimistic conflict surfaces.
- **Domain/DB:** confirmed FK-backed DocumentPermissionGrant and separate PublicShareLink if approved; ProjectPermissionGrant remains provisional until explicitly confirmed before M7.2/M7.10. CommentThread has versioned validated anchor/resolution state; CommentMessage owns replies/body edits; ActivityEvent and expiry/revocation states are explicit.
- **API:** grant/revoke/list shares; thread/comment CRUD/reply/resolve/reopen; activity feed; conditional mutations.
- **Storage/jobs/search:** no heavy byte path; notify/activity jobs where durable delivery exists; comments indexed idempotently.
- **Authorization/security:** role matrix, least privilege, expiry/revocation, hashed public token if enabled, IDOR/CSRF/XSS/rate-limit/audit tests; anchors cannot expose hidden versions.
- **Autosave/version:** optimistic concurrency and conflicts integrate with drafts/versions; no CRDT/OT claim.
- **A11y/mobile/performance:** accessible thread navigation/status; touch anchors; cursor feeds, bounded thread depth/body.
- **Migration/rollback:** additive collaboration tables; revocation remains effective during rollback.
- **Expected files:** collaboration domain/repos/services/APIs/UI/notifications/tests.
- **Acceptance/gates:** all role scenarios and revocation/expiry/concurrency cases pass without data leakage.

### M7.11 — Statistics and document comparison

- **Objective/flows:** view version-specific statistics; compare documents/versions structurally, textually, visually, and by editor objects where supported; progress/cancel.
- **Domain/DB:** version-keyed statistics/comparison operation/artifact status.
- **API:** stats read/recompute; comparison create/status/cancel/result with authorized artifact download.
- **Storage/jobs:** cached derived artifacts; bounded cancellable jobs; cleanup/retention; deterministic checksum/version keys.
- **Search/autosave/version:** statistics and comparisons bind to immutable versions; new version invalidates current projections, not historical records.
- **Security/A11y/mobile/performance:** do not process inaccessible versions; safe result rendering; accessible diff navigation; responsive summary; corpus limits and worker concurrency.
- **Migration/rollback:** additive cache/operation records; derived data can be dropped/rebuilt safely.
- **Expected files:** services/jobs/processors/APIs/diff UI/tests.
- **Acceptance/gates:** deterministic, version-specific, cancellable comparison with honest limitations and large-document bounds.

### M7.12 — Multi-document tabs and session restoration

- **Objective/flows:** open/switch/reorder/close multiple documents, preserve dirty/conflict state, suspend inactive tabs, restore a prior session.
- **Domain/DB:** WorkspaceSession, WorkspaceSessionTab, and WorkspaceNavigationEntry descriptors/lifecycle with bounded schema-versioned payloads; no editor-domain rewrite.
- **API:** read/write/close session with optimistic revision and bounded payload.
- **Storage/jobs/search:** lazy source/background recreation; dispose object URLs/PDF.js resources; no job duplication on restore.
- **Authorization/security:** reauthorize every restored tab; inaccessible/revoked documents fail closed without exposing metadata.
- **Autosave/version:** dirty close preserves draft/checkpoint or requires explicit discard; session is not a version.
- **A11y/mobile/performance:** ARIA tab pattern, keyboard reorder/switch/close/focus return; mobile overflow menu; tab cap, suspension, memory profiling.
- **Migration/rollback:** additive session schema; incompatible payload versions degrade safely.
- **Expected files:** workspace editor host, tab/session coordinator, session repo/API, resource manager, UI/tests.
- **Acceptance/gates:** no cross-tab state/history/resource leakage; restore and disposal are deterministic; standalone `/editor` remains green.

### M7.13 — Split view and navigation

- **Objective/flows:** show two documents/versions, optional synchronized scroll/zoom, jump via pages/bookmarks/comments/search, back/forward navigation.
- **Domain/DB:** pane/session/navigation descriptors; bounded history.
- **API:** session persistence only; document access follows existing APIs.
- **Storage/jobs/search:** reuse tab resources and search/bookmark anchors; avoid duplicate loads.
- **Authorization/security:** each pane independently authorized; history does not leak inaccessible titles.
- **Autosave/version:** active-pane commands route to correct editor/base revision; sync never mutates content.
- **A11y/mobile/performance:** clear pane labels/active state, keyboard pane switching, responsive single-pane fallback, source-tagged sync preventing loops.
- **Migration/rollback:** optional navigation/session fields; safe fallback to one pane.
- **Expected files:** split coordinator, navigation service/hooks/UI/tests.
- **Acceptance/gates:** no feedback loops or wrong-pane actions; history/jumps restore focus and remain bounded.

### M7.14 — Command palette and professional notifications

- **Objective/flows:** search/execute context-aware commands; see disabled reasons; track upload/index/compare/restore/bulk operations; retry/cancel/undo where safe.
- **Domain/DB:** canonical command descriptors in application/UI layer; persisted operation record only where existing Job/activity is insufficient.
- **API/jobs:** operation-center reads/actions, retry/cancel with idempotency and capability checks.
- **Search/autosave/version:** command search is local metadata, not document AI search; Save command follows durable-version rule; operation notifications reflect authoritative state.
- **Security:** commands filtered and reauthorized at execution; no hidden action through palette; notification content sanitized.
- **A11y/mobile/performance:** keyboard-first dialog, focus trap/return, accessible disabled explanations and live announcements without spam, mobile command access, lazy registry/filtering.
- **Migration/rollback:** additive operation records only if justified; UI degrades to existing actions.
- **Expected files:** command registry/palette, operation center, toast/banner/dialog primitives, migration from blocking M7 alerts, tests.
- **Acceptance/gates:** one command definition powers palette/shortcut/menu availability where adopted; progress/retry/cancel/undo are truthful and accessible.

### M7.15 — Accessibility, mobile, security, and performance hardening

- **Objective:** harden all M7 flows to production quality without broad stable-system rewrites.
- **Security:** full threat-model verification—tenant isolation, IDOR, CSRF, share/signed tokens, upload/path safety, injection/XSS, job trust, retention/purge, malformed PDFs, resource exhaustion, audit.
- **Accessibility:** WCAG 2.2 AA semantics, keyboard/focus, 200–400% zoom/reflow, contrast, errors/status, reduced motion, target sizes, screen-reader verification when environment exists.
- **Mobile/touch:** responsive file manager/editor workspace, 44px coarse-pointer targets where practical, drag/drop alternatives, virtual-keyboard and lifecycle behavior, no hidden primary action.
- **Performance:** SQLite WAL/concurrent writer tests, short transactions, cursor query plans, virtualization, autosave batching, worker concurrency, large PDFs, tab memory/suspension, search/index/comparison benchmarks.
- **Tests:** focused unit/integration/security/performance/a11y suites; minimal Playwright for IndexedDB/reload/multi-tab/focus flows if justified; physical/emulated evidence labeled precisely.
- **Migration/rollback:** verify backup/restore, migrations and staged cleanup under failure.
- **Expected files:** cross-cutting fixes, benchmark/stress fixtures, test configuration only when justified, updated docs.
- **Acceptance/gates:** no unresolved critical/high or correctness/security/accessibility/performance/data-integrity medium issue; full checkpoint green.

### M7.16 — Integration, stress tests, independent review, and completion report

- **Objective:** prove M7 is complete rather than infer completion.
- **Integration/stress:** representative end-to-end flows; 10,000 document records; deep folders; large files; many versions/comments/tabs; offline/retry/conflict; queue duplicates/recovery; storage cleanup; migration upgrade/rollback.
- **Independent review:** architecture, data/backend, frontend, security, performance, accessibility/mobile, testing/QA, and docs. If specialist service remains unavailable, record that limitation and perform explicit review matrices without claiming independence.
- **Final gates:** run sequentially `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`; then hygiene and `npm audit`. Record exact counts, durations, routes, warnings/stderr, Prisma/migration state, advisories, browser/device categories, and residual debt.
- **Completion:** create `docs/milestone-7-completion.md` only after every required phase and gate genuinely passes; update project memory and checkpoint documentation; stop and do not begin M8.

## 12. Amendment traceability matrix

The actual `docs/milestone-7-plan.md` must contain this table with final section anchors, concrete ADR filenames, and every status set to `Incorporated`:

| Amendment | Plan section | ADR | Status |
| --- | --- | --- | --- |
| Organization.defaultWorkspaceId authority | Data model; migration strategy; M7.1 | `docs/adr/ADR-M7-001-default-workspace.md` | Incorporated |
| Exact access precedence and role mapping | Authorization matrix; M7.1 | `docs/adr/ADR-M7-002-workspace-authorization-precedence.md` | Incorporated |
| Project/Folder semantics | Data model; M7.2 | `docs/adr/ADR-M7-003-project-folder-model.md` | Incorporated |
| WorkspaceSession naming/lifecycle | Session/tab lifecycle; M7.12–13 | `docs/adr/ADR-M7-010-multi-tab-autosave-ownership.md` | Incorporated |
| CommentThread + CommentMessage | Sections 4.4 and M7.10 | No separate ADR required; canonical model defined directly in the M7 plan | Incorporated |
| FK-backed DocumentPermissionGrant/PublicShareLink; provisional ProjectPermissionGrant | Authorization model; M7.2/M7.10 | `docs/adr/ADR-M7-002-workspace-authorization-precedence.md` | Incorporated |
| Transactional OutboxEvent | Data model; storage/jobs; M7.4+ | `docs/adr/ADR-M7-007-transactional-outbox.md` | Incorporated |
| Durable version artifact manifest | Version/storage model; M7.6 | `docs/adr/ADR-M7-005-version-artifact-manifest.md` | Incorporated |
| Immutable blob lifecycle | Storage/version model; M7.4/M7.6 | `docs/adr/ADR-M7-006-blob-lifecycle.md` | Incorporated |
| Server draft object-storage policy | Autosave model; M7.5 | `docs/adr/ADR-M7-004-drafts-versus-versions.md` | Incorporated |
| navigator.locks and lease fallback | Autosave ownership; M7.5 | `docs/adr/ADR-M7-010-multi-tab-autosave-ownership.md` | Incorporated |
| SearchDocument/SearchChunk | Search architecture; M7.8 | `docs/adr/ADR-M7-008-search-chunking.md` | Incorporated |
| SQLite operations/PostgreSQL triggers | Migration/operations; M7.0 | `docs/adr/ADR-M7-009-sqlite-operations.md` | Incorporated |
| Trash/retention/purge | Lifecycle contract; M7.2–3 | `docs/adr/ADR-M7-011-trash-retention-purge.md` | Incorporated |
| Portable Unicode normalization | Normalization contract; M7.1–3/M7.7 | `docs/adr/ADR-M7-012-unicode-name-normalization.md` | Incorporated |
| Early notification/operation state | M7.3/M7.4/M7.12 | Plan early-operation section (expanded later; no extra ADR required by approval) | Incorporated |
| Required implementation invariants | Invariants; affected phases | Cross-referenced across ADR-M7-004/005/006/007/010 | Incorporated |
| Canonical WorkspaceMembership name | Sections 4.1, 5, M7.1 and all implementation naming guidance | `docs/adr/ADR-M7-002-workspace-authorization-precedence.md` | Incorporated |
| Safe Organization role inheritance | Section 5 authorization matrix and M7.1 | `docs/adr/ADR-M7-002-workspace-authorization-precedence.md` | Incorporated |
| Concrete threat/risk artifact paths | M7.0 required artifacts and execution boundary | `docs/milestone-7-threat-model.md`; `docs/milestone-7-risk-register.md` | Incorporated |
| Exact M7.0 command order/evidence | M7.0 gates and execution boundary | `docs/milestone-7-current-architecture.md` baseline evidence section | Incorporated |

### 12.1 M7.0 baseline evidence and disposition

- Prisma validate: exit 0; schema valid; Prisma 7 configuration deprecation warning.
- Prisma generate: exit 0; Client 6.19.3 generated in 3.20s; same warning.
- Typecheck: exit 0; no diagnostics/stderr.
- Lint: exit 0; 0 errors and 0 warnings.
- Tests: exit 0; 85/85 files and 964/964 tests passed, duration 15.51s. Expected test-only stderr was observed in the export-isolation and explicit insecure-development-secret cases; no unexpected test stderr.
- Build: incomplete after its Prisma generation passed in 3.61s. `next build` produced no compilation output for more than 32 minutes while `.next/lock` existed. The confirmed owning shell started by this run was stopped; no unrelated process was terminated. Host safety policy refused stale-lock deletion, so no route/page output exists.
- npm audit: 3 high vulnerabilities (Next through bundled PostCSS and Sharp), no critical; only an unacceptable Next 9.3.3 downgrade is suggested; no remediation performed.
- Full evidence and contradictions: `docs/milestone-7-current-architecture.md`.
- Threat model: `docs/milestone-7-threat-model.md`.
- Risk register: `docs/milestone-7-risk-register.md`.
- M7.1 recommendation: not safe to authorize until the Next build hang/lock ownership can be diagnosed safely and an uncontended rerun makes all six commands pass sequentially with current route/page evidence. See `docs/milestone-7.0-checkpoint.md`.

## 13. Risks and open feasibility questions

1. **PDF-native mutation:** confirm current libraries/toolchain can safely read/write outlines, embedded attachments, permissions/encryption metadata, embedded metadata, and signatures without invalidating documents. Mutation is not promised before spike evidence.
2. **Signature semantics:** determine whether only presence/field inspection is possible or cryptographic chain validation can be supported; wording must remain precise.
3. **Storage/DB split-brain:** finalize staged-object state, cleanup sweeper, reference counting, and retention rules across Local and R2.
4. **SQLite concurrency:** validate WAL availability, autosave/index writer contention, migration locking, and deployment topology. Escalate to PostgreSQL only if evidence requires it.
5. **Queue recovery:** design visibility-timeout/stale-processing recovery and idempotency before relying on Redis jobs for durable indexing/comparison.
6. **Workspace role inheritance:** specify exact default-workspace inheritance and explicit override/revocation precedence, including organization admin access.
7. **Project-level permissions:** decide whether M7 needs direct project grants or document/workspace grants are sufficient; do not add ambiguous inheritance.
8. **Document placement:** finalize policy for direct-project documents versus folder-contained project documents and root/unfiled documents while preserving one authoritative Workspace.
9. **Draft privacy/retention:** decide server draft expiry, local IndexedDB quota/cleanup, shared-device logout cleanup, and close/idle checkpoint policy.
10. **Session limits:** establish tab cap, suspension threshold, restoration payload versioning, and memory-pressure behavior.
11. **Search portability:** validate normalized substring/prefix query performance and optional FTS5 runtime support without coupling application services.
12. **Comparison fidelity:** define and label structural/text/visual/editor-object comparison limits; do not imply pixel or semantic equivalence beyond evidence.
13. **No-Git attribution:** maintain exact per-session checkpoint notes and generated reports because Git history is unavailable.
14. **M5 typography debt:** track independently. Only a specific proven blocker to M7 is eligible for an explicit prerequisite repair; no wholesale typography phase enters M7.

## 14. Initial execution boundary after approval

Execute M7.0 now, and only M7.0:

1. Re-read `docs/milestone-6-completion.md` and current project memory.
2. Reconfirm database, storage, auth, worker, editor, API, UI, and test architecture from disk.
3. Run sequentially and stop on red: `npx prisma validate`, `npx prisma generate`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`. Capture exact command output, exit status, counts, durations, warnings/stderr, Prisma validation/generation, routes, and worker/build evidence.
4. Run hygiene and `npm audit` without destructive or forced remediation.
5. Create the actual repository documents `docs/milestone-7-current-architecture.md`, `docs/milestone-7-threat-model.md`, and `docs/milestone-7-risk-register.md`.
6. Rewrite the actual repository document `docs/milestone-7-plan.md`; remove superseded choices rather than appending contradictory amendments.
7. Create exactly the required ADR set:
   - `docs/adr/ADR-M7-001-default-workspace.md`
   - `docs/adr/ADR-M7-002-workspace-authorization-precedence.md`
   - `docs/adr/ADR-M7-003-project-folder-model.md`
   - `docs/adr/ADR-M7-004-drafts-versus-versions.md`
   - `docs/adr/ADR-M7-005-version-artifact-manifest.md`
   - `docs/adr/ADR-M7-006-blob-lifecycle.md`
   - `docs/adr/ADR-M7-007-transactional-outbox.md`
   - `docs/adr/ADR-M7-008-search-chunking.md`
   - `docs/adr/ADR-M7-009-sqlite-operations.md`
   - `docs/adr/ADR-M7-010-multi-tab-autosave-ownership.md`
   - `docs/adr/ADR-M7-011-trash-retention-purge.md`
   - `docs/adr/ADR-M7-012-unicode-name-normalization.md`
8. Put the concrete amendment mapping table into `docs/milestone-7-plan.md` with every row marked `Incorporated`.
9. Verify the actual plan no longer contains superseded architecture: default flags as authority, persisted inherited membership rows, old session names, a single comment entity, unchecked polymorphic grants, database-then-queue delivery without outbox recovery, ambiguous inline/server drafts, notification-only writer election, an unbounded monolithic search text row, or notifications deferred entirely to late M7.
10. Report exact Prisma/gate output, test and file counts, build/routes, npm audit findings, created documents, repository contradictions, unresolved decisions, and a recommendation on whether M7.1 is safe to authorize.
11. Present all M7.0 artifacts and stop for approval.

Hard boundary: do not edit `prisma/schema.prisma`, create migrations, implement typography, begin M7.1, or begin M8.
