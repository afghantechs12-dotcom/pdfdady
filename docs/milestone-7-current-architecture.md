# Milestone 7 Current Architecture Report

**Date:** 2026-08-01  
**Scope:** M7.0 inspection and baseline evidence only. No M7.1 schema or feature work was performed.

## Executive status

The repository has reusable tenant, storage, queue, worker, editor, and API foundations, but no existing Document Workspace domain. The required M7 architecture is additive. On the latest uninterrupted sequential run, Prisma validation/generation, typecheck, lint, and all 964 tests passed. The production build gate is **not green**: after its Prisma generation, `next build` produced no compilation output for more than 32 minutes while `.next/lock` existed. The confirmed owning shell started for this run was stopped; no unrelated Node process was terminated. Host safety policy refused stale-lock deletion, so no route/page evidence exists.

## Exact baseline evidence

Commands ran sequentially in the required order.

| Command | Exit | Evidence |
| --- | ---: | --- |
| `npx prisma validate` | 0 | `prisma/schema.prisma` valid. Warning: `package.json#prisma` is deprecated and removed in Prisma 7. Environment loaded from `.env`. |
| `npx prisma generate` | 0 | Prisma Client 6.19.3 generated to `node_modules/@prisma/client` in 3.20s. Same deprecation warning. |
| `npm run typecheck` | 0 | `tsc --noEmit`; no stdout diagnostics or stderr. |
| `npm run lint` | 0 | `eslint .`; no diagnostics or stderr, therefore 0 errors/0 warnings. |
| `npm run test` | 0 | Vitest 3.2.6: **85/85 files and 964/964 tests passed. Duration 15.51s.** ZIP tests passed, including the many-entry case in 806ms. |
| `npm run build` | Incomplete | The script regenerated Prisma Client 6.19.3 in 3.61s; `next build` then produced no compile output for over 32 minutes. The owning shell was stopped. No route/page output exists. |

Expected test stderr appeared for the deliberate per-object PDF export failure-isolation case and the explicit insecure-development admin-secret fallback case. There was no unexpected test stderr. Unexpected build stderr was the concurrent-build-process guard. The previous M7.0 attempt had transient ZIP timeout/cleanup failures; the clean rerun passed them, but the build gate remains red.

## Repository integrity and hygiene

- Project root is not a Git working tree; `git status` cannot provide attribution.
- Protected-file SHA-256 before documentation work:
  - `prisma/schema.prisma`: `c548ce78b246dc64fd865296ef67fe2de4dfc7a5954fdccbe6d3ad4a3a3c30b4`
  - `prisma/seed.ts`: `5655db4ea67096db583fd0db27ef7d266df8bfbb22b5c20e56b4b86bafee6b58`
  - initial migration: `fe3d7a3c8eb687a9b9182414165eaac37da8993707687f7629f24e2ca6f80a4f`
  - password migration: `628e40a1c4f293ab7d0d75189075d113e08683e50199002972f4eb56dbcd9123`
- Exactly two migration SQL files exist.
- Zero-byte files in `app`, `components`, `hooks`, `lib`, `src`, and `docs`: 0.
- No scoped matches for placeholder assertion, `.only`, `.skip`, TODO, or FIXME.
- Console calls found in the intentional logger, editor open/export errors, development-secret warning, and per-object export failure isolation. Editor M7 flows must replace blocking alerts with the early operation contract.
- `npm ls --depth=0` completed successfully with declared top-level dependencies present.

## Database and tenancy

`prisma/schema.prisma` uses SQLite and Prisma 6.19.3. It intentionally avoids Prisma enums and JSON types for SQLite portability. Existing models include User, Organization, OrganizationMembership, authentication Session, StoredFile, Job, AuditLog, ApiKey, and Webhook. No Workspace or M7 document model exists.

Important contradiction/qualification: Prisma comments say production can switch providers while retaining an identical schema, but provider changes and migration histories are not automatic. PostgreSQL readiness requires its own validated migration/deployment process.

`LocalOrganizationProvider.create()` creates Organization and owner membership in two writes without a transaction. M7 provisioning must be atomic; M7.0 does not change this code.

## Authentication and authorization

Local authentication uses opaque `pdfdadi_session` cookies and AuthService. API routes repeat cookie extraction and authentication. Existing authorization is organization-scoped with roles `owner/admin/member/viewer` and coarse permissions. It does not provide workspace/resource precedence, explicit deny, or document grants.

M7 uses canonical `WorkspaceMembership`, derives default-workspace inheritance, and keeps organization roles separate. ADR-M7-002 specifies precedence and safe admin mapping.

## Storage and ingestion

`IObjectStorage` supports buffered and streaming methods with Local and R2 adapters. Local storage rejects path escape. `StoredFile` is physical metadata, not document identity.

Current UploadService performs global byte-level content-addressed deduplication across owners while metadata dedup is per owner. M7.0 records the approved compatibility decision: preserve this physical optimization early in M7; all DocumentRecord, DocumentVersion, AutosaveDraft, AttachmentRecord, and derived artifact access is through tenant-scoped logical references. Checksums/keys/dedup results must never disclose another tenant’s existence or metadata, APIs must not disclose cross-tenant deduplication, and deletion requires zero authoritative references plus retention/legal-hold validation. Quota semantics (recommended: logical referenced bytes per Organization, with physical bytes tracked separately) must be finalized before ingestion. Object storage and metadata writes remain non-atomic and can leave an orphan after failure; staged/quarantine/reconciliation is required later. Organization-scoped physical dedup remains a future migration option if compliance evidence requires it.

## Queues and workers

Configuration selects in-memory queue by default and Redis when configured. Worker infrastructure supports progress, cancellation, concurrency, and retries. Redis uses `BRPOPLPUSH`, but its own code states that a visibility-timeout reaper is a follow-up. Queue enqueue creates a database Job and then pushes Redis separately; it is not a transactional outbox. M7 derived work must consume OutboxEvent idempotently.

## APIs

The inspected API inventory contains auth, storage, jobs, tools, health, and admin routes. No workspace routes exist. Existing routes provide useful patterns for rate limits, upload validation, asynchronous status, cancellation, and signed downloads, but M7 needs shared actor resolution, resource authorization, cursor pagination, idempotency, and consistent errors.

## Editor integration

Editor format v6 and migrations v1–v6 are stable. The DI factory creates independent editor state/history per surface. `EditorWorkspace.tsx` currently owns one editor, source bytes, rendered page backgrounds, viewport/tool state, active page, and filename. This is a valid seam for WorkspaceSessionTab isolation, but source/background resource ownership must be lifted per tab. The direct `/editor` route remains independent.

No IndexedDB, `navigator.locks`, BroadcastChannel, WorkspaceSession, search index, or autosave implementation was found.

## Test infrastructure

Vitest is established with 964 tests across 85 files. No repository Playwright project was found. Minimal browser E2E should be introduced only when IndexedDB, reload, multi-tab lock/focus behavior requires it.

## Dependency audit

`npm audit --json` exited 1 with **3 high vulnerabilities, 0 critical**:

- `next` 16.2.12 is reported through bundled dependencies.
- bundled `postcss` is affected by three advisories, including source-map file disclosure.
- `sharp` <0.35.0 is affected by inherited libvips advisories.

npm reports only a semver-major/destructive `next@9.3.3` fix, which is not acceptable. No `--force` or remediation was run.

## Architecture contradictions and blockers

1. Current production-build gate is red because the captured `next build` process hung before compilation for over 32 minutes; M7.1 is not safe to authorize until one uncontended full sequence passes.
2. Global physical byte dedup is now an approved early-M7 compatibility choice, but its non-disclosure, logical quota, encryption-key, legal-hold, reference reconciliation, and safe-delete controls remain implementation gates.
3. Current enqueue path is DB-then-Redis without atomic outbox recovery.
4. Redis lacks a visibility-timeout reaper.
5. Organization creation is non-transactional.
6. Existing role model is too coarse for Workspace permissions.
7. No Workspace or document persistence exists—which supports additive design but means migration assumptions remain unproven.
8. No current route/page evidence exists because the captured build hung before compilation and was stopped.
9. Prisma config deprecation remains.
10. No Git history is available.

## SQLite operating boundary

M7.0 records one writable application deployment per SQLite database, no multi-instance concurrent writers, no network/shared-filesystem SQLite, WAL only when verified, explicit busy timeout, short bounded transactions, no streaming/PDF work in transactions, bounded outbox/index writers, and a tested backup/restore procedure. The contention benchmark covering autosave, outbox, indexing, comments/activity, version creation, and reads is unmeasured because M7.1 schema/workloads are not authorized. No numeric capacity claim is made. PostgreSQL is mandatory before multi-instance writes, shared/network SQLite, sustained lock failures after retries, repeated write-latency SLO breaches, growing backlog, or unsupported backup/recovery requirements.

## Recommendation

**Do not authorize M7.1 yet.** The captured six-command sequence passed Prisma validation/generation, typecheck, lint, and tests, but `next build` hung before compilation. The owning repository process tree was later identified and terminated without touching unrelated processes, and its stale lock was removed. A fresh run was started but its output handle was lost after session continuation, so no success is claimed. Run one fresh sequence with retained complete output to capture production routes/pages. The global physical deduplication compatibility decision is recorded in ADR-M7-006; SQLite topology and unmeasured thresholds are recorded in ADR-M7-009.
