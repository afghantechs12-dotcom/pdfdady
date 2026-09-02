-- CreateTable
CREATE TABLE "document_metadata" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fields" TEXT NOT NULL DEFAULT '{}',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "workspace_bookmarks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "anchorX" REAL,
    "anchorY" REAL,
    "orderKey" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "outline_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "parentId" TEXT,
    "title" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "orderKey" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'workspace',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "attachment_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "storedFileId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'workspace',
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "description" TEXT,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "checksum" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "document_metadata_organizationId_workspaceId_idx" ON "document_metadata"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "document_metadata_documentId_idx" ON "document_metadata"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "document_metadata_workspaceId_documentId_key" ON "document_metadata"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "workspace_bookmarks_workspaceId_documentId_orderKey_idx" ON "workspace_bookmarks"("workspaceId", "documentId", "orderKey");

-- CreateIndex
CREATE INDEX "workspace_bookmarks_workspaceId_documentId_pageNumber_idx" ON "workspace_bookmarks"("workspaceId", "documentId", "pageNumber");

-- CreateIndex
CREATE INDEX "workspace_bookmarks_organizationId_workspaceId_idx" ON "workspace_bookmarks"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "workspace_bookmarks_createdById_idx" ON "workspace_bookmarks"("createdById");

-- CreateIndex
CREATE INDEX "outline_items_workspaceId_documentId_origin_orderKey_idx" ON "outline_items"("workspaceId", "documentId", "origin", "orderKey");

-- CreateIndex
CREATE INDEX "outline_items_workspaceId_parentId_idx" ON "outline_items"("workspaceId", "parentId");

-- CreateIndex
CREATE INDEX "outline_items_organizationId_workspaceId_idx" ON "outline_items"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "outline_items_documentId_idx" ON "outline_items"("documentId");

-- CreateIndex
CREATE INDEX "attachment_records_workspaceId_documentId_origin_idx" ON "attachment_records"("workspaceId", "documentId", "origin");

-- CreateIndex
CREATE INDEX "attachment_records_organizationId_workspaceId_idx" ON "attachment_records"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "attachment_records_storedFileId_idx" ON "attachment_records"("storedFileId");

-- CreateIndex
CREATE INDEX "attachment_records_createdById_idx" ON "attachment_records"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "attachment_records_documentId_normalizedName_key" ON "attachment_records"("documentId", "normalizedName");
