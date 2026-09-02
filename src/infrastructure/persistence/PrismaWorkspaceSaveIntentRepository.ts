import { PrismaClient } from "@prisma/client";
import type {
  SaveIntentIdentity,
  SaveIntentMeaning,
  WorkspaceSaveIntentRepository,
} from "@/src/application/ports/workspaces/WorkspaceSaveIntentRepository";
import type {
  SaveIntentSourceKind,
  SaveIntentStatus,
  WorkspaceSaveIntent,
} from "@/src/domain/entities/WorkspaceSaveIntent";

type Row = {
  id: string;
  key: string;
  organizationId: string;
  userId: string;
  workspaceId: string;
  sourceKind: string;
  sourceIdentity: string;
  payloadChecksum: string;
  status: string;
  documentId: string | null;
  ingestionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDomain(row: Row): WorkspaceSaveIntent {
  return {
    ...row,
    sourceKind: row.sourceKind as SaveIntentSourceKind,
    status: row.status as SaveIntentStatus,
  };
}

/**
 * Prisma-backed save-intent identity over `workspace_save_intents`.
 *
 * The two writes that matter are the two that must be atomic against a concurrent
 * copy of themselves. `insertPending` leans on the unique index rather than on a
 * read-then-write, and `takeOverStale` is a conditional `updateMany` whose WHERE
 * carries the value it expects to find — so both hold across processes, workers and
 * a restart, which is the whole point of putting operation identity in a row.
 */
export class PrismaWorkspaceSaveIntentRepository implements WorkspaceSaveIntentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async insertPending(
    identity: SaveIntentIdentity,
    meaning: SaveIntentMeaning,
  ): Promise<WorkspaceSaveIntent | null> {
    try {
      const row = await this.prisma.workspaceSaveIntent.create({
        data: { ...identity, ...meaning, status: "pending" },
      });
      return toDomain(row);
    } catch (error) {
      // P2002 — the unique index refused it, i.e. this identity is already
      // claimed. Read off the code rather than the message, and rethrown for
      // anything else so a real fault is not mistaken for a lost race.
      if ((error as { code?: string }).code === "P2002") return null;
      throw error;
    }
  }

  async find(identity: SaveIntentIdentity): Promise<WorkspaceSaveIntent | null> {
    const row = await this.prisma.workspaceSaveIntent.findUnique({
      where: {
        organizationId_userId_key: {
          organizationId: identity.organizationId,
          userId: identity.userId,
          key: identity.key,
        },
      },
    });
    return row ? toDomain(row) : null;
  }

  async reclaim(
    id: string,
    expectedUpdatedAt: Date,
    meaning: SaveIntentMeaning,
  ): Promise<boolean> {
    const { count } = await this.prisma.workspaceSaveIntent.updateMany({
      // `status` in the WHERE, not just `updatedAt`: a row that completed between
      // the read and this write must not be reopened, and `completed` is the one
      // status whose document is the answer.
      where: { id, status: { in: ["pending", "failed"] }, updatedAt: expectedUpdatedAt },
      data: { ...meaning, status: "pending", documentId: null, ingestionId: null },
    });
    return count > 0;
  }

  async complete(id: string, documentId: string, ingestionId: string): Promise<void> {
    await this.prisma.workspaceSaveIntent.updateMany({
      where: { id },
      data: { status: "completed", documentId, ingestionId },
    });
  }

  async fail(id: string): Promise<void> {
    await this.prisma.workspaceSaveIntent.updateMany({
      where: { id },
      data: { status: "failed" },
    });
  }
}
