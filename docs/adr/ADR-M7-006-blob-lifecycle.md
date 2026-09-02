# ADR-M7-006: Immutable Blob Lifecycle and Storage Commit

**Status:** Accepted for M7.0 compatibility; implementation requires later phase approval.

## Compatibility decision

Early M7 preserves the existing physical global byte-deduplication mechanism. `StoredFile` remains immutable physical byte metadata. `DocumentRecord`, `DocumentVersion`, `AutosaveDraft`, `AttachmentRecord`, and every derived artifact use tenant-scoped logical references. Authorization is evaluated only through those references—never checksum, storage key, physical object presence, or a deduplication result.

A checksum match must not reveal another tenant's document existence, ownership, display name, metadata, retention state, or access. APIs use uniform responses and do not disclose whether a cross-tenant physical deduplication occurred. Timing must be measured and padded/normalized where practical if it reveals material existence information.

Cross-tenant deduplication is a storage optimization only and grants no access. Organization-scoped physical deduplication remains a future migration option if privacy, encryption, residency, or compliance evidence requires it. UploadService is unchanged in M7.0.

## Immutable lifecycle and references

Blobs are immutable and checksum-addressed; storage keys are unique for content and never treated as authorization. Lifecycle states cover staged/quarantined, live, retained/held, orphan-candidate, and deleted. Authoritative references include version source/editor/materialized artifacts, draft snapshots, attachments, thumbnails, search/statistics artifacts, and comparisons. A live or retained reference forbids deletion.

Quota accounting must be selected before ingestion implementation. The recommended initial policy is **logical referenced bytes per Organization** for user-visible quota, with physical bytes tracked separately for infrastructure cost and dedup savings. If a hybrid is chosen, its formula and user-facing semantics must be documented and test-stable.

Commit protocol: stream/checksum to staged storage; validate/quarantine; create metadata/reference and OutboxEvent in a short DB transaction; promote logically; reconcile asynchronously. Failures have compensating cleanup or durable orphan reconciliation. Permanent purge removes references transactionally, preserves legal/audit holds, then emits cleanup. The worker rechecks zero authoritative references across every tenant plus retention/legal hold immediately before delete. Failed uploads expire from quarantine through audited cleanup.

## Cross-tenant risks and controls

- **Existence/timing side channel:** uniform API contract, no dedup flag, bounded timing analysis.
- **Retention coupling:** any tenant retention blocks physical deletion; logical purge remains tenant-local.
- **Quota correctness:** logical references are tenant-scoped; physical accounting is operational only.
- **Reference-count correctness:** prefer authoritative reference queries/constraints and reconciliation over a blind counter.
- **Deletion safety:** two-phase asynchronous purge with final zero-reference/hold check.
- **Encryption-key scope:** global physical dedup is incompatible with per-Organization ciphertext unless envelope/key design proves safe; this is an implementation gate.
- **Legal holds:** a hold on any reference retains the physical blob without exposing the holding tenant.
- **Backup/restore:** restore must rebuild/reconcile logical references before orphan deletion can resume.
