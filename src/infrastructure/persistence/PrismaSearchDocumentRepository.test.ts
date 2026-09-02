import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaSearchDocumentRepository } from "./PrismaSearchDocumentRepository";
import { SEARCH_LIMITS } from "@/src/domain/entities/SearchIndex";

/**
 * Row-backed stand-in for the `searchDocument` delegate.
 *
 * The fake deliberately does *not* inject Workspace scoping of its own: it
 * evaluates only the predicates the adapter actually sends. A `workspaceId` the
 * adapter forgets simply does not filter, so a missing tenant predicate shows up
 * as a cross-Workspace row being returned rather than as a silently passing test.
 */
interface Row {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string | null;
  state: string;
  schemaVersion: number;
  checksum: string;
  chunkCount: number;
  error: string | null;
  indexedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Evaluates one field predicate, supporting the operators the adapter uses. */
function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as { in?: string[]; not?: unknown };
    if ("in" in ops) return Array.isArray(ops.in) && ops.in.includes(actual as string);
    if ("not" in ops) {
      return ops.not === null ? actual !== null : actual !== ops.not;
    }
    return false;
  }
  return actual === expected;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) =>
    matchValue(row[key as keyof Row], value),
  );
}

/** Applies an `{ increment }` write, mirroring Prisma's atomic number update. */
function applyData(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in (value as object)) {
      const current = row[key as keyof Row];
      (row as unknown as Record<string, unknown>)[key] =
        (typeof current === "number" ? current : 0) +
        ((value as { increment: number }).increment ?? 0);
      continue;
    }
    (row as unknown as Record<string, unknown>)[key] = value;
  }
  // The schema declares @updatedAt, so any write advances it. Stepping forward a
  // whole second keeps the assertion immune to same-millisecond execution.
  row.updatedAt = new Date(row.updatedAt.getTime() + 1000);
}

function fakePrisma(rows: Row[]) {
  let seq = 0;

  const delegate = {
    async findUnique({
      where,
    }: {
      where: { workspaceId_documentId?: { workspaceId: string; documentId: string } };
    }) {
      const key = where.workspaceId_documentId;
      if (!key) return null;
      return (
        rows.find(
          (r) => r.workspaceId === key.workspaceId && r.documentId === key.documentId,
        ) ?? null
      );
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy?: Record<string, "asc" | "desc">;
      take?: number;
    }) {
      const found = rows.filter((r) => matches(r, where));
      // Only sorts when the adapter asked for it, and only on the named field.
      if (orderBy?.documentId === "asc") {
        found.sort((a, b) => a.documentId.localeCompare(b.documentId));
      }
      if (orderBy?.indexedAt === "desc") {
        found.sort((a, b) => (b.indexedAt?.getTime() ?? 0) - (a.indexedAt?.getTime() ?? 0));
      }
      return take === undefined ? found : found.slice(0, take);
    },
    async upsert({
      where,
      create,
      update,
    }: {
      where: { workspaceId_documentId: { workspaceId: string; documentId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) {
      const key = where.workspaceId_documentId;
      const existing = rows.find(
        (r) => r.workspaceId === key.workspaceId && r.documentId === key.documentId,
      );
      if (existing) {
        applyData(existing, update);
        return existing;
      }
      seq += 1;
      const created: Row = {
        id: `search-doc-${seq}`,
        organizationId: String(create.organizationId),
        workspaceId: String(create.workspaceId),
        documentId: String(create.documentId),
        versionId: (create.versionId as string | null) ?? null,
        state: String(create.state ?? "pending"),
        schemaVersion: Number(create.schemaVersion ?? 1),
        checksum: String(create.checksum ?? ""),
        chunkCount: Number(create.chunkCount ?? 0),
        error: (create.error as string | null) ?? null,
        indexedAt: (create.indexedAt as Date | null) ?? null,
        revision: Number(create.revision ?? 1),
        createdAt: new Date("2026-08-03T00:00:00.000Z"),
        updatedAt: new Date("2026-08-03T00:00:00.000Z"),
      };
      rows.push(created);
      return created;
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      const affected = rows.filter((r) => matches(r, where));
      for (const row of affected) applyData(row, data);
      return { count: affected.length };
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  return { rows, searchDocument: delegate };
}

function repo(rows: Row[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    subject: new PrismaSearchDocumentRepository(prisma as unknown as PrismaClient),
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "sd-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    versionId: "ver-1",
    state: "indexed",
    schemaVersion: 1,
    checksum: "abc123",
    chunkCount: 3,
    error: null,
    indexedAt: new Date("2026-08-02T00:00:00.000Z"),
    revision: 1,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  };
}

function upsertInput(overrides: Partial<Parameters<PrismaSearchDocumentRepository["upsert"]>[0]> = {}) {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    versionId: "ver-1",
    state: "pending" as const,
    schemaVersion: SEARCH_LIMITS.schemaVersion,
    checksum: "abc123",
    ...overrides,
  };
}

describe("PrismaSearchDocumentRepository — reads are Workspace scoped", () => {
  it("gets an entry by document id within the Workspace", async () => {
    const { subject } = repo([row()]);
    const entry = await subject.getByDocumentId("ws-a", "doc-1");
    expect(entry?.id).toBe("sd-seed");
    expect(entry?.documentId).toBe("doc-1");
  });

  it("does not return another Workspace's entry addressed by document id", async () => {
    const { subject } = repo([row({ workspaceId: "ws-b" })]);
    // The row exists, but a document id alone must never authorize a read.
    expect(await subject.getByDocumentId("ws-a", "doc-1")).toBeNull();
  });

  it("gets an entry by search-document id within the Workspace", async () => {
    const { subject } = repo([row()]);
    expect((await subject.getById("ws-a", "sd-seed"))?.documentId).toBe("doc-1");
  });

  it("does not return another Workspace's entry addressed by search-document id", async () => {
    const { subject } = repo([row({ workspaceId: "ws-b" })]);
    expect(await subject.getById("ws-a", "sd-seed")).toBeNull();
  });
});

describe("PrismaSearchDocumentRepository — upsert converges", () => {
  it("creates a new entry when none exists", async () => {
    const { subject, prisma } = repo();
    const entry = await subject.upsert(upsertInput());
    expect(entry.documentId).toBe("doc-1");
    expect(entry.state).toBe("pending");
    expect(prisma.rows).toHaveLength(1);
  });

  it("converges on one entry when upserted repeatedly", async () => {
    const { subject, prisma } = repo();
    const first = await subject.upsert(upsertInput());
    const second = await subject.upsert(upsertInput({ state: "indexing" }));
    // Duplicate delivery of an indexing event must not create a second entry.
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("indexing");
    expect(prisma.rows).toHaveLength(1);
  });

  it("keeps one entry per Workspace and document pair", async () => {
    const { subject, prisma } = repo();
    await subject.upsert(upsertInput({ documentId: "doc-1" }));
    await subject.upsert(upsertInput({ documentId: "doc-2" }));
    await subject.upsert(upsertInput({ documentId: "doc-1" }));
    expect(prisma.rows).toHaveLength(2);
  });

  it("isolates the same document id living in another Workspace", async () => {
    const { subject, prisma } = repo();
    await subject.upsert(upsertInput({ workspaceId: "ws-a" }));
    await subject.upsert(upsertInput({ workspaceId: "ws-b", organizationId: "org-b" }));
    // Same documentId, different Workspace: two independent rows, not a collision.
    expect(prisma.rows).toHaveLength(2);
    expect((await subject.getByDocumentId("ws-a", "doc-1"))?.organizationId).toBe("org-a");
    expect((await subject.getByDocumentId("ws-b", "doc-1"))?.organizationId).toBe("org-b");
  });

  it("bounds an oversized checksum on write", async () => {
    const { subject } = repo();
    const entry = await subject.upsert(
      upsertInput({ checksum: "c".repeat(SEARCH_LIMITS.maxChecksumLength + 50) }),
    );
    expect(entry.checksum.length).toBe(SEARCH_LIMITS.maxChecksumLength);
  });
});

describe("PrismaSearchDocumentRepository — listings", () => {
  it("scopes list to the Workspace", async () => {
    const { subject } = repo([
      row({ id: "a", documentId: "doc-1" }),
      row({ id: "b", documentId: "doc-2", workspaceId: "ws-b" }),
    ]);
    const listed = await subject.list({ workspaceId: "ws-a", limit: 50 });
    expect(listed.map((e) => e.id)).toEqual(["a"]);
  });

  it("filters list by state", async () => {
    const { subject } = repo([
      row({ id: "a", documentId: "doc-1", state: "indexed" }),
      row({ id: "b", documentId: "doc-2", state: "failed" }),
    ]);
    const failed = await subject.list({ workspaceId: "ws-a", state: "failed", limit: 50 });
    expect(failed.map((e) => e.id)).toEqual(["b"]);
  });

  it("bounds the list limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r${i}`, documentId: `doc-${i}` }));
    const { subject } = repo(rows);
    expect(await subject.list({ workspaceId: "ws-a", limit: 3 })).toHaveLength(3);
  });

  it("scopes listForDocuments to the Workspace", async () => {
    const { subject } = repo([
      row({ id: "a", documentId: "doc-1" }),
      row({ id: "b", documentId: "doc-2", workspaceId: "ws-b" }),
    ]);
    const listed = await subject.listForDocuments("ws-a", ["doc-1", "doc-2"]);
    expect(listed.map((e) => e.id)).toEqual(["a"]);
  });

  it("returns no rows safely for an empty document-id input", async () => {
    const { subject } = repo([row()]);
    // An empty `in` list must short-circuit rather than degenerate into "all rows".
    expect(await subject.listForDocuments("ws-a", [])).toEqual([]);
  });
});

describe("PrismaSearchDocumentRepository — compare-and-swap state transitions", () => {
  it("transitions state when the expected revision matches", async () => {
    const { subject } = repo([row({ state: "pending", revision: 4 })]);
    const updated = await subject.setState("ws-a", "sd-seed", 4, "indexing");
    expect(updated?.state).toBe("indexing");
  });

  it("returns null for a stale revision", async () => {
    const { subject, prisma } = repo([row({ state: "pending", revision: 4 })]);
    expect(await subject.setState("ws-a", "sd-seed", 3, "indexing")).toBeNull();
    // The row is untouched, not partially written.
    expect(prisma.rows[0].state).toBe("pending");
  });

  it("does not disclose whether a missing row or a stale revision failed", async () => {
    const { subject } = repo([row({ revision: 2 })]);
    const staleRevision = await subject.setState("ws-a", "sd-seed", 1, "indexed");
    const missingRow = await subject.setState("ws-a", "sd-absent", 1, "indexed");
    const foreignRow = await subject.setState("ws-b", "sd-seed", 2, "indexed");
    // All three are indistinguishable: null, with no error carrying a reason.
    expect(staleRevision).toBeNull();
    expect(missingRow).toBeNull();
    expect(foreignRow).toBeNull();
  });

  it("increments the revision exactly once per transition", async () => {
    const { subject } = repo([row({ revision: 1 })]);
    const updated = await subject.setState("ws-a", "sd-seed", 1, "indexing");
    expect(updated?.revision).toBe(2);
  });

  it("leaves createdAt unchanged and advances updatedAt", async () => {
    const { subject, prisma } = repo([row({ revision: 1 })]);
    const before = prisma.rows[0].updatedAt.getTime();
    const updated = await subject.setState("ws-a", "sd-seed", 1, "indexing");
    expect(updated?.createdAt.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(before);
  });

  it("scopes the transition to the Workspace", async () => {
    const { subject, prisma } = repo([row({ workspaceId: "ws-b", revision: 1 })]);
    expect(await subject.setState("ws-a", "sd-seed", 1, "failed")).toBeNull();
    expect(prisma.rows[0].state).toBe("indexed");
  });
});

describe("PrismaSearchDocumentRepository — markIndexed", () => {
  it("stores the checksum and chunk count, clears the error and records indexedAt", async () => {
    const { subject } = repo([
      row({ state: "indexing", checksum: "", chunkCount: 0, error: "boom", indexedAt: null }),
    ]);
    const indexed = await subject.markIndexed("ws-a", "sd-seed", 7, "sum-9");

    expect(indexed?.state).toBe("indexed");
    expect(indexed?.checksum).toBe("sum-9");
    expect(indexed?.chunkCount).toBe(7);
    // A successful pass must not leave the previous failure's reason behind.
    expect(indexed?.error).toBeNull();
    expect(indexed?.indexedAt).toBeInstanceOf(Date);
  });

  it("bounds an oversized checksum", async () => {
    const { subject } = repo([row()]);
    const indexed = await subject.markIndexed(
      "ws-a",
      "sd-seed",
      1,
      "c".repeat(SEARCH_LIMITS.maxChecksumLength + 100),
    );
    expect(indexed?.checksum.length).toBe(SEARCH_LIMITS.maxChecksumLength);
  });

  it("is Workspace scoped", async () => {
    const { subject, prisma } = repo([row({ workspaceId: "ws-b", state: "pending" })]);
    expect(await subject.markIndexed("ws-a", "sd-seed", 5, "sum")).toBeNull();
    expect(prisma.rows[0].state).toBe("pending");
  });
});

describe("PrismaSearchDocumentRepository — reading degraded rows", () => {
  it("degrades an unknown persisted state to stale rather than surfacing it", async () => {
    const { subject } = repo([row({ state: "quantum-indexed" })]);
    const entry = await subject.getByDocumentId("ws-a", "doc-1");
    // Failing closed: an unrecognized state must not read as current.
    expect(entry?.state).toBe("stale");
  });

  it("bounds an oversized persisted error message", async () => {
    const { subject } = repo([row({ error: "e".repeat(SEARCH_LIMITS.maxErrorLength + 200) })]);
    const entry = await subject.getByDocumentId("ws-a", "doc-1");
    expect(entry?.error?.length).toBe(SEARCH_LIMITS.maxErrorLength);
  });

  it("bounds an oversized persisted checksum", async () => {
    const { subject } = repo([row({ checksum: "c".repeat(SEARCH_LIMITS.maxChecksumLength + 10) })]);
    const entry = await subject.getByDocumentId("ws-a", "doc-1");
    expect(entry?.checksum.length).toBe(SEARCH_LIMITS.maxChecksumLength);
  });

  it("normalizes a negative chunk count and revision", async () => {
    const { subject } = repo([row({ chunkCount: -5, revision: 0 })]);
    const entry = await subject.getByDocumentId("ws-a", "doc-1");
    expect(entry?.chunkCount).toBe(0);
    expect(entry?.revision).toBe(1);
  });
});

describe("PrismaSearchDocumentRepository — deletes and aggregates", () => {
  it("scopes delete to the Workspace", async () => {
    const { subject, prisma } = repo([row({ workspaceId: "ws-b" })]);
    expect(await subject.delete("ws-a", "doc-1")).toBe(false);
    expect(prisma.rows).toHaveLength(1);

    prisma.rows[0].workspaceId = "ws-a";
    expect(await subject.delete("ws-a", "doc-1")).toBe(true);
    expect(prisma.rows).toHaveLength(0);
  });

  it("excludes other Workspaces from the count", async () => {
    const { subject } = repo([
      row({ id: "a", documentId: "doc-1" }),
      row({ id: "b", documentId: "doc-2", workspaceId: "ws-b" }),
    ]);
    expect(await subject.countForWorkspace("ws-a")).toBe(1);
  });

  it("excludes other states from a state count", async () => {
    const { subject } = repo([
      row({ id: "a", documentId: "doc-1", state: "indexed" }),
      row({ id: "b", documentId: "doc-2", state: "failed" }),
    ]);
    expect(await subject.countForWorkspace("ws-a", "indexed")).toBe(1);
    expect(await subject.countForWorkspace("ws-a", "failed")).toBe(1);
    expect(await subject.countForWorkspace("ws-a", "pending")).toBe(0);
  });

  it("scopes lastIndexedAt to the Workspace and returns the most recent", async () => {
    const { subject } = repo([
      row({ id: "a", documentId: "doc-1", indexedAt: new Date("2026-08-01T00:00:00.000Z") }),
      row({ id: "b", documentId: "doc-2", indexedAt: new Date("2026-08-02T00:00:00.000Z") }),
      row({
        id: "c",
        documentId: "doc-3",
        workspaceId: "ws-b",
        indexedAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ]);
    // The ws-b row is newer; leaking it would disclose activity in another tenant.
    expect((await subject.lastIndexedAt("ws-a"))?.toISOString()).toBe(
      "2026-08-02T00:00:00.000Z",
    );
  });

  it("returns null lastIndexedAt when nothing in the Workspace has been indexed", async () => {
    const { subject } = repo([row({ indexedAt: null })]);
    expect(await subject.lastIndexedAt("ws-a")).toBeNull();
  });
});

describe("PrismaSearchDocumentRepository — returned values are copies", () => {
  it("cannot mutate persisted state through a returned entry", async () => {
    const { subject, prisma } = repo([row()]);
    const entry = await subject.getByDocumentId("ws-a", "doc-1");

    entry!.createdAt.setFullYear(1999);
    entry!.updatedAt.setFullYear(1999);
    entry!.indexedAt!.setFullYear(1999);

    // The stored row is untouched: Dates were copied, not aliased.
    expect(prisma.rows[0].createdAt.getFullYear()).toBe(2026);
    expect(prisma.rows[0].updatedAt.getFullYear()).toBe(2026);
    expect(prisma.rows[0].indexedAt!.getFullYear()).toBe(2026);
  });
});

describe("PrismaSearchDocumentRepository — every predicate carries Workspace scope", () => {
  /**
   * Guards the tenancy invariant structurally rather than case by case: the
   * adapter is driven against a recording delegate, and every `where` it emits
   * must name a workspaceId. A future method that authorizes on documentId,
   * searchDocumentId, checksum or versionId alone fails here.
   */
  it("never issues a predicate without workspaceId", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const record = (where: Record<string, unknown> = {}) => {
      seen.push(where);
    };

    const delegate = {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        const compound = where.workspaceId_documentId as Record<string, unknown> | undefined;
        record(compound ?? where);
        return null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        record(where);
        return null;
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        record(where);
        return [];
      },
      async upsert({ where }: { where: Record<string, unknown> }) {
        const compound = where.workspaceId_documentId as Record<string, unknown> | undefined;
        record(compound ?? where);
        throw new Error("stop");
      },
      async updateMany({ where }: { where: Record<string, unknown> }) {
        record(where);
        return { count: 0 };
      },
      async deleteMany({ where }: { where: Record<string, unknown> }) {
        record(where);
        return { count: 0 };
      },
      async count({ where }: { where: Record<string, unknown> }) {
        record(where);
        return 0;
      },
    };
    const subject = new PrismaSearchDocumentRepository(
      { searchDocument: delegate } as unknown as PrismaClient,
    );

    await subject.getByDocumentId("ws-a", "doc-1");
    await subject.getById("ws-a", "sd-1");
    await subject.list({ workspaceId: "ws-a", limit: 10 });
    await subject.listForDocuments("ws-a", ["doc-1"]);
    await subject.setState("ws-a", "sd-1", 1, "indexed");
    await subject.markIndexed("ws-a", "sd-1", 1, "sum");
    await subject.delete("ws-a", "doc-1");
    await subject.countForWorkspace("ws-a");
    await subject.lastIndexedAt("ws-a");
    await subject.upsert(upsertInput()).catch(() => undefined);

    expect(seen.length).toBeGreaterThan(0);
    for (const where of seen) {
      expect(Object.keys(where)).toContain("workspaceId");
      expect(where.workspaceId).toBe("ws-a");
    }
  });
});
