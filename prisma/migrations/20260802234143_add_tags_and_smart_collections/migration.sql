-- CreateTable
CREATE TABLE "tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "color" TEXT,
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "document_tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "smart_collections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "queryVersion" INTEGER NOT NULL DEFAULT 1,
    "query" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "tags_organizationId_workspaceId_idx" ON "tags"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "tags_createdById_idx" ON "tags"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "tags_workspaceId_normalizedName_key" ON "tags"("workspaceId", "normalizedName");

-- CreateIndex
CREATE INDEX "document_tags_workspaceId_documentId_idx" ON "document_tags"("workspaceId", "documentId");

-- CreateIndex
CREATE INDEX "document_tags_workspaceId_tagId_idx" ON "document_tags"("workspaceId", "tagId");

-- CreateIndex
CREATE INDEX "document_tags_organizationId_workspaceId_idx" ON "document_tags"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "document_tags_documentId_tagId_key" ON "document_tags"("documentId", "tagId");

-- CreateIndex
CREATE INDEX "smart_collections_organizationId_workspaceId_idx" ON "smart_collections"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "smart_collections_createdById_idx" ON "smart_collections"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "smart_collections_workspaceId_normalizedName_key" ON "smart_collections"("workspaceId", "normalizedName");
