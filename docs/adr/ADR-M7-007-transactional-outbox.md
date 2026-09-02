# ADR-M7-007: Transactional Outbox

**Status:** Accepted for planning.

## Decision

Authoritative mutations and OutboxEvent rows commit in the same Prisma transaction. Do not rely on database commit followed by best-effort queue enqueue.

OutboxEvent fields include id, Organization, Workspace, aggregate type/id/revision, event type, versioned bounded payload, idempotency key, created/available/processed timestamps, attempts, lease/fencing data, and last error. Idempotency keys include actor, Organization, Workspace, operation, and canonical request hash.

A dispatcher leases available rows, publishes or handles work, and records completion. Consumers for indexing, metadata, thumbnails, statistics, comparisons, notifications, activity, audit propagation, derived invalidation, and storage cleanup are idempotent and duplicate-delivery safe. Crashed leases expire; stale consumers cannot commit after a newer fencing generation. Poison events retain error evidence and enter bounded retry/dead-letter review rather than disappearing.
