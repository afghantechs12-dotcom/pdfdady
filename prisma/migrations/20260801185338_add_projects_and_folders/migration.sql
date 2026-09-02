-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "normalizedSlug" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lifecycleState" TEXT NOT NULL DEFAULT 'active',
    "orderKey" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "trashedAt" DATETIME,
    "archivedById" TEXT,
    "trashedById" TEXT
);

-- CreateTable
CREATE TABLE "folders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "orderKey" TEXT NOT NULL DEFAULT '',
    "lifecycleState" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "trashedAt" DATETIME,
    "archivedById" TEXT,
    "trashedById" TEXT
);

-- CreateIndex
CREATE INDEX "projects_workspaceId_lifecycleState_idx" ON "projects"("workspaceId", "lifecycleState");

-- CreateIndex
CREATE INDEX "projects_workspaceId_orderKey_idx" ON "projects"("workspaceId", "orderKey");

-- CreateIndex
CREATE INDEX "projects_organizationId_workspaceId_idx" ON "projects"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_normalizedName_key" ON "projects"("workspaceId", "normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "projects_workspaceId_normalizedSlug_key" ON "projects"("workspaceId", "normalizedSlug");

-- CreateIndex
CREATE INDEX "folders_workspaceId_lifecycleState_idx" ON "folders"("workspaceId", "lifecycleState");

-- CreateIndex
CREATE INDEX "folders_workspaceId_projectId_idx" ON "folders"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "folders_workspaceId_parentId_idx" ON "folders"("workspaceId", "parentId");

-- CreateIndex
CREATE INDEX "folders_organizationId_workspaceId_idx" ON "folders"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "folders_workspaceId_parentId_normalizedName_key" ON "folders"("workspaceId", "parentId", "normalizedName");
