import type { DocumentTag } from "@/src/domain/entities/Tag";

export interface AssignDocumentTagInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  tagId: string;
  assignedById: string;
}

/**
 * Workspace-scoped document/tag assignments.
 *
 * The assignment row carries its own `workspaceId`, so every predicate here is
 * Workspace-scoped without a join. A caller cannot express a cross-Workspace
 * assignment through this port: the workspace is a parameter, not something
 * derived from whichever document or tag id was passed.
 */
export interface DocumentTagRepository {
  /**
   * Assigns a tag to a document, idempotently. Re-assigning an existing pair
   * returns the existing row rather than inserting a second one or failing —
   * a user clicking "add tag" twice has expressed the same intent twice, not
   * an error.
   */
  assign(input: AssignDocumentTagInput): Promise<DocumentTag>;

  /**
   * Removes an assignment. Returns false when there was nothing to remove,
   * which callers treat as success: removal is idempotent.
   */
  remove(workspaceId: string, documentId: string, tagId: string): Promise<boolean>;

  /** Whether a document currently carries a tag. */
  isAssigned(workspaceId: string, documentId: string, tagId: string): Promise<boolean>;

  /** Every assignment for one document, bounded by the per-document cap. */
  listForDocument(workspaceId: string, documentId: string): Promise<DocumentTag[]>;

  /**
   * Document ids carrying *all* of the named tags. Used by collection
   * evaluation; the "all" semantics are the repository's job because doing it
   * in the service would mean reading every assignment in the Workspace.
   */
  listDocumentIdsWithAllTags(
    workspaceId: string,
    tagIds: string[],
    limit: number,
  ): Promise<string[]>;

  /** Assignments for several documents at once, for tag chips in a listing. */
  listForDocuments(workspaceId: string, documentIds: string[]): Promise<DocumentTag[]>;

  /** How many documents carry a tag. Guards deletion and drives counts in UI. */
  countForTag(workspaceId: string, tagId: string): Promise<number>;

  /** How many tags a document carries. Enforces the per-document cap. */
  countForDocument(workspaceId: string, documentId: string): Promise<number>;

  /** Removes every assignment of a tag, so deleting a tag leaves no orphans. */
  removeAllForTag(workspaceId: string, tagId: string): Promise<number>;
}
