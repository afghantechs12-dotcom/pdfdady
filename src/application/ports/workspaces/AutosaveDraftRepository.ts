import type { AutosaveDraft, AutosaveDraftStatus } from "@/src/domain/entities/AutosaveDraft";

export interface CreateAutosaveDraftInput {
  workspaceId: string;
  organizationId: string;
  documentId: string;
  userId: string;
  deviceId: string;
  baseVersion: number;
  expectedRevision: number;
  /** Object-storage key of the serialized editor state. */
  snapshotKey: string;
  /** Monotonic per-draft counter embedded in `snapshotKey`. */
  snapshotGeneration: number;
  checksum: string;
  byteSize: number;
  status: AutosaveDraftStatus;
  leaseOwnerDeviceId?: string | null;
  leaseExpiresAt?: Date | null;
}

export interface UpdateAutosaveDraftInput {
  snapshotKey?: string;
  snapshotGeneration?: number;
  checksum?: string;
  byteSize?: number;
  status?: AutosaveDraftStatus;
  failureReason?: string | null;
  leaseOwnerDeviceId?: string | null;
  leaseExpiresAt?: Date | null;
}

/**
 * AutosaveDraftRepository port — durable metadata for per-device document
 * drafts. The serialized editor state itself lives in object storage under the
 * draft's `snapshotKey`; this port persists only the row that references it.
 *
 * Every method takes a Workspace id (or the pair (workspaceId, userId)) and
 * never resolves a draft by id alone, so cross-Workspace or cross-user access is
 * unreachable at the adapter boundary. Adapters: PrismaAutosaveDraftRepository
 * and an in-memory one for tests.
 */
export interface AutosaveDraftRepository {
  create(input: CreateAutosaveDraftInput): Promise<AutosaveDraft>;
  getById(workspaceId: string, draftId: string): Promise<AutosaveDraft | null>;
  /**
   * The draft a device holds for a document. There is at most one: a draft's
   * identity is (workspaceId, documentId, userId, deviceId). `userId` is part
   * of the lookup, not a post-read check, so one user cannot reach another's
   * draft by guessing a device id.
   */
  findByDevice(
    workspaceId: string,
    documentId: string,
    userId: string,
    deviceId: string,
  ): Promise<AutosaveDraft | null>;
  listByDocument(workspaceId: string, documentId: string, limit?: number): Promise<AutosaveDraft[]>;
  /** Drafts a single user holds for a document, newest first. */
  listByDocumentAndUser(
    workspaceId: string,
    documentId: string,
    userId: string,
    limit?: number,
  ): Promise<AutosaveDraft[]>;
  /**
   * Presence-aware update with optimistic concurrency: when `expectedVersion`
   * is supplied it is part of the WHERE predicate, so a concurrent writer is
   * rejected (returns null) instead of silently overwriting.
   */
  update(
    workspaceId: string,
    draftId: string,
    data: UpdateAutosaveDraftInput,
    expectedVersion?: number,
  ): Promise<AutosaveDraft | null>;
  delete(workspaceId: string, draftId: string): Promise<boolean>;
  /**
   * True when any draft in the Workspace still references `snapshotKey`.
   *
   * The service uses this before deleting an object: a snapshot must never be
   * removed while a draft points at it, no matter what the service's own book-
   * keeping believes.
   */
  isSnapshotReferenced(workspaceId: string, snapshotKey: string): Promise<boolean>;
}
