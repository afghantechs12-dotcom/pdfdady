import type { WorkspaceBookmark } from "@/src/domain/entities/DocumentMetadata";

export interface CreateBookmarkInput {
  organizationId: string;
  workspaceId: string;
  documentId: string;
  pageNumber: number;
  title: string;
  note: string | null;
  anchor: { x: number; y: number } | null;
  orderKey: string;
  createdById: string;
}

export interface UpdateBookmarkInput {
  pageNumber?: number;
  title?: string;
  note?: string | null;
  anchor?: { x: number; y: number } | null;
  orderKey?: string;
}

export interface BookmarkListQuery {
  workspaceId: string;
  documentId: string;
  /** Restricts to one page, for a per-page marker gutter. */
  pageNumber?: number;
  limit: number;
}

/**
 * Workspace bookmarks — the user's own page markers.
 *
 * Distinct from the PDF's embedded outline, which is a projection of the file
 * and lives in `OutlineItemRepository` with `origin: "embedded"`. A bookmark is
 * ours, editable, and belongs to the Workspace rather than to the bytes.
 *
 * Every predicate carries `workspaceId`, so a bookmark addressed from another
 * Workspace reads as missing.
 */
export interface BookmarkRepository {
  create(input: CreateBookmarkInput): Promise<WorkspaceBookmark>;
  getById(workspaceId: string, bookmarkId: string): Promise<WorkspaceBookmark | null>;
  list(query: BookmarkListQuery): Promise<WorkspaceBookmark[]>;
  /**
   * Compare-and-swap update. Returns null for both a stale revision and a
   * missing row, so neither discloses the other.
   */
  update(
    workspaceId: string,
    bookmarkId: string,
    expectedRevision: number,
    input: UpdateBookmarkInput,
  ): Promise<WorkspaceBookmark | null>;
  delete(workspaceId: string, bookmarkId: string): Promise<boolean>;
  /** Removes every bookmark of one document, returning how many. */
  deleteForDocument(workspaceId: string, documentId: string): Promise<number>;
  countForDocument(workspaceId: string, documentId: string): Promise<number>;
  /** Highest existing order key in the document, for appending. */
  lastOrderKey(workspaceId: string, documentId: string): Promise<string | null>;
}
