import type {
  SaveIntentIdentity,
  SaveIntentMeaning,
  WorkspaceSaveIntentRepository,
} from "@/src/application/ports/workspaces/WorkspaceSaveIntentRepository";
import type { WorkspaceSaveIntent } from "@/src/domain/entities/WorkspaceSaveIntent";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-save-intent-${counter}`;
}

function scopeOf(identity: SaveIntentIdentity): string {
  return `${identity.organizationId}\u0000${identity.userId}\u0000${identity.key}`;
}

function clone(intent: WorkspaceSaveIntent): WorkspaceSaveIntent {
  return {
    ...intent,
    createdAt: new Date(intent.createdAt),
    updatedAt: new Date(intent.updatedAt),
  };
}

/**
 * In-memory save-intent identity, for tests and for the container's no-database
 * path.
 *
 * It mirrors the one property the Prisma adapter is chosen FOR: `insertPending`
 * refuses a second claim on `(organizationId, userId, key)`, and `takeOverStale`
 * compares before it swaps. A twin that let both succeed would make every
 * convergence test written against it vacuous — which is how a constraint comes to
 * be trusted for a job it does not do. What it cannot mirror is genuine
 * parallelism, so the concurrency behaviour is proved against real SQLite in
 * `src/application/services/saveIntentIdentity.test.ts`.
 */
export class InMemoryWorkspaceSaveIntentRepository implements WorkspaceSaveIntentRepository {
  private readonly rows = new Map<string, WorkspaceSaveIntent>();

  async insertPending(
    identity: SaveIntentIdentity,
    meaning: SaveIntentMeaning,
  ): Promise<WorkspaceSaveIntent | null> {
    const scope = scopeOf(identity);
    if (this.rows.has(scope)) return null;
    const now = new Date();
    const row: WorkspaceSaveIntent = {
      id: uid(),
      ...identity,
      ...meaning,
      status: "pending",
      documentId: null,
      ingestionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(scope, row);
    return clone(row);
  }

  async find(identity: SaveIntentIdentity): Promise<WorkspaceSaveIntent | null> {
    const row = this.rows.get(scopeOf(identity));
    return row ? clone(row) : null;
  }

  async reclaim(
    id: string,
    expectedUpdatedAt: Date,
    meaning: SaveIntentMeaning,
  ): Promise<boolean> {
    const found = this.locate(id);
    if (found === null) return false;
    const [scope, row] = found;
    if (row.status === "completed") return false;
    if (row.updatedAt.getTime() !== expectedUpdatedAt.getTime()) return false;
    this.rows.set(scope, {
      ...row,
      ...meaning,
      status: "pending",
      documentId: null,
      ingestionId: null,
      updatedAt: new Date(),
    });
    return true;
  }

  async complete(id: string, documentId: string, ingestionId: string): Promise<void> {
    this.patch(id, { status: "completed", documentId, ingestionId });
  }

  async fail(id: string): Promise<void> {
    this.patch(id, { status: "failed" });
  }

  private locate(id: string): [string, WorkspaceSaveIntent] | null {
    for (const [scope, row] of this.rows) {
      if (row.id === id) return [scope, row];
    }
    return null;
  }

  private patch(id: string, data: Partial<WorkspaceSaveIntent>): void {
    const found = this.locate(id);
    if (found === null) return;
    const [scope, row] = found;
    this.rows.set(scope, { ...row, ...data, updatedAt: new Date() });
  }
}
