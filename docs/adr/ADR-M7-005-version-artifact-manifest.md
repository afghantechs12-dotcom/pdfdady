# ADR-M7-005: DocumentVersion Artifact Manifest

**Status:** Accepted for planning.

## Decision

Every immutable DocumentVersion owns a schema-versioned manifest containing:

- immutable source PDF/blob reference,
- immutable editor-state snapshot reference,
- optional materialized edited-PDF reference,
- checksum and byte size for each artifact,
- provenance and creator,
- parent/base/restored-from relationships,
- thumbnail, search, and statistics revision relationships.

A materialized edited PDF is produced on explicit export, explicit Save when policy requires a ready downloadable edited PDF, or a background materialization request. Rolling autosave never exports a permanent PDF. If Save stores editor state without immediate materialization, the manifest records materialization state and a deterministic background event.

Version creation transactionally updates `Document.currentVersionId`, document revision, current size/page count/checksum, and applicable derived-revision pointers, and writes OutboxEvents. Version numbers use transaction-safe allocation and bounded unique-conflict retry. Restore creates a new version and never overwrites history.
