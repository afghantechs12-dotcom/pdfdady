import type { PrismaClient, Prisma } from "@prisma/client";
import { normalizeWorkspaceName, normalizeWorkspaceSlug } from "./workspaceNormalization";

/**
 * Provisions the personal tenant for a newly registered user:
 * Organization → owner OrganizationMembership → default Workspace → owner
 * WorkspaceMembership → Organization.defaultWorkspaceId.
 *
 * WHY THIS EXISTS
 * ---------------
 * `AuthService.register` used to create only a `User` row. A freshly signed-up
 * user therefore had no Organization, so `/workspaces` — which resolves the
 * actor's first Organization and 404s without one — was unreachable. Signup
 * that cannot reach the product is not signup.
 *
 * IDEMPOTENCE
 * -----------
 * Every step is "find, else create", the whole thing runs in one transaction,
 * and the entry point is keyed on the user id. Re-running it for a user who is
 * already provisioned makes no writes and returns the existing ids. That makes
 * a retried signup (double-submit, network retry, a crash between two writes)
 * converge on exactly one Organization, one Workspace and one membership pair
 * rather than accumulating duplicates.
 *
 * Slug uniqueness is global on Organization, so the candidate walk below probes
 * increasing suffixes; the transaction plus the unique index is what actually
 * guarantees correctness under concurrency.
 */

export interface ProvisionedAccount {
  organizationId: string;
  workspaceId: string;
  /** True when this call created the Organization rather than reusing one. */
  created: boolean;
}

/** Derives a human-facing organization name from the user's name or email. */
export function personalOrganizationName(name: string | null, email: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length > 0) return `${trimmed}'s Organization`;
  const localPart = email.split("@")[0] ?? "personal";
  return `${localPart}'s Organization`;
}

/** Base slug candidate derived from the email local part, always non-empty. */
export function personalOrganizationSlug(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const slug = normalizeWorkspaceSlug(localPart);
  return slug.length > 0 ? slug : "workspace";
}

async function findOrCreateOrganization(
  tx: Prisma.TransactionClient,
  userId: string,
  email: string,
  name: string | null,
): Promise<{ id: string; name: string; slug: string; created: boolean }> {
  // Already a member of something? Reuse the earliest — that is this user's
  // personal tenant, and re-provisioning must never mint a second one.
  const existingMembership = await tx.organizationMembership.findFirst({
    where: { userId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (existingMembership) {
    const organization = await tx.organization.findUnique({
      where: { id: existingMembership.organizationId },
    });
    if (organization) {
      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        created: false,
      };
    }
  }

  const organizationName = personalOrganizationName(name, email);
  const baseSlug = personalOrganizationSlug(email);

  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const slug = suffix === 1 ? baseSlug : normalizeWorkspaceSlug(`${baseSlug}-${suffix}`);
    const taken = await tx.organization.findUnique({ where: { slug } });
    if (taken) continue;
    const organization = await tx.organization.create({
      data: { name: organizationName, slug, plan: "free" },
    });
    await tx.organizationMembership.create({
      data: { organizationId: organization.id, userId, role: "owner" },
    });
    return { id: organization.id, name: organization.name, slug: organization.slug, created: true };
  }

  throw new Error("Exhausted deterministic Organization slug candidates.");
}

async function findOrCreateDefaultWorkspace(
  tx: Prisma.TransactionClient,
  organization: { id: string; name: string; slug: string },
  ownerId: string,
): Promise<string> {
  // An existing, still-valid pointer is authoritative — honour it.
  const current = await tx.organization.findUnique({ where: { id: organization.id } });
  if (current?.defaultWorkspaceId) {
    const valid = await tx.workspace.findFirst({
      where: { id: current.defaultWorkspaceId, organizationId: organization.id },
    });
    if (valid) {
      await tx.workspaceMembership.upsert({
        where: { workspaceId_userId: { workspaceId: valid.id, userId: ownerId } },
        create: { workspaceId: valid.id, userId: ownerId, role: "owner", createdById: ownerId },
        update: {},
      });
      return valid.id;
    }
  }

  const baseName = `${organization.name} Workspace`;
  const baseSlug = normalizeWorkspaceSlug(`${organization.slug}-workspace`);

  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const workspaceName = suffix === 1 ? baseName : `${baseName} ${suffix}`;
    const slug = suffix === 1 ? baseSlug : normalizeWorkspaceSlug(`${baseSlug}-${suffix}`);
    const normalizedName = normalizeWorkspaceName(workspaceName);

    const existing = await tx.workspace.findFirst({
      where: {
        organizationId: organization.id,
        OR: [{ normalizedName }, { normalizedSlug: slug }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    // Exact match on both keys → reuse it rather than creating a near-duplicate.
    if (existing?.normalizedName === normalizedName && existing.normalizedSlug === slug) {
      await tx.workspaceMembership.upsert({
        where: { workspaceId_userId: { workspaceId: existing.id, userId: ownerId } },
        create: { workspaceId: existing.id, userId: ownerId, role: "owner", createdById: ownerId },
        update: {},
      });
      return existing.id;
    }
    // Partial collision on one key only → advance to the next candidate.
    if (existing) continue;

    const workspace = await tx.workspace.create({
      data: {
        organizationId: organization.id,
        name: workspaceName,
        normalizedName,
        slug,
        normalizedSlug: slug,
        description: "Default Workspace",
        createdById: ownerId,
      },
    });
    await tx.workspaceMembership.create({
      data: { workspaceId: workspace.id, userId: ownerId, role: "owner", createdById: ownerId },
    });
    return workspace.id;
  }

  throw new Error("Exhausted deterministic Workspace name candidates.");
}

/**
 * Ensures `userId` owns a personal Organization with an authoritative default
 * Workspace. Safe to call repeatedly — see the idempotence note above.
 */
export async function provisionPersonalAccount(
  prisma: PrismaClient,
  userId: string,
  email: string,
  name: string | null = null,
): Promise<ProvisionedAccount> {
  return prisma.$transaction(async (tx) => {
    const organization = await findOrCreateOrganization(tx, userId, email, name);
    const workspaceId = await findOrCreateDefaultWorkspace(tx, organization, userId);
    // Re-point unconditionally: cheap, and it repairs a dangling pointer left by
    // an interrupted earlier attempt.
    await tx.organization.update({
      where: { id: organization.id },
      data: { defaultWorkspaceId: workspaceId },
    });
    return { organizationId: organization.id, workspaceId, created: organization.created };
  });
}
