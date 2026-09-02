# ADR-M7-012: Portable Unicode Name Normalization

**Status:** Accepted for planning; entity limits need final product validation.

## Decision

A shared domain/application service produces display-preserving and normalized values for Workspace slugs/names where unique, Projects, Folders, Tags, SmartCollections, and Document normalized names. Do not rely on SQLite/PostgreSQL collation.

Use Unicode NFKC for uniqueness/matching, trim and collapse Unicode whitespace, and apply locale-independent Unicode case folding. Reject NUL, C0/C1 controls, bidi override/isolate controls unless explicitly justified, empty/dot-only names, and storage/path separators where names can reach exported paths. Preserve display input after validation.

Define explicit code-point and UTF-8 byte limits per entity before M7.1. Slugs use deterministic bounded ASCII-safe generation and hyphen separators. Scoped normalized columns carry unique constraints appropriate to Organization/Workspace/parent Folder. Collision handling uses stable validation errors or deterministic suffixes for generated slugs; normalization test vectors must run identically under SQLite and PostgreSQL adapters.
