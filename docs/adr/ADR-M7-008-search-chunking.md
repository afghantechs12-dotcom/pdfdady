# ADR-M7-008: Portable Chunked Search Index

**Status:** Accepted for planning.

## Decision

`SearchIndexPort` isolates application code from database-specific search. Use `SearchDocument` for Workspace/Document/Version/index version/checksum/state/error/indexedAt and bounded `SearchChunk` rows for source type, page, ordinal, normalized text, bounded original text, and optional validated anchor metadata.

Chunks support page/source-aware snippets, incremental replacement, bounded rows, safe deletion, and later FTS adapters. Initial implementation provides portable metadata and content indexing. SQLite FTS5 is optional only after runtime feasibility; PostgreSQL FTS is a future adapter.

Authorization first selects eligible DocumentRecords; only then may search return results, counts, snippets, facets, highlights, or existence signals. Highlights are structured ranges, not unsafe HTML. Indexing consumes OutboxEvents idempotently; version restore/new version/trash/share changes invalidate or reconcile index state. Unicode, malformed extraction, stale state, duplicate delivery, and 10,000-document profiles are required tests.
