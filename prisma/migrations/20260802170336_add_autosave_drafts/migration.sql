-- CreateTable
CREATE TABLE "autosave_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "expectedRevision" INTEGER NOT NULL,
    "payload" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'dirty',
    "failureReason" TEXT,
    "leaseOwnerDeviceId" TEXT,
    "leaseExpiresAt" DATETIME,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "autosave_drafts_workspaceId_documentId_userId_idx" ON "autosave_drafts"("workspaceId", "documentId", "userId");

-- CreateIndex
CREATE INDEX "autosave_drafts_userId_workspaceId_idx" ON "autosave_drafts"("userId", "workspaceId");

-- CreateIndex
CREATE INDEX "autosave_drafts_workspaceId_status_idx" ON "autosave_drafts"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "autosave_drafts_workspaceId_documentId_userId_deviceId_key" ON "autosave_drafts"("workspaceId", "documentId", "userId", "deviceId");
