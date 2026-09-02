import crypto from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type {
  AutosaveDraftRepository,
  UpdateAutosaveDraftInput,
} from "@/src/application/ports/workspaces/AutosaveDraftRepository";
import type { AutosaveDraft, AutosaveDraftStatus } from "@/src/domain/entities/AutosaveDraft";
import {
  AUTOSAVE_DRAFT_LIMITS as L,
  AUTOSAVE_SNAPSHOT_CONTENT_TYPE,
  autosaveSnapshotKey,
} from "@/src/domain/entities/AutosaveDraft";
import { DomainError, NotFoundError } from "@/src/domain/errors";

export interface AutosaveServiceOptions {
  /** Largest accepted serialized payload, in bytes. */
  maxPayloadBytes?: number;
  /** Lease duration for a device's write slot, in milliseconds. */
  leaseMs?: number;
  /** Injectable clock so lease expiry is testable without waiting. */
  now?: () => Date;
}

/** What a client submits when saving a draft. */
export interface SaveDraftInput {
  documentId: string;
  deviceId: string;
  baseVersion: number;
  expectedRevision: number;
  payload: string;
}

/** A draft plus the snapshot bytes fetched from object storage. */
export interface AutosaveDraftWithPayload {
  draft: AutosaveDraft;
  payload: string;
}

function assertBoundedCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > L.maxCounter) {
    throw new DomainError(`${field} must be an integer between 0 and ${L.maxCounter}.`);
  }
  return value;
}

function assertDeviceId(value: unknown): string {
  if (typeof value !== "string") throw new DomainError("deviceId is required.");
  const trimmed = value.trim();
  if (!trimmed) throw new DomainError("deviceId is required.");
  if (trimmed.length > L.maxDeviceIdLength) {
    throw new DomainError(`deviceId exceeds ${L.maxDeviceIdLength} characters.`);
  }
  // Control characters would corrupt logs and any header the id reaches.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new DomainError("deviceId must not contain control characters.");
  }
  return trimmed;
}

function assertPayload(value: unknown, maxBytes: number): { payload: string; byteSize: number } {
  if (typeof value !== "string") throw new DomainError("Draft payload must be a string.");
  const byteSize = Buffer.byteLength(value, "utf8");
  if (byteSize === 0) throw new DomainError("Draft payload must not be empty.");
  // Bounded by real byte length, not string length — a multi-byte payload would
  // otherwise slip past a character-count check.
  if (byteSize > maxBytes) {
    throw new DomainError(`Draft payload exceeds ${maxBytes} bytes.`);
  }
  return { payload: value, byteSize };
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Device ids are client-chosen, so they are hashed before entering a storage key. */
function deviceIdHash(deviceId: string): string {
  return sha256(deviceId).slice(0, 32);
}

/**
 * M7.5 durable autosave.
 *
 * Persists per-device draft state for a document so an interrupted editing
 * session survives a crash or a device switch. Every operation re-authorizes the
 * Workspace and the document, and a draft is private to its author: reads and
 * writes are addressed by (workspaceId, documentId, userId, deviceId), never by
 * draft id alone.
 *
 * Storage split (docs/milestone-7-plan.md §4.3): the database row is metadata;
 * the serialized editor state is written to object storage. Each save stages a
 * new snapshot under a fresh generation key *before* the row is repointed, so a
 * failed or conflicted write never damages the snapshot the draft still refers
 * to. The superseded object is deleted only after the row no longer references
 * it, and only once the repository confirms nothing else does either.
 *
 * Scope note: this service is the *server* half of autosave. Browser-side
 * IndexedDB staging and Web Locks coordination are client concerns the server
 * cannot observe, so nothing here claims them.
 */
export class AutosaveService {
  private readonly maxPayloadBytes: number;
  private readonly leaseMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly drafts: AutosaveDraftRepository,
    private readonly documents: DocumentRecordRepository,
    private readonly storage: IObjectStorage,
    options: AutosaveServiceOptions = {},
  ) {
    const requestedMax = options.maxPayloadBytes ?? L.maxPayloadBytes;
    this.maxPayloadBytes = Math.min(Math.max(1, requestedMax), L.maxPayloadBytes);
    const requestedLease = options.leaseMs ?? L.defaultLeaseMs;
    this.leaseMs = Math.min(Math.max(1_000, requestedLease), L.maxLeaseMs);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Authorizes the actor for the Workspace and confirms the document is present
   * and editable. Returns the organization id so draft rows carry real tenancy
   * rather than a value derived from a string.
   */
  private async requireDocument(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    write: boolean,
  ): Promise<{ organizationId: string; revision: number }> {
    const { workspace } = await this.workspaces.get(actor, workspaceId, write);
    if (workspace.organizationId !== actor.organizationId) {
      throw new DomainError("Cross-organization access is not permitted.");
    }
    if (typeof documentId !== "string" || !documentId.trim()) {
      throw new DomainError("documentId is required.");
    }

    const document = await this.documents.getById(workspaceId, documentId);
    // A document in another Workspace is reported as missing, not forbidden —
    // the distinction would itself disclose that it exists.
    if (!document || document.workspaceId !== workspaceId) {
      throw new NotFoundError("Document not found in this workspace.");
    }
    if (document.lifecycleState !== "active") {
      throw new DomainError("Cannot autosave an archived or trashed document.");
    }
    return { organizationId: workspace.organizationId, revision: document.revision };
  }

  private leaseExpiry(): Date {
    return new Date(this.now().getTime() + this.leaseMs);
  }

  private snapshotKeyFor(
    draft: Pick<AutosaveDraft, "workspaceId" | "documentId" | "userId" | "deviceId">,
    generation: number,
  ): string {
    return autosaveSnapshotKey({
      workspaceId: draft.workspaceId,
      documentId: draft.documentId,
      userId: draft.userId,
      deviceIdHash: deviceIdHash(draft.deviceId),
      generation,
    });
  }

  /** Writes the snapshot bytes. Never runs inside a database transaction. */
  private async putSnapshot(key: string, payload: string, checksum: string): Promise<void> {
    await this.storage.put(key, Buffer.from(payload, "utf8"), {
      contentType: AUTOSAVE_SNAPSHOT_CONTENT_TYPE,
      sha256: checksum,
    });
  }

  /**
   * Deletes a superseded or orphaned snapshot, but only once no draft row still
   * references it. Failure to delete is logged, never thrown: an orphaned object
   * is a cleanup concern, not a reason to fail the author's save.
   */
  private async releaseSnapshot(workspaceId: string, key: string): Promise<void> {
    try {
      if (await this.drafts.isSnapshotReferenced(workspaceId, key)) return;
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn("Autosave snapshot cleanup failed", {
        workspaceId,
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Whether another of this user's devices currently holds the write lease for
   * the document. Ownership is per (document, user): two tabs editing the same
   * document contend for one slot, which is what the lease exists to arbitrate.
   */
  private async liveLeaseHolder(
    workspaceId: string,
    documentId: string,
    userId: string,
    deviceId: string,
  ): Promise<AutosaveDraft | null> {
    const drafts = await this.drafts.listByDocumentAndUser(
      workspaceId,
      documentId,
      userId,
      L.maxDraftsPerDocument,
    );
    const nowMs = this.now().getTime();
    for (const draft of drafts) {
      if (
        draft.leaseOwnerDeviceId !== null &&
        draft.leaseOwnerDeviceId !== deviceId &&
        draft.leaseExpiresAt !== null &&
        draft.leaseExpiresAt.getTime() > nowMs
      ) {
        return draft;
      }
    }
    return null;
  }

  /**
   * Saves a draft for this device, creating it on first write and updating it
   * afterwards. The checksum is computed server-side; a client-supplied checksum
   * is never trusted.
   *
   * When the document's revision has moved past what the client expected, or
   * another device holds a live lease, the draft is stored as `conflict` with its
   * snapshot intact so the author can resolve it. Work is never silently
   * discarded or overwritten.
   */
  async saveDraft(
    actor: ActorContext,
    workspaceId: string,
    input: SaveDraftInput,
  ): Promise<AutosaveDraft> {
    const { organizationId, revision } = await this.requireDocument(
      actor,
      workspaceId,
      input.documentId,
      true,
    );

    const deviceId = assertDeviceId(input.deviceId);
    const baseVersion = assertBoundedCounter(input.baseVersion, "baseVersion");
    const expectedRevision = assertBoundedCounter(input.expectedRevision, "expectedRevision");
    const { payload, byteSize } = assertPayload(input.payload, this.maxPayloadBytes);
    const checksum = sha256(payload);

    // The document moved on beneath this client.
    const conflicted = revision > expectedRevision;
    const holder = await this.liveLeaseHolder(workspaceId, input.documentId, actor.userId, deviceId);
    const status: AutosaveDraftStatus = conflicted || holder ? "conflict" : "dirty";
    const failureReason = conflicted
      ? `Document revision ${revision} is ahead of the expected revision ${expectedRevision}.`
      : holder
        ? `Draft lease is held by another device until ${holder.leaseExpiresAt?.toISOString()}.`
        : null;

    const existing = await this.drafts.findByDevice(
      workspaceId,
      input.documentId,
      actor.userId,
      deviceId,
    );

    if (!existing) {
      const generation = 1;
      const snapshotKey = this.snapshotKeyFor(
        { workspaceId, documentId: input.documentId, userId: actor.userId, deviceId },
        generation,
      );
      // Bytes first, then metadata: a row is never created pointing at an object
      // that does not exist.
      await this.putSnapshot(snapshotKey, payload, checksum);

      let created: AutosaveDraft;
      try {
        created = await this.drafts.create({
          workspaceId,
          organizationId,
          documentId: input.documentId,
          userId: actor.userId,
          deviceId,
          baseVersion,
          expectedRevision,
          snapshotKey,
          snapshotGeneration: generation,
          checksum,
          byteSize,
          status,
          // A conflicted write does not take the lease from the live holder.
          leaseOwnerDeviceId: holder ? null : deviceId,
          leaseExpiresAt: holder ? null : this.leaseExpiry(),
        });
      } catch (error) {
        // The metadata write failed, so nothing references these bytes.
        await this.releaseSnapshot(workspaceId, snapshotKey);
        throw error;
      }

      if (failureReason) {
        const marked = await this.drafts.update(
          workspaceId,
          created.id,
          { status: "conflict", failureReason },
          created.version,
        );
        return marked ?? created;
      }
      this.logger.debug("Autosave draft created", {
        workspaceId,
        documentId: input.documentId,
        draftId: created.id,
      });
      return created;
    }

    // Stage the replacement under a fresh generation so the snapshot the row
    // still points at survives a failed or rejected update.
    const generation = existing.snapshotGeneration + 1;
    const snapshotKey = this.snapshotKeyFor(existing, generation);
    await this.putSnapshot(snapshotKey, payload, checksum);

    const updates: UpdateAutosaveDraftInput = {
      snapshotKey,
      snapshotGeneration: generation,
      checksum,
      byteSize,
      status,
      failureReason,
      // A conflicted write leaves the existing lease exactly as it was.
      ...(holder
        ? {}
        : { leaseOwnerDeviceId: deviceId, leaseExpiresAt: this.leaseExpiry() }),
    };

    // Version-checked write: a concurrent save is rejected rather than lost.
    const updated = await this.drafts.update(workspaceId, existing.id, updates, existing.version);
    if (!updated) {
      // The row still points at the previous snapshot; drop the staged bytes.
      await this.releaseSnapshot(workspaceId, snapshotKey);
      throw new DomainError("The draft changed concurrently. Reload and retry.");
    }

    if (existing.snapshotKey !== snapshotKey) {
      await this.releaseSnapshot(workspaceId, existing.snapshotKey);
    }

    this.logger.debug("Autosave draft updated", {
      workspaceId,
      documentId: input.documentId,
      draftId: updated.id,
      status: updated.status,
    });
    return updated;
  }

  /** The calling user's draft for a device, or null when there is none. */
  async getDraft(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    deviceId: string,
  ): Promise<AutosaveDraft | null> {
    await this.requireDocument(actor, workspaceId, documentId, false);
    const draft = await this.drafts.findByDevice(
      workspaceId,
      documentId,
      actor.userId,
      assertDeviceId(deviceId),
    );
    return draft ? this.withDerivedStatus(draft) : null;
  }

  /**
   * The calling user's drafts for a document, newest first. Other users' drafts
   * are never returned — a draft is private to its author.
   */
  async listDrafts(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<AutosaveDraft[]> {
    await this.requireDocument(actor, workspaceId, documentId, false);
    const drafts = await this.drafts.listByDocumentAndUser(
      workspaceId,
      documentId,
      actor.userId,
      L.maxDraftsPerDocument,
    );
    return drafts.map((draft) => this.withDerivedStatus(draft));
  }

  /**
   * Reads a draft's snapshot bytes back from object storage, verifying they
   * still match the checksum recorded when they were written. A mismatch is
   * reported rather than returned: silently handing back altered editor state
   * would be worse than failing.
   */
  async readSnapshot(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    deviceId: string,
  ): Promise<AutosaveDraftWithPayload> {
    await this.requireDocument(actor, workspaceId, documentId, false);
    const draft = await this.drafts.findByDevice(
      workspaceId,
      documentId,
      actor.userId,
      assertDeviceId(deviceId),
    );
    if (!draft) throw new NotFoundError("No draft found.");
    return { draft: this.withDerivedStatus(draft), payload: await this.loadSnapshot(draft) };
  }

  private async loadSnapshot(draft: AutosaveDraft): Promise<string> {
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(draft.snapshotKey);
    } catch {
      throw new NotFoundError("Draft snapshot is no longer available.");
    }
    if (bytes.byteLength > this.maxPayloadBytes) {
      throw new DomainError("Stored draft snapshot exceeds the payload bound.");
    }
    if (sha256(bytes) !== draft.checksum) {
      throw new DomainError("Stored draft snapshot failed its checksum check.");
    }
    return bytes.toString("utf8");
  }

  /**
   * Recovers a draft after a crash or a conflict: the snapshot is returned
   * untouched and the lease is reassigned to the recovering device. Recovery
   * never rewrites the snapshot, so the author decides what to keep.
   */
  async recoverDraft(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    deviceId: string,
  ): Promise<AutosaveDraftWithPayload> {
    await this.requireDocument(actor, workspaceId, documentId, true);
    const device = assertDeviceId(deviceId);
    const draft = await this.drafts.findByDevice(workspaceId, documentId, actor.userId, device);
    if (!draft) throw new NotFoundError("No draft to recover.");

    // Read before repointing the lease: if the bytes are gone there is nothing
    // to recover, and the draft should not be presented as recovered.
    const payload = await this.loadSnapshot(draft);

    const recovered = await this.drafts.update(
      workspaceId,
      draft.id,
      {
        status: "dirty",
        failureReason: null,
        leaseOwnerDeviceId: device,
        leaseExpiresAt: this.leaseExpiry(),
      },
      draft.version,
    );
    if (!recovered) throw new DomainError("The draft changed concurrently. Reload and retry.");

    this.logger.debug("Autosave draft recovered", {
      workspaceId,
      documentId,
      draftId: recovered.id,
    });
    return { draft: recovered, payload };
  }

  /**
   * Marks a draft committed once its work has been persisted as a version, and
   * releases the lease. The snapshot is retained so a caller can still audit
   * what was committed.
   *
   * This never creates or advances a DocumentVersion — autosave is not a version
   * (docs/milestone-7-plan.md §7.2). The caller that created the version calls
   * this afterwards.
   */
  async markSaved(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    deviceId: string,
  ): Promise<AutosaveDraft> {
    await this.requireDocument(actor, workspaceId, documentId, true);
    const device = assertDeviceId(deviceId);
    const draft = await this.drafts.findByDevice(workspaceId, documentId, actor.userId, device);
    if (!draft) throw new NotFoundError("No draft to mark saved.");

    const saved = await this.drafts.update(
      workspaceId,
      draft.id,
      { status: "saved", failureReason: null, leaseOwnerDeviceId: null, leaseExpiresAt: null },
      draft.version,
    );
    if (!saved) throw new DomainError("The draft changed concurrently. Reload and retry.");
    return saved;
  }

  /**
   * Discards the calling user's draft for a device, removing the row and then
   * its snapshot. Returns false when there was nothing to discard.
   */
  async discardDraft(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    deviceId: string,
  ): Promise<boolean> {
    await this.requireDocument(actor, workspaceId, documentId, true);
    const draft = await this.drafts.findByDevice(
      workspaceId,
      documentId,
      actor.userId,
      assertDeviceId(deviceId),
    );
    if (!draft) return false;

    const deleted = await this.drafts.delete(workspaceId, draft.id);
    // Row first, object second: the reference is gone before the bytes are, so a
    // failure in between leaves an orphan rather than a dangling pointer.
    if (deleted) await this.releaseSnapshot(workspaceId, draft.snapshotKey);
    return deleted;
  }

  /**
   * Whether a draft's lease has lapsed. Derived from the stored expiry against
   * the injected clock — never from a stored "is stale" flag, which would drift.
   */
  isLeaseExpired(draft: AutosaveDraft): boolean {
    if (!draft.leaseExpiresAt) return true;
    return draft.leaseExpiresAt.getTime() <= this.now().getTime();
  }

  /**
   * Presents `stale` for a draft whose lease lapsed while it still held unsaved
   * work. The stored status is left alone: staleness is a function of time, so
   * deriving it on read keeps reads honest without a sweeper job. A `saved` or
   * `conflict` draft is never re-presented as stale.
   */
  private withDerivedStatus(draft: AutosaveDraft): AutosaveDraft {
    if (draft.status === "dirty" && this.isLeaseExpired(draft)) {
      return { ...draft, status: "stale" };
    }
    return draft;
  }
}
