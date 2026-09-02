import { describe, expect, it } from "vitest";
import { PrismaComparisonOperationRepository } from "./PrismaComparisonOperationRepository";
import type { PrismaClient } from "@prisma/client";
import { STATISTICS_LIMITS } from "@/src/domain/entities/DocumentStatistics";
import type { CreateComparisonOperationInput } from "@/src/application/ports/workspaces/ComparisonOperationRepository";

interface OperationRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  leftVersionId: string;
  rightVersionId: string;
  type: string;
  status: string;
  progress: number;
  requestedById: string;
  cancelRequestedAt: Date | null;
  error: string | null;
  resultId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    // `{ in: [...] }` is the only set predicate this adapter uses.
    if ("in" in (expected as object)) {
      return (expected as { in: unknown[] }).in.includes(actual);
    }
    return false;
  }
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

/**
 * Applies only the predicates the adapter supplied.
 *
 * If the adapter dropped `workspaceId` or `status` from a `where` clause, this
 * matcher would stop filtering on it and the scoping and compare-and-swap tests
 * below would fail rather than pass on the fake's goodwill.
 */
function matches(row: OperationRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof OperationRow], v));
}

function fakePrisma(rows: OperationRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const takes: Array<number | undefined> = [];
  const orderBys: unknown[] = [];

  const delegate = {
    async create({ data }: { data: Partial<OperationRow> }) {
      seq += 1;
      const now = new Date(Date.UTC(2026, 7, 4, 12, 0, seq));
      const row: OperationRow = {
        id: `cmp-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        leftVersionId: data.leftVersionId!,
        rightVersionId: data.rightVersionId!,
        type: data.type!,
        // Defaults belong to the schema, not to the caller.
        status: "pending",
        progress: 0,
        requestedById: data.requestedById!,
        cancelRequestedAt: null,
        error: null,
        resultId: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findMany({
      where,
      take,
      orderBy,
    }: {
      where: Record<string, unknown>;
      take?: number;
      orderBy?: unknown;
    }) {
      wheres.push(where);
      takes.push(take);
      orderBys.push(orderBy);
      const found = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      return take === undefined ? found : found.slice(0, take);
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      wheres.push(where);
      const found = rows.filter((r) => matches(r, where));
      seq += 1;
      for (const row of found) {
        if ("status" in data) row.status = data.status as string;
        if ("progress" in data) row.progress = data.progress as number;
        if ("error" in data) row.error = data.error as string | null;
        if ("resultId" in data) row.resultId = data.resultId as string | null;
        if ("startedAt" in data) row.startedAt = data.startedAt as Date | null;
        if ("completedAt" in data) row.completedAt = data.completedAt as Date | null;
        if ("cancelRequestedAt" in data) {
          row.cancelRequestedAt = data.cancelRequestedAt as Date | null;
        }
        row.updatedAt = new Date(Date.UTC(2026, 7, 4, 12, 0, seq));
      }
      return { count: found.length };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return rows.filter((r) => matches(r, where)).length;
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: removed };
    },
  };

  return {
    prisma: { comparisonOperation: delegate } as unknown as PrismaClient,
    wheres,
    takes,
    orderBys,
  };
}

function draft(
  overrides: Partial<CreateComparisonOperationInput> = {},
): CreateComparisonOperationInput {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    leftVersionId: "ver-1",
    rightVersionId: "ver-2",
    type: "textual",
    requestedById: "user-1",
    ...overrides,
  };
}

describe("PrismaComparisonOperationRepository", () => {
  it("creates a real operation with schema defaults", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);

    const operation = await repo.create(draft());
    expect(operation.status).toBe("pending");
    expect(operation.progress).toBe(0);
    expect(operation.leftVersionId).toBe("ver-1");
    expect(operation.rightVersionId).toBe("ver-2");
    expect(operation.requestedById).toBe("user-1");
    expect(operation.resultId).toBeNull();
  });

  it("scopes lookup by Workspace", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    expect(await repo.getById("ws-1", created.id)).not.toBeNull();
    expect(await repo.getById("ws-other", created.id)).toBeNull();
  });

  it("scopes the listing by document", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    await repo.create(draft());
    await repo.create(draft({ documentId: "doc-2" }));
    await repo.create(draft({ workspaceId: "ws-other" }));

    const listed = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 25 });
    expect(listed).toHaveLength(1);
    expect(listed[0].documentId).toBe("doc-1");
  });

  it("bounds the listing at the domain cap", async () => {
    const rows: OperationRow[] = [];
    const { prisma, takes } = fakePrisma(rows);
    const repo = new PrismaComparisonOperationRepository(prisma);

    await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 10_000 });
    expect(takes.at(-1)).toBe(STATISTICS_LIMITS.maxListLimit);
  });

  it("orders newest first deterministically", async () => {
    const rows: OperationRow[] = [];
    const { prisma, orderBys } = fakePrisma(rows);
    const repo = new PrismaComparisonOperationRepository(prisma);
    const first = await repo.create(draft());
    const second = await repo.create(draft());

    const listed = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 25 });
    expect(listed.map((o) => o.id)).toEqual([second.id, first.id]);
    // A tiebreaker on id keeps the order stable when timestamps collide.
    expect(orderBys.at(-1)).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("parses a valid status and type", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft({ type: "structural" }));
    rows[0].status = "running";

    const read = await repo.getById("ws-1", created.id);
    expect(read?.status).toBe("running");
    expect(read?.type).toBe("structural");
  });

  it("degrades an unknown status and type safely", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    rows[0].status = "levitating";
    rows[0].type = "olfactory";

    const read = await repo.getById("ws-1", created.id);
    // Neither is trusted: an unknown status must not read as completed, and an
    // unknown type must not widen the union.
    expect(read?.status).toBe("pending");
    expect(read?.type).toBe("structural");
  });

  it("transitions on a compare-and-swap of the current status", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    const started = await repo.transition("ws-1", created.id, "pending", "running", {
      progress: 0,
      startedAt: new Date("2026-08-04T10:00:00.000Z"),
    });
    expect(started?.status).toBe("running");
    expect(started?.startedAt).not.toBeNull();
  });

  it("returns null for a stale transition", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    await repo.transition("ws-1", created.id, "pending", "running", {});

    // The expected status no longer holds, so the swap matches nothing.
    const stale = await repo.transition("ws-1", created.id, "pending", "cancelled", {});
    expect(stale).toBeNull();
    expect(rows[0].status).toBe("running");
  });

  it("makes a duplicate transition idempotent", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    await repo.transition("ws-1", created.id, "pending", "running", {});
    const first = await repo.transition("ws-1", created.id, "running", "completed", {
      resultId: "res-1",
      progress: 100,
    });
    const second = await repo.transition("ws-1", created.id, "running", "completed", {
      resultId: "res-2",
    });

    expect(first?.status).toBe("completed");
    // The redelivered completion changed nothing — including the result id.
    expect(second).toBeNull();
    expect(rows[0].resultId).toBe("res-1");
  });

  it("records progress only in active states", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    await repo.transition("ws-1", created.id, "pending", "running", {});

    expect((await repo.reportProgress("ws-1", created.id, 55))?.progress).toBe(55);

    await repo.transition("ws-1", created.id, "running", "failed", { error: "broke" });
    // Terminal: a slow worker must not animate a finished operation.
    expect(await repo.reportProgress("ws-1", created.id, 90)).toBeNull();
  });

  it("makes a cancellation request idempotent", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    const first = new Date("2026-08-04T10:00:00.000Z");
    const second = new Date("2026-08-04T11:00:00.000Z");
    const one = await repo.requestCancellation("ws-1", created.id, first);
    const two = await repo.requestCancellation("ws-1", created.id, second);

    expect(one?.cancelRequestedAt?.toISOString()).toBe(first.toISOString());
    // A repeat request reads as success but leaves the original timestamp: the
    // first request is the one that counts.
    expect(two?.cancelRequestedAt?.toISOString()).toBe(first.toISOString());
  });

  it("refuses a cancellation request once terminal", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());
    await repo.transition("ws-1", created.id, "pending", "running", {});
    await repo.transition("ws-1", created.id, "running", "completed", { resultId: "res-1" });

    expect(await repo.requestCancellation("ws-1", created.id, new Date())).toBeNull();
    expect(rows[0].cancelRequestedAt).toBeNull();
  });

  it("counts active operations scoped to the Workspace and document", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const a = await repo.create(draft());
    await repo.create(draft());
    await repo.create(draft({ documentId: "doc-2" }));
    await repo.create(draft({ workspaceId: "ws-other" }));

    expect(await repo.countActiveForDocument("ws-1", "doc-1")).toBe(2);

    // A terminal operation stops counting against the active limit.
    await repo.transition("ws-1", a.id, "pending", "cancelled", {});
    expect(await repo.countActiveForDocument("ws-1", "doc-1")).toBe(1);
  });

  it("scopes deletion by Workspace", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    expect(await repo.delete("ws-other", created.id)).toBe(false);
    expect(rows).toHaveLength(1);
    expect(await repo.delete("ws-1", created.id)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("returns dates and objects that cannot mutate stored rows", async () => {
    const rows: OperationRow[] = [];
    const repo = new PrismaComparisonOperationRepository(fakePrisma(rows).prisma);
    const created = await repo.create(draft());

    created.createdAt.setFullYear(1999);
    created.progress = 77;

    const reread = await repo.getById("ws-1", created.id);
    expect(reread?.createdAt.getFullYear()).toBe(2026);
    expect(reread?.progress).toBe(0);
  });
});
