-- CreateTable
CREATE TABLE "workspace_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "activeTabId" TEXT,
    "tabs" TEXT NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "workspace_sessions_userId_idx" ON "workspace_sessions"("userId");

-- CreateIndex
CREATE INDEX "workspace_sessions_organizationId_workspaceId_idx" ON "workspace_sessions"("organizationId", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_sessions_workspaceId_userId_key" ON "workspace_sessions"("workspaceId", "userId");
