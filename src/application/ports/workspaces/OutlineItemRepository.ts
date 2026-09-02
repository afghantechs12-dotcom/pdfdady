import type { MetadataOrigin, OutlineItem } from "@/src/domain/entities/DocumentMetadata";

export interface CreateOutlineItemInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  parentId: string | null;
  title: string;
  pageNumber: number;
  depth: number;
  orderKey: string;
  origin: MetadataOrigin;
  createdById: string;
}

export interface UpdateOutlineItemInput {
  title?: string;
  pageNumber?: number;
  parentId?: string | null;
  depth?: number;
  orderKey?: string;
}

export interface OutlineListQuery {
  workspaceId: string;
  documentId: string;
  /** Restricts to one origin, so an embedded outline can be shown on its own. */
  origin?: MetadataOrigin;
  limit: number;
}

/**
 * Outline items for a document.
 *
 * Holds both origins in one table because they form one tree in the UI and the
 * distinction is a column, not a schema: a `workspace` item is ours and
 * editable, an `embedded` item mirrors the PDF's own outline and is replaced
 * wholesale when the file is re-inspected, never edited in place.
 *
 * Every predicate carries `workspaceId`.
 */
export interface OutlineItemRepository {
  create(input: CreateOutlineItemInput): Promise<OutlineItem>;
  getById(workspaceId: string, outlineItemId: string): Promise<OutlineItem | null>;
  list(query: OutlineListQuery): Promise<OutlineItem[]>;
  /** Compare-and-swap update; null for both a stale revision and a missing row. */
  update(
    workspaceId: string,
    outlineItemId: string,
    expectedRevision: number,
    input: UpdateOutlineItemInput,
  ): Promise<OutlineItem | null>;
  delete(workspaceId: string, outlineItemId: string): Promise<boolean>;
  /**
   * Replaces every item of one origin for a document in a single transaction.
   * Used by inspection: a re-read of the PDF's outline must converge on the file
   * rather than accumulate a second copy beside the first.
   */
  replaceForDocument(
    workspaceId: string,
    documentId: string,
    origin: MetadataOrigin,
    items: CreateOutlineItemInput[],
  ): Promise<OutlineItem[]>;
  /** Direct children of one item, for an incremental tree expansion. */
  listChildren(workspaceId: string, parentId: string): Promise<OutlineItem[]>;
  /**
   * Removes every descendant of one item, not the item itself.
   *
   * Belongs here rather than in the service because it is one atomic statement
   * over a set the database can compute: deleting a subtree row-by-row from
   * application code leaves a half-removed chapter behind if it fails midway.
   * The walk is bounded to the named document, so a parent link that points
   * outside it cannot pull unrelated rows into the deletion.
   */
  deleteDescendants(
    workspaceId: string,
    documentId: string,
    outlineItemId: string,
  ): Promise<number>;
  deleteForDocument(workspaceId: string, documentId: string): Promise<number>;
  countForDocument(workspaceId: string, documentId: string, origin?: MetadataOrigin): Promise<number>;
  lastOrderKey(
    workspaceId: string,
    documentId: string,
    parentId: string | null,
  ): Promise<string | null>;
}
