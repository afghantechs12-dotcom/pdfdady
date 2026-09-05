# §2 canonical body-consumer inventory

Every route that can receive a request body, with the policy assigned to it. Generated from
`ingress/bodyRoutes.mjs`, which `ingress/bodyRoutes.test.ts` (E1) holds against the filesystem:
a new mutating route, a removed one, a changed method list, or a route that stops calling the
guard it claims fails that test rather than drifting from this page.

Membership is "can receive a body", not "calls `.json()`" — `app/api/auth/register/route.ts` is
`export const POST = signupPost`, so a file-local search for a body read would have missed it.
Seven of the 98 read no body at all and are listed anyway, because "reads nothing" is a policy
that a later edit should not be able to change silently.

## The four class-determined columns

These four answers are the same for every route in a class, so they are stated once. The class
comes from `classifyPath` in `ingress/policy.mjs` — one implementation, used by the guard that
enforces it and by the test that checks this table.

| | class A — no body | class B — small structured body | class C — streamed multipart |
|---|---|---|---|
| **inside `proxy.ts`'s matcher** | yes (everything not excluded) | yes | **no** — the five matcher exclusions |
| **enforced before middleware buffering** | yes — `ingress/guard.mjs`, in the `'request'` event, before `installIngress()` hands the socket to Next | yes — same place | n/a — Next never clones an excluded path, so there is no pre-buffer to be ahead of |
| **media types accepted** | none | `application/json`, `application/csp-report`, `text/plain`, `application/x-www-form-urlencoded` | `multipart/form-data` only (`isMultipartRequest`) |
| **missing `Content-Length`** | 411 before a byte is read | 411 before a byte is read | accepted — `readMultipart` counts the bytes it reads and stops at the ceiling |
| **understated `Content-Length`** | Node's parser delivers only the declared bytes; the rest cannot enter the request (E6) | same, plus the route re-checks the bytes it actually read (`csp-report`, `analytics/events`, `billing/webhook`, auth) | same, plus `readMultipart`'s own byte count |
| **ceiling** | `CLASS_A_MAX_BYTES` = 0 | `CLASS_B_MAX_BYTES` = 2 MiB, then the route's own | the route's own (`TOOLS_MAX_BODY_BYTES` 110 MiB, or the gate's `maxBytes`) |

## The routes

`limit` is the route's OWN ceiling. `class ceiling only` means the route relies on the ingress
number above it — correct for a route whose schema bounds every field, and the reason class B's
ceiling had to be a real number rather than 120 MB.

| class | route | methods | reads | auth before read | limit | public |
|---|---|---|---|---|---|---|
| B | `/api/admin/ai-tools/[id]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/blog/[slug]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/blog/author` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/faq/[id]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/features/[id]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/login` | POST | json | anonymous | class ceiling only | yes |
| B | `/api/admin/logout` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/admin/nav` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/pages/[key]` | PUT | json | admin | class ceiling only | no |
| B | `/api/admin/password` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/pricing/[id]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/reorder` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/seo` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/server-tools/[slug]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/setup` | POST | json | anonymous | class ceiling only | yes |
| B | `/api/admin/site` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/tool-categories/[id]` | PUT | json | admin | class ceiling only | no |
| B | `/api/admin/tools` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/tools/[slug]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/tools/bulk` | POST | json | admin | class ceiling only | no |
| B | `/api/admin/trust/[id]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/admin/use-cases/[id]` | PUT, DELETE | json | admin | class ceiling only | no |
| B | `/api/analytics/events` | POST | text | anonymous | `MAX_BODY_BYTES` | yes |
| B | `/api/auth/login` | POST | readBoundedJson | anonymous (credential endpoint) | `MAX_AUTH_BODY_BYTES` | yes |
| B | `/api/auth/logout` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/auth/register` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/auth/signup` | POST | readBoundedJson | anonymous (credential endpoint) | `MAX_AUTH_BODY_BYTES` | yes |
| B | `/api/billing/checkout` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/billing/portal` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/billing/webhook` | POST | json,text | stripe signature | `MAX_WEBHOOK_BODY_BYTES` | yes |
| B | `/api/csp-report` | POST, PUT, PATCH, DELETE | text | anonymous | `MAX_BODY_BYTES` | yes |
| B | `/api/jobs/[id]/cancel` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/jobs/[id]/retry` | POST | none | anonymous | class ceiling only | yes |
| B | `/api/jobs/[id]/save-to-workspace` | POST | json | session | class ceiling only | no |
| B | `/api/storage/multipart` | POST | json | anonymous | class ceiling only | yes |
| B | `/api/storage/multipart/[...segments]` | POST, PUT, DELETE | arrayBuffer,json | anonymous | class ceiling only | yes |
| B | `/api/workspaces` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]` | PATCH | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/archive` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/commands` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]` | PATCH | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/attachments/[attachmentId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/autosave` | POST, DELETE | json | session | `MAX_AUTOSAVE_BODY_BYTES` | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/autosave/mark-saved` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/autosave/recover` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/bookmarks` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/bookmarks/[bookmarkId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comments` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/messages` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/messages/[messageId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/reopen` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comments/[threadId]/resolve` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comparisons` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comparisons/[comparisonId]/cancel` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/comparisons/[comparisonId]/retry` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/favorite` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/lifecycle` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/metadata` | PUT | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/opened` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/outline` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/outline/[outlineItemId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/permissions` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/permissions/[grantId]` | DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/search-index/reindex` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/statistics` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/tags` | POST, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/versions` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/[documentId]/versions/[versionNumber]/restore` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/documents/bulk` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/folders` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/folders/[folderId]` | PATCH | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/folders/[folderId]/lifecycle` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/members` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/members/[userId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/operations/[operationId]/cancel` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/operations/[operationId]/retry` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/projects` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/projects/[projectId]` | PATCH | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/projects/[projectId]/lifecycle` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/restore` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/search` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/session` | POST, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/session/split` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/session/tabs` | POST, PATCH | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/session/tabs/[tabId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/smart-collections` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/smart-collections/[collectionId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/smart-collections/preview` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/tags` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/tags/[tagId]` | PATCH, DELETE | json | session | class ceiling only | no |
| B | `/api/workspaces/[workspaceId]/tags/bulk` | POST | json | session | class ceiling only | no |
| B | `/api/workspaces/provision-default` | POST | json | session | class ceiling only | no |
| C | `/api/jobs` | POST | submitToolJob,submitProcessingJob | anonymous | `TOOLS_MAX_BODY_BYTES` | yes |
| C | `/api/tools/[slug]` | POST | submitToolJob | anonymous | `TOOLS_MAX_BODY_BYTES` | yes |
| C | `/api/workspaces/[workspaceId]/documents/[documentId]/attachments` | POST | workspaceUploadGate | session | `workspaceUploadGate` | no |
| C | `/api/workspaces/[workspaceId]/documents/[documentId]/versions/upload` | POST | workspaceUploadGate | session | `workspaceUploadGate` | no |
| C | `/api/workspaces/[workspaceId]/documents/upload` | POST | workspaceUploadGate | session | `workspaceUploadGate` | no |

98 routes. Class C is the five accepted streaming paths, unchanged by this work.
