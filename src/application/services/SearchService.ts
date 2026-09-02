import { createHash } from "node:crypto";
import type { ILogger } from "@/src/application/ports/Logger";
import type { ActorContext, WorkspaceService } from "./WorkspaceService";
import type { DocumentRecordRepository } from "@/src/application/ports/workspaces/DocumentRecordRepository";
import type { SearchDocumentRepository } from "@/src/application/ports/workspaces/SearchDocumentRepository";
import type {
  CreateSearchChunkInput,
  SearchChunkRepository,
} from "@/src/application/ports/workspaces/SearchChunkRepository";
import type { SearchIndexPort } from "@/src/application/ports/workspaces/SearchIndexPort";
import type {
  ChunkSourceType,
  SearchChunk,
  SearchDocument,
  SearchHit,
  SearchIndexState,
} from "@/src/domain/entities/SearchIndex";
import {
  SEARCH_LIMITS,
  buildSnippet,
  chunkText,
  isBoundedSearchId,
  isChunkSourceType,
  normalizeSearchText,
  parseSearchQuery,
  searchResultLimit,
} from "@/src/domain/entities/SearchIndex";
import type { DocumentRecord, DocumentRecordLifecycleState } from "@/src/domain/entities/DocumentRecord";
import { DomainError, NotFoundError } from "@/src/domain/errors";

export interface SearchServiceOptions {
  /** Most documents one eligibility sweep will consider. */
  maxCandidateDocuments?: number;
}

/** One unit of extracted content offered for indexing. */
export interface IndexSourceSegment {
  sourceType: ChunkSourceType;
  pageNumber?: number | null;
  text: string;
}

export interface IndexDocumentInput {
  documentId: string;
  versionId?: string | null;
  segments: IndexSourceSegment[];
}

export interface SearchFilters {
  lifecycleState?: DocumentRecordLifecycleState;
  favorite?: boolean;
  projectId?: string;
  folderId?: string;
  createdById?: string;
}

export interface SearchRequest {
  query: unknown;
  filters?: SearchFilters;
  limit?: number;
  cursor?: string;
}

export interface SearchResults {
  /** The query as accepted, for echoing back to the client. */
  query: string;
  /** True when the query exceeded its term bounds and was narrowed. */
  truncated: boolean;
  hits: SearchHit[];
  /** How many eligible documents matched, capped by the result bound. */
  totalCount: number;
  /** Opaque cursor for the next page, or null when the last page was returned. */
  nextCursor: string | null;
}

export interface SearchStatistics {
  indexedDocuments: number;
  staleDocuments: number;
  failedDocuments: number;
  totalChunks: number;
  lastIndexedAt: Date | null;
}

/**
 * M7.8 workspace search and indexing.
 *
 * The order of operations is the security property: authorization narrows to a
 * set of eligible DocumentRecords *first*, and only then may chunks be
 * consulted. Every count, snippet, facet and existence signal is derived from
 * that eligible set, so no index row can reveal a document the actor cannot
 * already see (ADR-M7-008, threat model "Search leakage").
 *
 * Queries are tokenized into bounded literal terms, never compiled into a
 * pattern, so no input can describe catastrophic backtracking. Highlights are
 * returned as offset ranges rather than markup, so indexed document text cannot
 * become document structure in a client.
 *
 * Index state is honest about itself: an entry behind the document it describes
 * is reported `stale` rather than presented as current, and a failed extraction
 * is `failed` rather than quietly empty.
 */
export class SearchService {
  private readonly maxCandidateDocuments: number;

  constructor(
    private readonly logger: ILogger,
    private readonly workspaces: WorkspaceService,
    private readonly documents: DocumentRecordRepository,
    private readonly searchDocuments: SearchDocumentRepository,
    private readonly chunks: SearchChunkRepository,
    private readonly searchIndex: SearchIndexPort,
    options: SearchServiceOptions = {},
  ) {
    const requested = options.maxCandidateDocuments ?? SEARCH_LIMITS.maxCandidateDocuments;
    this.maxCandidateDocuments =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, SEARCH_LIMITS.maxCandidateDocuments)
        : SEARCH_LIMITS.maxCandidateDocuments;
  }

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
    if (!isBoundedSearchId(documentId)) {
      throw new DomainError("A valid document id is required.");
    }
    const document = await this.documents.getById(workspaceId, documentId);
    if (!document) throw new NotFoundError("Document not found in this workspace.");
    return document;
  }

  /**
   * Indexes a document's extracted content.
   *
   * The checksum is computed over the normalized segment content, so a reindex
   * of unchanged content is detectable and need not rewrite chunks. Indexing
   * moves the entry through `indexing` before `indexed`: a crash mid-pass leaves
   * a state that says so rather than one that claims success.
   */
  async indexDocument(
    actor: ActorContext,
    workspaceId: string,
    input: IndexDocumentInput,
  ): Promise<SearchDocument> {
    const { organizationId } = await this.requireWorkspace(actor, workspaceId, true);
    const document = await this.requireDocument(workspaceId, input.documentId);

    if (!Array.isArray(input.segments)) {
      throw new DomainError("Index input must carry a list of segments.");
    }
    for (const segment of input.segments) {
      if (!isChunkSourceType(segment.sourceType)) {
        throw new DomainError("A segment names an unknown source type.");
      }
    }

    const versionId = input.versionId ?? document.currentVersionId ?? null;
    if (versionId !== null && !isBoundedSearchId(versionId)) {
      throw new DomainError("A valid version id is required.");
    }

    const prepared = this.prepareChunks(input.segments);
    const checksum = this.checksumFor(prepared);

    const entry = await this.searchDocuments.upsert({
      organizationId,
      workspaceId,
      documentId: document.id,
      versionId,
      state: "indexing",
      schemaVersion: SEARCH_LIMITS.schemaVersion,
      checksum,
      error: null,
    });

    try {
      const chunkInputs: CreateSearchChunkInput[] = prepared.map((chunk, index) => ({
        organizationId,
        workspaceId,
        searchDocumentId: entry.id,
        documentId: document.id,
        ordinal: index,
        sourceType: chunk.sourceType,
        pageNumber: chunk.pageNumber,
        text: chunk.text,
        normalizedText: chunk.normalizedText,
      }));
      const written = await this.chunks.replaceForDocument(workspaceId, entry.id, chunkInputs);
      const indexed = await this.searchDocuments.markIndexed(
        workspaceId,
        entry.id,
        written.length,
        checksum,
      );
      if (!indexed) throw new DomainError("The index entry changed while indexing.");

      this.logger.debug("Indexed document for search", {
        workspaceId,
        documentId: document.id,
        chunkCount: written.length,
      });
      return indexed;
    } catch (error) {
      // A failed pass is recorded as failed, with a bounded reason. Leaving it
      // as "indexing" would make a broken extractor indistinguishable from one
      // still running, and leaving it "indexed" would be a lie.
      const message = error instanceof Error ? error.message : "Indexing failed.";
      await this.searchDocuments.setState(
        workspaceId,
        entry.id,
        entry.revision,
        "failed",
        message.slice(0, SEARCH_LIMITS.maxErrorLength),
      );
      this.logger.error("Search indexing failed", {
        workspaceId,
        documentId: document.id,
        reason: message,
      });
      throw error;
    }
  }

  /** Splits segments into bounded, normalized, page-aware chunks. */
  private prepareChunks(segments: IndexSourceSegment[]): Array<{
    sourceType: ChunkSourceType;
    pageNumber: number | null;
    text: string;
    normalizedText: string;
  }> {
    const prepared: Array<{
      sourceType: ChunkSourceType;
      pageNumber: number | null;
      text: string;
      normalizedText: string;
    }> = [];
    for (const segment of segments) {
      if (typeof segment.text !== "string") continue;
      const pageNumber =
        segment.pageNumber === undefined ||
        segment.pageNumber === null ||
        !Number.isFinite(segment.pageNumber) ||
        segment.pageNumber < 1
          ? null
          : Math.trunc(segment.pageNumber);
      for (const text of chunkText(segment.text)) {
        if (prepared.length >= SEARCH_LIMITS.maxChunksPerDocument) return prepared;
        const normalizedText = normalizeSearchText(text);
        // A segment that normalizes to nothing carries no searchable content;
        // storing it would inflate the chunk count without affecting any result.
        if (!normalizedText) continue;
        prepared.push({ sourceType: segment.sourceType, pageNumber, text, normalizedText });
      }
    }
    return prepared;
  }

  /** Deterministic checksum over the normalized content actually indexed. */
  private checksumFor(
    prepared: Array<{ sourceType: string; pageNumber: number | null; normalizedText: string }>,
  ): string {
    const separator = String.fromCharCode(0);
    const hash = createHash("sha256");
    hash.update(String(SEARCH_LIMITS.schemaVersion));
    for (const chunk of prepared) {
      hash.update(separator);
      hash.update(chunk.sourceType);
      hash.update(separator);
      hash.update(chunk.pageNumber === null ? "-" : String(chunk.pageNumber));
      hash.update(separator);
      hash.update(chunk.normalizedText);
    }
    return hash.digest("hex");
  }

  /**
   * Searches the Workspace.
   *
   * Eligibility is resolved from real DocumentRecords before any chunk is read,
   * and results are then assembled only for documents in that set — so a chunk
   * belonging to a document the actor cannot see can neither appear nor be
   * counted.
   */
  async search(
    actor: ActorContext,
    workspaceId: string,
    request: SearchRequest,
  ): Promise<SearchResults> {
    await this.requireWorkspace(actor, workspaceId, false);

    const parsed = parseSearchQuery(request.query);
    if (!parsed) {
      throw new DomainError(
        `Enter a search term of at least ${SEARCH_LIMITS.minTermLength} characters.`,
      );
    }

    const limit = searchResultLimit(request.limit);
    const offset = this.decodeCursor(request.cursor);

    // 1. Authorization first: the eligible set is what the actor may see.
    const eligible = await this.eligibleDocuments(workspaceId, request.filters);
    if (eligible.size === 0) {
      return { query: parsed.raw, truncated: parsed.truncated, hits: [], totalCount: 0, nextCursor: null };
    }

    // 2. Only now may chunks be consulted, and only those of eligible documents.
    const matched = await this.searchIndex.searchChunks(
      workspaceId,
      parsed.terms,
      SEARCH_LIMITS.maxCandidateDocuments,
    );
    const byDocument = new Map<string, SearchChunk[]>();
    for (const chunk of matched) {
      if (!eligible.has(chunk.documentId)) continue;
      const existing = byDocument.get(chunk.documentId);
      if (existing) existing.push(chunk);
      else byDocument.set(chunk.documentId, [chunk]);
    }
    if (byDocument.size === 0) {
      return { query: parsed.raw, truncated: parsed.truncated, hits: [], totalCount: 0, nextCursor: null };
    }

    const entries = await this.searchDocuments.listForDocuments(workspaceId, [
      ...byDocument.keys(),
    ]);
    const entryByDocument = new Map(entries.map((entry) => [entry.documentId, entry]));

    const scored: SearchHit[] = [];
    for (const [documentId, documentChunks] of byDocument) {
      const document = eligible.get(documentId);
      if (!document) continue;
      const entry = entryByDocument.get(documentId);
      const hit = this.assembleHit(document, documentChunks, entry, parsed.terms);
      if (hit) scored.push(hit);
    }

    scored.sort(
      (a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId),
    );

    // Pagination is deterministic because the ordering is total: score first,
    // then document id as a tie-break, so the same query returns the same page.
    const page = scored.slice(offset, offset + limit);
    const consumed = offset + page.length;
    const nextCursor = consumed < scored.length ? this.encodeCursor(consumed) : null;

    this.logger.debug("Performed workspace search", {
      workspaceId,
      terms: parsed.terms.length,
      eligible: eligible.size,
      hits: scored.length,
    });

    return {
      query: parsed.raw,
      truncated: parsed.truncated,
      hits: page,
      totalCount: scored.length,
      nextCursor,
    };
  }

  /**
   * The documents the actor may see, after filters.
   *
   * Trashed documents are excluded unless explicitly asked for: a search that
   * silently surfaces deleted content reads as a leak even when the actor is
   * entitled to it.
   */
  private async eligibleDocuments(
    workspaceId: string,
    filters?: SearchFilters,
  ): Promise<Map<string, DocumentRecord>> {
    for (const key of ["projectId", "folderId", "createdById"] as const) {
      const value = filters?.[key];
      if (value !== undefined && !isBoundedSearchId(value)) {
        throw new DomainError(`The ${key} filter is invalid.`);
      }
    }

    const listing = await this.documents.list({
      workspaceId,
      limit: this.maxCandidateDocuments,
      sortBy: "updatedAt",
      sortOrder: "desc",
    });

    const eligible = new Map<string, DocumentRecord>();
    for (const document of listing.items) {
      if (filters?.lifecycleState === undefined) {
        if (document.lifecycleState === "trashed") continue;
      } else if (document.lifecycleState !== filters.lifecycleState) {
        continue;
      }
      if (filters?.favorite !== undefined && document.favorite !== filters.favorite) continue;
      if (filters?.projectId !== undefined && document.projectId !== filters.projectId) continue;
      if (filters?.folderId !== undefined && document.folderId !== filters.folderId) continue;
      if (filters?.createdById !== undefined && document.createdById !== filters.createdById) {
        continue;
      }
      eligible.set(document.id, document);
    }
    return eligible;
  }

  /** Builds one hit: snippets, pages, staleness and a relative score. */
  private assembleHit(
    document: DocumentRecord,
    documentChunks: SearchChunk[],
    entry: SearchDocument | undefined,
    terms: string[],
  ): SearchHit | null {
    const ordered = [...documentChunks].sort((a, b) => a.ordinal - b.ordinal);
    const snippets = [];
    for (const chunk of ordered) {
      const snippet = buildSnippet(chunk, terms);
      if (snippet) snippets.push(snippet);
      if (snippets.length >= SEARCH_LIMITS.maxSnippetsPerResult) break;
    }
    // A document whose chunks matched the term filter but yields no snippet has
    // nothing to show for itself; returning it would be a result the user cannot
    // interpret.
    if (snippets.length === 0) return null;

    const pageNumbers = [
      ...new Set(
        ordered
          .map((chunk) => chunk.pageNumber)
          .filter((page): page is number => page !== null),
      ),
    ].sort((a, b) => a - b);

    // Score is deliberately simple and *relative*: how many distinct terms the
    // document matched, then how many chunks matched, normalized. It ranks
    // within one result set and is not comparable across queries — presenting it
    // as a similarity measure would overstate what it knows.
    const distinctTerms = new Set<string>();
    for (const chunk of ordered) {
      for (const term of terms) {
        if (chunk.normalizedText.includes(term)) distinctTerms.add(term);
      }
    }
    const coverage = distinctTerms.size / terms.length;
    const density = Math.min(1, ordered.length / 10);
    const score = Math.round((coverage * 0.8 + density * 0.2) * 1000) / 1000;

    // Stale when the index entry describes a version other than the document's
    // current one, or when its state says so.
    const stale =
      entry === undefined ||
      entry.state === "stale" ||
      entry.state === "failed" ||
      entry.schemaVersion !== SEARCH_LIMITS.schemaVersion ||
      (document.currentVersionId !== null && entry.versionId !== document.currentVersionId);

    return {
      documentId: document.id,
      versionId: entry?.versionId ?? document.currentVersionId,
      score,
      snippets,
      pageNumbers,
      stale,
    };
  }

  /**
   * Cursors are opaque offsets, not encoded predicates: a client cannot widen a
   * read by editing one, because the offset is re-applied to a result set the
   * server just authorized.
   */
  private encodeCursor(offset: number): string {
    return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string | undefined): number {
    if (cursor === undefined) return 0;
    if (cursor.length > 128) throw new DomainError("The pagination cursor is invalid.");
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      throw new DomainError("The pagination cursor is invalid.");
    }
    const match = /^o:(\d{1,6})$/u.exec(decoded);
    if (!match) throw new DomainError("The pagination cursor is invalid.");
    const offset = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new DomainError("The pagination cursor is invalid.");
    }
    return offset;
  }

  /** The index entry for one document, or null when it has never been indexed. */
  async getIndexStatus(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<SearchDocument | null> {
    await this.requireWorkspace(actor, workspaceId, false);
    // The document is resolved first, so a status read cannot confirm the
    // existence of a document the actor cannot see.
    await this.requireDocument(workspaceId, documentId);
    return this.searchDocuments.getByDocumentId(workspaceId, documentId);
  }

  /** The chunks of one document, bounded — used by diagnostics and reindex UI. */
  async listChunks(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
    limit?: number,
  ): Promise<SearchChunk[]> {
    await this.requireWorkspace(actor, workspaceId, false);
    await this.requireDocument(workspaceId, documentId);
    return this.chunks.listForDocument(workspaceId, documentId, limit);
  }

  /**
   * Marks a document's entry stale.
   *
   * Called when content moves on — a new version, a restore — so the entry
   * advertises that it is behind instead of serving results as though current.
   * Absence of an entry is not an error: a document that was never indexed is
   * already not claiming to be current.
   */
  async markStale(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<SearchDocument | null> {
    await this.requireWorkspace(actor, workspaceId, true);
    await this.requireDocument(workspaceId, documentId);
    const entry = await this.searchDocuments.getByDocumentId(workspaceId, documentId);
    if (!entry) return null;
    const updated = await this.searchDocuments.setState(
      workspaceId,
      entry.id,
      entry.revision,
      "stale",
    );
    if (!updated) {
      throw new DomainError("The index entry changed since it was loaded. Reload and retry.");
    }
    this.logger.debug("Marked search entry stale", { workspaceId, documentId });
    return updated;
  }

  /**
   * Queues a reindex by moving the entry to `pending`.
   *
   * The service does not re-extract bytes itself: extraction is the caller's or
   * a job's responsibility, and claiming to have reindexed without new content
   * would be the same fabrication this phase replaced.
   */
  async requestReindex(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<SearchDocument> {
    const { organizationId } = await this.requireWorkspace(actor, workspaceId, true);
    const document = await this.requireDocument(workspaceId, documentId);

    const existing = await this.searchDocuments.getByDocumentId(workspaceId, documentId);
    if (existing) {
      const updated = await this.searchDocuments.setState(
        workspaceId,
        existing.id,
        existing.revision,
        "pending",
        null,
      );
      if (!updated) {
        throw new DomainError("The index entry changed since it was loaded. Reload and retry.");
      }
      this.logger.debug("Reindex requested", { workspaceId, documentId });
      return updated;
    }

    // No entry yet: create one in `pending` so the document is visibly queued
    // rather than silently absent from the index.
    const created = await this.searchDocuments.upsert({
      organizationId,
      workspaceId,
      documentId: document.id,
      versionId: document.currentVersionId,
      state: "pending",
      schemaVersion: SEARCH_LIMITS.schemaVersion,
      checksum: "",
      error: null,
    });
    this.logger.debug("Reindex requested for unindexed document", { workspaceId, documentId });
    return created;
  }

  /** Removes a document from the index entirely, entry and chunks together. */
  async removeFromIndex(
    actor: ActorContext,
    workspaceId: string,
    documentId: string,
  ): Promise<void> {
    await this.requireWorkspace(actor, workspaceId, true);
    if (!isBoundedSearchId(documentId)) {
      throw new DomainError("A valid document id is required.");
    }
    // Deliberately does not require the document to still exist: removal is
    // exactly what must work after a document is deleted, and refusing then
    // would leave its content searchable.
    await this.chunks.deleteForDocument(workspaceId, documentId);
    await this.searchDocuments.delete(workspaceId, documentId);
    this.logger.debug("Removed document from search index", { workspaceId, documentId });
  }

  /** Lists index entries in a given state — the reindex queue and error views. */
  async listByState(
    actor: ActorContext,
    workspaceId: string,
    state: SearchIndexState,
    limit = 100,
  ): Promise<SearchDocument[]> {
    await this.requireWorkspace(actor, workspaceId, false);
    return this.searchDocuments.list({ workspaceId, state, limit });
  }

  /** Index health for the Workspace. */
  async getStatistics(
    actor: ActorContext,
    workspaceId: string,
  ): Promise<SearchStatistics> {
    await this.requireWorkspace(actor, workspaceId, false);
    const [indexedDocuments, staleDocuments, failedDocuments, totalChunks, lastIndexedAt] =
      await Promise.all([
        this.searchDocuments.countForWorkspace(workspaceId, "indexed"),
        this.searchDocuments.countForWorkspace(workspaceId, "stale"),
        this.searchDocuments.countForWorkspace(workspaceId, "failed"),
        this.chunks.countForWorkspace(workspaceId),
        this.searchDocuments.lastIndexedAt(workspaceId),
      ]);
    return { indexedDocuments, staleDocuments, failedDocuments, totalChunks, lastIndexedAt };
  }
}
