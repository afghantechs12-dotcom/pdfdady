# ADR-M7-004: Rolling Drafts Versus Durable Versions

**Status:** Accepted for planning.

## Decision

Local recovery uses IndexedDB; server recovery uses `DocumentDraft` metadata plus a bounded object-storage editor-state snapshot reference. The initial server policy does not store repeated large editor-state JSON in SQLite.

Rolling autosave drafts are replaceable, coalesced, revision-aware, conflict-safe, and never increment durable version numbers. Page-lifecycle remote save is best-effort; IndexedDB is primary crash safety. Local keys are partitioned by user/Workspace/Document/device and cleared or quarantined on logout, account switch, access revocation, deletion, or incompatible schema.

Every explicit Save creates one immutable DocumentVersion. Named, restore, conflict-resolution, close, or policy-controlled idle checkpoints have explicit provenance. Server writes use base version, expected document/draft revision, checksum, and idempotency key scoped by actor/Organization/Workspace/operation/request hash. Conflict preserves both states; no last-write-wins.
