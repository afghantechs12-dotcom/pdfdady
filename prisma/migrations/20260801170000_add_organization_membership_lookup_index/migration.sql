-- M7.1 corrective migration: reconcile the existing Prisma schema's
-- OrganizationMembership lookup index without editing an applied migration.
CREATE INDEX "organization_memberships_userId_organizationId_idx"
ON "organization_memberships"("userId", "organizationId");
