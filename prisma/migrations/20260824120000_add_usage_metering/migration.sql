-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventName" TEXT NOT NULL,
    "ownerType" TEXT,
    "planId" TEXT,
    "subjectHash" TEXT,
    "toolSlug" TEXT,
    "executionMode" TEXT,
    "result" TEXT,
    "errorCategory" TEXT,
    "attempt" INTEGER,
    "inputBytes" INTEGER,
    "outputBytes" INTEGER,
    "inputSizeBucket" TEXT,
    "pageCount" INTEGER,
    "durationMs" INTEGER,
    "costUnits" INTEGER,
    "properties" TEXT
);

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "meter" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "usage_events_occurredAt_idx" ON "usage_events"("occurredAt");

-- CreateIndex
CREATE INDEX "usage_events_eventName_occurredAt_idx" ON "usage_events"("eventName", "occurredAt");

-- CreateIndex
CREATE INDEX "usage_events_toolSlug_occurredAt_idx" ON "usage_events"("toolSlug", "occurredAt");

-- CreateIndex
CREATE INDEX "usage_counters_ownerType_ownerId_idx" ON "usage_counters"("ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "usage_counters_periodEnd_idx" ON "usage_counters"("periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_ownerType_ownerId_meter_periodStart_key" ON "usage_counters"("ownerType", "ownerId", "meter", "periodStart");
