import { describe, expect, it } from "vitest";
import { PrismaCommentThreadRepository } from "./PrismaCommentThreadRepository";
import type { PrismaClient } from "@prisma/client";
import { COLLABORATION_LIMITS } from "@/src/domain/entities/Collaboration";
import type { CreateCommentThreadInput } from "@/src/application/ports/workspaces/CommentThreadRepository";

interface ThreadRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  versionId: string | null;
  anchorType: string;
  anchor: string;
  anchorSchemaVersion: number;
  pageNumber: number | null;
  status: string;
  createdById: string;
  resolvedById: string | null;
  resolvedAt: Date | null;
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
    // Range predicates ({ lt: Date }) are the only object form used here.
    if ("lt" in (expected as object)) {
      const bound = (expected as { lt: Date }).lt;
      return actual instanceof Date && actual.getTime() < bound.getTime();
    }
    return false;
  }
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function matches(row: ThreadRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof ThreadRow], v));
}

function fakePrisma(rows: ThreadRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const takes: Array<number | undefined> = [];
  const record = <T extends Record<string, unknown>>(w: T): T => {
    wheres.push(w);
    return w;
  };

  const delegate = {
    async create({ data }: { data: Partial<ThreadRow> }) {
      seq += 1;
      const now = new Date(Date.UTC(2026, 7, 3, 12, 0, seq));
      const row: ThreadRow = {
        id: `th-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        versionId: data.versionId ?? null,
        anchorType: data.anchorType ?? "document",
        anchor: data.anchor ?? '{"type":"document"}',
        anchorSchemaVersion: data.anchorSchemaVersion ?? 1,
        pageNumber: data.pageNumber ?? null,
        status: "open",
        createdById: data.createdById!,
        resolvedById: null,
        resolvedAt: null,
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
    async findMany({ where, take }: { where: Record<string, unknown>; take?: number }) {
      record(where);
      takes.push(take);
      const found = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      return take === undefined ? found : found.slice(0, take);
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      record(where);
      const found = rows.filter((r) => matches(r, where));
      for (const row of found) {
        if ("status" in data) row.status = data.status as string;
        if ("resolvedById" in data) row.resolvedById = data.resolvedById as string | null;
        if ("resolvedAt" in data) row.resolvedAt = data.resolvedAt as Date | null;
        if ("revision" in data) row.revision = applyIncrement(row.revision, data.revision);
      }
      return { count: found.length };
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      record(where);
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: removed };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      record(where);
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  return { prisma: { commentThread: delegate } as unknown as PrismaClient, wheres, takes };
}

function draft(overrides: Partial<CreateCommentThreadInput> = {}): CreateCommentThreadInput {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    anchorType: "page",
    anchor: JSON.stringify({ type: "page", pageNumber: 3 }),
    anchorSchemaVersion: 1,
    pageNumber: 3,
    createdById: "user-1",
    ...overrides,
  };
}

describe("PrismaCommentThreadRepository", () => {
  it("persists every supplied field", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);

    const thread = await repo.create(draft());
    expect(thread.organizationId).toBe("org-1");
    expect(thread.documentId).toBe("doc-1");
    expect(thread.versionId).toBe("ver-1");
    expect(thread.anchorType).toBe("page");
    expect(thread.anchor).toEqual({ type: "page", pageNumber: 3 });
    expect(thread.pageNumber).toBe(3);
    expect(thread.status).toBe("open");
    expect(thread.revision).toBe(1);
  });

  it("scopes every read by Workspace so a cross-tenant id reads as missing", async () => {
    const rows: ThreadRow[] = [];
    const { prisma, wheres } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);

    const thread = await repo.create(draft());
    expect(await repo.getById("ws-other", thread.id)).toBeNull();
    expect(await repo.getById("ws-1", thread.id)).not.toBeNull();
    // Not merely the outcome: the predicate itself must carry the Workspace.
    expect(wheres.every((w) => "workspaceId" in w)).toBe(true);
  });

  it("changes status only when the expected revision matches", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const thread = await repo.create(draft());

    const stale = await repo.setStatus("ws-1", thread.id, 99, "resolved", "user-2", new Date());
    expect(stale).toBeNull();

    const resolved = await repo.setStatus(
      "ws-1",
      thread.id,
      thread.revision,
      "resolved",
      "user-2",
      new Date("2026-08-03T13:00:00.000Z"),
    );
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedById).toBe("user-2");
    expect(resolved?.revision).toBe(thread.revision + 1);
  });

  it("clears the resolver when a thread is reopened", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const thread = await repo.create(draft());
    const resolved = await repo.setStatus(
      "ws-1",
      thread.id,
      thread.revision,
      "resolved",
      "user-2",
      new Date(),
    );
    const reopened = await repo.setStatus(
      "ws-1",
      thread.id,
      resolved!.revision,
      "open",
      "user-2",
      null,
    );
    // A stale resolver on an open thread would misreport who settled it.
    expect(reopened?.resolvedById).toBeNull();
    expect(reopened?.resolvedAt).toBeNull();
  });

  it("refuses a cross-Workspace status change", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const thread = await repo.create(draft());
    expect(
      await repo.setStatus("ws-other", thread.id, thread.revision, "resolved", "user-2", new Date()),
    ).toBeNull();
  });

  it("filters a listing by status and page", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    await repo.create(draft({ pageNumber: 1, anchorType: "page" }));
    const second = await repo.create(draft({ pageNumber: 7, anchorType: "page" }));
    await repo.setStatus("ws-1", second.id, second.revision, "resolved", "user-2", new Date());

    const open = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", status: "open", limit: 10 });
    expect(open).toHaveLength(1);
    const page7 = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", pageNumber: 7, limit: 10 });
    expect(page7).toHaveLength(1);
    expect(page7[0].pageNumber).toBe(7);
  });

  it("orders a listing newest first", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const first = await repo.create(draft());
    const second = await repo.create(draft());
    const listed = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 10 });
    expect(listed.map((t) => t.id)).toEqual([second.id, first.id]);
  });

  it("clamps a listing to the domain cap even when asked for more", async () => {
    const rows: ThreadRow[] = [];
    const { prisma, takes } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    await repo.create(draft());
    await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 100_000 });
    expect(takes.at(-1)).toBe(COLLABORATION_LIMITS.maxListLimit);
  });

  it("degrades an unreadable stored anchor to document scope", async () => {
    // A row written by another build must not fail the whole listing.
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    await repo.create(draft({ anchor: "not json at all", anchorType: "page" }));
    const listed = await repo.list({ workspaceId: "ws-1", documentId: "doc-1", limit: 10 });
    expect(listed[0].anchor).toEqual({ type: "document" });
  });

  it("degrades an unknown stored status and anchor type rather than trusting them", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const thread = await repo.create(draft());
    rows[0].status = "quantum";
    rows[0].anchorType = "wormhole";
    const reread = await repo.getById("ws-1", thread.id);
    expect(reread?.status).toBe("open");
    expect(reread?.anchorType).toBe("document");
  });

  it("deletes only within the Workspace", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const thread = await repo.create(draft());
    expect(await repo.delete("ws-other", thread.id)).toBe(false);
    expect(await repo.delete("ws-1", thread.id)).toBe(true);
    expect(await repo.getById("ws-1", thread.id)).toBeNull();
  });

  it("counts a document's threads within the Workspace", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    await repo.create(draft());
    await repo.create(draft());
    await repo.create(draft({ documentId: "doc-2" }));
    expect(await repo.countForDocument("ws-1", "doc-1")).toBe(2);
    expect(await repo.countForDocument("ws-other", "doc-1")).toBe(0);
  });

  it("returns independent date objects on every read", async () => {
    const rows: ThreadRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentThreadRepository(prisma);
    const thread = await repo.create(draft());
    thread.createdAt.setFullYear(1999);
    const reread = await repo.getById("ws-1", thread.id);
    expect(reread?.createdAt.getFullYear()).not.toBe(1999);
  });
});
