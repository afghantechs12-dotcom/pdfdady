-- CreateTable
CREATE TABLE "search_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "checksum" TEXT NOT NULL DEFAULT '',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "indexedAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "search_chunks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "searchDocumentId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'text',
    "pageNumber" INTEGER,
    "text" TEXT NOT NULL,
    "normalizedText" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "search_documents_workspaceId_state_idx" ON "search_documents"("workspaceId", "state");

-- CreateIndex
CREATE INDEX "search_documents_organizationId_workspaceId_idx" ON "search_documents"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "search_documents_documentId_idx" ON "search_documents"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "search_documents_workspaceId_documentId_key" ON "search_documents"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "search_chunks_workspaceId_documentId_idx" ON "search_chunks"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "search_chunks_workspaceId_searchDocumentId_idx" ON "search_chunks"("workspaceId", "searchDocumentId");

-- CreateIndex
CREATE INDEX "search_chunks_organizationId_workspaceId_idx" ON "search_chunks"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "search_chunks_searchDocumentId_ordinal_key" ON "search_chunks"("searchDocumentId", "ordinal");
