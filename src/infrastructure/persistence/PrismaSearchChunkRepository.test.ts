import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaSearchChunkRepository } from "./PrismaSearchChunkRepository";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

/**
 * Row-backed stand-in for the `searchChunk` delegate.
 *
 * `contains` is implemented as a plain `String.includes`, never as a compiled
 * pattern — which is exactly the property the adapter relies on. If a future
 * change passed a caller's text somewhere that treats it as a regex, the
 * regex-looking-term tests below would start matching text they should not.
 *
 * The fake enforces the real (searchDocumentId, ordinal) unique key and honours
 * only the predicates the adapter sends, so an omitted `workspaceId` surfaces as
 * a cross-Workspace row rather than as a passing test.
 */
interface Row {
  id: string;
  organizationId: string;
  workspaceId: string;
  searchDocumentId: string;
  documentId: string;
  ordinal: number;
  sourceType: string;
  pageNumber: number | null;
  text: string;
  normalizedText: string;
  createdAt: Date;
}

type Where = Record<string, unknown>;

/** Evaluates one field predicate: equality or a bounded `contains` substring. */
function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as { contains?: string; in?: string[] };
    if ("contains" in ops) {
      // Literal substring, exactly as SQLite's LIKE-with-bound-parameter behaves.
      return typeof actual === "string" && actual.includes(String(ops.contains));
    }
    if ("in" in ops) return Array.isArray(ops.in) && ops.in.includes(actual as string);
    return false;
  }
  return actual === expected;
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") {
      const clauses = Array.isArray(value) ? (value as Where[]) : [value as Where];
      return clauses.every((clause) => matches(row, clause));
    }
    return matchValue(row[key as keyof Row], value);
  });
}

function uniqueViolation(searchDocumentId: string, ordinal: number): Error {
  const error = new Error(
    `Unique constraint failed on the fields: (\`searchDocumentId\`,\`ordinal\`) ` +
      `for ${searchDocumentId}/${ordinal}`,
  );
  (error as Error & { code: string }).code = "P2002";
  return error;
}

function fakePrisma(rows: Row[]) {
  let seq = 0;
  const calls = { transactions: 0, creates: 0, deleteManys: 0 };

  const delegate = {
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where: Where;
      orderBy?: Array<Record<string, "asc">> | Record<string, "asc">;
      take?: number;
    }) {
      const found = rows.filter((r) => matches(r, where));
      // Sorts only on the keys the adapter actually named, in the order it named
      // them — an adapter that forgets `orderBy` gets insertion order, not luck.
      const clauses = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
      if (clauses.length > 0) {
        found.sort((a, b) => {
          for (const clause of clauses) {
            for (const [key, direction] of Object.entries(clause)) {
              const left = a[key as keyof Row];
              const right = b[key as keyof Row];
              const delta =
                typeof left === "number" && typeof right === "number"
                  ? left - right
                  : String(left).localeCompare(String(right));
              if (delta !== 0) return direction === "asc" ? delta : -delta;
            }
          }
          return 0;
        });
      }
      return take === undefined ? found : found.slice(0, take);
    },
    async create({ data }: { data: Partial<Row> }) {
      calls.creates += 1;
      if (
        rows.some(
          (r) => r.searchDocumentId === data.searchDocumentId && r.ordinal === data.ordinal,
        )
      ) {
        throw uniqueViolation(String(data.searchDocumentId), Number(data.ordinal));
      }
      seq += 1;
      const created: Row = {
        id: `chunk-${seq}`,
        organizationId: String(data.organizationId),
        workspaceId: String(data.workspaceId),
        searchDocumentId: String(data.searchDocumentId),
        documentId: String(data.documentId),
        ordinal: Number(data.ordinal),
        sourceType: String(data.sourceType ?? "text"),
        pageNumber: data.pageNumber ?? null,
        text: String(data.text ?? ""),
        normalizedText: String(data.normalizedText ?? ""),
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
      };
      rows.push(created);
      return created;
    },
    async deleteMany({ where }: { where: Where }) {
      calls.deleteManys += 1;
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    },
    async count({ where }: { where: Where }) {
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  const client = {
    rows,
    calls,
    searchChunk: delegate,
    async $transaction<T>(fn: (tx: { searchChunk: typeof delegate }) => Promise<T>): Promise<T> {
      calls.transactions += 1;
      return fn({ searchChunk: delegate });
    },
  };

  return client;
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaSearchChunkRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "chunk-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    searchDocumentId: "sd-1",
    documentId: "doc-1",
    ordinal: 0,
    sourceType: "text",
    pageNumber: 1,
    text: "The quarterly contract for 2026",
    normalizedText: "the quarterly contract for 2026",
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    ...overrides,
  };
}

function chunkInput(overrides: Partial<Row> = {}) {
  const base = row(overrides);
  return {
    organizationId: base.organizationId,
    workspaceId: base.workspaceId,
    searchDocumentId: base.searchDocumentId,
    documentId: base.documentId,
    ordinal: base.ordinal,
    sourceType: base.sourceType as "text",
    pageNumber: base.pageNumber,
    text: base.text,
    normalizedText: base.normalizedText,
  };
}

describe("PrismaSearchChunkRepository — replaceForDocument", () => {
  it("deletes the old chunks and inserts the new ones", async () => {
    const { subject, prisma } = repo([row({ id: "old", ordinal: 0, text: "stale content" })]);

    const written = await subject.replaceForDocument("ws-a", "sd-1", [
      chunkInput({ ordinal: 0, text: "fresh one", normalizedText: "fresh one" }),
      chunkInput({ ordinal: 1, text: "fresh two", normalizedText: "fresh two" }),
    ]);

    expect(written).toHaveLength(2);
    expect(prisma.rows.map((r) => r.text)).toEqual(["fresh one", "fresh two"]);
    expect(prisma.rows.some((r) => r.id === "old")).toBe(false);
  });

  it("performs the replacement inside a single transaction", async () => {
    const { subject, prisma } = repo([row({ id: "old" })]);
    await subject.replaceForDocument("ws-a", "sd-1", [chunkInput({ ordinal: 0 })]);
    // Delete-then-insert must be atomic, or a failed reindex leaves a document
    // indexed under a mix of two versions' content.
    expect(prisma.calls.transactions).toBe(1);
  });

  it("scopes the replacement to the Workspace and leaves another Workspace untouched", async () => {
    // The foreign row sits at a different ordinal: (searchDocumentId, ordinal)
    // is globally unique, so two Workspaces sharing one searchDocumentId *and*
    // ordinal is a state the database cannot hold. What is being tested is that
    // the delete predicate carries workspaceId, not that the key is shareable.
    const { subject, prisma } = repo([
      row({ id: "mine", workspaceId: "ws-a", searchDocumentId: "sd-1", ordinal: 0 }),
      row({ id: "theirs", workspaceId: "ws-b", searchDocumentId: "sd-1", ordinal: 1 }),
    ]);

    await subject.replaceForDocument("ws-a", "sd-1", [
      chunkInput({ ordinal: 0, text: "replaced", normalizedText: "replaced" }),
    ]);

    // The ws-b row must survive a ws-a replacement.
    expect(prisma.rows.some((r) => r.id === "theirs")).toBe(true);
    expect(prisma.rows.some((r) => r.id === "mine")).toBe(false);
  });

  it("rejects a duplicate ordinal within one replacement", async () => {
    const { subject } = repo();
    await expect(
      subject.replaceForDocument("ws-a", "sd-1", [
        chunkInput({ ordinal: 0, text: "first" }),
        chunkInput({ ordinal: 0, text: "second" }),
      ]),
    ).rejects.toThrow(/Unique constraint/u);
  });

  it("enforces the maximum chunks per document", async () => {
    const { subject, prisma } = repo();
    const inputs = Array.from({ length: SEARCH_LIMITS.maxChunksPerDocument + 25 }, (_, i) =>
      chunkInput({ ordinal: i, text: `chunk ${i}`, normalizedText: `chunk ${i}` }),
    );

    await subject.replaceForDocument("ws-a", "sd-1", inputs);

    expect(prisma.rows).toHaveLength(SEARCH_LIMITS.maxChunksPerDocument);
  });

  it("bounds text and normalized text on write", async () => {
    const { subject, prisma } = repo();
    await subject.replaceForDocument("ws-a", "sd-1", [
      chunkInput({
        ordinal: 0,
        text: "t".repeat(SEARCH_LIMITS.maxChunkTextLength + 500),
        normalizedText: "n".repeat(SEARCH_LIMITS.maxChunkTextLength + 500),
      }),
    ]);

    expect(prisma.rows[0].text.length).toBe(SEARCH_LIMITS.maxChunkTextLength);
    expect(prisma.rows[0].normalizedText.length).toBe(SEARCH_LIMITS.maxChunkTextLength);
  });

  it("returns the written chunks ordered by ordinal", async () => {
    const { subject } = repo();
    const written = await subject.replaceForDocument("ws-a", "sd-1", [
      chunkInput({ ordinal: 2, text: "third" }),
      chunkInput({ ordinal: 0, text: "first" }),
      chunkInput({ ordinal: 1, text: "second" }),
    ]);
    expect(written.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("clears the chunks when replacing with an empty set", async () => {
    const { subject, prisma } = repo([row()]);
    const written = await subject.replaceForDocument("ws-a", "sd-1", []);
    expect(written).toEqual([]);
    expect(prisma.rows).toHaveLength(0);
  });
});

describe("PrismaSearchChunkRepository — reading rows", () => {
  it("allowlists the source type and degrades an unknown one safely", async () => {
    const { subject } = repo([row({ sourceType: "exfiltrated" })]);
    const [chunk] = await subject.listForDocument("ws-a", "doc-1");
    // The text is still valid content; only its provenance label is unusable.
    expect(chunk.sourceType).toBe("text");
  });

  it("preserves an allowlisted source type", async () => {
    const { subject } = repo([row({ sourceType: "bookmark" })]);
    const [chunk] = await subject.listForDocument("ws-a", "doc-1");
    expect(chunk.sourceType).toBe("bookmark");
  });

  it("nulls an invalid page number", async () => {
    const { subject } = repo([
      row({ id: "a", ordinal: 0, pageNumber: 0 }),
      row({ id: "b", ordinal: 1, pageNumber: -3 }),
    ]);
    const chunks = await subject.listForDocument("ws-a", "doc-1");
    expect(chunks.map((c) => c.pageNumber)).toEqual([null, null]);
  });

  it("preserves a valid page number", async () => {
    const { subject } = repo([row({ pageNumber: 12 })]);
    const [chunk] = await subject.listForDocument("ws-a", "doc-1");
    expect(chunk.pageNumber).toBe(12);
  });

  it("bounds oversized persisted text on read", async () => {
    const { subject } = repo([
      row({
        text: "t".repeat(SEARCH_LIMITS.maxChunkTextLength + 400),
        normalizedText: "n".repeat(SEARCH_LIMITS.maxChunkTextLength + 400),
      }),
    ]);
    const [chunk] = await subject.listForDocument("ws-a", "doc-1");
    expect(chunk.text.length).toBe(SEARCH_LIMITS.maxChunkTextLength);
    expect(chunk.normalizedText.length).toBe(SEARCH_LIMITS.maxChunkTextLength);
  });
});

describe("PrismaSearchChunkRepository — listForDocument", () => {
  it("is Workspace scoped", async () => {
    const { subject } = repo([
      row({ id: "mine", workspaceId: "ws-a" }),
      row({ id: "theirs", workspaceId: "ws-b", ordinal: 1 }),
    ]);
    const chunks = await subject.listForDocument("ws-a", "doc-1");
    expect(chunks.map((c) => c.id)).toEqual(["mine"]);
  });

  it("is ordered by ordinal", async () => {
    const { subject } = repo([
      row({ id: "c", ordinal: 2 }),
      row({ id: "a", ordinal: 0 }),
      row({ id: "b", ordinal: 1 }),
    ]);
    const chunks = await subject.listForDocument("ws-a", "doc-1");
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("bounds the listing limit", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row({ id: `r${i}`, ordinal: i }));
    const { subject } = repo(rows);
    expect(await subject.listForDocument("ws-a", "doc-1", 5)).toHaveLength(5);
    // An absurd caller limit collapses to the per-document cap, not to itself.
    expect(
      await subject.listForDocument("ws-a", "doc-1", SEARCH_LIMITS.maxChunksPerDocument + 5000),
    ).toHaveLength(20);
  });
});

describe("PrismaSearchChunkRepository — listMatchingTerms", () => {
  const corpus = [
    row({
      id: "both",
      documentId: "doc-both",
      searchDocumentId: "sd-both",
      ordinal: 0,
      normalizedText: "the quarterly contract for 2026",
    }),
    row({
      id: "one",
      documentId: "doc-one",
      searchDocumentId: "sd-one",
      ordinal: 0,
      normalizedText: "a contract without a year",
    }),
    row({
      id: "foreign",
      documentId: "doc-foreign",
      searchDocumentId: "sd-foreign",
      workspaceId: "ws-b",
      ordinal: 0,
      normalizedText: "the quarterly contract for 2026",
    }),
  ];

  it("uses AND semantics across terms", async () => {
    const { subject } = repo(corpus.map((r) => ({ ...r })));
    const matched = await subject.listMatchingTerms("ws-a", ["contract", "2026"], 20);
    expect(matched.map((c) => c.documentId)).toEqual(["doc-both"]);
  });

  it("returns every chunk matching a single term", async () => {
    const { subject } = repo(corpus.map((r) => ({ ...r })));
    const matched = await subject.listMatchingTerms("ws-a", ["contract"], 20);
    expect(matched.map((c) => c.documentId).sort()).toEqual(["doc-both", "doc-one"]);
  });

  it("returns no rows for empty terms without querying the backend", async () => {
    const { subject } = repo(corpus.map((r) => ({ ...r })));
    // An empty AND would match every row; short-circuiting is what prevents it.
    expect(await subject.listMatchingTerms("ws-a", [], 20)).toEqual([]);
  });

  it("excludes another Workspace's chunks", async () => {
    const { subject } = repo(corpus.map((r) => ({ ...r })));
    const matched = await subject.listMatchingTerms("ws-a", ["quarterly"], 20);
    expect(matched.every((c) => c.workspaceId === "ws-a")).toBe(true);
    expect(matched.some((c) => c.documentId === "doc-foreign")).toBe(false);
  });

  it("treats a regex-looking term as a literal, not a pattern", async () => {
    const { subject } = repo([
      row({ id: "literal", documentId: "doc-literal", normalizedText: "a .*contract.* clause" }),
      row({
        id: "plain",
        documentId: "doc-plain",
        searchDocumentId: "sd-plain",
        normalizedText: "an ordinary contract clause",
      }),
    ]);

    const matched = await subject.listMatchingTerms("ws-a", [".*contract.*"], 20);

    // As a pattern this would match both; as a literal it matches only the text
    // that actually contains those characters.
    expect(matched.map((c) => c.documentId)).toEqual(["doc-literal"]);
  });

  it("does not let an anchor or quantifier term match anything it does not literally appear in", async () => {
    const { subject } = repo([row({ normalizedText: "the quarterly contract for 2026" })]);
    expect(await subject.listMatchingTerms("ws-a", ["^the"], 20)).toEqual([]);
    expect(await subject.listMatchingTerms("ws-a", ["contract+"], 20)).toEqual([]);
    expect(await subject.listMatchingTerms("ws-a", ["contr.ct"], 20)).toEqual([]);
  });

  it("bounds the number of search terms it sends", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const delegate = {
      async findMany({ where }: { where: Record<string, unknown> }) {
        sent.push(where);
        return [];
      },
      async deleteMany() {
        return { count: 0 };
      },
      async count() {
        return 0;
      },
    };
    const subject = new PrismaSearchChunkRepository(
      { searchChunk: delegate } as unknown as PrismaClient,
    );

    const terms = Array.from({ length: SEARCH_LIMITS.maxQueryTerms + 10 }, (_, i) => `term${i}`);
    await subject.listMatchingTerms("ws-a", terms, 20);

    const and = sent[0].AND as unknown[];
    expect(and).toHaveLength(SEARCH_LIMITS.maxQueryTerms);
  });

  it("bounds the length of each search term it sends", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const delegate = {
      async findMany({ where }: { where: Record<string, unknown> }) {
        sent.push(where);
        return [];
      },
      async deleteMany() {
        return { count: 0 };
      },
      async count() {
        return 0;
      },
    };
    const subject = new PrismaSearchChunkRepository(
      { searchChunk: delegate } as unknown as PrismaClient,
    );

    await subject.listMatchingTerms("ws-a", ["x".repeat(SEARCH_LIMITS.maxTermLength + 200)], 20);

    const and = sent[0].AND as Array<{ normalizedText: { contains: string } }>;
    expect(and[0].normalizedText.contains.length).toBe(SEARCH_LIMITS.maxTermLength);
  });

  it("bounds the result limit", async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row({
        id: `r${i}`,
        documentId: `doc-${String(i).padStart(2, "0")}`,
        searchDocumentId: `sd-${i}`,
        ordinal: 0,
        normalizedText: "contract text",
      }),
    );
    const { subject } = repo(rows);
    expect(await subject.listMatchingTerms("ws-a", ["contract"], 4)).toHaveLength(4);
  });

  it("orders results deterministically by document then ordinal", async () => {
    const { subject } = repo([
      row({ id: "b1", documentId: "doc-b", searchDocumentId: "sd-b", ordinal: 1, normalizedText: "contract b1" }),
      row({ id: "a2", documentId: "doc-a", searchDocumentId: "sd-a", ordinal: 2, normalizedText: "contract a2" }),
      row({ id: "a0", documentId: "doc-a", searchDocumentId: "sd-a", ordinal: 0, normalizedText: "contract a0" }),
      row({ id: "b0", documentId: "doc-b", searchDocumentId: "sd-b", ordinal: 0, normalizedText: "contract b0" }),
    ]);

    const matched = await subject.listMatchingTerms("ws-a", ["contract"], 20);

    expect(matched.map((c) => c.id)).toEqual(["a0", "a2", "b0", "b1"]);
  });
});

describe("PrismaSearchChunkRepository — deletes and counts", () => {
  it("scopes deleteForSearchDocument to the Workspace", async () => {
    const { subject, prisma } = repo([
      row({ id: "mine", workspaceId: "ws-a", searchDocumentId: "sd-1" }),
      row({ id: "theirs", workspaceId: "ws-b", searchDocumentId: "sd-1" }),
    ]);

    expect(await subject.deleteForSearchDocument("ws-a", "sd-1")).toBe(1);
    expect(prisma.rows.map((r) => r.id)).toEqual(["theirs"]);
  });

  it("scopes deleteForDocument to the Workspace", async () => {
    const { subject, prisma } = repo([
      row({ id: "mine", workspaceId: "ws-a", documentId: "doc-1" }),
      row({ id: "theirs", workspaceId: "ws-b", documentId: "doc-1" }),
    ]);

    expect(await subject.deleteForDocument("ws-a", "doc-1")).toBe(1);
    expect(prisma.rows.map((r) => r.id)).toEqual(["theirs"]);
  });

  it("scopes countForDocument to the Workspace", async () => {
    const { subject } = repo([
      row({ id: "a", ordinal: 0 }),
      row({ id: "b", ordinal: 1 }),
      row({ id: "c", ordinal: 0, workspaceId: "ws-b" }),
    ]);
    expect(await subject.countForDocument("ws-a", "doc-1")).toBe(2);
  });

  it("excludes another Workspace from countForWorkspace", async () => {
    const { subject } = repo([
      row({ id: "a", ordinal: 0 }),
      row({ id: "b", ordinal: 0, workspaceId: "ws-b", searchDocumentId: "sd-b" }),
    ]);
    expect(await subject.countForWorkspace("ws-a")).toBe(1);
    expect(await subject.countForWorkspace("ws-b")).toBe(1);
  });
});

describe("PrismaSearchChunkRepository — returned values are copies", () => {
  it("cannot mutate a persisted row through a returned chunk", async () => {
    const { subject, prisma } = repo([row()]);
    const [chunk] = await subject.listForDocument("ws-a", "doc-1");

    chunk.createdAt.setFullYear(1999);
    chunk.text = "tampered";

    expect(prisma.rows[0].createdAt.getFullYear()).toBe(2026);
    expect(prisma.rows[0].text).toBe("The quarterly contract for 2026");
  });
});

describe("PrismaSearchChunkRepository — every predicate carries Workspace scope", () => {
  /**
   * Structural guard on the tenancy invariant: every `where` the adapter emits
   * must name a workspaceId, so no method can authorize on documentId,
   * searchDocumentId or ordinal alone.
   */
  it("never issues a predicate without workspaceId", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const delegate = {
      async findMany({ where }: { where: Record<string, unknown> }) {
        seen.push(where);
        return [];
      },
      async create() {
        return null;
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        seen.push(where);
        return { count: 0 };
      },
      async count({ where }: { where: Record<string, unknown> }) {
        seen.push(where);
        return 0;
      },
    };
    const client = {
      searchChunk: delegate,
      async $transaction<T>(fn: (tx: { searchChunk: typeof delegate }) => Promise<T>) {
        return fn({ searchChunk: delegate });
      },
    };
    const subject = new PrismaSearchChunkRepository(client as unknown as PrismaClient);

    await subject.replaceForDocument("ws-a", "sd-1", []);
    await subject.listForDocument("ws-a", "doc-1");
    await subject.listMatchingTerms("ws-a", ["contract"], 10);
    await subject.countForDocument("ws-a", "doc-1");
    await subject.deleteForSearchDocument("ws-a", "sd-1");
    await subject.deleteForDocument("ws-a", "doc-1");
    await subject.countForWorkspace("ws-a");

    expect(seen.length).toBeGreaterThan(0);
    for (const where of seen) {
      expect(Object.keys(where)).toContain("workspaceId");
      expect(where.workspaceId).toBe("ws-a");
    }
  });
});
