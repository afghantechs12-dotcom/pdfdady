import type { PrismaClient, AutosaveDraft as AutosaveDraftRow } from "@prisma/client";
import type {
  AutosaveDraft,
  AutosaveDraftStatus,
} from "@/src/domain/entities/AutosaveDraft";
import { AUTOSAVE_DRAFT_LIMITS as L, autosaveDraftListLimit } from "@/src/domain/entities/AutosaveDraft";
import type {
  CreateAutosaveDraftInput,
  AutosaveDraftRepository,
  UpdateAutosaveDraftInput,
} from "@/src/application/ports/workspaces/AutosaveDraftRepository";

const VALID_STATUSES: readonly string[] = ["dirty", "saved", "conflict", "stale"];

/**
 * `status` is a plain String column (SQLite portability), so a row could in
 * principle hold a value outside the union. An unrecognized status is surfaced
 * as "conflict" rather than cast blindly: a draft in an unknown state must not
 * be treated as clean or committed.
 */
function toStatus(value: string): AutosaveDraftStatus {
  return VALID_STATUSES.includes(value) ? (value as AutosaveDraftStatus) : "conflict";
}

/** Keeps a stored counter finite and non-negative even if a row was written badly. */
function toCounter(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(0, Math.trunc(value)), L.maxCounter);
}

function toDomain(row: AutosaveDraftRow): AutosaveDraft {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    organizationId: row.organizationId,
    documentId: row.documentId,
    userId: row.userId,
    deviceId: row.deviceId.slice(0, L.maxDeviceIdLength),
    baseVersion: toCounter(row.baseVersion, 0),
    expectedRevision: toCounter(row.expectedRevision, 0),
    snapshotKey: row.snapshotKey.slice(0, L.maxSnapshotKeyLength),
    snapshotGeneration: toCounter(row.snapshotGeneration, 1),
    checksum: row.checksum,
    byteSize: toCounter(row.byteSize, 0),
    status: toStatus(row.status),
    failureReason: row.failureReason?.slice(0, L.maxFailureReasonLength) ?? null,
    leaseOwnerDeviceId: row.leaseOwnerDeviceId?.slice(0, L.maxDeviceIdLength) ?? null,
    // Copied, not aliased: a caller mutating a returned Date must not be able to
    // reach the row behind it.
    leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt) : null,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/** Listing bound — a caller-supplied limit can never widen past the domain cap. */
const toTake = autosaveDraftListLimit;

export class PrismaAutosaveDraftRepository implements AutosaveDraftRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateAutosaveDraftInput): Promise<AutosaveDraft> {
    const row = await this.prisma.autosaveDraft.create({
      data: {
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        documentId: input.documentId,
        userId: input.userId,
        deviceId: input.deviceId.slice(0, L.maxDeviceIdLength),
        baseVersion: input.baseVersion,
        expectedRevision: input.expectedRevision,
        snapshotKey: input.snapshotKey.slice(0, L.maxSnapshotKeyLength),
        snapshotGeneration: input.snapshotGeneration,
        checksum: input.checksum,
        byteSize: input.byteSize,
        status: input.status,
        leaseOwnerDeviceId:
          input.leaseOwnerDeviceId?.slice(0, L.maxDeviceIdLength) ?? null,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
      },
    });
    return toDomain(row);
  }

  async getById(workspaceId: string, draftId: string): Promise<AutosaveDraft | null> {
    const row = await this.prisma.autosaveDraft.findFirst({
      where: { id: draftId, workspaceId },
    });
    return row ? toDomain(row) : null;
  }

  async findByDevice(
    workspaceId: string,
    documentId: string,
    userId: string,
    deviceId: string,
  ): Promise<AutosaveDraft | null> {
    const row = await this.prisma.autosaveDraft.findFirst({
      where: { workspaceId, documentId, userId, deviceId },
    });
    return row ? toDomain(row) : null;
  }

  async listByDocument(
    workspaceId: string,
    documentId: string,
    limit: number = L.maxDraftsPerDocument,
  ): Promise<AutosaveDraft[]> {
    const rows = await this.prisma.autosaveDraft.findMany({
      where: { workspaceId, documentId },
      orderBy: { updatedAt: "desc" },
      take: toTake(limit),
    });
    return rows.map(toDomain);
  }

  async listByDocumentAndUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    limit: number = L.maxDraftsPerDocument,
  ): Promise<AutosaveDraft[]> {
    const rows = await this.prisma.autosaveDraft.findMany({
      where: { workspaceId, documentId, userId },
      orderBy: { updatedAt: "desc" },
      take: toTake(limit),
    });
    return rows.map(toDomain);
  }

  async update(
    workspaceId: string,
    draftId: string,
    data: UpdateAutosaveDraftInput,
    expectedVersion?: number,
  ): Promise<AutosaveDraft | null> {
    // updateMany keeps workspaceId (and, when supplied, the expected version) in
    // the WHERE clause, so a cross-Workspace or lost-update write is impossible
    // rather than merely unlikely.
    const result = await this.prisma.autosaveDraft.updateMany({
      where: {
        id: draftId,
        workspaceId,
        ...(expectedVersion !== undefined ? { version: expectedVersion } : {}),
      },
      data: {
        ...(data.snapshotKey !== undefined
          ? { snapshotKey: data.snapshotKey.slice(0, L.maxSnapshotKeyLength) }
          : {}),
        ...(data.snapshotGeneration !== undefined
          ? { snapshotGeneration: data.snapshotGeneration }
          : {}),
        ...(data.checksum !== undefined ? { checksum: data.checksum } : {}),
        ...(data.byteSize !== undefined ? { byteSize: data.byteSize } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.failureReason !== undefined
          ? { failureReason: data.failureReason?.slice(0, L.maxFailureReasonLength) ?? null }
          : {}),
        ...(data.leaseOwnerDeviceId !== undefined
          ? { leaseOwnerDeviceId: data.leaseOwnerDeviceId?.slice(0, L.maxDeviceIdLength) ?? null }
          : {}),
        ...(data.leaseExpiresAt !== undefined ? { leaseExpiresAt: data.leaseExpiresAt } : {}),
        version: { increment: 1 },
      },
    });
    if (result.count === 0) return null;

    return this.getById(workspaceId, draftId);
  }

  async delete(workspaceId: string, draftId: string): Promise<boolean> {
    const result = await this.prisma.autosaveDraft.deleteMany({
      where: { id: draftId, workspaceId },
    });
    return result.count > 0;
  }

  async isSnapshotReferenced(workspaceId: string, snapshotKey: string): Promise<boolean> {
    const row = await this.prisma.autosaveDraft.findFirst({
      where: { workspaceId, snapshotKey },
      select: { id: true },
    });
    return row !== null;
  }
}
