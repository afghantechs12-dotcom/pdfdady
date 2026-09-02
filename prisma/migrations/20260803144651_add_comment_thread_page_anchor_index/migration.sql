-- AlterTable
ALTER TABLE "comment_threads" ADD COLUMN "pageNumber" INTEGER;

-- CreateIndex
CREATE INDEX "comment_threads_workspaceId_documentId_pageNumber_idx" ON "comment_threads"("workspaceId", "documentId", "pageNumber");
