-- CreateTable
CREATE TABLE "document_ingestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "storedFileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "checksum" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "pageCount" INTEGER,
    "failureReason" TEXT,
    "uploadedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "document_ingestions_workspaceId_status_idx" ON "document_ingestions"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "document_ingestions_organizationId_workspaceId_idx" ON "document_ingestions"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "document_ingestions_workspaceId_checksum_key" ON "document_ingestions"("workspaceId", "checksum");

-- CreateIndex
CREATE UNIQUE INDEX "document_ingestions_workspaceId_documentId_key" ON "document_ingestions"("workspaceId", "documentId");
