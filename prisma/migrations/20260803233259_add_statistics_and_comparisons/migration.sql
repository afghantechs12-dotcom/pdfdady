-- CreateTable
CREATE TABLE "document_statistics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "counts" TEXT NOT NULL DEFAULT '{}',
    "checksum" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "calculatedAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "comparison_operations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "leftVersionId" TEXT NOT NULL,
    "rightVersionId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'structural',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "requestedById" TEXT NOT NULL,
    "cancelRequestedAt" DATETIME,
    "error" TEXT,
    "resultId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "comparison_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '{}',
    "differences" TEXT NOT NULL DEFAULT '[]',
    "checksum" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "document_statistics_workspaceId_documentId_versionId_idx" ON "document_statistics"("workspaceId", "documentId", "versionId");

-- CreateIndex
CREATE INDEX "document_statistics_organizationId_workspaceId_idx" ON "document_statistics"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "document_statistics_documentId_status_idx" ON "document_statistics"("documentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "document_statistics_versionId_key" ON "document_statistics"("versionId");

-- CreateIndex
CREATE INDEX "comparison_operations_workspaceId_documentId_createdAt_idx" ON "comparison_operations"("workspaceId", "documentId", "createdAt");

-- CreateIndex
CREATE INDEX "comparison_operations_workspaceId_documentId_status_idx" ON "comparison_operations"("workspaceId", "documentId", "status");

-- CreateIndex
CREATE INDEX "comparison_operations_organizationId_workspaceId_idx" ON "comparison_operations"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "comparison_operations_requestedById_idx" ON "comparison_operations"("requestedById");

-- CreateIndex
CREATE INDEX "comparison_results_workspaceId_documentId_idx" ON "comparison_results"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "comparison_results_organizationId_workspaceId_idx" ON "comparison_results"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "comparison_results_comparisonId_key" ON "comparison_results"("comparisonId");
