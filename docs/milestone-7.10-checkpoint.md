# Milestone 7.10 checkpoint — comments, sharing and asynchronous collaboration

Status: **complete**. Date: 2026-08-03.

## What was replaced

The pre-existing `CommentService` was fabricated and is now gone. For the record,
what it actually did:

- `createCommentThread` resolved the Workspace with
  `this.workspaces.get(actor, documentId.split('-')[0])` — a document id parsed as
  a Workspace id.
- `getCommentThread` returned a hardcoded thread for `document-123` /
  `workspace-456` regardless of input.
- Ids were `` `thread-${Date.now()}-${Math.random()}` `` — not persisted anywhere.
- Its test file asserted only against `vi.fn()` mocks, so none of the above failed.
- It carried `organizationRole: string`, which is what produced 12 of the 24
  repository-wide TypeScript errors.

Nothing from that implementation survives except the class name.

## Domain

`src/domain/entities/Collaboration.ts` (+ `Collaboration.test.ts`, 46 tests).

Three boundaries the module exists to hold:

1. **Threads own location; messages own text.** A thread is anchored once and
   carries resolution state; messages carry authored bodies and edit history.
   This is what lets a thread be resolved without rewriting anyone's words.
2. **Bodies are plain text, always.** No HTML is stored, accepted or produced.
   There is deliberately no sanitizer: a sanitizer is a filter that can be wrong,
   whereas a React text node cannot execute a string. Markup in a comment is
   *content* and is preserved verbatim — a user quoting `<script>` in a code
   review is making a legitimate comment.
3. **Anchors are validated, not trusted.** Six allowlisted types
   (`document`/`page`/`point`/`rectangle`/`text`/`object`), unknown types refused
   rather than defaulted, unknown fields refused rather than dropped, every
   number bounded, and the serialized size capped.

Also: `DOCUMENT_PERMISSION_ROLES` deliberately excludes `owner` — ownership is a
Workspace concept, and a document-scoped grant conferring it would escalate past
the Workspace containing the document.

## Persistence

Migrations (additive, applied):

- `20260803144104_add_comments_and_document_permissions`
- `20260803144651_add_comment_thread_page_anchor_index`

The second exists because the first stored the anchor only as serialized JSON,
which made "comments on the page I am looking at" a JSON extraction rather than
an indexed predicate. `CommentThread.pageNumber` is now a derived, indexed column
written from the validated anchor via `anchorPageNumber()`, so the column and the
anchor cannot disagree.

Three tables, three lifetimes: `comment_threads`, `comment_messages`,
`document_permission_grants`. No Prisma enums and no `Json` columns, per the
SQLite/PostgreSQL portability policy.

Ports and adapters:

| Port | In-memory | Prisma | Adapter tests |
| --- | --- | --- | --- |
| `CommentThreadRepository` | yes | yes | 13 |
| `CommentMessageRepository` | yes | yes | 14 |
| `DocumentPermissionGrantRepository` | yes | yes | 16 |

## Authorization

`authorize()` resolves in a fixed order — Workspace, then DocumentRecord within
it, then any grant. Consequences that are tested rather than assumed:

- A document in another Workspace, a Workspace in another organization, and a
  non-member all read as **NotFound**, never Forbidden. "Forbidden" confirms an id
  is real.
- Grants **add, never override**. A grant cannot confer sharing or moderation: a
  shared-with user who could re-share would make revocation unenforceable.
- Sharing maps to the existing owner-only `workspace:manage-members` capability
  rather than to a new rule. An organization admin inherits `editor`
  (`INHERITED_WORKSPACE_ROLE`) and therefore does **not** acquire it — inherited
  administration must not silently gain owner-only powers (ADR-M7-002).
- Revocation and expiry are re-evaluated on **every** call, so access is lost at
  the next request rather than at the next login. No sweep job is involved.
- Only an author may edit a message; a moderator may delete anyone's. Rewriting
  another person's words under their name is not something audit logging makes
  acceptable.

## Asynchronous only

No CRDT, no operational transform, no presence, no live shared editing state.
Concurrency is optimistic `revision` compare-and-swap; a losing writer is told to
refetch. A lost race and a missing row are deliberately indistinguishable.

## API

All under `/api/workspaces/[workspaceId]/documents/[documentId]/`:

- `comments` (GET, POST)
- `comments/[threadId]` (GET)
- `comments/[threadId]/messages` (GET, POST)
- `comments/[threadId]/messages/[messageId]` (PATCH, DELETE)
- `comments/[threadId]/resolve` (POST)
- `comments/[threadId]/reopen` (POST)
- `permissions` (GET, POST)
- `permissions/[grantId]` (DELETE)

Every mutation calls `requireSameOrigin` first — verified per-route, not assumed.
Responses omit `organizationId` and every internal storage handle.

## UI

- `components/workspaces/commentLogic.ts` (+ 48 tests)
- `components/workspaces/CommentsPanel.tsx`
- `components/workspaces/DocumentSharingPanel.tsx`

Bodies render as `{message.body}` — a React text node. There is no
`dangerouslySetInnerHTML` anywhere in this feature. Errors and successes are
reported in place through a live region; no `alert()`. Deleted messages render a
tombstone rather than an empty comment; stale threads say the position may not
match the current document.

## Gate

Focused: **279 tests / 8 files**, all passing.

| Suite | Tests |
| --- | --- |
| `Collaboration.test.ts` | 46 |
| `CommentService.test.ts` | 70 |
| `commentHttp.test.ts` | 19 |
| `PrismaCommentThreadRepository.test.ts` | 13 |
| `PrismaCommentMessageRepository.test.ts` | 14 |
| `PrismaDocumentPermissionGrantRepository.test.ts` | 16 |
| `container.test.ts` | 53 |
| `commentLogic.test.ts` | 48 |

Repository-wide after M7.10:

- `npx prisma validate` — valid
- `npm run lint` — 0 errors, 6 warnings (all pre-existing; 3 M7.10 errors fixed
  by removing pointless initializers and a try/catch that rethrew in every branch)
- `npm run test` — 131 files, 2291 tests, all passing
- `npm run typecheck` — 12 errors remaining, all in M7.11 files
  (`StatisticsService.ts` / `.test.ts`). Down from 24; the 12 M7.10 errors are gone.

## Notes for later phases

- `CommentService.effectiveGrantRole` is the hook M7.15 should use when auditing
  document-scoped access.
- The XSS regression tests assert bodies survive *as characters*. If a future
  phase introduces rich text, that is a new decision requiring its own render-path
  review — it must not be done by relaxing these tests.
