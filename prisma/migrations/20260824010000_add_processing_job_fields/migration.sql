-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "cancelRequestedAt" DATETIME;
ALTER TABLE "jobs" ADD COLUMN "errorCategory" TEXT;
ALTER TABLE "jobs" ADD COLUMN "expiresAt" DATETIME;
ALTER TABLE "jobs" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "jobs" ADD COLUMN "inputBytes" INTEGER;
ALTER TABLE "jobs" ADD COLUMN "outputBytes" INTEGER;
ALTER TABLE "jobs" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "jobs" ADD COLUMN "ownerType" TEXT;
ALTER TABLE "jobs" ADD COLUMN "progressStage" TEXT;
ALTER TABLE "jobs" ADD COLUMN "queuedAt" DATETIME;
ALTER TABLE "jobs" ADD COLUMN "safeErrorMessage" TEXT;
ALTER TABLE "jobs" ADD COLUMN "toolSlug" TEXT;
ALTER TABLE "jobs" ADD COLUMN "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "jobs_ownerType_ownerId_idx" ON "jobs"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "jobs_toolSlug_idx" ON "jobs"("toolSlug");

-- CreateIndex
CREATE INDEX "jobs_expiresAt_idx" ON "jobs"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_ownerType_ownerId_idempotencyKey_key" ON "jobs"("ownerType", "ownerId", "idempotencyKey");

