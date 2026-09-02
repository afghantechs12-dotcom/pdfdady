# ADR-M7-002: Workspace Authorization Precedence

**Status:** Accepted for planning; implementation requires M7.1 approval.

## Canonical models

Use exactly `WorkspaceMembership`. `DocumentPermissionGrant` is confirmed. `PublicShareLink` is conditional on public-sharing approval and must use a separate FK-backed resource plus hashed revocable opaque token. `ProjectPermissionGrant` is provisional and must not receive a Prisma table until project-level sharing is explicitly approved before M7.2 or M7.10.

## Decision algorithm

1. Missing/deleted/suspended/disabled/unauthorized Organization: deny.
2. Archived/trashed Workspace: deny writes by default; allow only explicit read/restore/admin policy.
3. Explicit workspace deny or revoked grant: deny.
4. Active explicit WorkspaceMembership: use explicit role; this overrides inherited default-workspace access.
5. For `Organization.defaultWorkspaceId`, derive role from OrganizationMembership.
6. Active DocumentPermissionGrant may grant only same-Organization/same-Workspace document scope. Provisional ProjectPermissionGrant follows this placement only if later approved. Resource grants never bypass lifecycle denial or explicit workspace deny.
7. Otherwise deny.

## Inherited mapping

- Organization owner -> Workspace owner.
- Organization admin -> Workspace editor plus explicit organization-administration capabilities.
- Organization member -> Workspace editor.
- Organization viewer -> Workspace viewer.

Organization admin does not inherit workspace ownership transfer, workspace deletion, permanent purge, or destructive retention override unless separately authorized. Every server use case scopes repository predicates by actor, Organization, Workspace, and resource. UI checks are never authoritative.
