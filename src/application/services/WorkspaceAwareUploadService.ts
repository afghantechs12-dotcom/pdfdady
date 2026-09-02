import crypto from "node:crypto";
import type { IUploadService, UploadInput, UploadInputStream, UploadResult } from "@/src/application/ports/storage/UploadService";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "@/src/application/services/WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { FolderRepository } from "@/src/application/ports/workspaces/FolderRepository";
import type { ProjectRepository } from "@/src/application/ports/workspaces/ProjectRepository";
import type { DocumentIngestionRepository } from "@/src/application/ports/workspaces/DocumentIngestionRepository";
import type {
  SaveIntentIdentity,
  SaveIntentMeaning,
  WorkspaceSaveIntentRepository,
} from "@/src/application/ports/workspaces/WorkspaceSaveIntentRepository";
import type { IQueue } from "@/src/application/ports/queue/Queue";
import type { IWorkspaceAwareUploadService } from "@/src/application/ports/workspace/WorkspaceAwareUploadService";
import type { WorkspaceUploadResult } from "@/src/domain/entities/DocumentIngestion";
import { DOCUMENT_INGESTION_LIMITS as L } from "@/src/domain/entities/DocumentIngestion";
import type { SaveIntentRequest, WorkspaceSaveIntent } from "@/src/domain/entities/WorkspaceSaveIntent";
import {
  SAVE_INTENT_LIMITS as SI,
  isSaveIntentSourceKind,
  normalizeSaveIntentKey,
} from "@/src/domain/entities/WorkspaceSaveIntent";
import {
  DomainError,
  NotFoundError,
  SaveIntentConflictError,
  SaveIntentInProgressError,
} from "@/src/domain/errors";
import { normalizeWorkspaceName } from "./workspaceNormalization";
import { generateOrderKeyBetween } from "./orderKey";
import { DocumentIngestionJobHandler } from "./DocumentIngestionJobHandler";

/**
 * Accepted upload types. The client-supplied MIME type is advisory only — it
 * must be on this list *and* the leading bytes must match the corresponding
 * signature, so a renamed executable cannot enter as a "PDF".
 */
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");
const SIGNATURE_FOR_MIME: ReadonlyMap<string, Buffer> = new Map([["application/pdf", PDF_SIGNATURE]]);

/**
 * Control characters (NUL, CR/LF, and friends) must never reach a filename we
 * persist or echo back in a header: NUL truncates in C-string consumers and
 * CR/LF splits headers.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const CONTENT_URL_PATTERN = /^\s*(?:data|blob):/i;

function assertSafeFilename(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("Filename is required.");
  }
  const trimmed = value.trim();
  if (trimmed.length > L.maxFilenameLength) {
    throw new DomainError(`Filename exceeds ${L.maxFilenameLength} characters.`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new DomainError("Filename must not contain control characters.");
  }
  if (CONTENT_URL_PATTERN.test(trimmed)) {
    throw new DomainError("Filename must not contain embedded content.");
  }
  // Path separators and traversal segments: the name is attacker-controlled and
  // ends up in storage metadata and Content-Disposition headers.
  if (/[/\\]/u.test(trimmed)) {
    throw new DomainError("Filename must not contain path separators.");
  }
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith("..")) {
    throw new DomainError("Filename must not be a traversal segment.");
  }
  return trimmed;
}

/**
 * M7.4 workspace-aware document upload and ingestion.
 *
 * Owns the "a file arrives for a Workspace" flow end to end:
 *
 *  1. authorizes the actor against the Workspace (write access required);
 *  2. validates the destination folder/project inside the same Workspace;
 *  3. validates the payload — filename, name bounds, MIME allow-list, and a
 *     magic-number signature check over the actual bytes;
 *  4. enforces the size limit;
 *  5. resolves the save's IDENTITY, one of two ways:
 *      - with a `saveIntent`, by claiming `(organizationId, userId, key)` — a
 *        retry of that intention converges on the document it already produced,
 *        and identical bytes saved under a *new* intention are a new document;
 *      - without one, by content hash within the Workspace — the legacy path a
 *        file-manager upload and the editor's first save still want.
 *     Workspace-scoped either way, so a duplicate can never disclose that
 *     another tenant holds the same file;
 *  6. persists bytes (content-addressed key), StoredFile, DocumentRecord and
 *     the ingestion record in `pending`;
 *  7. rolls back on partial failure so no orphaned row or object is left, and
 *     converges on the winner when a concurrent save of the same bytes into the
 *     same Workspace got there first.
 *
 * Content hash is NOT the save identity. Bytes are shared physically — one
 * content-addressed object, many documents — which is why storage collection asks
 * `meta.existsByKey` rather than assuming one document owns one object.
 */
export class WorkspaceAwareUploadService implements IUploadService, IWorkspaceAwareUploadService {
  constructor(
    private readonly storage: IObjectStorage,
    private readonly meta: IFileMetadataRepository,
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
    private readonly folders: FolderRepository,
    private readonly projects: ProjectRepository,
    private readonly ingestions: DocumentIngestionRepository,
    /**
     * Save-operation identity. Separate from the ingestion repository on purpose:
     * an ingestion is a fact about bytes, this is a fact about a user pressing
     * Save, and the previous closeout's defect was one row trying to be both.
     */
    private readonly intents: WorkspaceSaveIntentRepository,
    /**
     * Delivers the post-upload ingestion job. Optional so the service can be
     * constructed without a queue in tests and in any deployment that drains
     * ingestion some other way; when absent the row simply stays `pending` and
     * remains claimable by the repair path.
     */
    private readonly queue?: IQueue,
  ) {}

  // ---- low-level upload (storage-port composition) -------------------------

  async upload(input: UploadInput): Promise<UploadResult> {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");

    // Per-owner dedup: same owner re-uploading the same file.
    const existing = await this.meta.findBySha256(input.ownerType, input.ownerId, sha256);
    if (existing) {
      this.logger.debug("Upload deduplicated (owner already has file)", {
        fileId: existing.id,
        sha256,
      });
      return { file: existing, deduplicated: true };
    }

    // Content-addressed key → byte-level dedup across owners.
    const key = contentAddressedKey(sha256);
    const head = await this.storage.head(key);
    if (!head.exists) {
      await this.storage.put(key, data, { contentType: input.mimeType, sha256 });
    } else {
      this.logger.debug("Upload byte-deduplicated (object already stored)", { key, sha256 });
    }

    const file = await this.meta.create({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      key,
      sha256,
      size: data.length,
      mimeType: input.mimeType,
      originalName: input.originalName,
      expiresAt: input.expiresAt ?? null,
    });
    return { file, deduplicated: false };
  }

  async uploadStream(input: UploadInputStream): Promise<UploadResult> {
    // Stream straight to storage; putStream computes sha256 + size on the fly
    // so the object is never buffered whole. No dedup on this path.
    const { sha256, size } = await this.storage.putStream(input.key, input.data, {
      contentType: input.mimeType,
    });
    const file = await this.meta.create({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      key: input.key,
      sha256,
      size,
      mimeType: input.mimeType,
      originalName: input.originalName,
      expiresAt: input.expiresAt ?? null,
    });
    return { file, deduplicated: false };
  }

  // ---- M7.4: workspace upload ----------------------------------------------

  /**
   * Resolves the destination, enforcing that a supplied folder/project lives in
   * this Workspace and is usable. Throws rather than returning a soft failure
   * so a bad destination can never silently fall back to the Workspace root.
   */
  private async requireDestination(
    workspaceId: string,
    folderId: string | null,
    projectId: string | null,
  ): Promise<void> {
    if (folderId) {
      const folder = await this.folders.getById(workspaceId, folderId);
      if (!folder || folder.workspaceId !== workspaceId) {
        throw new NotFoundError("Folder not found in this workspace.");
      }
      if (folder.lifecycleState !== "active") {
        throw new DomainError("Cannot upload into an archived or trashed folder.");
      }
    }
    if (projectId) {
      const project = await this.projects.getById(workspaceId, projectId);
      if (!project || project.workspaceId !== workspaceId) {
        throw new NotFoundError("Project not found in this workspace.");
      }
    }
  }

  /** Non-throwing destination probe for callers that want to pre-validate a form. */
  async validateDestination(
    actor: ActorContext,
    workspaceId: string,
    folderId?: string | null,
    projectId?: string | null,
  ): Promise<boolean> {
    await this.workspaces.get(actor, workspaceId, true);
    try {
      await this.requireDestination(workspaceId, folderId ?? null, projectId ?? null);
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }

  /**
   * Uploads a document into a Workspace and records its ingestion.
   *
   * Every identifier in the result comes from real persistence. On failure
   * after the bytes were written, the rows created so far are removed so a
   * partial upload cannot linger as a broken document.
   */
  async uploadToWorkspace(
    actor: ActorContext,
    workspaceId: string,
    input: UploadInput & {
      folderId?: string | null;
      projectId?: string | null;
      name?: string;
      saveIntent?: SaveIntentRequest | null;
    },
  ): Promise<WorkspaceUploadResult> {
    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    if (workspace.organizationId !== actor.organizationId) {
      throw new DomainError("Cross-organization uploads are not permitted.");
    }

    const folderId = input.folderId ?? null;
    const projectId = input.projectId ?? null;
    await this.requireDestination(workspaceId, folderId, projectId);

    const originalName = assertSafeFilename(input.originalName);
    const rawName = (input.name ?? originalName).trim();
    if (!rawName) throw new DomainError("Document name is required.");
    if (rawName.length > L.maxNameLength) {
      throw new DomainError(`Document name exceeds ${L.maxNameLength} characters.`);
    }
    if (CONTROL_CHARACTERS.test(rawName) || CONTENT_URL_PATTERN.test(rawName)) {
      throw new DomainError("Document name contains unsupported characters.");
    }
    const normalizedName = normalizeWorkspaceName(rawName);
    if (!normalizedName) throw new DomainError("Document name is required.");

    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    if (data.byteLength === 0) throw new DomainError("An empty file cannot be uploaded.");
    if (data.byteLength > L.maxUploadBytes) {
      throw new DomainError(`Uploads are limited to ${L.maxUploadBytes} bytes.`);
    }

    const mimeType = String(input.mimeType ?? "").toLowerCase().trim();
    const signature = SIGNATURE_FOR_MIME.get(mimeType);
    if (!signature) throw new DomainError(`Unsupported file type "${mimeType}".`);
    if (!data.subarray(0, signature.length).equals(signature)) {
      throw new DomainError("File contents do not match the declared type.");
    }

    const checksum = crypto.createHash("sha256").update(data).digest("hex");

    /*
     * IDENTITY, and only now — after the actor, the Workspace, the destination,
     * the filename, the size, the declared type, the actual leading bytes and the
     * checksum have all been established.
     *
     * §9's rule in code form: an intention is looked up inside the authorized
     * scope of a caller who has already earned the right to write here. A key
     * presented before that could return a document to somebody who may not read
     * it, and a failed validation must not be able to leave an intention behind.
     */
    const intent = input.saveIntent ?? null;
    let claim: WorkspaceSaveIntent | null = null;
    if (intent === null) {
      // No intention: dedup by content, Workspace-scoped. A match in another
      // Workspace is deliberately not consulted — reporting it would disclose
      // another tenant's holdings.
      const already = await this.existingSaveResult(workspaceId, checksum);
      if (already) {
        this.logger.debug("Workspace upload deduplicated by content", {
          workspaceId,
          documentId: already.document.id,
        });
        return already;
      }
    } else {
      // An intention: the content pre-check is SKIPPED. Consulting it here is the
      // whole defect — it makes two deliberate saves of one file collapse into the
      // first document, under the first name.
      const claimed = await this.claimSaveIntent(actor, workspaceId, checksum, intent);
      if (claimed.settled) {
        this.logger.debug("Save intention already completed; returning its document", {
          workspaceId,
          documentId: claimed.settled.document.id,
        });
        return claimed.settled;
      }
      claim = claimed.claim;
    }

    const key = contentAddressedKey(checksum);
    const head = await this.storage.head(key);
    const objectPreexisting = head.exists;
    if (!objectPreexisting) {
      await this.storage.put(key, data, { contentType: mimeType, sha256: checksum });
    }

    let storedFileId: string | null = null;
    let documentId: string | null = null;
    let ingestionId: string | null = null;

    try {
      const file = await this.meta.create({
        ownerType: "org",
        ownerId: actor.organizationId,
        key,
        sha256: checksum,
        size: data.byteLength,
        mimeType,
        originalName,
      });
      storedFileId = file.id;

      const maxKey = await this.documents.maxOrderKey(workspaceId, folderId);
      const document = await this.documents.create({
        workspaceId,
        organizationId: actor.organizationId,
        folderId,
        projectId,
        name: rawName,
        normalizedName,
        orderKey: generateOrderKeyBetween(maxKey, null),
        createdById: actor.userId,
      });
      documentId = document.id;

      const ingestion = await this.ingestions.create({
        workspaceId,
        organizationId: actor.organizationId,
        documentId: document.id,
        storedFileId: file.id,
        status: "pending",
        checksum,
        byteSize: data.byteLength,
        mimeType,
        originalName,
        uploadedById: actor.userId,
      });
      ingestionId = ingestion.id;

      this.logger.info("Workspace upload ingested", {
        workspaceId,
        documentId: document.id,
        storedFileId: file.id,
        ingestionId: ingestion.id,
      });

      /*
       * The intention is completed HERE — after the document and the ingestion
       * are durable, and before anything that is allowed to fail.
       *
       * Both halves of that matter. Marking it completed any earlier hands a
       * retry the id of a row that may never commit; marking it after the queue
       * would let a queue outage leave a finished save looking `pending`, so the
       * retry that follows would be told to wait and then take the claim over and
       * save the file a second time.
       */
      if (claim) await this.intents.complete(claim.id, document.id, ingestion.id);

      // Hand the ingestion to the worker, which cuts the initial version that
      // makes the document openable.
      //
      // Deliberately *inside* the try but tolerant of its own failure: a queue
      // that is down must not roll back a perfectly good upload, because the
      // bytes, the document and the pending row are all durable and the repair
      // path can promote them later. What would be unacceptable is the reverse —
      // reporting success for an upload whose rows were unwound.
      if (this.queue) {
        try {
          await DocumentIngestionJobHandler.enqueue(this.queue, {
            organizationId: actor.organizationId,
            workspaceId,
            documentId: document.id,
            ingestionId: ingestion.id,
          });
        } catch (error) {
          this.logger.error("Upload stored but ingestion job could not be queued", {
            workspaceId,
            documentId: document.id,
            ingestionId: ingestion.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        document: {
          id: document.id,
          name: document.name,
          workspaceId: document.workspaceId,
          folderId: document.folderId,
          projectId: document.projectId,
        },
        file: {
          id: file.id,
          key: file.key,
          size: file.size,
          mimeType: file.mimeType,
          originalName: file.originalName,
        },
        ingestion: {
          id: ingestion.id,
          status: ingestion.status,
          checksum: ingestion.checksum,
          pageCount: ingestion.pageCount,
        },
        deduplicated: false,
      };
    } catch (error) {
      /*
       * A CONCURRENT SAVE OF THE SAME RESULT IS NOT A FAILURE.
       *
       * `(workspaceId, checksum)` is unique on the ingestion row, so when two
       * requests carry the same result into the same Workspace exactly one of them
       * creates it and the other arrives here. If a live document now holds this
       * checksum, the intention this request carried is already satisfied by the
       * winner — and answering with an error for a save that demonstrably happened
       * is what makes a client retry and produce a second document.
       *
       * Asked of the repository rather than read off the error, so it holds for
       * every adapter: no Prisma error code, no message matching, and it is equally
       * true for a name collision or any other loss of the same race.
       */
      const winner = intent
        ? null
        : await this.existingSaveResult(workspaceId, checksum).catch(() => null);
      const converged = winner && winner.ingestion.id !== ingestionId ? winner : null;
      /*
       * An intention does NOT converge on content, which is why `winner` is not
       * even looked up above. The checksum in this Workspace may belong to a
       * document this save has nothing to do with — a colleague's copy, or the
       * user's own earlier save under a different name — and answering with it
       * would report success for a document this intention did not produce and
       * record that id against this key. The intention's own row is the
       * convergence mechanism; releasing the claim is what lets the retry work.
       */
      if (claim) await this.intents.fail(claim.id).catch(() => undefined);
      // Unwind in reverse order of creation. Each step is best-effort: a
      // cleanup failure must not mask the original error.
      this.logger[converged ? "info" : "error"](
        converged
          ? "Workspace upload lost a concurrent race; converging on the stored document"
          : "Workspace upload failed; rolling back",
        { workspaceId, documentId, storedFileId, ingestionId },
      );
      if (ingestionId) {
        await this.ingestions.delete(workspaceId, ingestionId).catch(() => undefined);
      }
      if (documentId) {
        await this.documents
          .setLifecycle(workspaceId, documentId, "trashed", actor.userId)
          .catch(() => undefined);
      }
      if (storedFileId) {
        await this.meta.delete(storedFileId).catch(() => undefined);
      }
      // Only remove the object if this upload is what put it there AND nothing
      // else references it now. The key is content-addressed, so any other row
      // pointing at these exact bytes points at this object: deleting it would
      // leave that document with a document row, a version and no file. The lookup
      // runs after this request's own StoredFile row is gone, so it only ever sees
      // somebody else's.
      //
      // Asked by KEY rather than by (org, sha256): the object is shared by
      // everything that references it, including scopes this request cannot see,
      // and an owner-scoped question about shared bytes is the wrong question.
      if (!objectPreexisting) {
        const stillReferenced = await this.meta.existsByKey(key).catch(() => true);
        if (!stillReferenced) await this.storage.delete(key).catch(() => undefined);
      }
      if (converged) return converged;
      throw error;
    }
  }

  /**
   * Establishes this request's claim on the user's save intention.
   *
   * Returns either the claim to work under, or the result of the intention that
   * already completed. Never both, and never a document that some *other*
   * intention produced.
   *
   * The loop exists because three things can be found under one key and only one
   * of them is an answer: a completed intention (return its document), a live
   * attempt in flight (wait for it), or an abandoned attempt (take it over). Each
   * of those can change underneath the read, so every write is conditional and a
   * lost condition sends the request round again rather than forward on stale
   * facts.
   */
  private async claimSaveIntent(
    actor: ActorContext,
    workspaceId: string,
    checksum: string,
    request: SaveIntentRequest,
  ): Promise<{ claim: WorkspaceSaveIntent | null; settled: WorkspaceUploadResult | null }> {
    const key = normalizeSaveIntentKey(request.key);
    if (key === null) throw new DomainError("Save reference is not valid.");
    if (!isSaveIntentSourceKind(request.sourceKind)) {
      throw new DomainError("Save reference is not valid.");
    }
    const sourceIdentity = String(request.sourceIdentity ?? "").trim();
    if (!sourceIdentity || sourceIdentity.length > SI.maxSourceIdentityLength) {
      throw new DomainError("Save reference is not valid.");
    }

    // Scoped to the ACTOR, not to the key alone. This is what makes a key useless
    // as an oracle: a colleague who presents the same literal addresses their own
    // row, gets their own document, and learns nothing about anybody else's.
    const identity: SaveIntentIdentity = {
      organizationId: actor.organizationId,
      userId: actor.userId,
      key,
    };
    const meaning: SaveIntentMeaning = {
      workspaceId,
      sourceKind: request.sourceKind,
      sourceIdentity,
      payloadChecksum: checksum,
    };

    const deadline = Date.now() + SI.convergenceTimeoutMs;
    for (;;) {
      // The unique index is the mutual exclusion. Two concurrent requests both
      // attempt this; exactly one row exists afterwards, so exactly one of them
      // does the work and the other falls through to wait for it. No process-local
      // lock is involved, so it holds across workers and across a restart.
      const claimed = await this.intents.insertPending(identity, meaning);
      if (claimed) return { claim: claimed, settled: null };

      const row = await this.intents.find(identity);
      // Gone between the refused insert and this read — vanishingly unlikely, but
      // the honest response is to try to claim it again, not to guess.
      if (row === null) continue;

      if (!sameMeaning(row, meaning)) {
        // The key is real and it is this actor's, but it stands for a different
        // save: other bytes, another Workspace, another source result. There is no
        // safe way to pick one of the two, so neither is performed.
        throw new SaveIntentConflictError();
      }

      if (row.status === "completed") {
        const settled = await this.completedIntentResult(row);
        // A completed row whose document cannot be resolved is a broken record,
        // not an answer: fall through and let the take-over below redo the work.
        if (settled) return { claim: null, settled };
      } else if (row.status === "pending" && Date.now() - row.updatedAt.getTime() < SI.staleClaimMs) {
        // Somebody is saving this right now. Wait for their document rather than
        // making a second one; the winner completes in well under a second.
        if (Date.now() >= deadline) throw new SaveIntentInProgressError();
        await delay(SI.convergencePollMs);
        continue;
      }

      // `failed`, or `pending` and abandoned by a process that is not coming back.
      // Conditional on `updatedAt`, so of several retries arriving together only
      // one takes it over and the rest look again.
      const taken = await this.intents.reclaim(row.id, row.updatedAt, meaning);
      if (taken) return { claim: { ...row, ...meaning, status: "pending" }, settled: null };
      if (Date.now() >= deadline) throw new SaveIntentInProgressError();
      await delay(SI.convergencePollMs);
    }
  }

  /**
   * The document a completed intention produced, as an upload result.
   *
   * Read through the intention's own recorded ids — not through the checksum, and
   * not through the name. `deduplicated: true` is deliberate: it is what tells the
   * route this is the same logical save, so a retried Save cannot emit a second
   * activity event for one press of the button.
   *
   * A trashed document is still returned here, and that is not the trash defect.
   * This intention genuinely produced that document; what §8 forbids is a *new*
   * intention being answered with an old trashed document, and a new intention has
   * a different key, so it never reaches this method.
   */
  private async completedIntentResult(
    row: WorkspaceSaveIntent,
  ): Promise<WorkspaceUploadResult | null> {
    if (!row.documentId || !row.ingestionId) return null;
    const document = await this.documents.getById(row.workspaceId, row.documentId);
    if (!document) return null;
    const ingestion = await this.ingestions.getById(row.workspaceId, row.ingestionId);
    if (!ingestion) return null;
    const file = await this.meta.get(ingestion.storedFileId);
    return {
      document: {
        id: document.id,
        name: document.name,
        workspaceId: document.workspaceId,
        folderId: document.folderId,
        projectId: document.projectId,
      },
      file: {
        id: ingestion.storedFileId,
        key: file?.key ?? contentAddressedKey(ingestion.checksum),
        size: ingestion.byteSize,
        mimeType: ingestion.mimeType,
        originalName: ingestion.originalName,
      },
      ingestion: {
        id: ingestion.id,
        status: ingestion.status,
        checksum: ingestion.checksum,
        pageCount: ingestion.pageCount,
      },
      deduplicated: true,
    };
  }

  /**
   * The result a save that has ALREADY happened must answer with.
   *
   * One code path for two callers: the pre-check that spares a duplicate upload,
   * and the race loser above. Both have to name the same canonical document, which
   * is what makes a retried save idempotent rather than merely quiet.
   *
   * Null for a checksum whose document was trashed — a deleted document is not a
   * destination, so that save starts again.
   */
  private async existingSaveResult(
    workspaceId: string,
    checksum: string,
  ): Promise<WorkspaceUploadResult | null> {
    const duplicate = await this.ingestions.findByChecksum(workspaceId, checksum);
    if (!duplicate) return null;
    const existing = await this.documents.getById(workspaceId, duplicate.documentId);
    if (!existing || existing.lifecycleState === "trashed") return null;
    const file = await this.meta.get(duplicate.storedFileId);
    return {
      document: {
        id: existing.id,
        name: existing.name,
        workspaceId: existing.workspaceId,
        folderId: existing.folderId,
        projectId: existing.projectId,
      },
      file: {
        id: duplicate.storedFileId,
        key: file?.key ?? contentAddressedKey(checksum),
        size: duplicate.byteSize,
        mimeType: duplicate.mimeType,
        originalName: duplicate.originalName,
      },
      ingestion: {
        id: duplicate.id,
        status: duplicate.status,
        checksum: duplicate.checksum,
        pageCount: duplicate.pageCount,
      },
      deduplicated: true,
    };
  }
}

/**
 * Whether a recorded intention stands for the same save as this request.
 *
 * All four fields, because each of them changes what the save WOULD DO: other
 * bytes are another file, another Workspace is another destination, and another
 * source result is another run. Anything less makes one key able to produce a
 * document the user did not ask for.
 */
function sameMeaning(row: WorkspaceSaveIntent, meaning: SaveIntentMeaning): boolean {
  return (
    row.workspaceId === meaning.workspaceId &&
    row.sourceKind === meaning.sourceKind &&
    row.sourceIdentity === meaning.sourceIdentity &&
    row.payloadChecksum === meaning.payloadChecksum
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentAddressedKey(sha256: string): string {
  return `ca/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}
