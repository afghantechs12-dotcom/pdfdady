-- M7.1 additive Workspace foundation.
-- Existing Organization identifiers and semantics are preserved.

ALTER TABLE "organizations" ADD COLUMN "defaultWorkspaceId" TEXT;

CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "normalizedSlug" TEXT NOT NULL,
    "description" TEXT,
    "lifecycleState" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "trashedAt" DATETIME,
    "archivedById" TEXT,
    "trashedById" TEXT
);

CREATE TABLE "workspace_memberships" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "organizations_defaultWorkspaceId_idx" ON "organizations"("defaultWorkspaceId");
CREATE UNIQUE INDEX "workspaces_organizationId_normalizedName_key" ON "workspaces"("organizationId", "normalizedName");
CREATE UNIQUE INDEX "workspaces_organizationId_normalizedSlug_key" ON "workspaces"("organizationId", "normalizedSlug");
CREATE INDEX "workspaces_organizationId_lifecycleState_idx" ON "workspaces"("organizationId", "lifecycleState");
CREATE INDEX "workspaces_organizationId_createdAt_idx" ON "workspaces"("organizationId", "createdAt");
CREATE UNIQUE INDEX "workspace_memberships_workspaceId_userId_key" ON "workspace_memberships"("workspaceId", "userId");
CREATE INDEX "workspace_memberships_workspaceId_revokedAt_idx" ON "workspace_memberships"("workspaceId", "revokedAt");
CREATE INDEX "workspace_memberships_userId_workspaceId_idx" ON "workspace_memberships"("userId", "workspaceId");
