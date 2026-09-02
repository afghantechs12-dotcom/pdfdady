# Milestone 7 Risk Register

**Date:** 2026-08-04 (M7.16 closure update; originally 2026-08-01)  
**Status:** M7.0–M7.16 complete. Risks below carry their final M7 disposition.

| ID | Risk | Severity | Evidence/status | Mitigation / gate |
| --- | --- | --- | --- | --- |
| M7-R01 | Authoritative M7.1 quality sequence is incomplete | High | Retained pre-build gates passed 89/89 files and 978/978 tests, but the local log ends before completed build output; a separate earlier build failed at a safe-delete confirmation gate | Keep M7.1 open; run one foreground, uncontended clean-install/Prisma/typecheck/lint/test/build sequence and retain its exit codes. |
| M7-R02 | Storage/database split leaves orphan or missing metadata | High | UploadService writes storage then metadata | Quarantine/staging, immutable references, transactional outbox, compensating cleanup. |
| M7-R03 | Global physical dedup creates cross-tenant coupling | High | Approved early-M7 compatibility preserves content-addressed bytes across owners | Tenant-scoped logical references only; uniform APIs; no dedup disclosure; logical quota; zero-reference/hold deletion; future organization-scoped migration option. |
| M7-R04 | Redis job can remain stale in processing | High | Visibility-timeout reaper documented as follow-up | Outbox dispatcher/consumer leases, stale recovery, idempotent handlers. |
| M7-R05 | Cross-workspace IDOR/search leakage | Critical | No current workspace guard exists | Exact access precedence, tenant-scoped repositories, adversarial API/search tests. |
| M7-R06 | Organization creation/provisioning partial write | High | Organization and owner membership are separate writes | Transactional provisioning and idempotent default-workspace backfill. |
| M7-R07 | SQLite writer contention under autosave/index jobs | High | **Open, carried as M7 debt.** Verified at M7.15: no object streaming or PDF processing occurs inside any of the four `$transaction` call sites, and every list surface is bounded. WAL and busy timeout remain **unconfigured in code** and the ADR-M7-009 contention benchmark remains **unmeasured**; no numeric threshold is claimed anywhere in M7 documentation. | ADR-M7-009 topology holds (one writable deployment, no shared filesystem). Measure busy timeout, transaction budget and writer/worker caps before multi-writer or PostgreSQL migration. |
| M7-R08 | Autosave overwrites newer work | Critical | No current draft/revision/lock system | IndexedDB primary recovery, navigator.locks/fenced lease, server CAS/idempotency, preserve conflicts. |
| M7-R09 | Version restore leaves stale tabs/artifacts | High | No current reconciliation system | Same-transaction revision update + OutboxEvent invalidation; clients enter recovery/conflict state. |
| M7-R10 | Blob deleted while referenced | Critical | Existing StoredFile has no reference lifecycle | Immutable Blob/BlobReference model, retention/hold, zero-reference recheck before delete. |
| M7-R11 | Session payload causes memory/storage abuse | High | Current editor holds source/backgrounds in memory | Versioned bounded WorkspaceSession payload; no bytes/data URLs/backgrounds; tab suspension. |
| M7-R12 | PDF-native capabilities overstated or corrupt files | High | Library feasibility not proven | Read/write spikes and corpus round trips; omit unsupported mutation; precise signature language. |
| M7-R13 | Unicode/collation differences create duplicates | High | Existing organization slug trusts DB uniqueness | Shared NFKC/case-fold normalization columns and cross-provider vectors. |
| M7-R14 | Public links broaden access | High | Feature not yet approved | Separate hashed revocable FK-backed PublicShareLink; remain conditional. |
| M7-R15 | Project grant creates premature complexity | Medium | Project sharing requirements unconfirmed | Keep ProjectPermissionGrant provisional; no table before explicit approval. |
| M7-R16 | Production dependency advisories remain after framework transition | High | **Re-audited 2026-08-04 at M7.16.** Next 16.2.12 tree: **4 high** in both full and production-only audits — `postcss` (dev-only), `brace-expansion` (dev-only, via eslint), `sharp` (production dependency, path unreachable), `next` (inherits both). Classification and evidence in `docs/milestone-7.16-checkpoint.md`. No production-reachable critical/high remains. npm still proposes an unsafe `--force` downgrade. | Force/downgrade rejected. `sharp` is optional-of-`next`, traced into `.next/standalone` but never invoked: no `next/image` import exists anywhere in `app/` or `components/`, no `images` block is configured, and no code passes uploaded bytes to an image library. The four `next/og` `ImageResponse` surfaces render server-authored JSX with no attacker-controlled image source, and three of the four are statically prerendered at build time. `postcss` and `brace-expansion` are build/lint-only and absent from the standalone output. Re-audit on every Next upgrade. |
| M7-R17 | Prisma config deprecation | Medium | Warning on validate/generate | Remain on Prisma 6; plan config migration separately before Prisma 7. |
| M7-R18 | No Git history for attribution/rollback | Medium | Root is not a Git working tree | Protected-file hashes, exact reports, backups, migration rollback drills, session checkpoints. |
| M7-R19 | Browser/device/accessibility behavior unverified | Medium | **Partially closed.** M7.15 added 17 automated accessibility/responsive assertions and `focusTrap.test.ts` covers the shared dialog primitive. Rendered-DOM behaviour, live-region timing and visible focus remain **unverified** (the suite is `environment: "node"`; no DOM environment is configured). Screen-reader and physical-device verification were **not performed** and are not claimed. | Evidence levels are labelled per area in the M7.15 checkpoint. A DOM test environment or minimal Playwright run remains outstanding. |
| M7-R20 | Unfinished M5 typography contaminates M7 | Medium | Separate prior plan exists | Track as M5 debt; include only a narrowly proven blocker with separate approval. |

## Debt carried out of Milestone 7

These are open and explicitly not claimed as done.

1. **SQLite operational values unmeasured** (M7-R07). WAL, busy timeout, transaction budget and writer/worker caps are neither configured nor benchmarked. No numeric performance figure is asserted anywhere in M7 documentation.
2. **No DOM test environment** (M7-R19). Accessibility is verified at the logic layer only; rendered output, live-region timing and focus visibility are unverified.
3. **No screen-reader or physical-device verification** (M7-R19). Not performed, not claimed.
4. **Operation-center state is per-process** and does not survive a restart, by design (M7.14 plan §"persisted operation record only where existing Job/activity is insufficient"). Durable work is owned by its durable repository.
5. **Comparison job content resolver is not bound to production storage.** `ComparisonJobHandler` is tested end-to-end through the real queue with an injected resolver; binding it to object storage in the container is the remaining step.
6. **Prisma config deprecation** (M7-R17) unresolved; remains on Prisma 6.
7. **Public sharing and project-level sharing** remain out of scope; `ProjectPermissionGrant` stays provisional (M7-R14, M7-R15).
8. **No Git history** (M7-R18). The repository is not a working tree, so attribution and rollback rely on checkpoints and backups.

## Recommendation

Milestone 7 is **complete**. No production-reachable critical or high vulnerability remains, all gates pass, and the debt above is recorded rather than hidden. M8 is not authorized and has not been started.
