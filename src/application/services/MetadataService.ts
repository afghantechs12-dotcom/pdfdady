import { createHash } from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { DocumentMetadataRepository } from "@/src/application/ports/workspaces/DocumentMetadataRepository";
import type { BookmarkRepository } from "@/src/application/ports/workspaces/BookmarkRepository";
import type { OutlineItemRepository } from "@/src/application/ports/workspaces/OutlineItemRepository";
import type { AttachmentRepository } from "@/src/application/ports/workspaces/AttachmentRepository";
import type { IObjectStorage } from "@/src/application/ports/storage/ObjectStorage";
import type { IFileMetadataRepository } from "@/src/application/ports/storage/FileMetadataRepository";
import type {
  AttachmentRecord,
  DocumentMetadata,
  EmbeddedCapabilityReport,
  MetadataOrigin,
  OutlineItem,
  OutlineNode,
  WorkspaceBookmark,
} from "@/src/domain/entities/DocumentMetadata";
import {
  EMBEDDED_WRITE_SUPPORT,
  METADATA_LIMITS,
  asciiFallbackFilename,
  buildOutlineTree,
  canWriteEmbedded,
  isBoundedMetadataId,
  metadataListLimit,
  safeDownloadType,
  validateAnchor,
  validateAttachmentName,
  validateDescription,
  validateMetadataFields,
  validateMimeType,
  validateNote,
  validatePageNumber,
  validateTitle,
} from "@/src/domain/entities/DocumentMetadata";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import { DomainError, NotFoundError } from "@/src/domain/errors";
import { generateOrderKeyBetween } from "./orderKey";

export interface MetadataServiceOptions {
  /** Largest single attachment, in bytes. */
  maxAttachmentBytes?: number;
  /** Largest total attachment payload one document may accumulate, in bytes. */
  maxAttachmentTotalBytes?: number;
}

/** What a caller supplies to create a bookmark. */
export interface BookmarkDraft {
  pageNumber?: unknown;
  title?: unknown;
  note?: unknown;
  anchor?: unknown;
}

/** What a caller supplies to update a bookmark; absent keys are left alone. */
export interface BookmarkPatch {
  pageNumber?: unknown;
  title?: unknown;
  note?: unknown;
  anchor?: unknown;
}

export interface OutlineItemDraft {
  title?: unknown;
  pageNumber?: unknown;
  parentId?: unknown;
}

export interface OutlineItemPatch {
  title?: unknown;
  pageNumber?: unknown;
}

/** The bytes and declared shape of an attachment being uploaded. */
export interface AttachmentUpload {
  name?: unknown;
  description?: unknown;
  mimeType?: unknown;
  data: Buffer | Uint8Array;
}

/**
 * A resolved attachment download: the record, the bytes as a stream, and the
 * headers that make serving them safe.
 */
export interface AttachmentDownload {
  attachment: AttachmentRecord;
  stream: ReadableStream<Uint8Array>;
  /** Narrowed content type — not necessarily what was declared at upload. */
  contentType: string;
  /** A complete, header-safe `Content-Disposition` value. */
  contentDisposition: string;
  byteSize: number;
}

/** Everything the properties panel needs for one document, in one read. */
export interface DocumentProperties {
  documentId: string;
  /** Workspace-owned, editable fields. Null when none have been set. */
  metadata: DocumentMetadata | null;
  /** What this build established about the PDF's own structures. */
  embedded: EmbeddedCapabilityReport;
  counts: { bookmarks: number; outlineItems: number; attachments: number };
  /** Bytes consumed by this document's attachments, against the quota. */
  attachmentBytes: { used: number; limit: number };
}

/**
 * M7.9 document metadata, bookmarks, outlines and attachments.
 *
 * The governing distinction is **origin**. Workspace-owned records — properties,
 * bookmarks, authored outline items, uploaded attachments — live in our database
 * and are fully editable. Embedded records are projections of structures inside
 * the PDF bytes, and this build can read them but cannot write them
 * (`EMBEDDED_WRITE_SUPPORT`, all false). Every mutation path checks
 * `canWriteEmbedded` before touching an embedded record and refuses with a
 * message that says why, rather than accepting the call and discarding the edit.
 *
 * Authorization runs before any record is read. `requireDocument` resolves the
 * DocumentRecord within the Workspace first, so a metadata row, bookmark,
 * outline item or attachment can never confirm a document the actor cannot
 * already see — a document outside the Workspace reads as missing, never as
 * forbidden.
 *
 * Attachment bytes are streamed, never buffered on the read path: the record
 * carries the size and checksum recorded at upload, and the download resolves a
 * StoredFile through object storage. The served content type is narrowed by
 * `safeDownloadType`, because an attachment stored as text/html and served under
 * its own type would be stored XSS on our own origin.
 */
export class MetadataService {
  private readonly maxAttachmentBytes: number;
  private readonly maxAttachmentTotalBytes: number;

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
    private readonly metadata: DocumentMetadataRepository,
    private readonly bookmarks: BookmarkRepository,
    private readonly outline: OutlineItemRepository,
    private readonly attachments: AttachmentRepository,
    private readonly storage: IObjectStorage,
    private readonly files: IFileMetadataRepository,
    options: MetadataServiceOptions = {},
  ) {
    // A configured bound may tighten the domain limit but never widen it: a
    // deployment must not be able to raise a quota the domain considers a cap.
    this.maxAttachmentBytes = boundedOption(
      options.maxAttachmentBytes,
      METADATA_LIMITS.maxAttachmentBytes,
    );
    this.maxAttachmentTotalBytes = boundedOption(
      options.maxAttachmentTotalBytes,
      METADATA_LIMITS.maxAttachmentTotalBytes,
    );
  }

  // ---- authorization -------------------------------------------------------

  /** Authorizes the actor for a Workspace, enforcing write access when asked. */
  private async requireWorkspace(
    actor: ActorContext,
    workspaceId: string,
    write: boolean,
  ): Promise<{ organizationId: string }> {
    const { workspace } = await this.workspaces.get(actor, workspaceId, write);
    return { organizationId: workspace.organizationId };
  }

  /**
   * Resolves a document within the Workspace. A document outside it reads as
   * missing, never as forbidden, so a probe cannot learn that it exists.
   */
  private async requireDocument(
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentRecord> {
    if (!isBoundedMetadataId(documentId)) {
      throw new DomainError("A valid document id is required.");
    }
    const document = await this.documents.getById(workspaceId, documentId);
    if (!document) throw new NotFoundError("Document not found in this workspace.");
    return document;
  }

  /** Authorizes the Workspace and the document together, in that order. */
  private async authorize(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    write: boolean,
  ): Promise<{ organizationId: string; document: DocumentRecord }> {
    const { organizationId } = await this.requireWorkspace(actor, workspaceId, write);
    const document = await this.requireDocument(workspaceId, documentId);
    return { organizationId, document };
  }

  // ---- properties ----------------------------------------------------------

  /**
   * Replaces a document's Workspace-owned properties.
   *
   * A full replace rather than a merge: a properties panel submits the whole
   * form, and a merge would make clearing a field impossible to express. Unknown
   * keys are reported rather than dropped, so a save that ignored part of the
   * input never reads as a save that worked.
   */
  async setDocumentMetadata(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    fields: unknown,
  ): Promise<DocumentMetadata> {
    const { organizationId, document } = await this.authorize(
      actor,
      workspaceId,
      documentId,
      true,
    );

    const validated = validateMetadataFields(fields);
    if (!validated.ok) throw new DomainError(validated.reason);
    if (validated.rejected.length > 0) {
      throw new DomainError(
        `These metadata fields are not supported: ${validated.rejected.join(", ")}.`,
      );
    }

    const saved = await this.metadata.upsert({
      organizationId,
      workspaceId,
      documentId: document.id,
      fields: validated.fields,
      schemaVersion: METADATA_LIMITS.schemaVersion,
      actorId: actor.userId,
    });

    this.logger.debug("Set document metadata", {
      workspaceId,
      documentId: document.id,
      fieldCount: Object.keys(validated.fields).length,
    });
    return saved;
  }

  /** Reads a document's Workspace-owned properties, or null when none are set. */
  async getDocumentMetadata(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentMetadata | null> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);
    return this.metadata.getByDocumentId(workspaceId, document.id);
  }

  /**
   * Compare-and-swap replace of the properties.
   *
   * Used by a panel that read a revision and wants to write only if nothing has
   * moved underneath it. A stale revision and a missing row both surface as the
   * same conflict, so neither discloses the other.
   */
  async replaceDocumentMetadata(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    expectedRevision: number,
    fields: unknown,
  ): Promise<DocumentMetadata> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError("A valid expected revision is required.");
    }

    const validated = validateMetadataFields(fields);
    if (!validated.ok) throw new DomainError(validated.reason);
    if (validated.rejected.length > 0) {
      throw new DomainError(
        `These metadata fields are not supported: ${validated.rejected.join(", ")}.`,
      );
    }

    const updated = await this.metadata.replaceFields(
      workspaceId,
      document.id,
      expectedRevision,
      validated.fields,
      actor.userId,
    );
    if (!updated) {
      throw new DomainError("These properties changed since they were loaded.");
    }
    return updated;
  }

  /**
   * Everything the properties panel needs, in one authorized read.
   *
   * The embedded report is deliberately included even though it is currently
   * uninspected for every document: a panel that shows nothing about embedded
   * structures reads as "this file has none", which is a different claim from
   * "we have not looked".
   */
  async getDocumentProperties(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentProperties> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);

    const [metadata, bookmarkCount, outlineCount, attachmentCount, used] = await Promise.all([
      this.metadata.getByDocumentId(workspaceId, document.id),
      this.bookmarks.countForDocument(workspaceId, document.id),
      this.outline.countForDocument(workspaceId, document.id),
      this.attachments.countForDocument(workspaceId, document.id),
      this.attachments.totalBytesForDocument(workspaceId, document.id),
    ]);

    return {
      documentId: document.id,
      metadata,
      embedded: this.embeddedCapabilities(),
      counts: {
        bookmarks: bookmarkCount,
        outlineItems: outlineCount,
        attachments: attachmentCount,
      },
      attachmentBytes: { used, limit: this.maxAttachmentTotalBytes },
    };
  }

  /**
   * What this build can do with a document's embedded structures.
   *
   * Reported as uninspected rather than fabricated: no PDF parsing runs in this
   * milestone, so claiming a field count or an outline would be inventing it.
   * The limitations list is what a panel shows instead of an empty state.
   */
  private embeddedCapabilities(): EmbeddedCapabilityReport {
    return {
      inspected: false,
      parsed: false,
      // Presence, not validity: finding a signature entry establishes only that
      // one exists. Nothing here verifies a signature, so nothing here may say
      // a document is signed.
      signaturePresent: false,
      found: { metadataFields: 0, outlineItems: 0, attachments: 0 },
      writable: { ...EMBEDDED_WRITE_SUPPORT },
      limitations: [
        "Embedded PDF structures have not been inspected in this release.",
        "Embedded metadata, outlines and attachments are read-only: writing them requires a document rewrite that produces a new version, which this build does not perform.",
      ],
    };
  }

  // ---- bookmarks -----------------------------------------------------------

  /** Creates a Workspace bookmark on a page of a document. */
  async createBookmark(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    draft: BookmarkDraft,
  ): Promise<WorkspaceBookmark> {
    const { organizationId, document } = await this.authorize(
      actor,
      workspaceId,
      documentId,
      true,
    );

    const pageNumber = validatePageNumber(draft.pageNumber);
    if (pageNumber === null) {
      throw new DomainError("A bookmark needs a page number of at least 1.");
    }
    const title = validateTitle(draft.title);
    if (title === null) {
      throw new DomainError(
        `A bookmark title is required and must be at most ${METADATA_LIMITS.maxTitleLength} characters.`,
      );
    }
    const note = validateNote(draft.note);
    if (note === null) throw new DomainError("The bookmark note is not acceptable.");
    const anchor = validateAnchor(draft.anchor);
    if (!anchor.ok) {
      throw new DomainError("A bookmark anchor must be a point within the page.");
    }

    const existing = await this.bookmarks.countForDocument(workspaceId, document.id);
    if (existing >= METADATA_LIMITS.maxBookmarksPerDocument) {
      throw new DomainError(
        `A document may hold at most ${METADATA_LIMITS.maxBookmarksPerDocument} bookmarks.`,
      );
    }

    const last = await this.bookmarks.lastOrderKey(workspaceId, document.id);
    const bookmark = await this.bookmarks.create({
      organizationId,
      workspaceId,
      documentId: document.id,
      pageNumber,
      title,
      note: note ?? null,
      anchor: anchor.anchor,
      orderKey: generateOrderKeyBetween(last, null),
      createdById: actor.userId,
    });

    this.logger.debug("Created bookmark", {
      workspaceId,
      documentId: document.id,
      bookmarkId: bookmark.id,
      pageNumber,
    });
    return bookmark;
  }

  /** Lists a document's bookmarks, optionally narrowed to one page. */
  async listBookmarks(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { pageNumber?: number; limit?: number } = {},
  ): Promise<WorkspaceBookmark[]> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);

    let pageNumber: number | undefined;
    if (options.pageNumber !== undefined) {
      const validated = validatePageNumber(options.pageNumber);
      if (validated === null) throw new DomainError("The page filter is invalid.");
      pageNumber = validated;
    }

    return this.bookmarks.list({
      workspaceId,
      documentId: document.id,
      pageNumber,
      limit: metadataListLimit(options.limit),
    });
  }

  /** Updates a bookmark, compare-and-swap on its revision. */
  async updateBookmark(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    bookmarkId: string,
    expectedRevision: number,
    patch: BookmarkPatch,
  ): Promise<WorkspaceBookmark> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    const existing = await this.requireBookmark(workspaceId, document.id, bookmarkId);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError("A valid expected revision is required.");
    }

    const update: {
      pageNumber?: number;
      title?: string;
      note?: string | null;
      anchor?: { x: number; y: number } | null;
    } = {};

    if (patch.pageNumber !== undefined) {
      const pageNumber = validatePageNumber(patch.pageNumber);
      if (pageNumber === null) throw new DomainError("A bookmark page must be at least 1.");
      update.pageNumber = pageNumber;
    }
    if (patch.title !== undefined) {
      const title = validateTitle(patch.title);
      if (title === null) throw new DomainError("The bookmark title is not acceptable.");
      update.title = title;
    }
    if (patch.note !== undefined) {
      // An explicit null clears the note; an unusable value is rejected. The
      // two are different intents and must not collapse into each other.
      if (patch.note === null) update.note = null;
      else {
        const note = validateNote(patch.note);
        if (note === null) throw new DomainError("The bookmark note is not acceptable.");
        update.note = note ?? null;
      }
    }
    if (patch.anchor !== undefined) {
      const anchor = validateAnchor(patch.anchor);
      if (!anchor.ok) throw new DomainError("A bookmark anchor must be a point within the page.");
      update.anchor = anchor.anchor;
    }

    const updated = await this.bookmarks.update(
      workspaceId,
      existing.id,
      expectedRevision,
      update,
    );
    if (!updated) throw new DomainError("This bookmark changed since it was loaded.");
    return updated;
  }

  async deleteBookmark(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    bookmarkId: string,
  ): Promise<boolean> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    const existing = await this.requireBookmark(workspaceId, document.id, bookmarkId);
    return this.bookmarks.delete(workspaceId, existing.id);
  }

  /**
   * Resolves a bookmark, checking it belongs to the named document.
   *
   * The Workspace scope alone is not enough: a bookmark id from a sibling
   * document in the same Workspace would otherwise be editable through a URL
   * naming a document the actor happens to hold.
   */
  private async requireBookmark(
    workspaceId: string,
    documentId: string,
    bookmarkId: string,
  ): Promise<WorkspaceBookmark> {
    if (!isBoundedMetadataId(bookmarkId)) {
      throw new DomainError("A valid bookmark id is required.");
    }
    const bookmark = await this.bookmarks.getById(workspaceId, bookmarkId);
    if (!bookmark || bookmark.documentId !== documentId) {
      throw new NotFoundError("Bookmark not found for this document.");
    }
    return bookmark;
  }

  // ---- outline -------------------------------------------------------------

  /**
   * Creates a Workspace outline item.
   *
   * Only `workspace` items can be created: an embedded outline belongs to the
   * PDF, and adding a node to it would require writing the file.
   */
  async createOutlineItem(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    draft: OutlineItemDraft,
  ): Promise<OutlineItem> {
    const { organizationId, document } = await this.authorize(
      actor,
      workspaceId,
      documentId,
      true,
    );

    const title = validateTitle(draft.title);
    if (title === null) {
      throw new DomainError(
        `An outline title is required and must be at most ${METADATA_LIMITS.maxTitleLength} characters.`,
      );
    }
    const pageNumber = validatePageNumber(draft.pageNumber);
    if (pageNumber === null) {
      throw new DomainError("An outline item needs a page number of at least 1.");
    }

    let parent: OutlineItem | null = null;
    if (draft.parentId !== undefined && draft.parentId !== null) {
      if (!isBoundedMetadataId(draft.parentId)) {
        throw new DomainError("A valid parent id is required.");
      }
      parent = await this.outline.getById(workspaceId, draft.parentId);
      if (!parent || parent.documentId !== document.id) {
        throw new NotFoundError("Parent outline item not found for this document.");
      }
      // Nesting under the PDF's own outline would produce a tree that is half
      // ours and half the file's, and no write path could ever reconcile it.
      if (parent.origin === "embedded") {
        throw new DomainError(
          "An embedded outline item cannot hold workspace children: the PDF's outline is read-only.",
        );
      }
    }

    const depth = parent === null ? 0 : parent.depth + 1;
    if (depth > METADATA_LIMITS.maxOutlineDepth) {
      throw new DomainError(
        `An outline may nest at most ${METADATA_LIMITS.maxOutlineDepth} levels deep.`,
      );
    }

    const existing = await this.outline.countForDocument(workspaceId, document.id);
    if (existing >= METADATA_LIMITS.maxOutlineItems) {
      throw new DomainError(
        `A document may hold at most ${METADATA_LIMITS.maxOutlineItems} outline items.`,
      );
    }

    const last = await this.outline.lastOrderKey(
      workspaceId,
      document.id,
      parent === null ? null : parent.id,
    );
    const item = await this.outline.create({
      organizationId,
      workspaceId,
      documentId: document.id,
      parentId: parent === null ? null : parent.id,
      title,
      pageNumber,
      depth,
      orderKey: generateOrderKeyBetween(last, null),
      origin: "workspace",
      createdById: actor.userId,
    });

    this.logger.debug("Created outline item", {
      workspaceId,
      documentId: document.id,
      outlineItemId: item.id,
      depth,
    });
    return item;
  }

  /** Lists a document's outline as a flat, ordered list. */
  async listOutline(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { origin?: MetadataOrigin; limit?: number } = {},
  ): Promise<OutlineItem[]> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);
    return this.outline.list({
      workspaceId,
      documentId: document.id,
      origin: options.origin,
      limit: metadataListLimit(options.limit),
    });
  }

  /** Lists a document's outline assembled into a tree, for a navigable panel. */
  async getOutlineTree(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { origin?: MetadataOrigin } = {},
  ): Promise<OutlineNode[]> {
    const items = await this.listOutline(actor, workspaceId, documentId, {
      origin: options.origin,
      limit: METADATA_LIMITS.maxOutlineItems,
    });
    return buildOutlineTree(items);
  }

  /** Updates a Workspace outline item. Embedded items are refused. */
  async updateOutlineItem(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    outlineItemId: string,
    expectedRevision: number,
    patch: OutlineItemPatch,
  ): Promise<OutlineItem> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    const existing = await this.requireOutlineItem(workspaceId, document.id, outlineItemId);
    this.assertWritableOrigin(existing.origin, "outline");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError("A valid expected revision is required.");
    }

    const update: { title?: string; pageNumber?: number } = {};
    if (patch.title !== undefined) {
      const title = validateTitle(patch.title);
      if (title === null) throw new DomainError("The outline title is not acceptable.");
      update.title = title;
    }
    if (patch.pageNumber !== undefined) {
      const pageNumber = validatePageNumber(patch.pageNumber);
      if (pageNumber === null) throw new DomainError("An outline page must be at least 1.");
      update.pageNumber = pageNumber;
    }

    const updated = await this.outline.update(
      workspaceId,
      existing.id,
      expectedRevision,
      update,
    );
    if (!updated) throw new DomainError("This outline item changed since it was loaded.");
    return updated;
  }

  /**
   * Deletes a Workspace outline item and everything beneath it.
   *
   * Descendants go with it rather than being re-parented: an outline node's
   * children are its contents, and silently promoting them to the root would
   * scatter a chapter's sections across the top level.
   */
  async deleteOutlineItem(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    outlineItemId: string,
  ): Promise<number> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    const existing = await this.requireOutlineItem(workspaceId, document.id, outlineItemId);
    this.assertWritableOrigin(existing.origin, "outline");

    // Descendants first, then the item: the repository resolves the subtree in
    // one bounded statement, so a failure cannot leave a chapter half-removed
    // with its sections silently promoted to the root.
    const removedDescendants = await this.outline.deleteDescendants(
      workspaceId,
      document.id,
      existing.id,
    );
    const removedSelf = await this.outline.delete(workspaceId, existing.id);
    return removedDescendants + (removedSelf ? 1 : 0);
  }

  private async requireOutlineItem(
    workspaceId: string,
    documentId: string,
    outlineItemId: string,
  ): Promise<OutlineItem> {
    if (!isBoundedMetadataId(outlineItemId)) {
      throw new DomainError("A valid outline item id is required.");
    }
    const item = await this.outline.getById(workspaceId, outlineItemId);
    if (!item || item.documentId !== documentId) {
      throw new NotFoundError("Outline item not found for this document.");
    }
    return item;
  }

  /**
   * Refuses a mutation of an embedded record.
   *
   * Consults `canWriteEmbedded` rather than hard-coding the refusal, so that a
   * future feasibility-approved writer enables these paths by flipping one
   * constant instead of by finding every site that assumed the answer.
   */
  private assertWritableOrigin(
    origin: MetadataOrigin,
    kind: "metadata" | "outline" | "attachments",
  ): void {
    if (origin !== "embedded") return;
    if (canWriteEmbedded(kind)) return;
    throw new DomainError(
      "This item is part of the PDF file itself and cannot be edited here. Editing it would require rewriting the document, which this release does not do.",
    );
  }

  // ---- attachments ---------------------------------------------------------

  /**
   * Attaches a file to a document.
   *
   * The bytes are hashed and stored under a content-addressed key, and the
   * record carries the size and checksum computed here rather than any figure
   * the client supplied — a declared size is a claim, and the quota has to be
   * enforced against what actually arrived.
   */
  async createAttachment(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    upload: AttachmentUpload,
  ): Promise<AttachmentRecord> {
    const { organizationId, document } = await this.authorize(
      actor,
      workspaceId,
      documentId,
      true,
    );

    const name = validateAttachmentName(upload.name);
    if (!name) {
      throw new DomainError(
        `An attachment name is required, must be at most ${METADATA_LIMITS.maxAttachmentNameLength} characters, and must not contain path separators.`,
      );
    }
    const description = validateDescription(upload.description);
    if (description === null) {
      throw new DomainError("The attachment description is not acceptable.");
    }
    const mimeType = validateMimeType(upload.mimeType);
    if (mimeType === null) {
      throw new DomainError("A valid attachment content type is required.");
    }

    const data = Buffer.isBuffer(upload.data) ? upload.data : Buffer.from(upload.data);
    if (data.length === 0) throw new DomainError("An attachment must not be empty.");
    if (data.length > this.maxAttachmentBytes) {
      throw new DomainError(
        `An attachment may be at most ${this.maxAttachmentBytes} bytes.`,
      );
    }

    const count = await this.attachments.countForDocument(workspaceId, document.id);
    if (count >= METADATA_LIMITS.maxAttachmentsPerDocument) {
      throw new DomainError(
        `A document may hold at most ${METADATA_LIMITS.maxAttachmentsPerDocument} attachments.`,
      );
    }

    const used = await this.attachments.totalBytesForDocument(workspaceId, document.id);
    if (used + data.length > this.maxAttachmentTotalBytes) {
      throw new DomainError(
        `This document's attachments would exceed the ${this.maxAttachmentTotalBytes}-byte limit.`,
      );
    }

    const duplicate = await this.attachments.getByNormalizedName(
      workspaceId,
      document.id,
      name.normalizedName,
    );
    if (duplicate) {
      throw new DomainError("An attachment with this name already exists on the document.");
    }

    const checksum = createHash("sha256").update(data).digest("hex");
    const key = `workspaces/${workspaceId}/attachments/${checksum.slice(0, 2)}/${checksum}`;

    // Content-addressed: an identical byte sequence already stored need not be
    // written again, and writing it again would produce the same object anyway.
    const head = await this.storage.head(key);
    if (!head.exists) {
      await this.storage.put(key, data, { contentType: mimeType, sha256: checksum });
    }

    const file = await this.files.create({
      ownerType: "org",
      ownerId: organizationId,
      key,
      sha256: checksum,
      size: data.length,
      mimeType,
      originalName: name.name,
    });

    try {
      const attachment = await this.attachments.create({
        organizationId,
        workspaceId,
        documentId: document.id,
        storedFileId: file.id,
        origin: "workspace",
        name: name.name,
        normalizedName: name.normalizedName,
        description: description ?? null,
        mimeType,
        byteSize: data.length,
        checksum,
        createdById: actor.userId,
      });

      this.logger.debug("Created attachment", {
        workspaceId,
        documentId: document.id,
        attachmentId: attachment.id,
        byteSize: data.length,
      });
      return attachment;
    } catch (error) {
      // The StoredFile row is rolled back so a failed attach does not leave a
      // file record no attachment points at. The object itself is left in place:
      // it is content-addressed and may be shared with another attachment, so
      // deleting it could remove bytes something else still references.
      await this.files.delete(file.id).catch(() => undefined);
      throw error;
    }
  }

  async listAttachments(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    options: { origin?: MetadataOrigin; limit?: number } = {},
  ): Promise<AttachmentRecord[]> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);
    return this.attachments.list({
      workspaceId,
      documentId: document.id,
      origin: options.origin,
      limit: metadataListLimit(options.limit),
    });
  }

  /**
   * Resolves an attachment for download.
   *
   * The stream comes from object storage rather than a buffer, so a large
   * attachment never sits in memory. The content type is narrowed and the
   * disposition is always `attachment` — the caller must also send
   * `X-Content-Type-Options: nosniff`, which the route does.
   */
  async getAttachmentDownload(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    attachmentId: string,
  ): Promise<AttachmentDownload> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);
    const attachment = await this.requireAttachment(workspaceId, document.id, attachmentId);

    if (attachment.storedFileId === null) {
      // Catalogued but never extracted. Saying so beats a 404, which would
      // suggest the attachment does not exist when it demonstrably does.
      throw new DomainError(
        "This attachment is part of the PDF and has not been extracted, so its contents are not available for download.",
      );
    }

    const file = await this.files.get(attachment.storedFileId);
    if (!file) throw new NotFoundError("The attachment's contents are no longer available.");

    const stream = await this.storage.getStream(file.key);
    const fallback = asciiFallbackFilename(attachment.name);
    // Both forms: `filename` for clients that read only ASCII, `filename*` with
    // percent-encoded UTF-8 for those that do not. The exact name never reaches
    // the header unencoded.
    const encoded = encodeURIComponent(attachment.name);

    return {
      attachment,
      stream,
      contentType: safeDownloadType(attachment.mimeType),
      contentDisposition: `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
      byteSize: attachment.byteSize,
    };
  }

  /** Renames or re-describes a Workspace attachment. */
  async updateAttachment(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    attachmentId: string,
    expectedRevision: number,
    patch: { name?: unknown; description?: unknown },
  ): Promise<AttachmentRecord> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    const existing = await this.requireAttachment(workspaceId, document.id, attachmentId);
    this.assertWritableOrigin(existing.origin, "attachments");
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError("A valid expected revision is required.");
    }

    const update: { name?: string; normalizedName?: string; description?: string | null } = {};
    if (patch.name !== undefined) {
      const name = validateAttachmentName(patch.name);
      if (!name) throw new DomainError("The attachment name is not acceptable.");
      if (name.normalizedName !== existing.normalizedName) {
        const clash = await this.attachments.getByNormalizedName(
          workspaceId,
          document.id,
          name.normalizedName,
        );
        if (clash) {
          throw new DomainError("An attachment with this name already exists on the document.");
        }
      }
      update.name = name.name;
      update.normalizedName = name.normalizedName;
    }
    if (patch.description !== undefined) {
      if (patch.description === null) update.description = null;
      else {
        const description = validateDescription(patch.description);
        if (description === null) {
          throw new DomainError("The attachment description is not acceptable.");
        }
        update.description = description ?? null;
      }
    }

    const updated = await this.attachments.update(
      workspaceId,
      existing.id,
      expectedRevision,
      update,
    );
    if (!updated) throw new DomainError("This attachment changed since it was loaded.");
    return updated;
  }

  /**
   * Removes a Workspace attachment.
   *
   * The catalogue row goes; the stored object does not. The key is
   * content-addressed, so the same bytes may back another attachment in another
   * document, and deleting the object would break it. Reclaiming unreferenced
   * objects is the retention job's business, not this call's.
   */
  async deleteAttachment(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    attachmentId: string,
  ): Promise<boolean> {
    const { document } = await this.authorize(actor, workspaceId, documentId, true);
    const existing = await this.requireAttachment(workspaceId, document.id, attachmentId);
    this.assertWritableOrigin(existing.origin, "attachments");

    const removed = await this.attachments.delete(workspaceId, existing.id);
    if (removed && existing.storedFileId !== null) {
      await this.files.delete(existing.storedFileId).catch(() => undefined);
    }
    return removed;
  }

  private async requireAttachment(
    workspaceId: string,
    documentId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord> {
    if (!isBoundedMetadataId(attachmentId)) {
      throw new DomainError("A valid attachment id is required.");
    }
    const attachment = await this.attachments.getById(workspaceId, attachmentId);
    if (!attachment || attachment.documentId !== documentId) {
      throw new NotFoundError("Attachment not found for this document.");
    }
    return attachment;
  }

  // ---- indexable content ---------------------------------------------------

  /**
   * The searchable text this document's metadata contributes.
   *
   * Returned rather than indexed here: SearchService owns indexing, and having
   * two services write index chunks would make a reindex depend on which ran
   * last. Attachment *names* are included; attachment *contents* are not —
   * indexing bytes we never parsed would be a claim about them.
   */
  async collectIndexableContent(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<Array<{ sourceType: "metadata" | "bookmark" | "outline"; text: string }>> {
    const { document } = await this.authorize(actor, workspaceId, documentId, false);

    const [metadata, bookmarkList, outlineList, attachmentList] = await Promise.all([
      this.metadata.getByDocumentId(workspaceId, document.id),
      this.bookmarks.list({
        workspaceId,
        documentId: document.id,
        limit: METADATA_LIMITS.maxBookmarksPerDocument,
      }),
      this.outline.list({
        workspaceId,
        documentId: document.id,
        limit: METADATA_LIMITS.maxOutlineItems,
      }),
      this.attachments.list({
        workspaceId,
        documentId: document.id,
        limit: METADATA_LIMITS.maxAttachmentsPerDocument,
      }),
    ]);

    const segments: Array<{
      sourceType: "metadata" | "bookmark" | "outline";
      text: string;
    }> = [];

    if (metadata) {
      const values = Object.values(metadata.fields).filter(
        (value): value is string => typeof value === "string" && value !== "",
      );
      if (values.length > 0) segments.push({ sourceType: "metadata", text: values.join(" ") });
    }
    for (const bookmark of bookmarkList) {
      const text = bookmark.note === null ? bookmark.title : `${bookmark.title} ${bookmark.note}`;
      segments.push({ sourceType: "bookmark", text });
    }
    for (const item of outlineList) {
      segments.push({ sourceType: "outline", text: item.title });
    }
    for (const attachment of attachmentList) {
      const text =
        attachment.description === null
          ? attachment.name
          : `${attachment.name} ${attachment.description}`;
      segments.push({ sourceType: "metadata", text });
    }

    return segments;
  }
}

/** Clamps a configured option to the domain bound; a bad value falls back to it. */
function boundedOption(value: number | undefined, cap: number): number {
  if (value === undefined) return cap;
  if (!Number.isFinite(value) || value <= 0) return cap;
  return Math.min(Math.trunc(value), cap);
}

