import { PrismaClient, type Prisma } from "@prisma/client";
import { normalizeWorkspaceName, normalizeWorkspaceSlug } from "../src/application/services/workspaceNormalization";

export interface WorkspaceProvisionReport {
  organizations: number;
  processed: number;
  created: number;
  reused: number;
  pointersRepaired: number;
  skipped: number;
  failures: Array<{ organizationId: string; message: string }>;
  interrupted: boolean;
}

export interface WorkspaceProvisionOptions {
  maxOrganizations?: number;
  beforeOrganization?: (organizationId: string) => void | Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown provisioning failure.";
}

async function selectOrCreateWorkspace(
  tx: Prisma.TransactionClient,
  organization: { id: string; name: string; slug: string },
  ownerId: string,
): Promise<{ id: string; created: boolean }> {
  const baseName = `${organization.name} Workspace`;
  const baseSlug = normalizeWorkspaceSlug(`${organization.slug}-workspace`);

  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName} ${suffix}`;
    const slug = suffix === 1 ? baseSlug : normalizeWorkspaceSlug(`${baseSlug}-${suffix}`);
    const normalizedName = normalizeWorkspaceName(name);
    const existing = await tx.workspace.findFirst({
      where: {
        organizationId: organization.id,
        OR: [{ normalizedName }, { normalizedSlug: slug }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

    if (existing?.normalizedName === normalizedName && existing.normalizedSlug === slug) {
      return { id: existing.id, created: false };
    }
    if (existing) continue;

    const created = await tx.workspace.create({
      data: {
        organizationId: organization.id,
        name,
        normalizedName,
        slug,
        normalizedSlug: slug,
        description: "Default Workspace",
        createdById: ownerId,
      },
    });
    return { id: created.id, created: true };
  }

  throw new Error(`Organization ${organization.id} exhausted deterministic Workspace name candidates.`);
}

export async function provisionAllDefaultWorkspaces(
  prisma: PrismaClient,
  options: WorkspaceProvisionOptions = {},
): Promise<WorkspaceProvisionReport> {
  const organizations = await prisma.organization.findMany({ orderBy: { id: "asc" } });
  const limit = Math.max(0, Math.min(options.maxOrganizations ?? organizations.length, organizations.length));
  const report: WorkspaceProvisionReport = {
    organizations: organizations.length,
    processed: 0,
    created: 0,
    reused: 0,
    pointersRepaired: 0,
    skipped: 0,
    failures: [],
    interrupted: limit < organizations.length,
  };

  for (const organization of organizations.slice(0, limit)) {
    try {
      await options.beforeOrganization?.(organization.id);
      const outcome = await prisma.$transaction(async (tx) => {
        const current = await tx.organization.findUnique({ where: { id: organization.id } });
        if (!current) return { kind: "skipped" as const };

        if (current.defaultWorkspaceId) {
          const valid = await tx.workspace.findFirst({
            where: { id: current.defaultWorkspaceId, organizationId: current.id },
          });
          if (valid) return { kind: "skipped" as const };
        }

        const owner = await tx.organizationMembership.findFirst({
          where: { organizationId: current.id, role: "owner" },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        if (!owner) throw new Error(`Organization ${current.id} has no owner for default Workspace provisioning.`);

        const workspace = await selectOrCreateWorkspace(tx, current, owner.userId);
        await tx.workspaceMembership.upsert({
          where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.userId } },
          create: { workspaceId: workspace.id, userId: owner.userId, role: "owner", createdById: owner.userId },
          update: {},
        });
        await tx.organization.update({ where: { id: current.id }, data: { defaultWorkspaceId: workspace.id } });
        return { kind: workspace.created ? "created" as const : "reused" as const };
      });

      report.processed += 1;
      if (outcome.kind === "skipped") report.skipped += 1;
      if (outcome.kind === "created") {
        report.created += 1;
        report.pointersRepaired += 1;
      }
      if (outcome.kind === "reused") {
        report.reused += 1;
        report.pointersRepaired += 1;
      }
    } catch (error) {
      report.processed += 1;
      report.failures.push({ organizationId: organization.id, message: messageOf(error) });
    }
  }

  return report;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  provisionAllDefaultWorkspaces(prisma)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.failures.length > 0) process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
