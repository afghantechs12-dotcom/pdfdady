-- CreateTable
-- One row per organization; created with the provider customer, before any
-- subscription exists, which is why the subscription columns are nullable.
CREATE TABLE "billing_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "providerCustomerId" TEXT NOT NULL,
    "providerSubscriptionId" TEXT,
    "providerPriceId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "planId" TEXT NOT NULL DEFAULT 'free',
    "currentPeriodEnd" DATETIME,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "lastEventAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
-- The PRIMARY KEY on the provider event id is the webhook idempotency guard:
-- whichever delivery inserts first owns the event, every retry violates the
-- constraint instead of applying a second plan change.
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscriptions_organizationId_key" ON "billing_subscriptions"("organizationId");

-- CreateIndex
-- Unique for ownership, not speed: a webhook resolves the organization FROM the
-- customer id, so two orgs sharing one customer would make that lookup ambiguous.
CREATE UNIQUE INDEX "billing_subscriptions_providerCustomerId_key" ON "billing_subscriptions"("providerCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_subscriptions_providerSubscriptionId_key" ON "billing_subscriptions"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "billing_subscriptions_status_idx" ON "billing_subscriptions"("status");

-- CreateIndex
CREATE INDEX "billing_events_receivedAt_idx" ON "billing_events"("receivedAt");
