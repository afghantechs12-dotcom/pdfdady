# Milestone 2.4 — Authentication (Completion Report)

**Status:** Complete — implemented, verified, documented.
**Date:** 2026-07-27

M2.4 adds the auth abstraction + a working **Local auth implementation** (email/
password on the DB) + a **Clerk adapter scaffold** (stubbed, not wired). Four
provider ports (`IUserProvider`, `ISessionProvider`, `IOrganizationProvider`,
`IRoleProvider`) decouple identity from the application; swapping Local for
Clerk is a DI registration change. RBAC roles/permissions, an append-only audit
log, and the `/api/auth/{register,login,logout,me}` routes are in. The existing
M1 admin auth is untouched (a separate `pdfdadi_session` cookie).

## What landed

**Ports (src/application/ports/auth/):** `IUserProvider`, `ISessionProvider`,
`IOrganizationProvider`, `IRoleProvider`, `IAuditLogRepository`.

**Domain (src/domain/entities/):** `User` (+ `PublicUser`/`toPublicUser`),
`Organization`, `OrganizationMembership`, `UserSession`, `AuditLog`, `Role`
(`Role`/`Permission`/`ROLE_PERMISSIONS`/`roleHasPermission`).

**Local adapters (src/infrastructure/auth/):** `LocalUserProvider` (scrypt
password hash, reuses M1 `lib/admin/passwords`), `LocalSessionProvider`
(opaque random tokens in `sessions`), `LocalOrganizationProvider` (orgs +
memberships), `LocalRoleProvider` (role from membership + permission map).

**Clerk scaffold:** `ClerkProviders.ts` — `ClerkUserProvider`,
`ClerkSessionProvider`, `ClerkOrganizationProvider`, `ClerkRoleProvider`
implement the four ports but throw "not implemented" until Clerk is integrated.

**Persistence:** `PrismaAuditLogRepository` (append-only `audit_logs`).

**Application service:** `AuthService` — register/login/logout/getMe through
the provider ports (Local flow); `USER_SESSION_COOKIE` constant.

**Routes:** `POST /api/auth/register`, `POST /api/auth/login`,
`POST /api/auth/logout`, `GET /api/auth/me` — set/clear the
`pdfdadi_session` cookie (httpOnly, sameSite=lax, secure in prod, 30d);
record `user.register`/`user.login`/`user.logout` audit events; return
`PublicUser` (no `passwordHash`/`providerExternalId`).

**Schema:** added `User.passwordHash` (nullable — null for Clerk users) via
migration `20260727165301_add_user_password`.

**DI:** `Tokens.UserProvider | SessionProvider | OrganizationProvider |
RoleProvider | AuditLogRepository | AuthService` wired to the Local adapters
+ AuthService.

## Files

**New (16):** 5 auth ports, 6 domain entities, 4 Local adapters + 1 Clerk
scaffold file, 1 audit repository, AuthService, 4 auth routes, 2 test files.
**Edited:** `prisma/schema.prisma` (passwordHash) + migration; `tokens.ts`,
`container.ts` (wiring); `User.ts` (PublicUser), `AuthService.ts` (cookie const).

## Tests added

`npm run test` → **71 passed (17 files)**. New M2.4 tests (12):
- `AuthService` (8) — register, duplicate-email, short-password, valid/invalid
  login, getMe (valid/bad token), logout, hash-not-plaintext + verifies.
- `Role` (4) — owner has all; admin lacks billing; member tool/file but not
  org; viewer read-only.

## Build verification (all green)

| Gate | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — 0 errors, 16 warnings (pre-existing) |
| `npm run test` | 71/71 passed (17 files) |
| `npm run build` | exit 0 — auth routes compiled |

## Performance / security / SEO impact

- **Security:** positive — no default user password (register sets a scrypt
  hash via M1's helper); sessions are opaque 32-byte tokens, httpOnly +
  secure-in-prod cookies, separate from the admin cookie; `PublicUser` strips
  `passwordHash`/`providerExternalId`; audit log records auth events
  (append-only). RBAC roles gate org actions (used in M2.8). The Clerk stubs
  throw, so Clerk is not accidentally active.
- **Performance:** additive — no existing request path changed. Auth routes
  are dynamic; one DB write per register/login (user/session) + one audit row.
- **SEO:** none — `/api/auth/*` are noindex JSON endpoints, not linked from the
  site.

## Breaking changes

None to existing functionality. New `passwordHash` column is additive
(nullable). `pdfdadi_session` is a new cookie, separate from `pdfdadi_admin`.
Clerk is stubbed (not wired) — Local is the default.

## Remaining M2 tasks

- **M2.5 — Observability:** `IMetrics`/`ITracing`/`IAnalytics`/`IErrorReporter`
  interfaces + local implementations; Sentry/PostHog adapters later (the
  Phase 1.5 analytics agent recommended self-hosted PostHog + Sentry,
  privacy-first).
- **Follow-up (M2.8 enterprise):** API keys + webhooks (the `api_keys`/`webhooks`
  tables exist in the schema); retention policies + GDPR erasure; Clerk
  integration (webhook user-mirroring + session JWT verification); a
  `/api/auth/session` refresh + email verification; wire `IRoleProvider` into
  route guards.
