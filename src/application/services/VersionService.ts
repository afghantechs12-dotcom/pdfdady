import crypto from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type {
  CreateDocumentVersionInput,
  DocumentVersionRepository,
} from "@/src/application/ports/workspaces/DocumentVersionRepository";
import type {
  DocumentVersion,
  DocumentVersionManifest,
  DocumentVersionOrigin,
} from "@/src/domain/entities/DocumentVersion";
import {
  DOCUMENT_VERSION_LIMITS as L,
  canonicalManifestJson,
  documentVersionListLimit,
  manifestArtifactKeys,
  normalizeManifest,
  serializeManifest,
} from "@/src/domain/entities/DocumentVersion";
import { DomainError, NotFoundError } from "@/src/domain/errors";

export interface VersionServiceOptions {
  /**
   * How many versions a document keeps before the oldest are pruned. 0 disables
   * pruning entirely, which is the safe default: silently deleting history is
   * worse than keeping too much of it.
   */
  maxVersionsPerDocument?: number;
}

/**
 * A version, plus the document revision the commit produced.
 *
 * An intersection rather than a wrapper so every existing caller keeps reading
 * `version.versionNumber`. The extra field exists because `versionNumber` and
 * `DocumentRecord.revision` are different domains that only *look* alike: a
 * rename bumps the revision without creating a version, after which a client
 * that used the version number as its compare-and-swap token conflicts with
 * itself — the write it is fencing against is its own.
 */
export type CommittedVersion = DocumentVersion & { documentRevision: number };

/** What a caller submits to create a version. */
export interface CreateVersionInput {
  documentId: string;
  /** The document revision the client believed current. Checked, not trusted. */
  expectedRevision: number;
  origin?: DocumentVersionOrigin;
  label?: string | null;
  /** Artifact manifest; validated against the domain bounds before it is stored. */
  manifest: unknown;
}

function assertBoundedCounter(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > L.maxCounter) {
    throw new DomainError(`${field} must be an integer between 0 and ${L.maxCounter}.`);
  }
  return value;
}

function assertDocumentId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("documentId is required.");
  }
  return value.trim();
}

function assertLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new DomainError("label must be a string.");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > L.maxLabelLength) {
    throw new DomainError(`label exceeds ${L.maxLabelLength} characters.`);
  }
  // Control characters would corrupt logs and any header or filename the label reaches.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new DomainError("label must not contain control characters.");
  }
  return trimmed;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * M7.6 durable document versions.
 *
 * A version is an immutable checkpoint. This service can create one, read one,
 * list history, and restore — but it can never modify one, because the
 * repository port has no update method. Restoring version N does not rewind the
 * document: it creates version N+k whose manifest is a copy of N's and whose
 * `restoredFromVersionId` records where it came from, so history is preserved
 * rather than rewritten (docs/milestone-7-plan.md §6.3).
 *
 * Every operation re-authorizes the Workspace and re-resolves the document by
 * (workspaceId, documentId); no identity is derived from the shape of an id.
 * Version creation is compare-and-swap against the document's revision: if the
 * document moved on beneath the client, the write is rejected with a conflict
 * rather than applied on top of a state the client never saw.
 *
 * Ordering note: the version row is inserted *before* the document's pointer is
 * moved. A version that exists but is not yet current is invisible history; a
 * pointer to a version that does not exist would be a dangling reference.
 */
export class VersionService {
  private readonly maxVersionsPerDocument: number;

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly versions: DocumentVersionRepository,
    private readonly documents: DocumentRecordRepository,
    private readonly storage: IObjectStorage,
    options: VersionServiceOptions = {},
  ) {
    const requested = options.maxVersionsPerDocument ?? 0;
    this.maxVersionsPerDocument = Number.isInteger(requested) && requested > 0 ? requested : 0;
  }

  /**
   * Authorizes the actor for the Workspace and confirms the document is present
   * and usable. Returns the organization id and revision so version rows carry
   * real tenancy rather than a value inferred from an identifier.
   */
  private async requireDocument(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    write: boolean,
  ): Promise<{ organizationId: string; revision: number; currentVersionId: string | null }> {
    const { workspace } = await this.workspaces.get(actor, workspaceId, write);
    if (workspace.organizationId !== actor.organizationId) {
      throw new DomainError("Cross-organization access is not permitted.");
    }
    const id = assertDocumentId(documentId);

    const document = await this.documents.getById(workspaceId, id);
    // A document in another Workspace is reported as missing, not forbidden —
    // the distinction would itself disclose that it exists.
    if (!document || document.workspaceId !== workspaceId) {
      throw new NotFoundError("Document not found in this workspace.");
    }
    if (write && document.lifecycleState !== "active") {
      throw new DomainError("Cannot version an archived or trashed document.");
    }
    return {
      organizationId: workspace.organizationId,
      revision: document.revision,
      currentVersionId: document.currentVersionId,
    };
  }

  /** Validates and serializes a manifest, rejecting anything outside the domain bounds. */
  private prepareManifest(input: unknown): { manifest: DocumentVersionManifest; json: string; checksum: string } {
    const manifest = normalizeManifest(input);
    if (!manifest) {
      throw new DomainError("Version manifest is missing required artifacts or exceeds its bounds.");
    }
    const json = serializeManifest(manifest);
    if (json === null) {
      throw new DomainError(`Version manifest exceeds ${L.maxManifestBytes} bytes.`);
    }
    // Checksummed over the canonical form, so two equal manifests always agree.
    return { manifest, json, checksum: sha256(canonicalManifestJson(manifest)) };
  }

  /**
   * Inserts the version row, then advances the document's pointer and revision.
   *
   * If the pointer update fails the version row is left in place: it is real
   * history that was genuinely written, and deleting it to tidy up would destroy
   * the artifacts the caller just committed. The caller is told the commit did
   * not complete.
   */
  private async commit(
    workspaceId: string,
    input: CreateDocumentVersionInput,
    revision: number,
  ): Promise<CommittedVersion> {
    const version = await this.versions.create(input);

    let advanced: DocumentRecord;
    try {
      // `revision` here is the EXPECTED CURRENT revision, not the value to store:
      // the repository puts it in the WHERE clause and increments the column
      // itself (see `DocumentRecordRepository.update`). Passing `revision + 1`
      // asked the database for a row whose revision was already one ahead, which
      // never matched — every save after the first failed with "the version was
      // written but the document could not be advanced", leaving an orphan
      // version row behind. Passing the expected value also makes this write
      // conditional: if anything moved the document between the compare-and-swap
      // above and here, the save fails honestly instead of overwriting it.
      advanced = await this.documents.update(workspaceId, input.documentId, {
        currentVersionId: version.id,
        revision,
      });
    } catch (error) {
      this.logger.error("Version created but document pointer update failed", {
        workspaceId,
        documentId: input.documentId,
        versionId: version.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DomainError(
        "The version was written but the document could not be advanced. Reload and retry.",
      );
    }

    await this.pruneOldVersions(workspaceId, input.documentId, version.id);
    // The revision this write PRODUCED, read back from the store rather than
    // computed as `revision + 1`. A client uses it as its next compare-and-swap
    // token, so an inferred value would be a guess about someone else's column.
    return { ...version, documentRevision: advanced.revision };
  }

  /**
   * Drops the oldest versions past the retention bound.
   *
   * Artifacts are deleted only when no surviving version references them, so
   * pruning one version can never strip bytes another still points at. Failure
   * is logged, never thrown: retention is housekeeping, not a reason to fail the
   * author's save.
   */
  private async pruneOldVersions(
    workspaceId: string,
    documentId: string,
    keepVersionId: string,
  ): Promise<void> {
    if (this.maxVersionsPerDocument <= 0) return;
    try {
      const total = await this.versions.countForDocument(workspaceId, documentId);
      if (total <= this.maxVersionsPerDocument) return;

      // Oldest first: the listing is newest-first, so take the tail.
      const all = await this.versions.list({
        workspaceId,
        documentId,
        limit: L.maxListLimit,
      });
      const excess = all.slice(this.maxVersionsPerDocument);

      for (const version of excess) {
        if (version.id === keepVersionId) continue;
        const keys = manifestArtifactKeys(version.manifest);
        const deleted = await this.versions.delete(workspaceId, version.id);
        if (!deleted) continue;
        for (const key of keys) {
          if (await this.versions.isArtifactReferenced(workspaceId, key)) continue;
          await this.storage.delete(key);
        }
      }
    } catch (error) {
      this.logger.warn("Version retention sweep failed", {
        workspaceId,
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Creates a durable version, compare-and-swapping against the document's
   * revision. A stale `expectedRevision` is a conflict, never a silent
   * overwrite: both states are preserved and the client is told to reconcile.
   */
  async createVersion(
    actor: ActorContext,
    workspaceId: string,
    input: CreateVersionInput,
  ): Promise<CommittedVersion> {
    const documentId = assertDocumentId(input.documentId);
    const { organizationId, revision } = await this.requireDocument(
      actor,
      workspaceId,
      documentId,
      true,
    );

    const expectedRevision = assertBoundedCounter(input.expectedRevision, "expectedRevision");
    if (revision !== expectedRevision) {
      throw new DomainError(
        `Document revision ${revision} does not match the expected revision ${expectedRevision}. Reload and retry.`,
      );
    }

    const origin = input.origin ?? "save";
    if (origin === "restore") {
      // Restore provenance is set by restoreVersion, which knows the source. A
      // caller may not claim it, or history would record a lineage that never happened.
      throw new DomainError("Restore versions are created by restoring, not by direct save.");
    }
    const label = assertLabel(input.label);
    const { json, checksum } = this.prepareManifest(input.manifest);

    const version = await this.commit(
      workspaceId,
      {
        workspaceId,
        organizationId,
        documentId,
        revision,
        origin,
        restoredFromVersionId: null,
        label,
        manifest: json,
        checksum,
        createdById: actor.userId,
      },
      revision,
    );

    this.logger.debug("Document version created", {
      workspaceId,
      documentId,
      versionId: version.id,
      versionNumber: version.versionNumber,
    });
    return version;
  }

  /** A single version by its number, or null when the document has no such version. */
  async getVersion(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<DocumentVersion | null> {
    await this.requireDocument(actor, workspaceId, documentId, false);
    const number = assertBoundedCounter(versionNumber, "versionNumber");
    return this.versions.getByNumber(workspaceId, documentId, number);
  }

  /** Version history, newest first, bounded by the domain cap. */
  async listVersions(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    limit: number = L.defaultListLimit,
    beforeVersionNumber?: number,
  ): Promise<DocumentVersion[]> {
    await this.requireDocument(actor, workspaceId, documentId, false);
    const before =
      beforeVersionNumber === undefined
        ? undefined
        : assertBoundedCounter(beforeVersionNumber, "beforeVersionNumber");
    return this.versions.list({
      workspaceId,
      documentId,
      limit: documentVersionListLimit(limit),
      beforeVersionNumber: before,
    });
  }

  /** The newest version, or null when the document has never been saved. */
  async getLatestVersion(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentVersion | null> {
    await this.requireDocument(actor, workspaceId, documentId, false);
    return this.versions.latest(workspaceId, documentId);
  }

  /**
   * Restores an earlier version by creating a *new* one carrying the same
   * artifacts and a `restoredFromVersionId` pointing back at the source. The
   * restored version's own row is untouched, so history is never rewritten and a
   * restore is itself undoable by restoring what preceded it.
   */
  async restoreVersion(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    versionNumber: number,
    expectedRevision: number,
  ): Promise<CommittedVersion> {
    const id = assertDocumentId(documentId);
    const { organizationId, revision } = await this.requireDocument(actor, workspaceId, id, true);

    const number = assertBoundedCounter(versionNumber, "versionNumber");
    const expected = assertBoundedCounter(expectedRevision, "expectedRevision");
    if (revision !== expected) {
      throw new DomainError(
        `Document revision ${revision} does not match the expected revision ${expected}. Reload and retry.`,
      );
    }

    const source = await this.versions.getByNumber(workspaceId, id, number);
    if (!source) throw new NotFoundError("Version not found for this document.");
    if (source.manifestDegraded) {
      // Restoring an unreadable manifest would fabricate a version pointing at
      // artifacts nobody can prove exist.
      throw new DomainError("This version's manifest is unreadable and cannot be restored.");
    }

    const { json, checksum } = this.prepareManifest(source.manifest);
    const restored = await this.commit(
      workspaceId,
      {
        workspaceId,
        organizationId,
        documentId: id,
        revision,
        origin: "restore",
        restoredFromVersionId: source.id,
        label: source.label,
        manifest: json,
        checksum,
        createdById: actor.userId,
      },
      revision,
    );

    this.logger.debug("Document version restored", {
      workspaceId,
      documentId: id,
      restoredFrom: source.versionNumber,
      versionNumber: restored.versionNumber,
    });
    return restored;
  }

  /**
   * Whether a version's manifest still matches its recorded checksum.
   *
   * Recomputed from the stored manifest rather than compared to a
   * caller-supplied value, so this answers "is this version intact?" instead of
   * "did the caller guess the checksum?".
   */
  async verifyVersion(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    versionNumber: number,
  ): Promise<{ version: DocumentVersion; intact: boolean }> {
    const version = await this.getVersion(actor, workspaceId, documentId, versionNumber);
    if (!version) throw new NotFoundError("Version not found for this document.");
    const intact =
      !version.manifestDegraded && sha256(canonicalManifestJson(version.manifest)) === version.checksum;
    return { version, intact };
  }
}
