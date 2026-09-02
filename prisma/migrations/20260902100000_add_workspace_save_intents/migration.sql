-- Phase 5 data-identity closeout: save INTENTION is not save CONTENT.
--
-- Two changes, in this order, and both are additive to the data:
--
--  1. `workspace_save_intents` is created. It holds one row per intention to save
--     a result into a Workspace, which is what makes a retry converge and a
--     genuinely new save get its own document. No historical rows are fabricated:
--     a save that happened before this migration has no intention record, and the
--     keyless upload path (the file manager, the editor's first save) still
--     deduplicates by content, so every existing document keeps opening and
--     downloading exactly as before.
--
--  2. `document_ingestions (workspaceId, checksum)` stops being UNIQUE and becomes
--     an ordinary index. Dropping a uniqueness constraint cannot fail on existing
--     data and deletes nothing: every row that satisfied the unique index still
--     satisfies the plain one. The lookup it supports (content dedup for the
--     keyless path) is unchanged in speed and in scope.
--
-- ROLLBACK IS NOT SYMMETRIC. Re-creating the UNIQUE index fails if, by then, one
-- Workspace holds two ingestions with the same checksum — which is precisely the
-- behaviour this migration enables. Roll back by reverting the application code
-- and leaving the schema, or by first collapsing those rows by hand. See the
-- ledger's deployment note.

-- CreateTable
CREATE TABLE "workspace_save_intents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceIdentity" TEXT NOT NULL,
    "payloadChecksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "ingestionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
-- The claim. One row per (organization, actor, key): a concurrent second request
-- for the same intention loses this insert instead of doing the work twice, and a
-- key presented by a different actor lands on a different row rather than
-- reaching — or revealing — someone else's operation.
CREATE UNIQUE INDEX "workspace_save_intents_organizationId_userId_key_key" ON "workspace_save_intents"("organizationId", "userId", "key");

-- CreateIndex
CREATE INDEX "workspace_save_intents_workspaceId_status_idx" ON "workspace_save_intents"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "workspace_save_intents_documentId_idx" ON "workspace_save_intents"("documentId");

-- DropIndex
-- Content is no longer the identity of an operation. It stays indexed, because
-- the keyless upload path still asks "are these bytes already here?" — it just
-- stops being a rule that a Workspace may hold given bytes only once.
DROP INDEX "document_ingestions_workspaceId_checksum_key";

-- CreateIndex
CREATE INDEX "document_ingestions_workspaceId_checksum_idx" ON "document_ingestions"("workspaceId", "checksum");
