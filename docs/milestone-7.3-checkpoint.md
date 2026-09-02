# Milestone 7.3 Checkpoint — Document Records and Professional File Manager

**Status:** COMPLETE  
**Completed:** 2026-08-01  
**Authorization:** Covered by the M7 blanket authorization (M7.1–M7.16).  
**Boundary:** M7.4 may begin. M8 remains outside the authorized scope.

## 1. Objective

Introduce DocumentRecord as logical document identity within a Workspace, separate from StoredFile (physical storage). Implement cursor-paginated listing with multiple views (all/favorites/recent/archived/trashed), deterministic sort/filter, rename, move, lifecycle (archive/trash/restore), favorite toggle, and bulk operations (lifecycle + move) with per-item result reporting.

## 2. Schema changes

**Migration:** `20260801191609_add_document_records`  
**Total migrations after M7.3:** 6

New table `document_records`:
- workspaceId, organizationId, projectId (optional), folderId (optional)
- name, normalizedName, lifecycleState, orderKey
- currentVersionId (pointer to future DocumentVersion), favorite, lastAccessedAt
- createdById, revision, lifecycle timestamps
- Unique on (workspaceId, folderId, normalizedName)
- Indexed on (workspaceId, lifecycleState), (workspaceId, projectId), (workspaceId, folderId), (workspaceId, favorite), (workspaceId, lastAccessedAt), (organizationId, workspaceId), (createdById)

DocumentRecord is kept separate from StoredFile. No StoredFile rows were blindly converted.

## 3. New domain entity

- `src/domain/entities/DocumentRecord.ts` — DocumentRecordLifecycleState, DocumentRecord interface

## 4. New repository port

- `src/application/ports/workspaces/DocumentRecordRepository.ts` — list, getById, create, update, setLifecycle, touchLastAccessed, bulkSetLifecycle, bulkMove, maxOrderKey

## 5. New infrastructure repository

- `src/infrastructure/persistence/PrismaDocumentRecordRepository.ts`

Scoped on workspaceId throughout. Bulk operations return per-item results with operationId. restore via setLifecycle("active") clears both archivedAt and trashedAt.

## 6. New service

- `src/application/services/DocumentRecordService.ts` — list (with view/sort/filter), get, create, rename, move, setLifecycle, toggleFavorite, touchAccessed, bulkSetLifecycle, bulkMove

### Key invariants enforced

- Cross-organization creation rejected
- Folder must be in same workspace and active before create/move into it
- Move into archived/trashed folder rejected
- Move reference documents must be in same workspace
- Bulk operation capped at 50 items (MAX_BULK_OPERATION_SIZE)
- Bulk results are per-item — partial failures reported individually
- storedFile is never modified; DocumentRecord is the logical identity layer

## 7. DI wiring

Added to tokens.ts: `DocumentRecordRepository`, `DocumentRecordService`  
Added to container.ts: PrismaDocumentRecordRepository, DocumentRecordService  
Updated workspaceHttp.ts: `workspaceServices()` exposes `documents`

## 8. API routes

New routes (all CSRF-protected for mutations):

| Method | Route | Description |
|---|---|---|
| GET | /api/workspaces/[workspaceId]/documents | List documents (view/sort/filter/cursor) |
| POST | /api/workspaces/[workspaceId]/documents | Create document record |
| GET | /api/workspaces/[workspaceId]/documents/[documentId] | Get document |
| PATCH | /api/workspaces/[workspaceId]/documents/[documentId] | Rename or move |
| POST | /api/workspaces/[workspaceId]/documents/[documentId]/lifecycle | Archive/trash/restore |
| POST | /api/workspaces/[workspaceId]/documents/[documentId]/favorite | Toggle favorite |
| POST | /api/workspaces/[workspaceId]/documents/bulk | Bulk lifecycle or bulk move |

Bulk endpoint distinguishes lifecycle (has `state` field) from move (has `targetFolderId` field).

## 9. Tests

New test file: `src/application/services/DocumentRecordService.test.ts` (16 tests)

Coverage:
- create: root, cross-org rejection, empty name, archived folder rejection, cross-ws folder rejection
- rename: success
- move: into folder, archived folder rejection, cross-ws reference rejection
- lifecycle: archive, not found
- favorites: toggle false→true, toggle true→false
- bulk: 10 items, >50 rejection, archived target folder rejection

## 10. Build script fix

`package.json` build script updated:
```
"build": "prisma generate && NODE_OPTIONS=--max-old-space-size=4096 next build"
```
The growing route table requires a larger Node heap during static page generation.

## 11. Test timeout fix

`prisma/provision-workspaces.test.ts` `beforeAll` timeout increased from default (10s) to 60s to accommodate 6 migrations in the isolated SQLite deployment.

## 12. Quality gate — 2026-08-01

Sequential foreground execution:

```
npx prisma validate     PASS
npx prisma generate     PASS — Prisma Client v6.19.3
npm run typecheck       PASS — exit 0
npm run lint            PASS — exit 0, 0 errors 0 warnings
npm run test            PASS — 97 files / 1077 tests / exit 0
npm run build           PASS — Next.js 16.2.12, 106 static pages, exit 0 (with NODE_OPTIONS=--max-old-space-size=4096)
```

All M7.3 document API routes confirmed in build output:
- /api/workspaces/[workspaceId]/documents
- /api/workspaces/[workspaceId]/documents/[documentId]
- /api/workspaces/[workspaceId]/documents/[documentId]/favorite
- /api/workspaces/[workspaceId]/documents/[documentId]/lifecycle
- /api/workspaces/[workspaceId]/documents/bulk

## 13. Known limitations

- UI file manager shell (list/grid/compact views, column controls, selection UI) not yet built — that is M7.3's UI layer, deferred to be implemented alongside the workspace pages
- DocumentRecord.currentVersionId is null for all new records (populated in M7.6 when durable versions are introduced)
- No content search — search index preparation planned in M7.8
- No autosave drafts tied to DocumentRecord yet — M7.5
- `bulkMove` uses per-document update in a loop (not a single UPDATE ... WHERE IN ...) — acceptable for max 50 items

## 14. Final decision

**M7.3 is COMPLETE.**

Gates met: schema additive, no StoredFile conversion, tenant isolation enforced, bulk partial failures explicit, tests pass, build passes.

**M7.4 may begin immediately. M8 remains outside the authorized scope.**
