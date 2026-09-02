-- M7.6 durable document versions.
--
-- Immutable checkpoints. Rows are inserted and never updated; a restore inserts
-- a new row carrying "restoredFromVersionId" rather than rewinding history
-- (docs/milestone-7-plan.md 6.3).
--
-- The unique constraint on (documentId, versionNumber) is load-bearing, not
-- decorative: version numbers are allocated by re-reading the authoritative
-- maximum inside the insert transaction, and this constraint is what makes a
-- losing concurrent writer fail and retry instead of duplicating a number.

-- CreateTable
CREATE TABLE "document_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'save',
    "restoredFromVersionId" TEXT,
    "label" TEXT,
    "manifest" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_documentId_versionNumber_key" ON "document_versions"("documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "document_versions_workspaceId_documentId_versionNumber_idx" ON "document_versions"("workspaceId", "documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "document_versions_workspaceId_documentId_createdAt_idx" ON "document_versions"("workspaceId", "documentId", "createdAt");

-- CreateIndex
CREATE INDEX "document_versions_organizationId_workspaceId_idx" ON "document_versions"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "document_versions_restoredFromVersionId_idx" ON "document_versions"("restoredFromVersionId");

-- CreateIndex
CREATE INDEX "document_versions_createdById_idx" ON "document_versions"("createdById");
