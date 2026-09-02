-- Adds the display name captured at signup.
-- Additive and nullable: existing rows keep NULL, so this migration is
-- non-destructive and safe to apply to a populated database.
ALTER TABLE "users" ADD COLUMN "name" TEXT;
