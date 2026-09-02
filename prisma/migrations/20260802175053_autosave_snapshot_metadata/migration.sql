-- Corrective migration (applied after 20260802170336_add_autosave_drafts).
--
-- Rationale: docs/milestone-7-plan.md §4.3 requires AutosaveDraft to be a
-- metadata row plus a bounded object-storage editor-state snapshot — "Large
-- repeated editor-state JSON is not stored in SQLite." The initial migration
-- stored the serialized payload inline in a `payload` TEXT column. That column
-- is dropped here and replaced by snapshot reference fields.
--
-- SQLite 3.35+ supports in-place ALTER TABLE ... DROP COLUMN, so this migration
-- is a true column add/drop — no table rebuild. The generated Prisma client is
-- regenerated separately; this file only changes the database shape.
--
-- This migration is not applied to an existing deployment with data in
-- autosave_drafts: drafts stored before this correction have no object-storage
-- snapshot to point at. On such a deployment, the pre-migration drafts must be
-- discarded (or exported) before applying. The local dev database had zero
-- rows when this was applied.

-- Add the snapshot reference columns.
ALTER TABLE "autosave_drafts" ADD COLUMN "snapshotKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "autosave_drafts" ADD COLUMN "snapshotGeneration" INTEGER NOT NULL DEFAULT 1;

-- Drop the inline payload column (SQLite 3.35+).
ALTER TABLE "autosave_drafts" DROP COLUMN "payload";

-- Reference + retention indexes.
CREATE INDEX "autosave_drafts_snapshotKey_idx" ON "autosave_drafts"("snapshotKey");
CREATE INDEX "autosave_drafts_updatedAt_idx" ON "autosave_drafts"("updatedAt");
