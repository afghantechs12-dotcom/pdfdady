import { describe, expect, it } from "vitest";
import { PrismaOutlineItemRepository } from "./PrismaOutlineItemRepository";
import type { PrismaClient } from "@prisma/client";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type { CreateOutlineItemInput } from "@/src/application/ports/workspaces/OutlineItemRepository";

interface OutlineRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  parentId: string | null;
  title: string;
  pageNumber: number;
  depth: number;
  orderKey: string;
  origin: string;
  createdById: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

function applyIncrement(current: number, op: unknown): number {
  if (op !== null && typeof op === "object" && "increment" in op) {
    return current + (op as { increment: number }).increment;
  }
  return typeof op === "number" ? op : current;
}

function matchValue(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === "object" && !(expected instanceof Date)) {
    const ops = expected as Record<string, unknown>;
    if ("in" in ops) return Array.isArray(ops.in) && (ops.in as unknown[]).includes(actual);
    return false;
  }
  return actual === expected;
}

function matches(row: OutlineRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof OutlineRow], v));
}

function fakePrisma(rows: OutlineRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const stats = { transactions: 0 };
  const record = <T extends Record<string, unknown>>(w: T): T => { wheres.push(w); return w; };

  const delegate = {
    async create({ data }: { data: Partial<OutlineRow> }) {
      seq += 1;
      const now = new Date();
      const row: OutlineRow = {
        id: `out-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        parentId: data.parentId ?? null,
        title: data.title!,
        pageNumber: data.pageNumber!,
        depth: data.depth ?? 0,
        orderKey: data.orderKey ?? "",
        origin: data.origin ?? "workspace",
        createdById: data.createdById!,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      record(where);
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findMany({
      where,
      orderBy,
      take,
    }: {
      where: Record<string, unknown>;
      orderBy?: Array<Record<string, "asc" | "desc">>;
      take?: number;
      select?: unknown;
    }) {
      record(where);
      let found = rows.filter((r) => matches(r, where));
      // Sorted only when the adapter asks: an implicit ordering in the fake
      // would let an adapter that forgot `orderBy` still look deterministic.
      if (orderBy) {
        found = [...found].sort((a, b) => {
          for (const clause of orderBy) {
            for (const [key, dir] of Object.entries(clause)) {
              const av = a[key as keyof OutlineRow] as string;
              const bv = b[key as keyof OutlineRow] as string;
              const cmp = av < bv ? -1 : av > bv ? 1 : 0;
              if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
            }
          }
          return 0;
        });
      }
      return take === undefined ? found : found.slice(0, take);
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      record(where);
      const matched = rows.filter((r) => matches(r, where));
      const now = new Date();
      for (const row of matched) {
        const idx = rows.indexOf(row);
        rows[idx] = {
          ...row,
          ...(data.title !== undefined ? { title: data.title as string } : {}),
          ...(data.pageNumber !== undefined ? { pageNumber: data.pageNumber as number } : {}),
          ...(data.parentId !== undefined ? { parentId: data.parentId as string | null } : {}),
          ...(data.depth !== undefined ? { depth: data.depth as number } : {}),
          ...(data.orderKey !== undefined ? { orderKey: data.orderKey as string } : {}),
          revision: applyIncrement(row.revision, data.revision ?? row.revision),
          updatedAt: now,
        };
      }
      return { count: matched.length };
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      record(where);
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      record(where);
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  return {
    outlineItem: delegate,
    rows,
    wheres,
    stats,
    async $transaction<T>(fn: (tx: { outlineItem: typeof delegate }) => Promise<T>): Promise<T> {
      stats.transactions += 1;
      return fn({ outlineItem: delegate });
    },
  };
}

function repo(rows: OutlineRow[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    rows: prisma.rows,
    subject: new PrismaOutlineItemRepository(prisma as unknown as PrismaClient),
  };
}

function seedRow(overrides: Partial<OutlineRow> = {}): OutlineRow {
  return {
    id: "out-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    parentId: null,
    title: "Chapter 1",
    pageNumber: 1,
    depth: 0,
    orderKey: "m",
    origin: "workspace",
    createdById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    updatedAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateOutlineItemInput> = {}): CreateOutlineItemInput {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    parentId: null,
    title: "Chapter 1",
    pageNumber: 1,
    depth: 0,
    orderKey: "m",
    origin: "workspace",
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaOutlineItemRepository — create", () => {
  it("creates a root item", async () => {
    const { subject, rows } = repo();
    const item = await subject.create(createInput());

    expect(rows).toHaveLength(1);
    expect(item.parentId).toBeNull();
    expect(item.depth).toBe(0);
  });

  it("creates a child item under a parent", async () => {
    const { subject } = repo([seedRow({ id: "out-parent" })]);
    const child = await subject.create(
      createInput({ parentId: "out-parent", depth: 1, title: "Section 1.1" }),
    );

    expect(child.parentId).toBe("out-parent");
    expect(child.depth).toBe(1);
  });
});

describe("PrismaOutlineItemRepository — reads", () => {
  it("getById is workspace scoped", async () => {
    const { subject } = repo([seedRow()]);

    expect((await subject.getById("ws-a", "out-seed"))?.id).toBe("out-seed");
    expect(await subject.getById("ws-b", "out-seed")).toBeNull();
  });

  it("list is document scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "o1", documentId: "doc-1" }),
      seedRow({ id: "o2", documentId: "doc-2" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 100 });

    expect(found.map((i) => i.id)).toEqual(["o1"]);
  });

  it("list is workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "o1", workspaceId: "ws-a" }),
      seedRow({ id: "o2", workspaceId: "ws-b" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 100 });

    expect(found.map((i) => i.id)).toEqual(["o1"]);
  });

  it("filters by origin", async () => {
    const { subject } = repo([
      seedRow({ id: "o-ws", origin: "workspace", orderKey: "a" }),
      seedRow({ id: "o-emb", origin: "embedded", orderKey: "b" }),
    ]);
    const embedded = await subject.list({
      workspaceId: "ws-a",
      documentId: "doc-1",
      origin: "embedded",
      limit: 100,
    });

    expect(embedded.map((i) => i.id)).toEqual(["o-emb"]);
  });

  it("bounds the listing to the domain outline cap", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      seedRow({ id: `o-${i}`, orderKey: String(i).padStart(3, "0") }),
    );
    const { subject } = repo(rows);
    const found = await subject.list({
      workspaceId: "ws-a",
      documentId: "doc-1",
      limit: METADATA_LIMITS.maxOutlineItems + 500,
    });

    expect(found.length).toBeLessThanOrEqual(METADATA_LIMITS.maxOutlineItems);
    expect(found).toHaveLength(12);
  });

  it("orders by orderKey then id as a deterministic total order", async () => {
    const { subject } = repo([
      seedRow({ id: "o-z", orderKey: "z" }),
      seedRow({ id: "o-m2", orderKey: "m" }),
      seedRow({ id: "o-m1", orderKey: "m" }),
      seedRow({ id: "o-a", orderKey: "a" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 100 });

    expect(found.map((i) => i.id)).toEqual(["o-a", "o-m1", "o-m2", "o-z"]);
  });

  it("resolves a parent lookup within the workspace only", async () => {
    const { subject } = repo([seedRow({ id: "out-parent", workspaceId: "ws-b" })]);

    // A parent in another Workspace reads as missing, so a service cannot accept
    // it as a placement target.
    expect(await subject.getById("ws-a", "out-parent")).toBeNull();
  });

  it("does not surface another document's parent in the document listing", async () => {
    const { subject } = repo([
      seedRow({ id: "o-here", documentId: "doc-1" }),
      seedRow({ id: "o-there", documentId: "doc-2" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 100 });

    expect(found.some((i) => i.id === "o-there")).toBe(false);
  });
});

describe("PrismaOutlineItemRepository — degraded stored values", () => {
  it("degrades an unknown stored origin to the read-only embedded side", async () => {
    const { subject } = repo([seedRow({ origin: "something-new" })]);
    const found = await subject.getById("ws-a", "out-seed");

    // Failing closed matters here: presenting an unknown row as workspace-owned
    // would offer an edit that can never be written back into the PDF.
    expect(found?.origin).toBe("embedded");
  });

  it("normalizes a negative stored depth", async () => {
    const { subject } = repo([seedRow({ depth: -4 })]);

    expect((await subject.getById("ws-a", "out-seed"))?.depth).toBe(0);
  });

  it("clamps a stored depth beyond the maximum", async () => {
    const { subject } = repo([seedRow({ depth: 999 })]);

    expect((await subject.getById("ws-a", "out-seed"))?.depth).toBe(
      METADATA_LIMITS.maxOutlineDepth,
    );
  });

  it("returns an invalid stored page number without throwing", async () => {
    const { subject } = repo([seedRow({ pageNumber: 0 })]);
    const found = await subject.getById("ws-a", "out-seed");

    expect(found).not.toBeNull();
    expect(found?.pageNumber).toBe(0);
  });

  it("normalizes a nonsensical stored revision", async () => {
    const { subject } = repo([seedRow({ revision: 0 })]);

    expect((await subject.getById("ws-a", "out-seed"))?.revision).toBe(1);
  });
});

describe("PrismaOutlineItemRepository — optimistic update", () => {
  it("applies the update when the revision matches", async () => {
    const { subject } = repo([seedRow({ revision: 2 })]);
    const updated = await subject.update("ws-a", "out-seed", 2, { title: "Renamed" });

    expect(updated?.title).toBe("Renamed");
  });

  it("returns null on a stale revision", async () => {
    const { subject, rows } = repo([seedRow({ revision: 2 })]);

    expect(await subject.update("ws-a", "out-seed", 1, { title: "Lost" })).toBeNull();
    expect(rows[0].title).toBe("Chapter 1");
  });

  it("increments the revision exactly once", async () => {
    const { subject } = repo([seedRow({ revision: 4 })]);

    expect((await subject.update("ws-a", "out-seed", 4, { pageNumber: 7 }))?.revision).toBe(5);
  });

  it("preserves createdAt", async () => {
    const created = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([seedRow({ createdAt: created, revision: 1 })]);
    const updated = await subject.update("ws-a", "out-seed", 1, { title: "Kept" });

    expect(updated?.createdAt.toISOString()).toBe(created.toISOString());
  });

  it("advances updatedAt", async () => {
    const stamp = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([seedRow({ updatedAt: stamp, revision: 1 })]);
    const updated = await subject.update("ws-a", "out-seed", 1, { title: "Fresh" });

    expect(updated!.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  });
});

describe("PrismaOutlineItemRepository — deletion", () => {
  it("delete is workspace scoped", async () => {
    const { subject, rows } = repo([seedRow({ workspaceId: "ws-b" })]);

    expect(await subject.delete("ws-a", "out-seed")).toBe(false);
    expect(rows).toHaveLength(1);
  });

  it("deleteDescendants removes only descendants of the selected item", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "root", parentId: null }),
      seedRow({ id: "child", parentId: "root", depth: 1 }),
      seedRow({ id: "grandchild", parentId: "child", depth: 2 }),
    ]);
    const removed = await subject.deleteDescendants("ws-a", "doc-1", "root");

    // The item itself survives; only what hangs beneath it goes.
    expect(removed).toBe(2);
    expect(rows.map((r) => r.id)).toEqual(["root"]);
  });

  it("preserves sibling subtrees when one subtree is deleted", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "a", parentId: null }),
      seedRow({ id: "a1", parentId: "a", depth: 1 }),
      seedRow({ id: "b", parentId: null }),
      seedRow({ id: "b1", parentId: "b", depth: 1 }),
      seedRow({ id: "b2", parentId: "b1", depth: 2 }),
    ]);
    await subject.deleteDescendants("ws-a", "doc-1", "a");

    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "b1", "b2"]);
  });

  it("does not follow a parent link into another document", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "root", documentId: "doc-1", parentId: null }),
      seedRow({ id: "foreign", documentId: "doc-2", parentId: "root", depth: 1 }),
    ]);
    const removed = await subject.deleteDescendants("ws-a", "doc-1", "root");

    expect(removed).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it("terminates on a cycle in stored parent links", async () => {
    const { subject } = repo([
      seedRow({ id: "x", parentId: "y" }),
      seedRow({ id: "y", parentId: "x" }),
    ]);

    // A naive walk would loop forever here, and a deletion path is exactly where
    // that must not happen.
    const removed = await subject.deleteDescendants("ws-a", "doc-1", "x");
    expect(removed).toBe(1);
  });

  it("deleteDescendants is workspace scoped", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "root", workspaceId: "ws-b" }),
      seedRow({ id: "child", workspaceId: "ws-b", parentId: "root", depth: 1 }),
    ]);

    expect(await subject.deleteDescendants("ws-a", "doc-1", "root")).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it("deleteForDocument is workspace scoped", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "o1", workspaceId: "ws-a" }),
      seedRow({ id: "o2", workspaceId: "ws-b" }),
    ]);

    expect(await subject.deleteForDocument("ws-a", "doc-1")).toBe(1);
    expect(rows.map((r) => r.id)).toEqual(["o2"]);
  });
});

describe("PrismaOutlineItemRepository — counting and ordering keys", () => {
  it("countForDocument is workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "o1", workspaceId: "ws-a" }),
      seedRow({ id: "o2", workspaceId: "ws-b" }),
    ]);

    expect(await subject.countForDocument("ws-a", "doc-1")).toBe(1);
  });

  it("countForDocument narrows by origin when asked", async () => {
    const { subject } = repo([
      seedRow({ id: "o1", origin: "workspace" }),
      seedRow({ id: "o2", origin: "embedded" }),
    ]);

    expect(await subject.countForDocument("ws-a", "doc-1", "embedded")).toBe(1);
  });

  it("lastOrderKey scopes to the root when no parent is given", async () => {
    const { subject } = repo([
      seedRow({ id: "root-a", parentId: null, orderKey: "b" }),
      seedRow({ id: "child", parentId: "root-a", orderKey: "zzz", depth: 1 }),
    ]);

    // A child's key must not be mistaken for the last root key, or the next root
    // item would be appended after a position that belongs to another level.
    expect(await subject.lastOrderKey("ws-a", "doc-1", null)).toBe("b");
  });

  it("lastOrderKey scopes to a named parent", async () => {
    const { subject } = repo([
      seedRow({ id: "root-a", parentId: null, orderKey: "b" }),
      seedRow({ id: "c1", parentId: "root-a", orderKey: "d", depth: 1 }),
      seedRow({ id: "c2", parentId: "root-a", orderKey: "k", depth: 1 }),
    ]);

    expect(await subject.lastOrderKey("ws-a", "doc-1", "root-a")).toBe("k");
  });

  it("lastOrderKey returns null when the scope is empty", async () => {
    const { subject } = repo();

    expect(await subject.lastOrderKey("ws-a", "doc-1", null)).toBeNull();
  });
});

describe("PrismaOutlineItemRepository — origin-scoped replace", () => {
  it("replaces embedded items without touching workspace items", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "mine", origin: "workspace", orderKey: "a" }),
      seedRow({ id: "old-embedded", origin: "embedded", orderKey: "b" }),
    ]);
    await subject.replaceForDocument("ws-a", "doc-1", "embedded", [
      createInput({ origin: "embedded", title: "Fresh embedded", orderKey: "c" }),
    ]);

    const ids = rows.map((r) => r.id);
    expect(ids).toContain("mine");
    expect(ids).not.toContain("old-embedded");
  });

  it("replaces inside a transaction", async () => {
    const { subject, prisma } = repo();
    await subject.replaceForDocument("ws-a", "doc-1", "embedded", [
      createInput({ origin: "embedded" }),
    ]);

    // A re-inspection that failed midway must not leave a document showing a mix
    // of two files' outlines.
    expect(prisma.stats.transactions).toBe(1);
  });
});

describe("PrismaOutlineItemRepository — returned values are copies", () => {
  it("cannot mutate stored rows through a returned item", async () => {
    const { subject, rows } = repo([seedRow()]);
    const found = await subject.getById("ws-a", "out-seed");
    found!.title = "Tampered";
    found!.createdAt.setFullYear(1999);

    expect(rows[0].title).toBe("Chapter 1");
    expect(rows[0].createdAt.getUTCFullYear()).toBe(2026);
  });
});

describe("PrismaOutlineItemRepository — tenant scoping", () => {
  it("carries workspaceId in every predicate", async () => {
    const { subject, prisma } = repo([seedRow({ revision: 1 })]);

    await subject.getById("ws-a", "out-seed");
    await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 10 });
    await subject.update("ws-a", "out-seed", 1, { title: "x" });
    await subject.listChildren("ws-a", "out-seed");
    await subject.deleteDescendants("ws-a", "doc-1", "out-seed");
    await subject.countForDocument("ws-a", "doc-1");
    await subject.lastOrderKey("ws-a", "doc-1", null);
    await subject.delete("ws-a", "out-seed");
    await subject.deleteForDocument("ws-a", "doc-1");

    expect(prisma.wheres.length).toBeGreaterThan(0);
    for (const where of prisma.wheres) {
      expect(where).toHaveProperty("workspaceId", "ws-a");
    }
  });
});
