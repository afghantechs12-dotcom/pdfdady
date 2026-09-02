# ADR-M7-011: Trash, Retention, Restore, and Purge

**Status:** Accepted for planning.

## Decision

Trash is reversible metadata state: `trashedAt`, `trashedById`, original Folder/Project location, `purgeAfter`, and retention override metadata. Project/Folder trash applies explicit subtree visibility; it does not immediately delete documents, versions, comments, activity, attachments, or blobs.

Restore prefers the original authorized location. If missing or invalid, restore to an authorized Workspace recovery location and resolve normalized-name collisions explicitly. Version history remains intact.

Permanent purge is a separate owner/policy-authorized, confirmed, audited asynchronous process. Organization admin does not inherit purge or destructive retention override. Purge preserves audit/legal records and honors holds. It removes logical references transactionally with OutboxEvents; cleanup consumers delete only after authoritative zero-reference and retention checks. Partial failure is recoverable and visible through operation state.
