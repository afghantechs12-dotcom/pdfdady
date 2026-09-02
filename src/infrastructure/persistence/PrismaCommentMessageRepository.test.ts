import { describe, expect, it } from "vitest";
import { PrismaCommentMessageRepository } from "./PrismaCommentMessageRepository";
import type { PrismaClient } from "@prisma/client";
import { COLLABORATION_LIMITS } from "@/src/domain/entities/Collaboration";
import type { CreateCommentMessageInput } from "@/src/application/ports/workspaces/CommentMessageRepository";

interface MessageRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  documentId: string;
  threadId: string;
  authorId: string;
  parentMessageId: string | null;
  body: string;
  revision: number;
  editedAt: Date | null;
  deletedAt: Date | null;
  deletedById: string | null;
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
    if ("gt" in (expected as object)) {
      const bound = (expected as { gt: Date }).gt;
      return actual instanceof Date && actual.getTime() > bound.getTime();
    }
    return false;
  }
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  return actual === expected;
}

function matches(row: MessageRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => matchValue(row[k as keyof MessageRow], v));
}

function fakePrisma(rows: MessageRow[]) {
  let seq = 0;
  const wheres: Record<string, unknown>[] = [];
  const takes: Array<number | undefined> = [];

  const delegate = {
    async create({ data }: { data: Partial<MessageRow> }) {
      seq += 1;
      const now = new Date(Date.UTC(2026, 7, 3, 12, 0, seq));
      const row: MessageRow = {
        id: `msg-${seq}`,
        organizationId: data.organizationId!,
        workspaceId: data.workspaceId!,
        documentId: data.documentId!,
        threadId: data.threadId!,
        authorId: data.authorId!,
        parentMessageId: data.parentMessageId ?? null,
        body: data.body ?? "",
        revision: 1,
        editedAt: null,
        deletedAt: null,
        deletedById: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return rows.find((r) => matches(r, where)) ?? null;
    },
    async findMany({ where, take }: { where: Record<string, unknown>; take?: number }) {
      wheres.push(where);
      takes.push(take);
      const found = rows
        .filter((r) => matches(r, where))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
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
      for (const row of found) {
        if ("body" in data) row.body = data.body as string;
        if ("editedAt" in data) row.editedAt = data.editedAt as Date;
        if ("deletedAt" in data) row.deletedAt = data.deletedAt as Date;
        if ("deletedById" in data) row.deletedById = data.deletedById as string;
        if ("revision" in data) row.revision = applyIncrement(row.revision, data.revision);
      }
      return { count: found.length };
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      const keep = rows.filter((r) => !matches(r, where));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { count: removed };
    },
    async count({ where }: { where: Record<string, unknown> }) {
      wheres.push(where);
      return rows.filter((r) => matches(r, where)).length;
    },
  };

  return { prisma: { commentMessage: delegate } as unknown as PrismaClient, wheres, takes };
}

function draft(overrides: Partial<CreateCommentMessageInput> = {}): CreateCommentMessageInput {
  return {
    organizationId: "org-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    threadId: "th-1",
    authorId: "user-1",
    parentMessageId: null,
    body: "hello",
    ...overrides,
  };
}

describe("PrismaCommentMessageRepository", () => {
  it("persists every supplied field", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);

    const message = await repo.create(draft());
    expect(message.threadId).toBe("th-1");
    expect(message.authorId).toBe("user-1");
    expect(message.body).toBe("hello");
    expect(message.parentMessageId).toBeNull();
    expect(message.deletedAt).toBeNull();
    expect(message.revision).toBe(1);
  });

  it("stores a markup-bearing body verbatim", async () => {
    // The adapter is not an escaping layer; the body is text all the way down.
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const payload = "<script>alert(1)</script>";
    const message = await repo.create(draft({ body: payload }));
    expect(message.body).toBe(payload);
  });

  it("scopes every read by Workspace", async () => {
    const rows: MessageRow[] = [];
    const { prisma, wheres } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft());
    expect(await repo.getById("ws-other", message.id)).toBeNull();
    expect(await repo.getById("ws-1", message.id)).not.toBeNull();
    expect(wheres.every((w) => "workspaceId" in w)).toBe(true);
  });

  it("edits only on a matching revision", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft());

    expect(await repo.updateBody("ws-1", message.id, 99, "new", new Date())).toBeNull();

    const edited = await repo.updateBody(
      "ws-1",
      message.id,
      message.revision,
      "new text",
      new Date("2026-08-03T13:00:00.000Z"),
    );
    expect(edited?.body).toBe("new text");
    expect(edited?.editedAt).not.toBeNull();
    expect(edited?.revision).toBe(message.revision + 1);
  });

  it("clears the body when soft-deleting, in the same write", async () => {
    // "Deleted" must actually remove the words, not hide them behind a flag.
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft({ body: "sensitive text" }));

    const deleted = await repo.softDelete(
      "ws-1",
      message.id,
      message.revision,
      "user-2",
      new Date("2026-08-03T13:00:00.000Z"),
    );
    expect(deleted?.body).toBe("");
    expect(deleted?.deletedById).toBe("user-2");
    expect(rows[0].body).toBe("");
  });

  it("refuses to edit an already-deleted message", async () => {
    // Atomic with the write: a concurrent delete must not be silently reversed.
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft());
    const deleted = await repo.softDelete("ws-1", message.id, message.revision, "user-2", new Date());
    expect(
      await repo.updateBody("ws-1", message.id, deleted!.revision, "resurrected", new Date()),
    ).toBeNull();
  });

  it("refuses to delete an already-deleted message", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft());
    const deleted = await repo.softDelete("ws-1", message.id, message.revision, "user-2", new Date());
    expect(
      await repo.softDelete("ws-1", message.id, deleted!.revision, "user-2", new Date()),
    ).toBeNull();
  });

  it("refuses a cross-Workspace edit or delete", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft());
    expect(await repo.updateBody("ws-other", message.id, message.revision, "x", new Date())).toBeNull();
    expect(await repo.softDelete("ws-other", message.id, message.revision, "u", new Date())).toBeNull();
  });

  it("lists a thread's messages oldest first", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const first = await repo.create(draft({ body: "one" }));
    const second = await repo.create(draft({ body: "two" }));
    const listed = await repo.list({ workspaceId: "ws-1", threadId: "th-1", limit: 10 });
    expect(listed.map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it("clamps a listing to the domain cap", async () => {
    const rows: MessageRow[] = [];
    const { prisma, takes } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    await repo.create(draft());
    await repo.list({ workspaceId: "ws-1", threadId: "th-1", limit: 100_000 });
    expect(takes.at(-1)).toBe(COLLABORATION_LIMITS.maxListLimit);
  });

  it("supports an incremental read via createdAfter", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const first = await repo.create(draft({ body: "one" }));
    const second = await repo.create(draft({ body: "two" }));
    const since = await repo.list({
      workspaceId: "ws-1",
      threadId: "th-1",
      createdAfter: first.createdAt,
      limit: 10,
    });
    expect(since.map((m) => m.id)).toEqual([second.id]);
  });

  it("reports whether a message has replies", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const root = await repo.create(draft());
    expect(await repo.hasReplies("ws-1", root.id)).toBe(false);
    await repo.create(draft({ parentMessageId: root.id }));
    expect(await repo.hasReplies("ws-1", root.id)).toBe(true);
  });

  it("counts and clears a thread's messages within the Workspace", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    await repo.create(draft());
    await repo.create(draft());
    await repo.create(draft({ threadId: "th-2" }));
    expect(await repo.countForThread("ws-1", "th-1")).toBe(2);
    expect(await repo.deleteForThread("ws-other", "th-1")).toBe(0);
    expect(await repo.deleteForThread("ws-1", "th-1")).toBe(2);
    expect(await repo.countForThread("ws-1", "th-2")).toBe(1);
  });

  it("returns independent date objects on every read", async () => {
    const rows: MessageRow[] = [];
    const { prisma } = fakePrisma(rows);
    const repo = new PrismaCommentMessageRepository(prisma);
    const message = await repo.create(draft());
    message.createdAt.setFullYear(1999);
    const reread = await repo.getById("ws-1", message.id);
    expect(reread?.createdAt.getFullYear()).not.toBe(1999);
  });
});
