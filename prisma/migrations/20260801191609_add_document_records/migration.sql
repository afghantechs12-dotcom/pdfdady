-- CreateTable
CREATE TABLE "document_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "folderId" TEXT,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "lifecycleState" TEXT NOT NULL DEFAULT 'active',
    "orderKey" TEXT NOT NULL DEFAULT '',
    "currentVersionId" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "lastAccessedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "trashedAt" DATETIME,
    "archivedById" TEXT,
    "trashedById" TEXT
);

-- CreateIndex
CREATE INDEX "document_records_workspaceId_lifecycleState_idx" ON "document_records"("workspaceId", "lifecycleState");

-- CreateIndex
CREATE INDEX "document_records_workspaceId_projectId_idx" ON "document_records"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "document_records_workspaceId_folderId_idx" ON "document_records"("workspaceId", "folderId");

-- CreateIndex
CREATE INDEX "document_records_workspaceId_favorite_idx" ON "document_records"("workspaceId", "favorite");

-- CreateIndex
CREATE INDEX "document_records_workspaceId_lastAccessedAt_idx" ON "document_records"("workspaceId", "lastAccessedAt");

-- CreateIndex
CREATE INDEX "document_records_organizationId_workspaceId_idx" ON "document_records"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "document_records_createdById_idx" ON "document_records"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "document_records_workspaceId_folderId_normalizedName_key" ON "document_records"("workspaceId", "folderId", "normalizedName");
