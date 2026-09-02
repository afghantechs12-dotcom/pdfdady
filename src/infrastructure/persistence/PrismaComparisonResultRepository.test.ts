import { describe, expect, it } from "vitest";
import { PrismaComparisonResultRepository } from "./PrismaComparisonResultRepository";
import type { PrismaClient } from "@prisma/client";
import { STATISTICS_LIMITS, emptySummary } from "@/src/domain/entities/DocumentStatistics";
import type {
  ComparisonDifference,
  ComparisonSummary,
} from "@/src/domain/entities/DocumentStatistics";
import type { CreateComparisonResultInput } from "@/src/application/ports/workspaces/ComparisonResultRepository";

interface ResultRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  comparisonId: string;
  type: string;
  summary: string;
  differences: string;
  checksum: string;
  createdAt: Date;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

/**
 * Applies only the predicates the adapter supplied — so a missing `workspaceId`
 * predicate makes the cross-tenant tests below fail rather than pass.
 */
function matches(row: ResultRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof ResultRow], v));
}

function fakePrisma(rows: ResultRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];

  const delegate = {
    async create({ data }: { data: Partial<ResultRow> }) {
      seq += 1;
      const row: ResultRow = {
        id: `res-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        comparisonId: data.comparisonId!,
        type: data.type!,
        summary: data.summary ?? "{}",
        differences: data.differences ?? "[]",
        checksum: data.checksum ?? "",
        createdAt: new Date(Date.UTC(2026, 7, 4, 12, 0, seq)),
      };
      rows.push(row);
      return row;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: removed };
    },
  };

  return { prisma: { comparisonResult: delegate } as unknown as PrismaClient, wheres };
}

function summary(overrides: Partial<ComparisonSummary> = {}): ComparisonSummary {
  return {
    added: 2,
    removed: 1,
    changed: 3,
    pagesAdded: [4],
    pagesRemoved: [7],
    truncated: false,
    ...overrides,
  };
}

function differences(count = 2): ComparisonDifference[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "added" as const,
    pageNumber: i + 1,
    excerpt: `line ${i + 1}`,
  }));
}

function draft(overrides: Partial<CreateComparisonResultInput> = {}): CreateComparisonResultInput {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    comparisonId: "cmp-1",
    type: "textual",
    summary: summary(),
    differences: differences(),
    checksum: "a".repeat(64),
    ...overrides,
  };
}

describe("PrismaComparisonResultRepository", () => {
  it("creates an immutable result with every supplied field", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);

    const result = await repo.create(draft());
    expect(result.organizationId).toBe("org-1");
    expect(result.comparisonId).toBe("cmp-1");
    expect(result.type).toBe("textual");
    expect(result.summary.changed).toBe(3);
    expect(result.differences).toHaveLength(2);
    // No `update` exists on the port: a result describes immutable versions.
    expect("update" in repo).toBe(false);
  });

  it("keeps one result per operation", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    await repo.create(draft());
    await repo.create(draft({ checksum: "b".repeat(64) }));

    expect(rows).toHaveLength(1);
  });

  it("converges rather than duplicating on a redelivered create", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const first = await repo.create(draft());
    const second = await repo.create(draft({ summary: summary({ added: 999 }) }));

    expect(second.id).toBe(first.id);
    // The existing artifact wins: a redelivered completion must not rewrite it.
    expect(second.summary.added).toBe(2);
  });

  it("scopes lookup by id and Workspace", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    expect(await repo.getById("ws-1", created.id)).not.toBeNull();
    expect(await repo.getById("ws-other", created.id)).toBeNull();
  });

  it("scopes lookup by comparison and Workspace", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    await repo.create(draft());

    expect(await repo.getByComparisonId("ws-1", "cmp-1")).not.toBeNull();
    expect(await repo.getByComparisonId("ws-other", "cmp-1")).toBeNull();
  });

  it("bounds the stored differences on the way in", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const result = await repo.create(
      draft({ differences: differences(STATISTICS_LIMITS.maxDifferences + 50) }),
    );

    // A pathological pair of documents must not write an unbounded row.
    expect(result.differences.length).toBeLessThanOrEqual(STATISTICS_LIMITS.maxDifferences);
    expect(JSON.parse(rows[0].differences)).toHaveLength(STATISTICS_LIMITS.maxDifferences);
  });

  it("degrades a malformed summary safely", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    rows[0].summary = "{ truncated json";

    const read = await repo.getById("ws-1", created.id);
    expect(read?.summary).toEqual(emptySummary());
  });

  it("degrades malformed differences safely", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    rows[0].differences = JSON.stringify([
      { kind: "added", pageNumber: 1, excerpt: "kept" },
      { kind: "teleported", pageNumber: 2, excerpt: "dropped" },
      "not an object",
    ]);

    const read = await repo.getById("ws-1", created.id);
    // Unknown kinds are dropped rather than widening the union.
    expect(read?.differences).toHaveLength(1);
    expect(read?.differences[0].excerpt).toBe("kept");
  });

  it("validates the stored type", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    rows[0].type = "chromatic";

    const read = await repo.getById("ws-1", created.id);
    expect(read?.type).toBe("structural");
  });

  it("preserves the checksum", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft({ checksum: "f".repeat(64) }));

    const read = await repo.getById("ws-1", created.id);
    expect(read?.checksum).toBe("f".repeat(64));
  });

  it("scopes delete by Workspace", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    expect(await repo.delete("ws-other", created.id)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(await repo.delete("ws-1", created.id)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("scopes deleteForDocument by Workspace", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    await repo.create(draft({ comparisonId: "cmp-1" }));
    await repo.create(draft({ comparisonId: "cmp-2" }));
    await repo.create(draft({ comparisonId: "cmp-3", workspaceId: "ws-other" }));

    expect(await repo.deleteForDocument("ws-1", "doc-1")).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe("ws-other");
  });

  it("returns objects that cannot mutate stored rows", async () => {
    const rows: ResultRow[] = [];
    const repo = new PrismaComparisonResultRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    created.summary.added = 999;
    created.differences.push({ kind: "removed", pageNumber: 9, excerpt: "injected" });
    created.createdAt.setFullYear(1999);

    const reread = await repo.getById("ws-1", created.id);
    expect(reread?.summary.added).toBe(2);
    expect(reread?.differences).toHaveLength(2);
    expect(reread?.createdAt.getFullYear()).toBe(2026);
  });
});
