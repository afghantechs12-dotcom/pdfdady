# Milestone 7.2 Checkpoint — Projects and Folder Hierarchy

**Status:** COMPLETE  
**Completed:** 2026-08-01  
**Authorization:** Covered by the M7 blanket authorization (all M7.1–M7.16 phases authorized).  
**Boundary:** M7.3 may begin. M8 remains outside the authorized scope.

## 1. Objective

Introduce Project as a business/workflow entity and Folder as a hierarchical navigation entity within a Workspace. Both are separate concepts. Projects have status, ordering, and lifecycle (active/archived/trashed). Folders support nested hierarchies up to depth 10 with cycle prevention, ordered via fractional lexicographic orderKeys, and breadcrumb retrieval. All operations are workspace-scoped and respect cross-organization invariants.

## 2. Schema changes

**Migration:** `20260801185338_add_projects_and_folders`  
**Total migrations after M7.2:** 5

New tables:
- `projects`: workspaceId, organizationId, name/normalizedName, slug/normalizedSlug, description, status, lifecycleState, orderKey, createdById, revision, lifecycle timestamps. Unique on (workspaceId, normalizedName) and (workspaceId, normalizedSlug). Indexed on (workspaceId, lifecycleState), (workspaceId, orderKey), (organizationId, workspaceId).
- `folders`: workspaceId, organizationId, projectId (optional), parentId (optional), name/normalizedName, orderKey, lifecycleState, createdById, revision, depth, lifecycle timestamps. Unique on (workspaceId, parentId, normalizedName). Indexed on (workspaceId, lifecycleState), (workspaceId, projectId), (workspaceId, parentId), (organizationId, workspaceId).

Both are additive migrations. No existing tables were modified.

## 3. New domain entities

- `src/domain/entities/Project.ts` — ProjectStatus, ProjectLifecycleState, Project interface
- `src/domain/entities/Folder.ts` — FolderLifecycleState, Folder interface

## 4. New repository ports

- `src/application/ports/workspaces/ProjectRepository.ts`
- `src/application/ports/workspaces/FolderRepository.ts`

## 5. New infrastructure repositories

- `src/infrastructure/persistence/PrismaProjectRepository.ts`
- `src/infrastructure/persistence/PrismaFolderRepository.ts`

Both use workspaceId scoping on every query. Folder.getAncestorIds and getDescendantIds use iterative traversal (BFS for descendants, chain-follow for ancestors).

## 6. New services

- `src/application/services/orderKey.ts` — base36 fractional indexing: `generateOrderKeyBetween(lo, hi)` and `firstOrderKey()`
- `src/application/services/ProjectService.ts` — list, get, create, update, move (reorder), setLifecycle
- `src/application/services/FolderService.ts` — list, get, create, rename, move (cycle prevention), setLifecycle, breadcrumbs

### Key invariants enforced

**Projects:**
- Cross-organization creation rejected before repository call
- Same-workspace constraint enforced in move references
- orderKey generated via fractional indexing

**Folders:**
- MAX_FOLDER_DEPTH = 10 enforced on create and move
- Cycle prevention: moving into self → rejected; moving into any descendant → rejected
- Parent must be in the same workspace (cross-workspace NotFoundError)
- Cannot create/move into archived or trashed parent
- Breadcrumbs fetched from root to target via getAncestorIds

## 7. DI wiring

Added to `src/application/di/tokens.ts`:
- `ProjectRepository`, `ProjectService`, `FolderRepository`, `FolderService`

Added to `src/application/di/container.ts`:
- PrismaProjectRepository, PrismaFolderRepository, ProjectService, FolderService registrations

Updated `src/application/services/workspaceHttp.ts`:
- `workspaceServices()` now exposes `projects` and `folders`

## 8. API routes

New routes (all CSRF-protected for mutations):

| Method | Route | Description |
|---|---|---|
| GET | /api/workspaces/[workspaceId]/projects | List active projects (cursor paginated) |
| POST | /api/workspaces/[workspaceId]/projects | Create project |
| GET | /api/workspaces/[workspaceId]/projects/[projectId] | Get project |
| PATCH | /api/workspaces/[workspaceId]/projects/[projectId] | Update or move project |
| POST | /api/workspaces/[workspaceId]/projects/[projectId]/lifecycle | Archive/trash/restore |
| GET | /api/workspaces/[workspaceId]/folders | List folders (with optional parentId filter) |
| POST | /api/workspaces/[workspaceId]/folders | Create folder |
| GET | /api/workspaces/[workspaceId]/folders/[folderId] | Get folder |
| PATCH | /api/workspaces/[workspaceId]/folders/[folderId] | Rename or move folder |
| POST | /api/workspaces/[workspaceId]/folders/[folderId]/lifecycle | Archive/trash/restore |
| GET | /api/workspaces/[workspaceId]/folders/[folderId]/breadcrumbs | Get breadcrumbs |

All audit events are best-effort fire-and-forget (`.catch(() => {})`).

## 9. Tests

New test files:

| File | Tests | Coverage |
|---|---|---|
| src/application/services/orderKey.test.ts | 9 | between, tail, head, none, tail sequence, head sequence, midpoint sequence, lo>=hi rejection |
| src/application/services/ProjectService.test.ts | 10 | list, create (normalize, cross-org rejection, empty name), update (not found), move (after ref, cross-workspace ref), lifecycle (archive, not found) |
| src/application/services/FolderService.test.ts | 12 | create (root, nested depth, max depth rejection, archived parent rejection, cross-ws parent, empty name), move (self-parent, descendant cycle, archived target), rename, lifecycle, breadcrumbs |

## 10. Quality gate — 2026-08-01

Sequential foreground execution:

```
npx prisma validate     PASS
npx prisma generate     PASS — Prisma Client v6.19.3
npm run typecheck       PASS — exit 0
npm run lint            PASS — exit 0, 0 errors 0 warnings
npm run test            PASS — 96 files / 1061 tests / exit 0 / 8.00 s
npm run build           PASS — Next.js 16.2.12, 106 static pages, exit 0
```

Build confirms all M7.2 routes present:
- `/api/workspaces/[workspaceId]/projects`
- `/api/workspaces/[workspaceId]/projects/[projectId]`
- `/api/workspaces/[workspaceId]/projects/[projectId]/lifecycle`
- `/api/workspaces/[workspaceId]/folders`
- `/api/workspaces/[workspaceId]/folders/[folderId]`
- `/api/workspaces/[workspaceId]/folders/[folderId]/breadcrumbs`
- `/api/workspaces/[workspaceId]/folders/[folderId]/lifecycle`

Intentional stderr retained (unchanged from M7.1):
1. Simulated per-object PDF drawing/export failure isolation.
2. Explicit insecure development admin-secret fallback test.

## 11. Accessibility and UI evidence

No M7.2 UI pages were added in this phase (project/folder UI is part of the workspace shell in M7.3). API routes are server-only. No browser or screen-reader evidence is claimed.

## 12. Known limitations

- Folder cycle prevention uses iterative BFS for descendants; very deep trees with many siblings will make multiple DB round-trips. This is acceptable for early M7 depths ≤ 10.
- Project slug uniqueness within a workspace may collide on rename — callers must handle the 409 response and offer a different slug. No automatic suffix generation is implemented for projects (unlike the M7.1 default-workspace provisioning path).
- Breadcrumb retrieval is N+1 queries (one per ancestor level). Bounded at depth 10 per the MAX_FOLDER_DEPTH limit.
- No UI shell or keyboard navigation for projects/folders yet — implemented in M7.3.

## 13. Final decision

**M7.2 is COMPLETE.**

All acceptance criteria met:
- Project and Folder are separate concepts with separate tables.
- Nested folder hierarchy up to depth 10 with cycle prevention.
- Cross-workspace references rejected before repository mutation.
- Folder cycles are impossible (descendant check + self-parent check).
- Ordering via fractional lexicographic orderKey with keyboard-operable move API (afterId/beforeId).
- Lifecycle (archive/trash/restore) with actor recording.
- Same-Workspace invariants enforced in all service operations.
- Tests pass; build passes.

**M7.3 may begin immediately. M8 remains outside the authorized scope.**
