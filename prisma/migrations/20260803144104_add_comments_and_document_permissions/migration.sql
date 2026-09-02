-- CreateTable
CREATE TABLE "comment_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT,
    "anchorType" TEXT NOT NULL DEFAULT 'document',
    "anchor" TEXT NOT NULL DEFAULT '{"type":"document"}',
    "anchorSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdById" TEXT NOT NULL,
    "resolvedById" TEXT,
    "resolvedAt" DATETIME,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "comment_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentMessageId" TEXT,
    "body" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "editedAt" DATETIME,
    "deletedAt" DATETIME,
    "deletedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "document_permission_grants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "granteeUserId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "grantedById" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedById" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "comment_threads_workspaceId_documentId_status_createdAt_idx" ON "comment_threads"("workspaceId", "documentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "comment_threads_organizationId_workspaceId_idx" ON "comment_threads"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "comment_threads_documentId_versionId_idx" ON "comment_threads"("documentId", "versionId");

-- CreateIndex
CREATE INDEX "comment_threads_createdById_idx" ON "comment_threads"("createdById");

-- CreateIndex
CREATE INDEX "comment_messages_workspaceId_threadId_createdAt_idx" ON "comment_messages"("workspaceId", "threadId", "createdAt");

-- CreateIndex
CREATE INDEX "comment_messages_organizationId_workspaceId_idx" ON "comment_messages"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "comment_messages_threadId_parentMessageId_idx" ON "comment_messages"("threadId", "parentMessageId");

-- CreateIndex
CREATE INDEX "comment_messages_authorId_idx" ON "comment_messages"("authorId");

-- CreateIndex
CREATE INDEX "document_permission_grants_workspaceId_documentId_granteeUserId_revokedAt_idx" ON "document_permission_grants"("workspaceId", "documentId", "granteeUserId", "revokedAt");

-- CreateIndex
CREATE INDEX "document_permission_grants_organizationId_workspaceId_idx" ON "document_permission_grants"("organizationId", "workspaceId");

-- CreateIndex
CREATE INDEX "document_permission_grants_granteeUserId_idx" ON "document_permission_grants"("granteeUserId");

-- CreateIndex
CREATE INDEX "document_permission_grants_grantedById_idx" ON "document_permission_grants"("grantedById");
