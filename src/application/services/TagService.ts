import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { TagRepository } from "@/src/application/ports/workspaces/TagRepository";
import type { DocumentTagRepository } from "@/src/application/ports/workspaces/DocumentTagRepository";
import type { SmartCollectionRepository } from "@/src/application/ports/workspaces/SmartCollectionRepository";
import type {
  CollectionCondition,
  CollectionGroup,
  SmartCollection,
  SmartCollectionQuery,
} from "@/src/domain/entities/SmartCollection";
import {
  SMART_COLLECTION_LIMITS as C,
  collectionResultLimit,
  parseSmartCollectionQuery,
  validateCollectionName,
} from "@/src/domain/entities/SmartCollection";
import type { Tag, DocumentTag } from "@/src/domain/entities/Tag";
import {
  TAG_LIMITS,
  isBoundedId,
  validateTagColor,
  validateTagName,
} from "@/src/domain/entities/Tag";
import type { DocumentRecord } from "@/src/domain/entities/DocumentRecord";
import { DomainError, NotFoundError } from "@/src/domain/errors";

export interface TagServiceOptions {
  /** Most tags one Workspace may hold. */
  maxTagsPerWorkspace?: number;
}

/** What a caller supplies to create or update a tag. */
export interface TagDraft {
  name?: unknown;
  color?: unknown;
}

/** The shape of a bulk assignment request, bounded by TAG_LIMITS. */
export interface BulkAssignInput {
  documentIds: string[];
  tagIds: string[];
}

/** How one document fared in a bulk operation; failures are reported, not hidden. */
export interface TagOperationItemResult {
  documentId: string;
  success: boolean;
  error?: string;
}

export interface BulkTagOperationResult {
  tagIds: string[];
  succeeded: string[];
  failed: Array<{ documentId: string; error: string }>;
}

/** What a caller supplies to create or update a collection. */
export interface CollectionDraft {
  name?: unknown;
  query?: unknown;
}

/** An evaluated collection: the definition plus the ids it currently matches. */
export interface CollectionEvaluation {
  collection: SmartCollection;
  documentIds: string[];
  total: number;
}

/**
 * M7.7 tags and smart collections.
 *
 * A tag is Workspace-scoped and its uniqueness is normalized deterministically
 * in the application (NFKC, whitespace collapse, lowercase) rather than by
 * database collation, so the SQLite and PostgreSQL adapters agree on what
 * counts as a duplicate. Membership — which documents carry a tag — is a real
 * DocumentTag row; SmartCollection membership is never stored, it is
 * re-evaluated from live document and tag data on every read.
 *
 * Every operation re-authorizes the Workspace through `WorkspaceService`, and
 * resources are addressed by id only after that authorization has narrowed the
 * query to the Workspace. A resource that exists in another Workspace reads as
 * missing, never as forbidden, so a probe cannot learn whether it exists.
 *
 * The query grammar is strict and allowlisted (src/domain/entities/
 * SmartCollection.ts): unknown versions, fields, operators and shapes are
 * rejected outright, and the depth, condition-count, string and id bounds exist
 * so one malformed definition cannot describe an expensive evaluation.
 */
export class TagService {
  private readonly maxTagsPerWorkspace: number;

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
    private readonly tags: TagRepository,
    private readonly documentTags: DocumentTagRepository,
    private readonly collections: SmartCollectionRepository,
    options: TagServiceOptions = {},
  ) {
    const requested = options.maxTagsPerWorkspace ?? 1000;
    this.maxTagsPerWorkspace =
      Number.isInteger(requested) && requested > 0 ? requested : 1000;
  }

  /** Authorizes the actor for a Workspace, enforcing write access when asked. */
  private async requireWorkspace(
    actor: ActorContext,
    workspaceId: string,
    write: boolean,
  ): Promise<void> {
    await this.workspaces.get(actor, workspaceId, write);
  }

  /**
   * Resolves a tag, narrowing by Workspace so an id from another tenant reads as
   * missing. Never called with a write lock: the read path is what must not
   * disclose existence, and mutation paths call the write-locked resolver first.
   */
  private async requireTag(workspaceId: string, tagId: string): Promise<Tag> {
    const tag = await this.tags.getById(workspaceId, tagId);
    if (!tag) throw new NotFoundError("Tag not found.");
    return tag;
  }

  /**
   * Resolves a document for a mutation. A document outside this Workspace reads
   * as missing, and a non-active document cannot be tagged — a trashed document
   * must not collect new assignments it will have to clean up later.
   */
  private async requireWritableDocument(
    workspaceId: string,
    documentId: string,
  ): Promise<DocumentRecord> {
    const document = await this.documents.getById(workspaceId, documentId);
    if (!document) throw new NotFoundError("Document not found in this workspace.");
    if (document.lifecycleState !== "active") {
      throw new DomainError("Cannot tag an archived or trashed document.");
    }
    return document;
  }

  private assertBulkBound(tagIds: string[], documentIds: string[]): void {
    if (tagIds.length === 0 || tagIds.length > TAG_LIMITS.maxBulkTags) {
      throw new DomainError(
        `A bulk operation must name between 1 and ${TAG_LIMITS.maxBulkTags} tags.`,
      );
    }
    if (documentIds.length === 0 || documentIds.length > TAG_LIMITS.maxBulkDocuments) {
      throw new DomainError(
        `A bulk operation may touch between 1 and ${TAG_LIMITS.maxBulkDocuments} documents.`,
      );
    }
  }

  /**
   * Creates a tag. The duplicate is rejected by the repository's unique
   * constraint (Workspace + normalized name) rather than by a check-then-insert,
   * which is what keeps creation safe under concurrency; the same normalized
   * name in a different Workspace is a different tag.
   */
  async createTag(actor: ActorContext, workspaceId: string, draft: TagDraft): Promise<Tag> {
    await this.requireWorkspace(actor, workspaceId, true);

    const name = validateTagName(draft.name);
    if (!name) throw new DomainError(`Tag name is required and must be at most ${TAG_LIMITS.maxNameLength} characters.`);
    const color = validateTagColor(draft.color);
    if (!color.ok) throw new DomainError("Tag color must be a #rrggbb hex triplet.");

    const existing = await this.tags.countForWorkspace(workspaceId);
    if (existing >= this.maxTagsPerWorkspace) {
      throw new DomainError(`A workspace may hold at most ${this.maxTagsPerWorkspace} tags.`);
    }

    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    const tag = await this.tags.create({
      organizationId: workspace.organizationId,
      workspaceId,
      name: name.name,
      normalizedName: name.normalizedName,
      color: color.color,
      createdById: actor.userId,
    });

    this.logger.debug("Tag created", {
      workspaceId,
      tagId: tag.id,
      normalizedName: tag.normalizedName,
    });
    return tag;
  }

  /** Lists the Workspace's tags, bounded. A viewer may list when policy permits. */
  async listTags(
    actor: ActorContext,
    workspaceId: string,
    // Annotated `number` rather than inferred: TAG_LIMITS is `as const`, so the
    // default alone would narrow the parameter to the literal 50 and reject
    // every caller-supplied limit.
    limit: number = TAG_LIMITS.defaultListLimit,
  ): Promise<Tag[]> {
    await this.requireWorkspace(actor, workspaceId, false);
    return this.tags.list({ workspaceId, limit });
  }

  /** Renames or recolors a tag, compare-and-swap on its revision. */
  async updateTag(
    actor: ActorContext,
    workspaceId: string,
    tagId: string,
    expectedRevision: number,
    draft: TagDraft,
  ): Promise<Tag> {
    await this.requireWorkspace(actor, workspaceId, true);
    await this.requireTag(workspaceId, tagId);

    const data: {
      name?: string;
      normalizedName?: string;
      color?: string | null;
    } = {};
    if (draft.name !== undefined) {
      const name = validateTagName(draft.name);
      if (!name) throw new DomainError(`Tag name is required and must be at most ${TAG_LIMITS.maxNameLength} characters.`);
      data.name = name.name;
      data.normalizedName = name.normalizedName;
    }
    if (draft.color !== undefined) {
      const color = validateTagColor(draft.color);
      if (!color.ok) throw new DomainError("Tag color must be a #rrggbb hex triplet.");
      data.color = color.color;
    }

    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError("A valid tag revision is required.");
    }
    const updated = await this.tags.update(workspaceId, tagId, expectedRevision, data);
    // The repository reports a stale revision and a missing tag identically, so
    // this failure does not disclose which happened.
    if (!updated) throw new DomainError("The tag changed since it was loaded. Reload and retry.");

    this.logger.debug("Tag updated", { workspaceId, tagId });
    return updated;
  }

  /**
   * Deletes a tag and every assignment to it. A tag in active use is deleted
   * from the documents it labels rather than refused: keeping a tag that is
   * nowhere on screen while holding its assignments hostage is worse than
   * removing both together.
   */
  async deleteTag(actor: ActorContext, workspaceId: string, tagId: string): Promise<void> {
    await this.requireWorkspace(actor, workspaceId, true);
    await this.requireTag(workspaceId, tagId);
    await this.documentTags.removeAllForTag(workspaceId, tagId);
    await this.tags.delete(workspaceId, tagId);
    this.logger.debug("Tag deleted", { workspaceId, tagId });
  }

  /** Assigns a tag to a document. Re-assigning the pair is idempotent. */
  async assignTag(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    tagId: string,
  ): Promise<DocumentTag> {
    await this.requireWorkspace(actor, workspaceId, true);
    const tag = await this.requireTag(workspaceId, tagId);
    const document = await this.requireWritableDocument(workspaceId, documentId);

    const current = await this.documentTags.countForDocument(workspaceId, documentId);
    const assigned = await this.documentTags.isAssigned(workspaceId, documentId, tagId);
    if (!assigned && current >= TAG_LIMITS.maxTagsPerDocument) {
      throw new DomainError(`A document may carry at most ${TAG_LIMITS.maxTagsPerDocument} tags.`);
    }

    const assignment = await this.documentTags.assign({
      organizationId: document.organizationId,
      workspaceId,
      documentId,
      tagId: tag.id,
      assignedById: actor.userId,
    });

    this.logger.debug("Tag assigned to document", {
      workspaceId,
      documentId,
      tagId: tag.id,
    });
    return assignment;
  }

  /** Removes a tag from a document. Removing an unassigned pair is idempotent. */
  async removeTag(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    tagId: string,
  ): Promise<void> {
    await this.requireWorkspace(actor, workspaceId, true);
    await this.requireTag(workspaceId, tagId);
    await this.requireWritableDocument(workspaceId, documentId);
    await this.documentTags.remove(workspaceId, documentId, tagId);
    this.logger.debug("Tag removed from document", { workspaceId, documentId, tagId });
  }

  /** The tags on one document, resolved to Tag rows, Workspace-scoped. */
  async listDocumentTags(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<Tag[]> {
    await this.requireWorkspace(actor, workspaceId, false);
    const document = await this.documents.getById(workspaceId, documentId);
    // A document outside the Workspace is reported as missing, never forbidden.
    if (!document) throw new NotFoundError("Document not found in this workspace.");
    const assignments = await this.documentTags.listForDocument(workspaceId, documentId);
    return this.tags.getManyByIds(
      workspaceId,
      assignments.map((assignment) => assignment.tagId),
    );
  }

  /**
   * Bulk-assigns tags to documents. The batch is bounded and the outcome is
   * reported honestly: each document is assigned every tag, and a failure on one
   * document (missing, archived, or over its cap) leaves the others applied.
   */
  async bulkAssignTags(
    actor: ActorContext,
    workspaceId: string,
    input: BulkAssignInput,
  ): Promise<BulkTagOperationResult> {
    await this.requireWorkspace(actor, workspaceId, true);
    const tagIds = [...new Set(input.tagIds.map((id) => id.trim()))];
    const documentIds = [...new Set(input.documentIds.map((id) => id.trim()))];
    this.assertBulkBound(tagIds, documentIds);

    for (const tagId of tagIds) {
      if (!isBoundedId(tagId)) throw new DomainError("A tag id in the request is invalid.");
      await this.requireTag(workspaceId, tagId);
    }

    const succeeded: string[] = [];
    const failed: Array<{ documentId: string; error: string }> = [];
    for (const documentId of documentIds) {
      if (!isBoundedId(documentId)) {
        failed.push({ documentId, error: "Document id is invalid." });
        continue;
      }
      try {
        const document = await this.requireWritableDocument(workspaceId, documentId);
        const current = await this.documentTags.countForDocument(workspaceId, documentId);
        let toAdd = 0;
        for (const tagId of tagIds) {
          const already = await this.documentTags.isAssigned(workspaceId, documentId, tagId);
          if (!already) toAdd += 1;
        }
        if (current + toAdd > TAG_LIMITS.maxTagsPerDocument) {
          throw new DomainError(`A document may carry at most ${TAG_LIMITS.maxTagsPerDocument} tags.`);
        }
        for (const tagId of tagIds) {
          await this.documentTags.assign({
            organizationId: document.organizationId,
            workspaceId,
            documentId,
            tagId,
            assignedById: actor.userId,
          });
        }
        succeeded.push(documentId);
      } catch (error) {
        failed.push({
          documentId,
          error: error instanceof Error ? error.message : "Assignment failed.",
        });
      }
    }

    this.logger.debug("Bulk tag assignment", {
      workspaceId,
      tagIds,
      succeeded: succeeded.length,
      failed: failed.length,
    });
    return { tagIds, succeeded, failed };
  }

  /** Bulk-removes tags from documents, with the same honest per-document report. */
  async bulkRemoveTags(
    actor: ActorContext,
    workspaceId: string,
    input: BulkAssignInput,
  ): Promise<BulkTagOperationResult> {
    await this.requireWorkspace(actor, workspaceId, true);
    const tagIds = [...new Set(input.tagIds.map((id) => id.trim()))];
    const documentIds = [...new Set(input.documentIds.map((id) => id.trim()))];
    this.assertBulkBound(tagIds, documentIds);

    for (const tagId of tagIds) {
      if (!isBoundedId(tagId)) throw new DomainError("A tag id in the request is invalid.");
      await this.requireTag(workspaceId, tagId);
    }

    const succeeded: string[] = [];
    const failed: Array<{ documentId: string; error: string }> = [];
    for (const documentId of documentIds) {
      if (!isBoundedId(documentId)) {
        failed.push({ documentId, error: "Document id is invalid." });
        continue;
      }
      try {
        await this.requireWritableDocument(workspaceId, documentId);
        for (const tagId of tagIds) {
          await this.documentTags.remove(workspaceId, documentId, tagId);
        }
        succeeded.push(documentId);
      } catch (error) {
        failed.push({
          documentId,
          error: error instanceof Error ? error.message : "Removal failed.",
        });
      }
    }

    this.logger.debug("Bulk tag removal", {
      workspaceId,
      tagIds,
      succeeded: succeeded.length,
      failed: failed.length,
    });
    return { tagIds, succeeded, failed };
  }

  /** Creates a validated SmartCollection. The query is parsed, never stored raw. */
  async createSmartCollection(
    actor: ActorContext,
    workspaceId: string,
    draft: CollectionDraft,
  ): Promise<SmartCollection> {
    await this.requireWorkspace(actor, workspaceId, true);
    const name = validateCollectionName(draft.name);
    if (!name) throw new DomainError(`Collection name is required and must be at most ${C.maxNameLength} characters.`);
    const query = parseSmartCollectionQuery(draft.query);
    if (!query) throw new DomainError("The collection query is invalid or exceeds its bounds.");

    const { workspace } = await this.workspaces.get(actor, workspaceId, true);
    const collection = await this.collections.create({
      organizationId: workspace.organizationId,
      workspaceId,
      name: name.name,
      normalizedName: name.normalizedName,
      queryVersion: query.version,
      queryJson: JSON.stringify(query),
      createdById: actor.userId,
    });

    this.logger.debug("Smart collection created", {
      workspaceId,
      collectionId: collection.id,
      normalizedName: collection.normalizedName,
    });
    return collection;
  }

  /** Lists the Workspace's collections, bounded. */
  async listSmartCollections(
    actor: ActorContext,
    workspaceId: string,
    limit: number = C.defaultListLimit,
  ): Promise<SmartCollection[]> {
    await this.requireWorkspace(actor, workspaceId, false);
    return this.collections.list({ workspaceId, limit });
  }

  /** Updates a collection's name or query, compare-and-swap on its revision. */
  async updateSmartCollection(
    actor: ActorContext,
    workspaceId: string,
    collectionId: string,
    expectedRevision: number,
    draft: CollectionDraft,
  ): Promise<SmartCollection> {
    await this.requireWorkspace(actor, workspaceId, true);
    const collection = await this.collections.getById(workspaceId, collectionId);
    if (!collection) throw new NotFoundError("Collection not found.");

    const data: {
      name?: string;
      normalizedName?: string;
      queryVersion?: number;
      queryJson?: string;
    } = {};
    if (draft.name !== undefined) {
      const name = validateCollectionName(draft.name);
      if (!name) throw new DomainError(`Collection name is required and must be at most ${C.maxNameLength} characters.`);
      data.name = name.name;
      data.normalizedName = name.normalizedName;
    }
    if (draft.query !== undefined) {
      const query = parseSmartCollectionQuery(draft.query);
      if (!query) throw new DomainError("The collection query is invalid or exceeds its bounds.");
      data.queryVersion = query.version;
      data.queryJson = JSON.stringify(query);
    }

    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      throw new DomainError("A valid collection revision is required.");
    }
    const updated = await this.collections.update(
      workspaceId,
      collectionId,
      expectedRevision,
      data,
    );
    if (!updated) {
      throw new DomainError("The collection changed since it was loaded. Reload and retry.");
    }

    this.logger.debug("Smart collection updated", { workspaceId, collectionId });
    return updated;
  }

  /** Deletes a collection. Deleting the collection changes nothing else. */
  async deleteSmartCollection(
    actor: ActorContext,
    workspaceId: string,
    collectionId: string,
  ): Promise<void> {
    await this.requireWorkspace(actor, workspaceId, true);
    const collection = await this.collections.getById(workspaceId, collectionId);
    if (!collection) throw new NotFoundError("Collection not found.");
    await this.collections.delete(workspaceId, collectionId);
    this.logger.debug("Smart collection deleted", { workspaceId, collectionId });
  }

  /**
   * Evaluates a collection against live document and tag data.
   *
   * The definition is parsed through the allowlisted grammar; an unreadable
   * stored definition matches nothing. Matching documents are authorized by
   * construction — every document candidate is a row the actor's Workspace
   * membership already covers — so no accessible id can appear and no
   * inaccessible id can leak.
   */
  async evaluateSmartCollection(
    actor: ActorContext,
    workspaceId: string,
    collectionId: string,
    requestedLimit?: number,
  ): Promise<CollectionEvaluation> {
    await this.requireWorkspace(actor, workspaceId, false);
    const collection = await this.collections.getById(workspaceId, collectionId);
    if (!collection) throw new NotFoundError("Collection not found.");
    // A definition the adapter could not parse evaluates to nothing. Treating it
    // as "no filters" would turn an unreadable row into every document in the
    // Workspace, which is the opposite of failing closed.
    const documentIds = collection.queryDegraded
      ? []
      : await this.evaluateQuery(workspaceId, collection.query, requestedLimit);
    return { collection, documentIds, total: documentIds.length };
  }

  /** Evaluates a query draft without saving it — the preview the builder shows. */
  async previewSmartCollectionQuery(
    actor: ActorContext,
    workspaceId: string,
    query: unknown,
    requestedLimit?: number,
  ): Promise<{ documentIds: string[]; total: number }> {
    await this.requireWorkspace(actor, workspaceId, false);
    const parsed = parseSmartCollectionQuery(query);
    if (!parsed) throw new DomainError("The collection query is invalid or exceeds its bounds.");
    const documentIds = await this.evaluateQuery(workspaceId, parsed, requestedLimit);
    return { documentIds, total: documentIds.length };
  }

  /** The shared evaluation core, bounded and never wider than the cap. */
  private async evaluateQuery(
    workspaceId: string,
    query: SmartCollectionQuery,
    requestedLimit?: number,
  ): Promise<string[]> {
    const hasConditions = query.root.conditions.length > 0 || (query.root.groups?.length ?? 0) > 0;
    if (!hasConditions) return [];
    const limit = collectionResultLimit(requestedLimit, query);

    const listing = await this.documents.list({
      workspaceId,
      limit: 1000,
      sortBy: "name",
      sortOrder: "asc",
    });
    const documents = listing.items;
    if (documents.length === 0) return [];

    // Tag conditions resolve to document ids once, then every group matches
    // against that set rather than re-querying per document.
    const tagsByCondition = await this.resolveTagConditions(workspaceId, query);

    const matched = documents.filter((document) =>
      this.matchesGroup(document, query.root, tagsByCondition),
    );

    return this.orderAndSlice(matched, query)
      .slice(0, limit)
      .map((document) => document.id);
  }

  /** Resolves every "in: tags" condition to its current document-id set. */
  private async resolveTagConditions(
    workspaceId: string,
    query: SmartCollectionQuery,
  ): Promise<Map<CollectionCondition, Set<string>>> {
    const resolved = new Map<CollectionCondition, Set<string>>();
    const visit = async (group: CollectionGroup): Promise<void> => {
      for (const condition of group.conditions) {
        if (condition.field === "tags" && Array.isArray(condition.value)) {
          const ids = await this.documentTags.listDocumentIdsWithAllTags(
            workspaceId,
            condition.value,
            1000,
          );
          // Keyed by the parsed condition object itself: identical conditions
          // share an entry, and no two distinct conditions can collide.
          resolved.set(condition, new Set(ids));
        }
      }
      for (const nested of group.groups ?? []) await visit(nested);
    };
    await visit(query.root);
    return resolved;
  }

  private matchesGroup(
    document: DocumentRecord,
    group: CollectionGroup,
    tagsByCondition: Map<CollectionCondition, Set<string>>,
  ): boolean {
    const results = group.conditions.map((condition) =>
      this.matchesCondition(document, condition, tagsByCondition),
    );
    const nested = (group.groups ?? []).map((nestedGroup) =>
      this.matchesGroup(document, nestedGroup, tagsByCondition),
    );
    const combined = [...results, ...nested];
    return group.mode === "all"
      ? combined.every((result) => result)
      : combined.some((result) => result);
  }

  private matchesCondition(
    document: DocumentRecord,
    condition: CollectionCondition,
    tagsByCondition: Map<CollectionCondition, Set<string>>,
  ): boolean {
    switch (condition.field) {
      case "name": {
        if (condition.operator !== "contains") return false;
        return document.normalizedName.includes(String(condition.value).toLowerCase());
      }
      case "lifecycleState": {
        if (condition.operator !== "eq") return false;
        return document.lifecycleState === condition.value;
      }
      case "favorite": {
        if (condition.operator !== "eq") return false;
        return document.favorite === condition.value;
      }
      case "projectId": {
        if (condition.operator !== "eq") return false;
        return document.projectId === condition.value;
      }
      case "folderId": {
        if (condition.operator !== "eq") return false;
        return document.folderId === condition.value;
      }
      case "createdById": {
        if (condition.operator !== "eq") return false;
        return document.createdById === condition.value;
      }
      case "createdAt": {
        if (condition.operator !== "range") return false;
        return this.matchesRange(document.createdAt, condition.from, condition.to);
      }
      case "updatedAt": {
        if (condition.operator !== "range") return false;
        return this.matchesRange(document.updatedAt, condition.from, condition.to);
      }
      case "tags": {
        if (condition.operator !== "in" || !Array.isArray(condition.value)) return false;
        const matched = tagsByCondition.get(condition);
        return matched !== undefined && matched.has(document.id);
      }
      default:
        return false;
    }
  }

  private matchesRange(value: Date, from: string | undefined, to: string | undefined): boolean {
    const time = value.getTime();
    if (from !== undefined) {
      const fromTime = Date.parse(from);
      if (Number.isNaN(fromTime)) return false;
      if (time < fromTime) return false;
    }
    if (to !== undefined) {
      const toTime = Date.parse(to);
      if (Number.isNaN(toTime)) return false;
      if (time > toTime) return false;
    }
    return true;
  }

  private orderAndSlice(
    matched: DocumentRecord[],
    query: SmartCollectionQuery,
  ): DocumentRecord[] {
    const sort = query.sort ?? { field: "name" as const, order: "asc" as const };
    const ordered = [...matched];
    if (sort.field === "name") {
      ordered.sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));
    } else if (sort.field === "createdAt") {
      ordered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    } else {
      ordered.sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    }
    return sort.order === "asc" ? ordered : ordered.reverse();
  }
}
