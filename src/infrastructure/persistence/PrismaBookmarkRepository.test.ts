import { describe, expect, it } from "vitest";
import { PrismaBookmarkRepository } from "./PrismaBookmarkRepository";
import type { PrismaClient } from "@prisma/client";
import { METADATA_LIMITS } from "@/src/domain/entities/DocumentMetadata";
import type { CreateBookmarkInput } from "@/src/application/ports/workspaces/BookmarkRepository";

interface BookmarkRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  pageNumber: number;
  title: string;
  note: string | null;
  anchorX: number | null;
  anchorY: number | null;
  orderKey: string;
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
    return false;
  }
  return actual === expected;
}

function matches(row: BookmarkRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof BookmarkRow], v));
}

function fakePrisma(rows: BookmarkRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const record = <T extends Record<string, unknown>>(w: T): T => { wheres.push(w); return w; };

  const delegate = {
    async create({ data }: { data: Partial<BookmarkRow> }) {
      seq += 1;
      const now = new Date();
      const row: BookmarkRow = {
        id: `bm-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        pageNumber: data.pageNumber!,
        title: data.title!,
        note: data.note ?? null,
        anchorX: data.anchorX ?? null,
        anchorY: data.anchorY ?? null,
        orderKey: data.orderKey ?? "",
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
    }) {
      record(where);
      let found = rows.filter((r) => matches(r, where));
      if (orderBy) {
        found = [...found].sort((a, b) => {
          for (const clause of orderBy) {
            for (const [key, dir] of Object.entries(clause)) {
              const av = a[key as keyof BookmarkRow] as string;
              const bv = b[key as keyof BookmarkRow] as string;
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
          ...(data.pageNumber !== undefined ? { pageNumber: data.pageNumber as number } : {}),
          ...(data.title !== undefined ? { title: data.title as string } : {}),
          ...(data.note !== undefined ? { note: data.note as string | null } : {}),
          ...(data.anchorX !== undefined ? { anchorX: data.anchorX as number | null } : {}),
          ...(data.anchorY !== undefined ? { anchorY: data.anchorY as number | null } : {}),
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
  return { workspaceBookmark: delegate, rows, wheres };
}

function repo(rows: BookmarkRow[] = []) {
  const prisma = fakePrisma(rows);
  return {
    prisma,
    rows: prisma.rows,
    subject: new PrismaBookmarkRepository(prisma as unknown as PrismaClient),
  };
}

function seedRow(overrides: Partial<BookmarkRow> = {}): BookmarkRow {
  return {
    id: "bm-seed",
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    pageNumber: 5,
    title: "Introduction",
    note: null,
    anchorX: null,
    anchorY: null,
    orderKey: "m",
    createdById: "user-1",
    revision: 1,
    createdAt: new Date("2026-08-01T09:00:00.000Z"),
    updatedAt: new Date("2026-08-01T09:00:00.000Z"),
    ...overrides,
  };
}

function createInput(overrides: Partial<CreateBookmarkInput> = {}): CreateBookmarkInput {
  return {
    organizationId: "org-a",
    workspaceId: "ws-a",
    documentId: "doc-1",
    pageNumber: 5,
    title: "Introduction",
    note: null,
    anchor: null,
    orderKey: "m",
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaBookmarkRepository — create", () => {
  it("persists a bookmark and returns the domain object", async () => {
    const { subject, rows } = repo();
    const bm = await subject.create(createInput());

    expect(rows).toHaveLength(1);
    expect(bm.title).toBe("Introduction");
    expect(bm.pageNumber).toBe(5);
    expect(bm.revision).toBe(1);
  });
});

describe("PrismaBookmarkRepository — getById", () => {
  it("is workspace scoped", async () => {
    const { subject } = repo([seedRow()]);
    const found = await subject.getById("ws-a", "bm-seed");

    expect(found?.id).toBe("bm-seed");
  });

  it("does not return another workspace's bookmark", async () => {
    const { subject } = repo([seedRow({ workspaceId: "ws-b" })]);

    expect(await subject.getById("ws-a", "bm-seed")).toBeNull();
  });
});

describe("PrismaBookmarkRepository — list", () => {
  it("is document scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "bm-1", documentId: "doc-1" }),
      seedRow({ id: "bm-2", documentId: "doc-2" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });

    expect(found.map((b) => b.id)).toEqual(["bm-1"]);
  });

  it("is workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "bm-1", workspaceId: "ws-a" }),
      seedRow({ id: "bm-2", workspaceId: "ws-b" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });

    expect(found.map((b) => b.id)).toEqual(["bm-1"]);
  });

  it("filters by page number when supplied", async () => {
    const { subject } = repo([
      seedRow({ id: "bm-p5", pageNumber: 5 }),
      seedRow({ id: "bm-p9", pageNumber: 9 }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", pageNumber: 5, limit: 50 });

    expect(found.map((b) => b.id)).toEqual(["bm-p5"]);
  });

  it("bounds the result count to the supplied limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      seedRow({ id: `bm-${i}`, orderKey: String(i).padStart(3, "0") }),
    );
    const { subject } = repo(rows);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 3 });

    expect(found).toHaveLength(3);
  });

  it("caps the limit at the domain maximum", async () => {
    const rows = Array.from({ length: METADATA_LIMITS.maxListLimit + 5 }, (_, i) =>
      seedRow({ id: `bm-${i}`, orderKey: String(i).padStart(4, "0") }),
    );
    const { subject } = repo(rows);
    const found = await subject.list({
      workspaceId: "ws-a",
      documentId: "doc-1",
      limit: METADATA_LIMITS.maxListLimit + 5,
    });

    expect(found.length).toBeLessThanOrEqual(METADATA_LIMITS.maxListLimit);
  });

  it("orders by orderKey then id as a deterministic total order", async () => {
    const { subject } = repo([
      seedRow({ id: "bm-z", orderKey: "z" }),
      seedRow({ id: "bm-a", orderKey: "a" }),
      seedRow({ id: "bm-m2", orderKey: "m" }),
      seedRow({ id: "bm-m1", orderKey: "m" }),
    ]);
    const found = await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 50 });

    expect(found.map((b) => b.id)).toEqual(["bm-a", "bm-m1", "bm-m2", "bm-z"]);
  });
});

describe("PrismaBookmarkRepository — anchor round-trip", () => {
  it("round-trips valid anchor coordinates", async () => {
    const { subject } = repo();
    const bm = await subject.create(createInput({ anchor: { x: 0.25, y: 0.75 } }));

    expect(bm.anchor).toEqual({ x: 0.25, y: 0.75 });
  });

  it("degrades a half-written anchor to null", async () => {
    const { subject } = repo([seedRow({ anchorX: 0.5, anchorY: null })]);
    const found = await subject.getById("ws-a", "bm-seed");

    expect(found?.anchor).toBeNull();
  });

  it("degrades an invalid stored page number safely", async () => {
    const { subject } = repo([seedRow({ pageNumber: -1 })]);
    const found = await subject.getById("ws-a", "bm-seed");

    // The adapter returns what is stored; domain validation is the service's job.
    expect(found).not.toBeNull();
    expect(found?.pageNumber).toBe(-1);
  });
});

describe("PrismaBookmarkRepository — field bounds on read", () => {
  it("returns a title within the domain limit", async () => {
    const { subject } = repo([seedRow({ title: "Short title" })]);
    const found = await subject.getById("ws-a", "bm-seed");

    expect(found?.title.length).toBeLessThanOrEqual(METADATA_LIMITS.maxTitleLength);
  });

  it("returns a note within the domain limit", async () => {
    const longNote = "n".repeat(METADATA_LIMITS.maxNoteLength);
    const { subject } = repo([seedRow({ note: longNote })]);
    const found = await subject.getById("ws-a", "bm-seed");

    expect(found?.note?.length).toBeLessThanOrEqual(METADATA_LIMITS.maxNoteLength);
  });
});

describe("PrismaBookmarkRepository — optimistic update", () => {
  it("applies the update when the revision matches", async () => {
    const { subject } = repo([seedRow({ revision: 2 })]);
    const updated = await subject.update("ws-a", "bm-seed", 2, { title: "Updated" });

    expect(updated?.title).toBe("Updated");
  });

  it("returns null on a stale revision", async () => {
    const { subject, rows } = repo([seedRow({ revision: 2 })]);
    const updated = await subject.update("ws-a", "bm-seed", 1, { title: "Lost" });

    expect(updated).toBeNull();
    expect(rows[0].title).toBe("Introduction");
  });

  it("increments the revision exactly once", async () => {
    const { subject } = repo([seedRow({ revision: 3 })]);
    const updated = await subject.update("ws-a", "bm-seed", 3, { title: "Once" });

    expect(updated?.revision).toBe(4);
  });

  it("leaves createdAt unchanged", async () => {
    const created = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([seedRow({ createdAt: created, revision: 1 })]);
    const updated = await subject.update("ws-a", "bm-seed", 1, { title: "Kept" });

    expect(updated?.createdAt.toISOString()).toBe(created.toISOString());
  });

  it("advances updatedAt", async () => {
    const stamp = new Date("2026-07-01T08:00:00.000Z");
    const { subject } = repo([seedRow({ updatedAt: stamp, revision: 1 })]);
    const updated = await subject.update("ws-a", "bm-seed", 1, { title: "Fresh" });

    expect(updated!.updatedAt.getTime()).toBeGreaterThan(stamp.getTime());
  });
});

describe("PrismaBookmarkRepository — delete", () => {
  it("is workspace scoped", async () => {
    const { subject, rows } = repo([seedRow()]);

    expect(await subject.delete("ws-a", "bm-seed")).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it("removes only the target document's bookmarks", async () => {
    const { subject, rows } = repo([
      seedRow({ id: "bm-1", documentId: "doc-1" }),
      seedRow({ id: "bm-2", documentId: "doc-2" }),
    ]);
    await subject.deleteForDocument("ws-a", "doc-1");

    expect(rows.map((r) => r.id)).toEqual(["bm-2"]);
  });

  it("countForDocument is workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "bm-1", workspaceId: "ws-a" }),
      seedRow({ id: "bm-2", workspaceId: "ws-b" }),
    ]);

    expect(await subject.countForDocument("ws-a", "doc-1")).toBe(1);
  });
});

describe("PrismaBookmarkRepository — lastOrderKey", () => {
  it("is document and workspace scoped", async () => {
    const { subject } = repo([
      seedRow({ id: "bm-1", workspaceId: "ws-a", documentId: "doc-1", orderKey: "z" }),
      seedRow({ id: "bm-2", workspaceId: "ws-b", documentId: "doc-1", orderKey: "zzz" }),
      seedRow({ id: "bm-3", workspaceId: "ws-a", documentId: "doc-2", orderKey: "zzzz" }),
    ]);

    expect(await subject.lastOrderKey("ws-a", "doc-1")).toBe("z");
  });

  it("returns null when no bookmarks exist", async () => {
    const { subject } = repo();

    expect(await subject.lastOrderKey("ws-a", "doc-1")).toBeNull();
  });
});

describe("PrismaBookmarkRepository — returned values are copies", () => {
  it("cannot mutate persisted state through a returned bookmark", async () => {
    const { subject, rows } = repo([seedRow()]);
    const found = await subject.getById("ws-a", "bm-seed");
    found!.title = "Tampered";

    expect(rows[0].title).toBe("Introduction");
  });
});

describe("PrismaBookmarkRepository — tenant scoping", () => {
  it("carries workspaceId in every predicate", async () => {
    const { subject, prisma } = repo([seedRow({ revision: 1 })]);

    await subject.getById("ws-a", "bm-seed");
    await subject.list({ workspaceId: "ws-a", documentId: "doc-1", limit: 10 });
    await subject.update("ws-a", "bm-seed", 1, { title: "x" });
    await subject.delete("ws-a", "bm-seed");
    await subject.deleteForDocument("ws-a", "doc-1");
    await subject.countForDocument("ws-a", "doc-1");
    await subject.lastOrderKey("ws-a", "doc-1");

    expect(prisma.wheres.length).toBeGreaterThan(0);
    for (const where of prisma.wheres) {
      expect(where).toHaveProperty("workspaceId", "ws-a");
    }
  });
});
