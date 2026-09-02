import type { AutosaveDraft } from "@/src/domain/entities/AutosaveDraft";
import { AUTOSAVE_DRAFT_LIMITS as L, autosaveDraftListLimit } from "@/src/domain/entities/AutosaveDraft";
import type {
  CreateAutosaveDraftInput,
  AutosaveDraftRepository,
  UpdateAutosaveDraftInput,
} from "@/src/application/ports/workspaces/AutosaveDraftRepository";

let counter = 0;
function uid(): string {
  counter += 1;
  return `inmem-draft-${counter}`;
}

function clamp(input: UpdateAutosaveDraftInput): UpdateAutosaveDraftInput {
  const clamped = { ...input };
  if (clamped.failureReason != null) {
    clamped.failureReason = clamped.failureReason.slice(0, L.maxFailureReasonLength);
  }
  if (clamped.snapshotKey != null) {
    clamped.snapshotKey = clamped.snapshotKey.slice(0, L.maxSnapshotKeyLength);
  }
  return clamped;
}

function clone(draft: AutosaveDraft): AutosaveDraft {
  return {
    ...draft,
    leaseExpiresAt: draft.leaseExpiresAt ? new Date(draft.leaseExpiresAt) : null,
    createdAt: new Date(draft.createdAt),
    updatedAt: new Date(draft.updatedAt),
  };
}

/**
 * In-memory AutosaveDraftRepository — for tests and as a zero-dependency
 * fallback. Mirrors the Prisma adapter's Workspace scoping, the
 * (workspaceId, documentId, userId, deviceId) single-draft rule, version-checked
 * updates, and the snapshot-reference predicate.
 */
export class InMemoryAutosaveDraftRepository implements AutosaveDraftRepository {
  private readonly rows = new Map<string, AutosaveDraft>();

  async create(input: CreateAutosaveDraftInput): Promise<AutosaveDraft> {
    const now = new Date();
    const row: AutosaveDraft = {
      id: uid(),
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      documentId: input.documentId,
      userId: input.userId,
      deviceId: input.deviceId,
      baseVersion: input.baseVersion,
      expectedRevision: input.expectedRevision,
      snapshotKey: input.snapshotKey,
      snapshotGeneration: input.snapshotGeneration,
      checksum: input.checksum,
      byteSize: input.byteSize,
      status: input.status,
      failureReason: null,
      leaseOwnerDeviceId: input.leaseOwnerDeviceId ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return clone(row);
  }

  async getById(workspaceId: string, draftId: string): Promise<AutosaveDraft | null> {
    const row = this.rows.get(draftId);
    if (!row || row.workspaceId !== workspaceId) return null;
    return clone(row);
  }

  async findByDevice(
    workspaceId: string,
    documentId: string,
    userId: string,
    deviceId: string,
  ): Promise<AutosaveDraft | null> {
    for (const row of this.rows.values()) {
      if (
        row.workspaceId === workspaceId &&
        row.documentId === documentId &&
        row.userId === userId &&
        row.deviceId === deviceId
      ) {
        return clone(row);
      }
    }
    return null;
  }

  async listByDocument(
    workspaceId: string,
    documentId: string,
    limit: number = L.maxDraftsPerDocument,
  ): Promise<AutosaveDraft[]> {
    return [...this.rows.values()]
      .filter((row) => row.workspaceId === workspaceId && row.documentId === documentId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, autosaveDraftListLimit(limit))
      .map(clone);
  }

  async listByDocumentAndUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    limit: number = L.maxDraftsPerDocument,
  ): Promise<AutosaveDraft[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.workspaceId === workspaceId &&
          row.documentId === documentId &&
          row.userId === userId,
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, autosaveDraftListLimit(limit))
      .map(clone);
  }

  async update(
    workspaceId: string,
    draftId: string,
    data: UpdateAutosaveDraftInput,
    expectedVersion?: number,
  ): Promise<AutosaveDraft | null> {
    const row = this.rows.get(draftId);
    if (!row || row.workspaceId !== workspaceId) return null;
    if (expectedVersion !== undefined && row.version !== expectedVersion) return null;

    const changes = clamp(data);
    const updated: AutosaveDraft = {
      ...row,
      snapshotKey: changes.snapshotKey ?? row.snapshotKey,
      snapshotGeneration: changes.snapshotGeneration ?? row.snapshotGeneration,
      checksum: changes.checksum ?? row.checksum,
      byteSize: changes.byteSize ?? row.byteSize,
      status: changes.status ?? row.status,
      failureReason: changes.failureReason !== undefined ? changes.failureReason : row.failureReason,
      leaseOwnerDeviceId:
        changes.leaseOwnerDeviceId !== undefined
          ? changes.leaseOwnerDeviceId
          : row.leaseOwnerDeviceId,
      leaseExpiresAt:
        changes.leaseExpiresAt !== undefined ? changes.leaseExpiresAt : row.leaseExpiresAt,
      version: row.version + 1,
      updatedAt: new Date(),
    };
    this.rows.set(draftId, updated);
    return clone(updated);
  }

  async delete(workspaceId: string, draftId: string): Promise<boolean> {
    const row = this.rows.get(draftId);
    if (!row || row.workspaceId !== workspaceId) return false;
    return this.rows.delete(draftId);
  }

  async isSnapshotReferenced(workspaceId: string, snapshotKey: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.snapshotKey === snapshotKey) return true;
    }
    return false;
  }
}
