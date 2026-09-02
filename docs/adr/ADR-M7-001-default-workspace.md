# ADR-M7-001: Organization Default Workspace

**Status:** Accepted for planning; implementation requires M7.1 approval.

## Decision

Organization remains the tenant/billing/policy boundary. Workspace is its document-productivity child. `Organization.defaultWorkspaceId -> Workspace.id` is the sole authoritative default pointer. No Workspace-local default flag participates in authority; omit one unless a proven cache need defines it only as a transactionally validated projection.

## Migration sequence

1. Add nullable `Organization.defaultWorkspaceId` and Workspace table additively.
2. Create exactly one Workspace per existing Organization through an idempotent backfill.
3. Set each Organization pointer in short transactions.
4. Validate referenced Workspace belongs to the same Organization and every eligible Organization has one pointer.
5. Tighten requiredness only where product eligibility and SQLite rebuild safety permit.

Inherited default-workspace access is derived from OrganizationMembership, not persisted as duplicate WorkspaceMembership rows. Personal tenancy provisioning is idempotent. Organization IDs and existing semantics remain unchanged. Rollback clears nullable pointers before removing newly introduced structures; no existing Organization is renamed or deleted.
