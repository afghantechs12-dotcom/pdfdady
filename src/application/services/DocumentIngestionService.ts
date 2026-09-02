import crypto from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type { DocumentIngestionRepository } from "@/src/application/ports/workspaces/DocumentIngestionRepository";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentVersionRepository } from "@/src/application/ports/workspaces/DocumentVersionRepository";
import type { DocumentIngestion } from "@/src/domain/entities/DocumentIngestion";
import { DOCUMENT_INGESTION_LIMITS } from "@/src/domain/entities/DocumentIngestion";
import type {
  DocumentVersion,
  DocumentVersionManifest,
} from "@/src/domain/entities/DocumentVersion";
import {
  DOCUMENT_VERSION_MANIFEST_SCHEMA,
  canonicalManifestJson,
  normalizeManifest,
  serializeManifest,
} from "@/src/domain/entities/DocumentVersion";

/**
 * Turns an accepted upload into an openable document.
 *
 * Uploading stores bytes, a StoredFile, a DocumentRecord and a `pending`
 * ingestion row — but a document is only *openable* once it has a durable
 * version, because the content route serves bytes named by a version manifest
 * and nothing else. This service is the missing half: it promotes a pending
 * ingestion into the document's initial `import` version and advances the
 * document pointer.
 *
 * Why a service rather than logic in the handler: the same promotion has to be
 * reachable from the queue worker *and* from the one-time repair of documents
 * that were uploaded before the pipeline existed. Two callers running different
 * code would be two chances to write a different kind of version.
 *
 * Trust boundary: the job payload names ids, never a storage key. Every key,
 * checksum and size used to build the manifest is re-read here from
 * tenant-scoped repositories, so a forged or stale payload cannot point a
 * version at bytes the document does not own.
 *
 * Idempotency is structural rather than lock-based (at-least-once delivery is
 * the queue's normal behaviour, and this also runs from a rerunnable repair):
 *
 *  - a document that already has an `import` version is adopted, never
 *    duplicated — the existing version is re-pointed at if the pointer is unset;
 *  - a completed ingestion returns its existing result;
 *  - the document pointer is only advanced from *unset*, so a stale worker
 *    cannot overwrite a newer version chosen by a later save.
 */

/** Why an ingestion could not be promoted. Bounded and safe to persist. */
export type IngestionFailureReason =
  | "missing-document"
  | "missing-stored-file"
  | "foreign-stored-file"
  | "missing-object"
  | "checksum-mismatch"
  | "size-mismatch"
  | "not-a-pdf"
  | "manifest-rejected";

/** Operator-facing text for each failure. Never includes a storage key. */
const FAILURE_TEXT: Record<IngestionFailureReason, string> = {
  "missing-document": "The document record for this upload no longer exists.",
  "missing-stored-file": "The uploaded file record could not be found.",
  "foreign-stored-file": "The uploaded file does not belong to this workspace.",
  "missing-object": "The uploaded bytes are no longer in storage.",
  "checksum-mismatch": "The stored bytes do not match the uploaded checksum.",
  "size-mismatch": "The stored bytes do not match the uploaded size.",
  "not-a-pdf": "The uploaded file is not a readable PDF.",
  "manifest-rejected": "The document version could not be described within its limits.",
};

export type IngestionOutcome =
  | { status: "completed"; version: DocumentVersion; created: boolean }
  | { status: "failed"; reason: IngestionFailureReason; message: string }
  | { status: "skipped"; detail: string };

/** What one recovery sweep did. Counts only — never document identifiers. */
export interface ReconcileSummary {
  examined: number;
  promoted: number;
  failed: number;
  skipped: number;
}

/**
 * Rows examined per recovery sweep. Bounded so startup cost stays predictable
 * no matter how large the backlog is; the next sweep continues from the front.
 */
export const DEFAULT_RECONCILE_LIMIT = 25;

const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

export interface DocumentIngestionServiceOptions {
  /** Overrides the clock, so retention/completion timestamps are testable. */
  now?: () => Date;
}

export class DocumentIngestionService {
  private readonly now: () => Date;

  constructor(
    private readonly logger: ILogger,
    private readonly ingestions: DocumentIngestionRepository,
    private readonly documents: DocumentRecordRepository,
    private readonly versions: DocumentVersionRepository,
    private readonly files: IFileMetadataRepository,
    private readonly storage: IObjectStorage,
    options: DocumentIngestionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Promotes one ingestion to a durable initial version.
   *
   * Returns rather than throws for every *expected* outcome — already done,
   * gone, invalid bytes — because those are states the caller must record, not
   * exceptions. Genuine infrastructure faults still throw, so the worker's retry
   * policy sees them.
   */
  async processIngestion(workspaceId: string, ingestionId: string): Promise<IngestionOutcome> {
    const ingestion = await this.ingestions.getById(workspaceId, ingestionId);
    if (!ingestion) return { status: "skipped", detail: "Ingestion not found in this workspace." };

    // A terminal ingestion is never reprocessed. `complete` converges by
    // reporting the version that already exists rather than making a second one.
    if (ingestion.status === "complete") {
      const existing = await this.findImportVersion(
        workspaceId,
        ingestion.documentId,
        ingestion.checksum,
      );
      if (existing) return { status: "completed", version: existing, created: false };
      return { status: "skipped", detail: "Ingestion already complete." };
    }
    if (ingestion.status === "failed") {
      return { status: "skipped", detail: "Ingestion previously failed; retry to reprocess." };
    }

    return this.promote(ingestion);
  }

  /**
   * Promotes ingestions that were left unfinished, and reports how many.
   *
   * This exists because the enqueue is not transactional with the upload. The
   * upload deliberately keeps its rows when the queue rejects a job — the bytes
   * are durable and a document is better recoverable than deleted — but that
   * leaves a real gap: an accepted upload whose job never existed would wait
   * forever. With no outbox in this repository, a bounded sweep at worker
   * startup is the honest recovery mechanism, so "pending" means "not promoted
   * yet" rather than "lost".
   *
   * Bounded and deterministic on purpose: oldest first, at most `limit` rows per
   * sweep, and each row goes through the same idempotent promotion the queue
   * uses — so a row already handled by a live job converges instead of being
   * duplicated. A row that fails promotion is recorded as failed and does not
   * block the rest of the batch.
   */
  async reconcileUnfinished(limit = DEFAULT_RECONCILE_LIMIT): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { examined: 0, promoted: 0, failed: 0, skipped: 0 };
    const stuck = await this.ingestions.listUnfinished(limit);

    for (const ingestion of stuck) {
      summary.examined += 1;
      try {
        const outcome = await this.processIngestion(ingestion.workspaceId, ingestion.id);
        if (outcome.status === "completed") summary.promoted += 1;
        else if (outcome.status === "failed") summary.failed += 1;
        else summary.skipped += 1;
      } catch (error) {
        // One unrecoverable row must not abort the sweep: the remaining
        // documents are independent and equally stranded.
        summary.failed += 1;
        this.logger.error("Ingestion recovery failed for one upload", {
          workspaceId: ingestion.workspaceId,
          ingestionId: ingestion.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (summary.examined > 0) {
      this.logger.info("Recovered unfinished ingestions", { ...summary });
    }
    return summary;
  }

  /**
   * Re-runs a failed ingestion by returning it to `pending`.
   *
   * The bytes were kept on failure precisely so this is possible. Returns false
   * when the ingestion is not in a retryable state, so a caller cannot use retry
   * to reopen work that already succeeded.
   */
  async markRetryable(workspaceId: string, ingestionId: string): Promise<boolean> {
    const ingestion = await this.ingestions.getById(workspaceId, ingestionId);
    if (!ingestion || ingestion.status !== "failed") return false;
    await this.ingestions.update(workspaceId, ingestionId, {
      status: "pending",
      failureReason: null,
      completedAt: null,
    });
    return true;
  }

  /**
   * The real work: validate everything, then write the version and advance the
   * document.
   *
   * Claiming happens first (`pending → processing`) so a second concurrent
   * delivery observes the claim. The claim is not the only protection — the
   * adopt-existing check below is what makes a duplicate converge even if two
   * workers get past the claim — but it keeps the common case cheap.
   */
  private async promote(ingestion: DocumentIngestion): Promise<IngestionOutcome> {
    const { workspaceId, documentId, id: ingestionId } = ingestion;

    const document = await this.documents.getById(workspaceId, documentId);
    if (!document || document.workspaceId !== workspaceId) {
      return this.fail(workspaceId, ingestionId, "missing-document");
    }

    // Adopt before creating. A retry after a partial failure — version written,
    // pointer or status update lost — must converge on the version that already
    // exists instead of cutting a second "initial" one.
    const adopted = await this.findImportVersion(workspaceId, documentId, ingestion.checksum);
    if (adopted) {
      await this.linkAndComplete(ingestion, adopted);
      return { status: "completed", version: adopted, created: false };
    }

    if (ingestion.status === "pending") {
      await this.ingestions.update(workspaceId, ingestionId, { status: "processing" });
    }

    const file = await this.files.get(ingestion.storedFileId);
    if (!file) return this.fail(workspaceId, ingestionId, "missing-stored-file");

    // The upload path stores Workspace bytes as org-owned (ownerType "org",
    // ownerId = the organization). The check is written as "must be exactly
    // that" rather than "must not be a foreign org": an allow-list rejects an
    // `anon`- or `user`-owned file whose ownerId happens to match, which a
    // deny-list would wave through and let a document name bytes that were
    // never uploaded into this organization.
    if (file.ownerType !== "org" || file.ownerId !== ingestion.organizationId) {
      return this.fail(workspaceId, ingestionId, "foreign-stored-file");
    }

    const head = await this.storage.head(file.key);
    if (!head.exists) return this.fail(workspaceId, ingestionId, "missing-object");

    // The checksum recorded at upload is the integrity anchor. Comparing the
    // StoredFile's hash against it catches a row that drifted from its bytes.
    if (file.sha256 !== ingestion.checksum) {
      return this.fail(workspaceId, ingestionId, "checksum-mismatch");
    }
    if (file.size !== ingestion.byteSize) {
      return this.fail(workspaceId, ingestionId, "size-mismatch");
    }

    if (!(await this.looksLikePdf(file.key))) {
      return this.fail(workspaceId, ingestionId, "not-a-pdf");
    }

    const manifestInput: DocumentVersionManifest = {
      schema: DOCUMENT_VERSION_MANIFEST_SCHEMA,
      sourceKey: file.key,
      sourceChecksum: file.sha256,
      sourceByteSize: file.size,
      editorStateKey: null,
      editorStateChecksum: null,
      outputKey: null,
      outputChecksum: null,
      pageCount: this.boundedPageCount(ingestion.pageCount),
      thumbnailKeys: [],
    };

    // Normalized and serialized through the same domain helpers the version
    // service uses, so a manifest written here is indistinguishable from one
    // written by a save — including its checksum.
    const manifest = normalizeManifest(manifestInput);
    const json = manifest ? serializeManifest(manifest) : null;
    if (!manifest || json === null) {
      return this.fail(workspaceId, ingestionId, "manifest-rejected");
    }

    const version = await this.versions.create({
      workspaceId,
      organizationId: ingestion.organizationId,
      documentId,
      revision: document.revision,
      origin: "import",
      restoredFromVersionId: null,
      label: null,
      manifest: json,
      checksum: crypto.createHash("sha256").update(canonicalManifestJson(manifest)).digest("hex"),
      createdById: ingestion.uploadedById,
    });

    await this.linkAndComplete(ingestion, version);

    this.logger.info("Upload ingested into initial version", {
      workspaceId,
      documentId,
      ingestionId,
      versionId: version.id,
      versionNumber: version.versionNumber,
    });

    return { status: "completed", version, created: true };
  }

  /**
   * Advances the document pointer and closes the ingestion.
   *
   * The pointer is written through a conditional update that carries the
   * "still unset" condition into the WHERE clause, so the database decides
   * whether it applies. Checking a `currentVersionId` this process read earlier
   * would be a stale read: a save can advance the document between that read
   * and this write, and an unconditional write would drag it back to the import
   * version. A refused update is the expected outcome in that race, not an
   * error — the initial version is the *first* version, never the current one
   * by force.
   */
  private async linkAndComplete(
    ingestion: DocumentIngestion,
    version: DocumentVersion,
  ): Promise<void> {
    const pointed = await this.documents.setCurrentVersionIfUnset(
      ingestion.workspaceId,
      ingestion.documentId,
      version.id,
    );
    if (!pointed) {
      this.logger.debug("Document already had a current version; import version left in history", {
        documentId: ingestion.documentId,
        importVersionId: version.id,
      });
    }

    if (ingestion.status !== "complete") {
      await this.ingestions.update(ingestion.workspaceId, ingestion.id, {
        status: "complete",
        pageCount: version.manifest.pageCount,
        failureReason: null,
        completedAt: this.now(),
      });
    }
  }

  /**
   * The document's initial version, if one was already cut for *these* bytes.
   *
   * Version 1 is the import version by construction: numbers are allocated
   * monotonically from 1 and this pipeline cuts the first one. The manifest's
   * source checksum is compared against the ingestion's as well, so a version 1
   * describing different bytes is not adopted — completing an ingestion against
   * a version that does not hold its content would report success for bytes the
   * user never sees. A degraded manifest is likewise not adoptable, because its
   * key cannot be vouched for.
   */
  private async findImportVersion(
    workspaceId: string,
    documentId: string,
    checksum: string,
  ): Promise<DocumentVersion | null> {
    const first = await this.versions.getByNumber(workspaceId, documentId, 1);
    if (!first || first.origin !== "import") return null;
    if (first.manifestDegraded) return null;
    if (first.manifest.sourceChecksum !== checksum) return null;
    return first;
  }

  /**
   * Reads only the leading bytes to confirm the object is really a PDF.
   *
   * Streamed and cancelled after the first chunk rather than `get()`-ing the
   * object: a worker must not pull a 100 MB upload into memory to inspect five
   * bytes.
   */
  private async looksLikePdf(key: string): Promise<boolean> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const stream = await this.storage.getStream(key);
      reader = stream.getReader();
      const head = new Uint8Array(PDF_SIGNATURE.length);
      let filled = 0;

      // A store is free to hand back tiny chunks, so accumulate until the
      // signature is covered rather than assuming the first chunk is enough.
      while (filled < head.length) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const take = Math.min(value.length, head.length - filled);
        head.set(value.subarray(0, take), filled);
        filled += take;
      }

      return filled === head.length && Buffer.from(head).equals(PDF_SIGNATURE);
    } catch (error) {
      this.logger.warn("Could not read uploaded object for signature check", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      // Releases the underlying handle/connection: the rest of the object is
      // never transferred.
      await reader?.cancel().catch(() => undefined);
    }
  }

  private boundedPageCount(value: number | null): number | null {
    if (value === null || !Number.isInteger(value)) return null;
    if (value < 0 || value > DOCUMENT_INGESTION_LIMITS.maxPageCount) return null;
    return value;
  }

  /**
   * Records a failure and stops.
   *
   * The uploaded bytes and every row are retained: a failed ingestion is a thing
   * an operator can inspect and retry, and deleting the evidence on failure
   * would make that impossible. `currentVersionId` is deliberately untouched —
   * a document with no openable version must keep saying so.
   */
  private async fail(
    workspaceId: string,
    ingestionId: string,
    reason: IngestionFailureReason,
  ): Promise<IngestionOutcome> {
    const message = FAILURE_TEXT[reason];
    await this.ingestions.update(workspaceId, ingestionId, {
      status: "failed",
      failureReason: message.slice(0, DOCUMENT_INGESTION_LIMITS.maxFailureReasonLength),
      completedAt: this.now(),
    });
    this.logger.warn("Upload ingestion failed", { workspaceId, ingestionId, reason });
    return { status: "failed", reason, message };
  }
}
