# Milestone 7 Threat Model

**Status:** M7.0 planning baseline. Review before M7.1 and at each security-relevant phase.

## Assets and trust boundaries

Assets include organization/workspace membership, documents and immutable versions, rolling drafts, comments, shares, sessions, search data, derived artifacts, audit/activity records, storage blobs, signing secrets, and background-job authority.

Trust boundaries exist at cookie authentication, workspace/resource authorization, API validation, object-storage keys and signed URLs, browser IndexedDB, public links, PDF parsing, queue/outbox consumers, search query/result assembly, and purge/retention processing.

## Primary threats and required controls

| Threat | Failure scenario | Required controls |
| --- | --- | --- |
| Cross-tenant IDOR | Attacker supplies another Workspace/Document ID | Actor + Organization + Workspace-scoped predicates; exact precedence; deny by default; negative tests on every route/job/artifact. |
| Authorization precedence bypass | Resource grant bypasses explicit workspace deny | Apply lifecycle/deny before explicit membership/inheritance/resource grants; same-workspace FK checks. |
| Search leakage | Counts/snippets/facets reveal inaccessible documents | Filter eligible DocumentRecords before all result derivation and existence signals. |
| Share-token theft | Public link grants indefinite access | Separate PublicShareLink, hashed opaque token, explicit scope/expiry, revocation, rate limit, audit; feature conditional on approval. |
| CSRF/session abuse | Cookie-authenticated mutation from hostile origin | SameSite/secure cookie policy, origin/CSRF validation, idempotency binding to actor/request hash. |
| Stored-object confused deputy | Checksum/key reused to access another tenant | Authorization by reference record, not key; short signed URL TTL; organization-scoped dedup decision. |
| Storage/DB split-brain | Blob stored but DB transaction fails | Quarantine/staging, immutable references, transactional outbox, compensating cleanup, orphan sweeper. |
| Referenced-blob deletion | Purge removes bytes still used by a version/draft/attachment | Authoritative FK/reference accounting, retention/legal holds, zero-reference recheck immediately before deletion. |
| Malicious PDF/resource exhaustion | Crafted PDF consumes CPU/memory or exploits parser | MIME/signature checks, byte/page/object/text limits, isolated temp directories, cancellation, timeouts, bounded workers. |
| Unsafe filename/path | Traversal or control characters escape storage/UI | Shared NFKC normalization/validation, storage key generation independent of user filenames, output encoding. |
| Draft disclosure on shared device | Previous account draft is recovered by another user | IndexedDB partition by user/workspace/document/device; clear/quarantine on logout/account switch/revocation/deletion/schema mismatch. |
| Autosave stale writer | Crashed/hidden tab overwrites newer state | navigator.locks; fenced expiring lease fallback; server revision compare-and-swap; scoped idempotency. |
| Outbox replay/duplication | Duplicate job creates duplicate artifact/activity | Versioned payloads, deterministic idempotency keys, consumer checkpoints, compare-and-swap and safe replacement. |
| Queue loss | DB commit succeeds but Redis enqueue fails | Mutation and OutboxEvent commit atomically; dispatcher retries undispatched events. |
| Comment XSS/anchor abuse | Content or anchor renders unsafe HTML or hidden resource | Plain/sanitized body rendering; versioned anchor schema; authorization on target; graceful anchor degradation. |
| Session resource abuse | Oversized session stores bytes/backgrounds | Versioned bounded schema; reject binary/data URLs/unbounded editor resources; reauthorize every restored tab. |
| Purge abuse | Admin permanently destroys protected data | Owner/policy-specific capability, confirmation, retention/legal hold, audit preservation, asynchronous reference-safe execution. |
| Signature misrepresentation | Presence presented as cryptographic validity | Separate presence, structural inspection, and cryptographic verification labels; feasibility spike. |

## Access decision algorithm

1. Missing/deleted/suspended/disabled Organization: deny.
2. Archived/trashed Workspace: default deny writes; allow only explicit read/restore/admin policy.
3. Explicit deny/revocation: deny.
4. Explicit WorkspaceMembership: explicit role.
5. Default Workspace: derive mapped OrganizationMembership role.
6. Same-workspace DocumentPermissionGrant; provisional ProjectPermissionGrant only if later approved.
7. Otherwise deny.

Organization admin inherits Workspace editor plus organization-administration capabilities, not workspace ownership transfer, deletion, permanent purge, or destructive retention override.

## Security verification gates

- Unit/property tests for normalization, access precedence, anchor schemas, revision/idempotency, and reference accounting.
- Integration tests for IDOR, CSRF, signed URLs, grants/revocation, search leakage, outbox replay, and purge.
- Corpus tests for malformed/encrypted/signed PDFs and oversized content.
- Audit checks for membership, grants, restores, purge, retention override, and security inspection.
- Manual browser/security review labeled honestly; no claim of screen-reader/device/manual verification without execution.
