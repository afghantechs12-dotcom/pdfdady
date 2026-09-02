import { describe, expect, it } from "vitest";
import type { SearchChunkRepository } from "@/src/application/ports/workspaces/SearchChunkRepository";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";
import { InMemorySearchChunkRepository } from "./InMemorySearchChunkRepository";
import { SQLiteSearchIndexAdapter } from "./SQLiteSearchIndexAdapter";

function adapterHarness(): {
  repository: SearchChunkRepository;
  adapter: SQLiteSearchIndexAdapter;
} {
  const repository = new InMemorySearchChunkRepository();
  return { repository, adapter: new SQLiteSearchIndexAdapter(repository) };
}

/** Records what the adapter asked the backend for, without answering. */
function recordingRepository(): {
  calls: Array<{ workspaceId: string; terms: string[]; limit: number }>;
  repository: SearchChunkRepository;
} {
  const calls: Array<{ workspaceId: string; terms: string[]; limit: number }> = [];
  const repository: SearchChunkRepository = {
    replaceForDocument: async () => [],
    listForDocument: async () => [],
    listMatchingTerms: async (workspaceId, terms, limit) => {
      calls.push({ workspaceId, terms, limit });
      return [];
    },
    countForDocument: async () => 0,
    deleteForSearchDocument: async () => 0,
    deleteForDocument: async () => 0,
    countForWorkspace: async () => 0,
  };
  return { calls, repository };
}

async function seed(
  repository: SearchChunkRepository,
  workspaceId: string,
  searchDocumentId: string,
  documentId: string,
  texts: string[],
): Promise<void> {
  await repository.replaceForDocument(
    workspaceId,
    searchDocumentId,
    texts.map((text, ordinal) => ({
      organizationId: `org-${workspaceId}`,
      workspaceId,
      searchDocumentId,
      documentId,
      ordinal,
      sourceType: "text" as const,
      pageNumber: ordinal + 1,
      text,
      normalizedText: text.toLowerCase(),
    })),
  );
}

describe("SQLiteSearchIndexAdapter — literal matching", () => {
  it("matches a bounded literal substring", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-a", "doc-a", ["The quarterly contract for 2026"]);

    const matches = await adapter.searchChunks("ws-a", ["contract"], 20);

    expect(matches.map((chunk) => chunk.documentId)).toEqual(["doc-a"]);
  });

  it("requires every term to be present (AND semantics)", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-both", "doc-both", ["quarterly contract 2026"]);
    await seed(repository, "ws-a", "sd-one", "doc-one", ["a contract with no year"]);

    const matches = await adapter.searchChunks("ws-a", ["contract", "2026"], 20);

    expect(matches.map((chunk) => chunk.documentId)).toEqual(["doc-both"]);
  });

  it("does not interpret a regex-looking term as a pattern", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-lit", "doc-literal", ["a .*contract.* clause"]);
    await seed(repository, "ws-a", "sd-plain", "doc-plain", ["an ordinary contract clause"]);

    // As a pattern this matches both documents; as a literal, only the one whose
    // text actually contains those characters.
    const matches = await adapter.searchChunks("ws-a", [".*contract.*"], 20);

    expect(matches.map((chunk) => chunk.documentId)).toEqual(["doc-literal"]);
  });

  it("does not honour anchors or quantifiers", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-a", "doc-a", ["the quarterly contract"]);

    expect(await adapter.searchChunks("ws-a", ["^the"], 20)).toEqual([]);
    expect(await adapter.searchChunks("ws-a", ["contract+"], 20)).toEqual([]);
    expect(await adapter.searchChunks("ws-a", ["contr.ct"], 20)).toEqual([]);
  });

  it("uses workspace-scoped AND literal matching", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "index-a", "doc-a", ["A .*contract.* for 2026"]);
    await seed(repository, "ws-b", "index-b", "doc-b", ["A .*contract.* for 2026"]);

    const matches = await adapter.searchChunks("ws-a", [".*contract.*", "2026"], 20);

    expect(matches.map((chunk) => chunk.documentId)).toEqual(["doc-a"]);
  });
});

describe("SQLiteSearchIndexAdapter — Workspace scoping", () => {
  it("excludes another Workspace's chunks entirely", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-a", "doc-a", ["shared contract text"]);
    await seed(repository, "ws-b", "sd-b", "doc-b", ["shared contract text"]);

    const fromA = await adapter.searchChunks("ws-a", ["contract"], 20);
    const fromB = await adapter.searchChunks("ws-b", ["contract"], 20);

    expect(fromA.every((chunk) => chunk.workspaceId === "ws-a")).toBe(true);
    expect(fromB.every((chunk) => chunk.workspaceId === "ws-b")).toBe(true);
    expect(fromA.map((c) => c.documentId)).toEqual(["doc-a"]);
  });

  it("forwards the caller's Workspace to the backend unchanged", async () => {
    const { calls, repository } = recordingRepository();
    await new SQLiteSearchIndexAdapter(repository).searchChunks("ws-a", ["contract"], 20);
    expect(calls[0].workspaceId).toBe("ws-a");
  });

  it("returns nothing for a Workspace with no indexed content", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-a", "doc-a", ["contract text"]);
    expect(await adapter.searchChunks("ws-empty", ["contract"], 20)).toEqual([]);
  });
});

describe("SQLiteSearchIndexAdapter — bounds", () => {
  it("returns nothing for empty terms without querying the backend", async () => {
    const { calls, repository } = recordingRepository();
    const adapter = new SQLiteSearchIndexAdapter(repository);

    expect(await adapter.searchChunks("ws-a", [], 20)).toEqual([]);
    // An empty AND would match every chunk in the Workspace; the backend must
    // never be reached with one.
    expect(calls).toHaveLength(0);
  });

  it("rejects unusable terms without querying the backend", async () => {
    const repository: SearchChunkRepository = {
      replaceForDocument: async () => [],
      listForDocument: async () => [],
      listMatchingTerms: async () => {
        throw new Error("backend must not be queried");
      },
      countForDocument: async () => 0,
      deleteForSearchDocument: async () => 0,
      deleteForDocument: async () => 0,
      countForWorkspace: async () => 0,
    };
    const adapter = new SQLiteSearchIndexAdapter(repository);

    await expect(adapter.searchChunks("ws-a", ["!!!"], 20)).resolves.toEqual([]);
  });

  it("drops unusable terms but keeps the searchable ones", async () => {
    const { calls, repository } = recordingRepository();
    await new SQLiteSearchIndexAdapter(repository).searchChunks(
      "ws-a",
      ["!!!", "contract", "?"],
      20,
    );
    expect(calls[0].terms).toEqual(["contract"]);
  });

  it("bounds the number of terms sent to the backend", async () => {
    const { calls, repository } = recordingRepository();
    const terms = Array.from({ length: SEARCH_LIMITS.maxQueryTerms + 12 }, (_, i) => `term${i}`);

    await new SQLiteSearchIndexAdapter(repository).searchChunks("ws-a", terms, 20);

    expect(calls[0].terms).toHaveLength(SEARCH_LIMITS.maxQueryTerms);
  });

  it("rejects an over-long term rather than truncating it into a prefix match", async () => {
    const { calls, repository } = recordingRepository();
    const long = "x".repeat(SEARCH_LIMITS.maxTermLength + 100);

    const result = await new SQLiteSearchIndexAdapter(repository).searchChunks(
      "ws-a",
      [long],
      20,
    );

    // Truncating would silently widen the query into a prefix search for
    // something the caller never asked for, so the term is dropped instead. With
    // nothing left, the backend is not queried at all.
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("drops an over-long term while keeping the usable ones", async () => {
    const { calls, repository } = recordingRepository();
    const long = "x".repeat(SEARCH_LIMITS.maxTermLength + 100);

    await new SQLiteSearchIndexAdapter(repository).searchChunks(
      "ws-a",
      [long, "contract"],
      20,
    );

    expect(calls[0].terms).toEqual(["contract"]);
  });

  it("caps an oversized result limit", async () => {
    const { calls, repository } = recordingRepository();
    await new SQLiteSearchIndexAdapter(repository).searchChunks("ws-a", ["contract"], 10_000_000);
    expect(calls[0].limit).toBe(SEARCH_LIMITS.maxCandidateDocuments);
  });

  it("floors a zero or negative limit to at least one row", async () => {
    const { calls, repository } = recordingRepository();
    const adapter = new SQLiteSearchIndexAdapter(repository);

    await adapter.searchChunks("ws-a", ["contract"], 0);
    await adapter.searchChunks("ws-a", ["contract"], -50);

    expect(calls[0].limit).toBe(1);
    expect(calls[1].limit).toBe(1);
  });

  it("falls back to the default limit for a non-finite one", async () => {
    const { calls, repository } = recordingRepository();
    await new SQLiteSearchIndexAdapter(repository).searchChunks(
      "ws-a",
      ["contract"],
      Number.NaN,
    );
    expect(calls[0].limit).toBe(SEARCH_LIMITS.defaultResultLimit);
  });

  it("actually bounds the returned row count", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(
      repository,
      "ws-a",
      "sd-a",
      "doc-a",
      Array.from({ length: 25 }, (_, i) => `contract clause ${i}`),
    );

    expect(await adapter.searchChunks("ws-a", ["contract"], 5)).toHaveLength(5);
  });
});

describe("SQLiteSearchIndexAdapter — determinism", () => {
  it("orders results by document then ordinal, stably across calls", async () => {
    const { repository, adapter } = adapterHarness();
    await seed(repository, "ws-a", "sd-b", "doc-b", ["contract b0", "contract b1"]);
    await seed(repository, "ws-a", "sd-a", "doc-a", ["contract a0", "contract a1"]);

    const first = await adapter.searchChunks("ws-a", ["contract"], 20);
    const second = await adapter.searchChunks("ws-a", ["contract"], 20);

    expect(first.map((c) => `${c.documentId}:${c.ordinal}`)).toEqual([
      "doc-a:0",
      "doc-a:1",
      "doc-b:0",
      "doc-b:1",
    ]);
    expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id));
  });
});

describe("SQLiteSearchIndexAdapter — separation of concerns", () => {
  /**
   * The adapter is a backend query boundary, not an authorization boundary. It
   * must not consult roles or memberships; SearchService resolves the eligible
   * document set before any chunk is read. This test pins that division: the
   * adapter is handed a Workspace it was told to query and does exactly that,
   * with no tenant-role decision of its own.
   */
  it("makes no tenant-role decision of its own", async () => {
    const { calls, repository } = recordingRepository();
    const adapter = new SQLiteSearchIndexAdapter(repository);

    await adapter.searchChunks("ws-a", ["contract"], 20);

    // One backend call, carrying exactly the scope it was given — no widening,
    // no second lookup for permissions.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      workspaceId: "ws-a",
      terms: ["contract"],
      limit: 20,
    });
  });
});
