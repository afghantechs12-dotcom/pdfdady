# ADR-M7-009: SQLite Operations and PostgreSQL Triggers

**Status:** Accepted for M7.0 supported-boundary definition; measured thresholds remain pending the schema/workload benchmark.

## Initial supported topology and limits

- One writable application deployment per SQLite database.
- No multi-instance concurrent writers.
- No network/shared-filesystem SQLite database.
- WAL is enabled only where runtime/storage support is verified; rollback to the default journal mode is documented if verification fails.
- Configure an explicit busy timeout and bounded retries.
- Keep transactions short and bounded; never stream objects or run PDF processing inside a transaction.
- Bound application writers, outbox writers, and indexing workers; readers may run concurrently within SQLite limits.
- PostgreSQL is required before supporting multi-instance writes.

The numeric busy timeout, transaction budget, writer cap, worker cap, WAL checkpoint setting, and supported database-size limit are **not claimed yet**. They must be measured, not guessed.

## Reproducible contention benchmark

The M7.0 benchmark fixture must run on recorded hardware/OS/runtime and a local SQLite database with a documented dataset size. It concurrently exercises autosave draft updates, outbox claiming/completion, indexing status updates, comments/activity writes, version creation, and file-manager reads during writes. Record database size, writer count, reader count, operation count, p50/p95/p99 latency, SQLITE_BUSY/locked failures, retry count, throughput, and queue/backlog behavior. Run warm-up and repeated trials; preserve raw results and query plans.

Initial benchmark status: **unmeasured** because M7.1 schema and workload entities are not authorized. No numeric capacity claim is made.

## Operational gates before schema implementation

Define and measure busy timeout, maximum transaction duration, application writer cap, outbox/index worker cap, WAL checkpoint policy, migration-exclusive-lock procedure, tested backup/restore, corruption recovery on a separate file, and `EXPLAIN QUERY PLAN` regressions for Workspace/Folder/Document/search/outbox queries plus the 10,000-document profile.

## PostgreSQL migration triggers

PostgreSQL is mandatory before any of these supported conditions:

- multiple application writer instances are required;
- SQLite is placed on a shared/network filesystem;
- sustained lock errors remain after bounded retries;
- measured write latency repeatedly exceeds the approved SLO;
- indexing/autosave backlog grows under the supported workload;
- backup/recovery requirements exceed verified SQLite capabilities;
- worker throughput is blocked by single-writer behavior or search exceeds verified portable/FTS5 capability.

Threshold values and benchmark evidence must be recorded before M7.1 authorization.
