-- CreateTable
-- The PRIMARY KEY on "key" is the durable settlement guard: whichever worker
-- inserts first owns the settlement, and every later attempt gets a unique
-- constraint violation instead of a second refund.
CREATE TABLE "usage_settlements" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "claimedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "usage_settlements_claimedAt_idx" ON "usage_settlements"("claimedAt");
