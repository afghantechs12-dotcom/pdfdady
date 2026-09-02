import { PrismaClient } from "@prisma/client";

/**
 * Repairs Workspaces created before `create` was atomic.
 *
 * `PrismaWorkspaceRepository.create` used to write the Workspace row alone, so
 * every Workspace created through the UI has no owner membership for its
 * creator. Those rows are now both unopenable (`WorkspaceService.get` requires a
 * membership or the organization default) and — since the picker became
 * membership-scoped — invisible. This writes the membership the transaction
 * should have written.
 *
 * Idempotent: it writes only where no membership row exists at all, so re-running
 * is a no-op. It grants only the row's own `createdById` the owner role it was
 * always supposed to have — never a membership for anyone else, and never a
 * revoked membership back.
 */
export interface BackfillReport {
  workspaces: number;
  repaired: number;
  alreadyPresent: number;
  /** Creator memberships that exist but were deliberately revoked — left alone. */
  revoked: number;
}

export async function runBackfill(prisma: PrismaClient): Promise<BackfillReport> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true, createdById: true } });
  const report: BackfillReport = {
    workspaces: workspaces.length,
    repaired: 0,
    alreadyPresent: 0,
    revoked: 0,
  };

  for (const workspace of workspaces) {
    const existing = await prisma.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: workspace.createdById } },
    });
    if (existing) {
      // A revoked row is a decision someone made, not damage from the bug.
      // Un-revoking it here would hand back access an admin removed, which is
      // exactly the kind of authorization weakening this repair must not do.
      if (existing.revokedAt === null) report.alreadyPresent += 1;
      else report.revoked += 1;
      continue;
    }
    await prisma.workspaceMembership.create({
      data: {
        workspaceId: workspace.id,
        userId: workspace.createdById,
        role: "owner",
        createdById: workspace.createdById,
      },
    });
    report.repaired += 1;
  }

  return report;
}

if (require.main === module) {
  const prisma = new PrismaClient();
  runBackfill(prisma)
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .finally(() => prisma.$disconnect());
}
