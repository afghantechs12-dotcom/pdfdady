# J3 — account deletion and data export: the facts, not a verdict

`LAUNCH DECISION REQUIRED`. This is not a defect report: nothing here is broken.
It is a capability the product does not have, whose absence has a legal
consequence in some jurisdictions and none in others, and that choice is the
operator's. It is recorded so it cannot vanish from the launch decision.

## What exists

Nothing user-facing. Every API route was enumerated (`find app/api -name route.ts`):
there is no delete-account route, no export route, and no admin route that removes a
user. The closest neighbours are `workspaces/[workspaceId]/archive` (archives a
workspace, does not erase it) and the document trash — both scoped to content, not
to a person.

## Why it is not a small feature

`model User` in `prisma/schema.prisma` has **no relations at all** — eight scalar
fields and nothing else. The 41-model schema carries a user id in **23 columns
across 22 models**, every one a plain `String` with no foreign key to `users` and
therefore no cascade:

    Job.ownerId (optional)          StoredFile.ownerId              OrganizationMembership.userId
    Workspace.createdById           WorkspaceMembership.userId      WorkspaceMembership.createdById
    Session.userId                  Project.createdById             Folder.createdById
    DocumentRecord.createdById      WorkspaceSession.userId         DocumentIngestion.uploadedById
    WorkspaceSaveIntent.userId      AutosaveDraft.userId            DocumentVersion.createdById
    Tag.createdById                 SmartCollection.createdById     DocumentMetadata.createdById
    WorkspaceBookmark.createdById   OutlineItem.createdById         AttachmentRecord.createdById
    CommentThread.createdById       UsageCounter.ownerId

Consequences, stated plainly:

- Deleting a `users` row today succeeds and orphans all 23 references. The database
  will not stop it, because there is nothing to stop.
- An export or an erasure has to be written by hand against all 22 models, and has
  to decide what to do about **shared** content — a `DocumentVersion` created by a
  departing member is part of a workspace other members still use, and the
  content-addressed store deliberately keeps bytes alive while any reference
  remains (`VersionService.artifactStillReferenced`, gated by brief mutation K).
- Cross-tenant safety is not the issue: membership checks are enforced and tested.
  The issue is that "everything belonging to this person" is not a query the schema
  can answer.

## The decision, framed

- If PDFDadi serves EU/UK data subjects, Articles 15 and 17 make export and erasure
  obligations rather than features, and this is a launch blocker for that audience.
- If it launches for a closed or single-tenant audience, a documented manual
  procedure (operator runs SQL, keeps a record) is a defensible interim position.
- Either way the manual procedure does not exist in writing today. That is the
  smallest thing that closes the gap without new code.

This audit does not choose between those. It records that the choice is open, and
that no code change in this branch has narrowed it.
